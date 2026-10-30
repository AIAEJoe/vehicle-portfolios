-- Vehicle Portfolios: complete database setup (paste all of this into Supabase → SQL Editor → Run)

-- ===== supabase/migrations/0001_vehicle_portfolios.sql =====
-- Vehicle Portfolios: core schema
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Multi-tenant: every row belongs to a dealership; staff access is granted
-- through dealership_members. Public visitors only see published/sold vehicles.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.vp_slugify(t text) returns text
language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function public.vp_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.vp_short_code(n int default 8) returns text
language plpgsql volatile as $$
declare
  chars constant text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out text := '';
  b bytea := gen_random_bytes(n);
begin
  for i in 0..n-1 loop
    out := out || substr(chars, 1 + (get_byte(b, i) % length(chars)), 1);
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Dealerships
-- ---------------------------------------------------------------------------
create table if not exists public.dealerships (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name             text not null,
  phone            text,
  sms_phone        text,
  email            text,
  website          text,
  address_line     text,
  city             text,
  state            text,
  zip              text,
  hours            text,
  logo_url         text,
  brand_primary    text not null default '#013C9E',
  brand_accent     text not null default '#F4BC00',
  default_fees_note text,
  custom_domain    text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger vp_dealerships_touch before update on public.dealerships
  for each row execute function public.vp_touch_updated_at();

-- Private, admin-only settings (lead routing, feed credentials, tokens)
create table if not exists public.dealership_settings (
  dealership_id          uuid primary key references public.dealerships(id) on delete cascade,
  lead_email             text,          -- where test-drive requests are emailed (comma separated ok)
  crm_adf_email          text,          -- Elead (or any CRM) ADF/XML lead intake address
  notify_on_open         boolean not null default true,
  open_alert_cooldown_minutes int not null default 60,
  feed_url               text,          -- HTTPS URL to HomeNet / vAuto CSV
  feed_auth_header       text,          -- optional, e.g. "Basic dXNlcjpwYXNz"
  feed_dealer_id         text,          -- optional: filter rows where DealerId = this value
  feed_auto_publish      boolean not null default true,
  feed_mark_missing_sold boolean not null default true,
  feed_ingest_token      text not null default encode(gen_random_bytes(18), 'hex'),
  feed_last_sync_at      timestamptz,
  feed_last_result       jsonb,
  updated_at             timestamptz not null default now()
);
create trigger vp_settings_touch before update on public.dealership_settings
  for each row execute function public.vp_touch_updated_at();

create or replace function public.vp_create_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.dealership_settings (dealership_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger vp_dealership_settings_auto after insert on public.dealerships
  for each row execute function public.vp_create_settings();

create table if not exists public.dealership_members (
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'sales' check (role in ('owner', 'admin', 'sales')),
  created_at    timestamptz not null default now(),
  primary key (dealership_id, user_id)
);
create index if not exists dealership_members_user_idx on public.dealership_members(user_id);

create or replace function public.vp_is_member(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dealership_members m
                 where m.dealership_id = d and m.user_id = auth.uid())
$$;

create or replace function public.vp_is_admin(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dealership_members m
                 where m.dealership_id = d and m.user_id = auth.uid()
                   and m.role in ('owner', 'admin'))
$$;

-- storage paths look like "<dealership uuid>/<...>"
create or replace function public.vp_is_member_path(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  first text := split_part(object_name, '/', 1);
begin
  if first !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.vp_is_member(first::uuid);
end $$;

-- ---------------------------------------------------------------------------
-- Staff (salespeople shown on portfolios; may or may not have a login)
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  full_name     text not null,
  title         text default 'Sales Consultant',
  phone         text,
  email         text,
  photo_url     text,
  active        boolean not null default true,
  notify_email  boolean not null default true,
  notify_sms    boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists staff_dealership_idx on public.staff(dealership_id);

-- ---------------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------------
create table if not exists public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  dealership_id   uuid not null references public.dealerships(id) on delete cascade,
  slug            text,
  status          text not null default 'draft'
                  check (status in ('draft', 'published', 'sold', 'archived')),
  sold_reason     text,
  condition       text not null default 'used' check (condition in ('new', 'used', 'certified')),
  stock_number    text,
  vin             text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  year            int check (year is null or year between 1900 and 2100),
  make            text,
  model           text,
  trim            text,
  body_style      text,
  exterior_color  text,
  interior_color  text,
  engine          text,
  transmission    text,
  drivetrain      text,
  fuel_type       text,
  mpg_city        int,
  mpg_hwy         int,
  mileage         int,
  price           numeric(12,2),
  price_label     text default 'Price',
  msrp            numeric(12,2),
  fees_note       text,
  description     text,
  features        text[] not null default '{}',
  listing_url     text,
  salesperson_id  uuid references public.staff(id) on delete set null,
  specs           jsonb not null default '{}'::jsonb,
  recalls         jsonb,
  recalls_checked_at timestamptz,
  source          text not null default 'manual' check (source in ('manual', 'feed', 'import')),
  feed_locked     boolean not null default false,
  feed_seen_at    timestamptz,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (dealership_id, slug),
  unique (dealership_id, vin)
);
create index if not exists vehicles_dealership_status_idx on public.vehicles(dealership_id, status);

create or replace function public.vp_vehicle_before_write() returns trigger
language plpgsql as $$
declare
  base text;
  candidate text;
  i int := 1;
begin
  if new.vin is not null then
    new.vin := upper(trim(new.vin));
    if new.vin = '' then new.vin := null; end if;
  end if;
  if new.slug is null or btrim(new.slug) = '' then
    base := public.vp_slugify(concat_ws(' ', new.year, new.make, new.model, new.trim, new.stock_number));
    if base = '' then base := substr(new.id::text, 1, 8); end if;
  else
    base := public.vp_slugify(new.slug);
  end if;
  candidate := base;
  while exists (select 1 from public.vehicles v
                where v.dealership_id = new.dealership_id and v.slug = candidate and v.id <> new.id) loop
    i := i + 1;
    candidate := base || '-' || i;
  end loop;
  new.slug := candidate;
  if new.status <> 'sold' then new.sold_reason := null; end if;
  return new;
end $$;
create trigger vp_vehicles_before_write before insert or update on public.vehicles
  for each row execute function public.vp_vehicle_before_write();
create trigger vp_vehicles_touch before update on public.vehicles
  for each row execute function public.vp_touch_updated_at();

-- Child rows inherit dealership_id from their vehicle (can't be spoofed)
create or replace function public.vp_inherit_dealership() returns trigger
language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  if new.vehicle_id is not null then
    select dealership_id into d from public.vehicles where id = new.vehicle_id;
    if d is null then raise exception 'vehicle % not found', new.vehicle_id; end if;
    new.dealership_id := d;
  end if;
  return new;
end $$;

create table if not exists public.vehicle_photos (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  url           text not null,
  storage_path  text,
  position      int not null default 0,
  source        text not null default 'upload' check (source in ('upload', 'feed', 'import', 'url')),
  created_at    timestamptz not null default now()
);
create index if not exists vehicle_photos_vehicle_idx on public.vehicle_photos(vehicle_id, position);
create trigger vp_photos_inherit before insert or update on public.vehicle_photos
  for each row execute function public.vp_inherit_dealership();

create table if not exists public.vehicle_documents (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  kind          text not null default 'other'
                check (kind in ('window_sticker', 'history_report', 'inspection', 'warranty', 'brochure', 'other')),
  title         text not null,
  url           text not null,
  storage_path  text,
  created_at    timestamptz not null default now()
);
create index if not exists vehicle_documents_vehicle_idx on public.vehicle_documents(vehicle_id);
create trigger vp_docs_inherit before insert or update on public.vehicle_documents
  for each row execute function public.vp_inherit_dealership();

-- ---------------------------------------------------------------------------
-- Shares (a personal, trackable link sent to one customer)
-- ---------------------------------------------------------------------------
create table if not exists public.shares (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique default public.vp_short_code(8),
  vehicle_id       uuid not null references public.vehicles(id) on delete cascade,
  dealership_id    uuid not null references public.dealerships(id) on delete cascade,
  staff_id         uuid references public.staff(id) on delete set null,
  customer_name    text,
  customer_phone   text,
  customer_email   text,
  channel          text not null default 'sms' check (channel in ('sms', 'email', 'link', 'qr')),
  open_count       int not null default 0,
  first_opened_at  timestamptz,
  last_opened_at   timestamptz,
  last_notified_at timestamptz,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);
create index if not exists shares_vehicle_idx on public.shares(vehicle_id);
create trigger vp_shares_inherit before insert or update on public.shares
  for each row execute function public.vp_inherit_dealership();

create table if not exists public.portfolio_views (
  id            bigint generated always as identity primary key,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  share_id      uuid references public.shares(id) on delete set null,
  visitor_id    text,
  referrer      text,
  user_agent    text,
  viewed_at     timestamptz not null default now()
);
create index if not exists portfolio_views_vehicle_idx on public.portfolio_views(vehicle_id, viewed_at desc);
create index if not exists portfolio_views_share_idx on public.portfolio_views(share_id, viewed_at desc);
create trigger vp_views_inherit before insert or update on public.portfolio_views
  for each row execute function public.vp_inherit_dealership();

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  dealership_id   uuid not null references public.dealerships(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete set null,
  share_id        uuid references public.shares(id) on delete set null,
  staff_id        uuid references public.staff(id) on delete set null,
  kind            text not null default 'test_drive' check (kind in ('test_drive', 'question', 'offer')),
  name            text not null,
  phone           text,
  email           text,
  preferred_date  date,
  preferred_time  text,
  message         text,
  status          text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  crm_sent_at     timestamptz,
  email_sent_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists leads_dealership_idx on public.leads(dealership_id, created_at desc);
create trigger vp_leads_inherit before insert or update on public.leads
  for each row execute function public.vp_inherit_dealership();

-- ---------------------------------------------------------------------------
-- Stats view (respects RLS of the caller)
-- ---------------------------------------------------------------------------
create or replace view public.vehicle_stats with (security_invoker = true) as
select v.id as vehicle_id,
       v.dealership_id,
       (select count(*) from public.portfolio_views pv where pv.vehicle_id = v.id)::int as views,
       (select count(distinct pv.visitor_id) from public.portfolio_views pv where pv.vehicle_id = v.id)::int as visitors,
       (select max(pv.viewed_at) from public.portfolio_views pv where pv.vehicle_id = v.id) as last_viewed_at,
       (select count(*) from public.leads l where l.vehicle_id = v.id)::int as leads,
       (select count(*) from public.shares s where s.vehicle_id = v.id)::int as shares
from public.vehicles v;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.dealerships         enable row level security;
alter table public.dealership_settings enable row level security;
alter table public.dealership_members  enable row level security;
alter table public.staff               enable row level security;
alter table public.vehicles            enable row level security;
alter table public.vehicle_photos      enable row level security;
alter table public.vehicle_documents   enable row level security;
alter table public.shares              enable row level security;
alter table public.portfolio_views     enable row level security;
alter table public.leads               enable row level security;

-- dealerships: public profile is readable by anyone, editable by admins
create policy dealerships_read on public.dealerships for select using (true);
create policy dealerships_update on public.dealerships for update
  using (public.vp_is_admin(id)) with check (public.vp_is_admin(id));

-- settings: admins only
create policy settings_read on public.dealership_settings for select using (public.vp_is_admin(dealership_id));
create policy settings_update on public.dealership_settings for update
  using (public.vp_is_admin(dealership_id)) with check (public.vp_is_admin(dealership_id));

-- members: you can see your own memberships; admins see/manage the roster
create policy members_read on public.dealership_members for select
  using (user_id = auth.uid() or public.vp_is_admin(dealership_id));
-- (owners can only be added/changed with vp_add_member from the SQL editor)
create policy members_admin_write on public.dealership_members for update
  using (public.vp_is_admin(dealership_id) and role <> 'owner' and user_id <> auth.uid())
  with check (public.vp_is_admin(dealership_id) and role <> 'owner');
create policy members_admin_delete on public.dealership_members for delete
  using (public.vp_is_admin(dealership_id) and role <> 'owner' and user_id <> auth.uid());

-- staff: public sees active staff (their name/photo/phone are on portfolios)
create policy staff_read on public.staff for select
  using (active or public.vp_is_member(dealership_id));
create policy staff_insert on public.staff for insert with check (public.vp_is_admin(dealership_id));
create policy staff_update on public.staff for update
  using (public.vp_is_admin(dealership_id) or user_id = auth.uid())
  with check (public.vp_is_admin(dealership_id) or user_id = auth.uid());
create policy staff_delete on public.staff for delete using (public.vp_is_admin(dealership_id));

-- vehicles
create policy vehicles_read on public.vehicles for select
  using (status in ('published', 'sold') or public.vp_is_member(dealership_id));
create policy vehicles_insert on public.vehicles for insert with check (public.vp_is_member(dealership_id));
create policy vehicles_update on public.vehicles for update
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));
create policy vehicles_delete on public.vehicles for delete using (public.vp_is_admin(dealership_id));

-- photos & documents: visible when their vehicle is visible
create policy photos_read on public.vehicle_photos for select using (
  public.vp_is_member(dealership_id)
  or exists (select 1 from public.vehicles v where v.id = vehicle_id and v.status in ('published', 'sold')));
create policy photos_write on public.vehicle_photos for all
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));

create policy docs_read on public.vehicle_documents for select using (
  public.vp_is_member(dealership_id)
  or exists (select 1 from public.vehicles v where v.id = vehicle_id and v.status in ('published', 'sold')));
create policy docs_write on public.vehicle_documents for all
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));

-- shares / views / leads: staff only (public writes go through server functions)
create policy shares_member on public.shares for all
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));
create policy views_member_read on public.portfolio_views for select using (public.vp_is_member(dealership_id));
create policy leads_member_read on public.leads for select using (public.vp_is_member(dealership_id));
create policy leads_member_update on public.leads for update
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));
create policy leads_member_delete on public.leads for delete using (public.vp_is_admin(dealership_id));

-- ---------------------------------------------------------------------------
-- Server-side RPCs (called by Cloudflare functions with the service role key)
-- ---------------------------------------------------------------------------

-- Record a portfolio open. Returns what the caller needs to send open alerts.
create or replace function public.vp_record_view(
  p_vehicle_id uuid,
  p_share_code text default null,
  p_visitor_id text default null,
  p_referrer   text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.vehicles%rowtype;
  s public.shares%rowtype;
  st public.staff%rowtype;
  cfg public.dealership_settings%rowtype;
  do_notify boolean := false;
begin
  select * into v from public.vehicles where id = p_vehicle_id and status in ('published', 'sold');
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'not_found');
  end if;

  if p_share_code is not null and p_share_code <> '' then
    select * into s from public.shares where code = p_share_code and vehicle_id = v.id;
  end if;

  -- de-duplicate refreshes from the same browser within 30 minutes
  if p_visitor_id is not null and exists (
      select 1 from public.portfolio_views pv
      where pv.vehicle_id = v.id and pv.visitor_id = p_visitor_id
        and pv.share_id is not distinct from s.id
        and pv.viewed_at > now() - interval '30 minutes') then
    return jsonb_build_object('recorded', false, 'reason', 'duplicate');
  end if;

  insert into public.portfolio_views (vehicle_id, dealership_id, share_id, visitor_id, referrer, user_agent)
  values (v.id, v.dealership_id, s.id, left(p_visitor_id, 64), left(p_referrer, 500), left(p_user_agent, 500));

  if s.id is null then
    return jsonb_build_object('recorded', true, 'notify', false);
  end if;

  select * into cfg from public.dealership_settings where dealership_id = v.dealership_id;
  do_notify := coalesce(cfg.notify_on_open, true) and (
    s.last_notified_at is null
    or s.last_notified_at < now() - make_interval(mins => coalesce(cfg.open_alert_cooldown_minutes, 60)));

  update public.shares set
    open_count = open_count + 1,
    first_opened_at = coalesce(first_opened_at, now()),
    last_opened_at = now(),
    last_notified_at = case when do_notify then now() else last_notified_at end
  where id = s.id
  returning * into s;

  if s.staff_id is not null then
    select * into st from public.staff where id = s.staff_id;
  end if;

  return jsonb_build_object(
    'recorded', true,
    'notify', do_notify and st.id is not null,
    'open_count', s.open_count,
    'share', jsonb_build_object('id', s.id, 'code', s.code, 'customer_name', s.customer_name,
                                'customer_phone', s.customer_phone),
    'staff', case when st.id is null then null else jsonb_build_object(
               'id', st.id, 'full_name', st.full_name, 'email', st.email, 'phone', st.phone,
               'notify_email', st.notify_email, 'notify_sms', st.notify_sms) end,
    'vehicle', jsonb_build_object('id', v.id, 'dealership_id', v.dealership_id, 'slug', v.slug, 'year', v.year, 'make', v.make,
                                  'model', v.model, 'trim', v.trim, 'stock_number', v.stock_number)
  );
end $$;

-- Upsert a batch of feed rows (already parsed to JSON by the sync function).
create or replace function public.vp_feed_sync(
  p_dealership_id uuid,
  p_rows jsonb,
  p_auto_publish boolean default true,
  p_mark_missing_sold boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  existing public.vehicles%rowtype;
  vid uuid;
  n_inserted int := 0;
  n_updated int := 0;
  n_locked int := 0;
  n_skipped int := 0;
  n_sold int := 0;
  n_photos int := 0;
  vins text[] := '{}';
  vin_clean text;
  new_photos text[];
  old_photos text[];
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    vin_clean := upper(btrim(coalesce(r->>'vin', '')));
    if vin_clean !~ '^[A-HJ-NPR-Z0-9]{17}$' then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    vins := vins || vin_clean;

    select * into existing from public.vehicles where dealership_id = p_dealership_id and vin = vin_clean;

    if not found then
      insert into public.vehicles (
        dealership_id, vin, status, source, feed_seen_at, condition, stock_number, year, make, model, trim,
        body_style, exterior_color, interior_color, engine, transmission, drivetrain, fuel_type,
        mpg_city, mpg_hwy, mileage, price, msrp, description, features, created_by)
      values (
        p_dealership_id, vin_clean, case when p_auto_publish then 'published' else 'draft' end, 'feed', now(),
        coalesce(nullif(r->>'condition', ''), 'used'), r->>'stock_number', (r->>'year')::int, r->>'make',
        r->>'model', r->>'trim', r->>'body_style', r->>'exterior_color', r->>'interior_color', r->>'engine',
        r->>'transmission', r->>'drivetrain', r->>'fuel_type', (r->>'mpg_city')::int, (r->>'mpg_hwy')::int,
        (r->>'mileage')::int, (r->>'price')::numeric, (r->>'msrp')::numeric, r->>'description',
        coalesce(array(select jsonb_array_elements_text(r->'features')), '{}'), null)
      returning id into vid;
      n_inserted := n_inserted + 1;
    elsif existing.feed_locked then
      update public.vehicles set feed_seen_at = now() where id = existing.id;
      n_locked := n_locked + 1;
      continue;
    else
      vid := existing.id;
      update public.vehicles set
        feed_seen_at   = now(),
        status         = case when existing.status = 'sold' and existing.sold_reason = 'feed_missing'
                              then 'published' else existing.status end,
        condition      = coalesce(nullif(r->>'condition', ''), condition),
        stock_number   = coalesce(nullif(r->>'stock_number', ''), stock_number),
        year           = coalesce((r->>'year')::int, year),
        make           = coalesce(nullif(r->>'make', ''), make),
        model          = coalesce(nullif(r->>'model', ''), model),
        trim           = coalesce(nullif(r->>'trim', ''), trim),
        body_style     = coalesce(nullif(r->>'body_style', ''), body_style),
        exterior_color = coalesce(nullif(r->>'exterior_color', ''), exterior_color),
        interior_color = coalesce(nullif(r->>'interior_color', ''), interior_color),
        engine         = coalesce(nullif(r->>'engine', ''), engine),
        transmission   = coalesce(nullif(r->>'transmission', ''), transmission),
        drivetrain     = coalesce(nullif(r->>'drivetrain', ''), drivetrain),
        fuel_type      = coalesce(nullif(r->>'fuel_type', ''), fuel_type),
        mpg_city       = coalesce((r->>'mpg_city')::int, mpg_city),
        mpg_hwy        = coalesce((r->>'mpg_hwy')::int, mpg_hwy),
        mileage        = coalesce((r->>'mileage')::int, mileage),
        price          = coalesce((r->>'price')::numeric, price),
        msrp           = coalesce((r->>'msrp')::numeric, msrp),
        description    = coalesce(nullif(r->>'description', ''), description),
        features       = case when jsonb_array_length(coalesce(r->'features', '[]'::jsonb)) > 0
                              then array(select jsonb_array_elements_text(r->'features')) else features end
      where id = vid;
      n_updated := n_updated + 1;
    end if;

    -- photos: replace feed photos only when the list changed; never touch uploads
    new_photos := coalesce(array(select jsonb_array_elements_text(r->'photos')), '{}');
    if array_length(new_photos, 1) is not null then
      select coalesce(array_agg(url order by position, created_at), '{}') into old_photos
        from public.vehicle_photos where vehicle_id = vid and source = 'feed';
      if old_photos is distinct from new_photos then
        delete from public.vehicle_photos where vehicle_id = vid and source = 'feed';
        insert into public.vehicle_photos (vehicle_id, dealership_id, url, position, source)
          select vid, p_dealership_id, u, ord - 1, 'feed'
          from unnest(new_photos) with ordinality as t(u, ord);
        n_photos := n_photos + array_length(new_photos, 1);
      end if;
    end if;
  end loop;

  if p_mark_missing_sold and array_length(vins, 1) is not null then
    with gone as (
      update public.vehicles set status = 'sold', sold_reason = 'feed_missing'
      where dealership_id = p_dealership_id and source = 'feed' and not feed_locked
        and status in ('published', 'draft') and vin is not null and not (vin = any(vins))
      returning 1)
    select count(*) into n_sold from gone;
  end if;

  return jsonb_build_object('inserted', n_inserted, 'updated', n_updated, 'locked', n_locked,
                            'skipped', n_skipped, 'marked_sold', n_sold, 'photos_replaced', n_photos,
                            'rows', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)));
end $$;

-- Public lookup for a personal link: who sent it and the customer's first name,
-- so the page can say "Prepared for Mike by Kyleigh". The code itself is the secret.
create or replace function public.vp_share_public(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'vehicle_id', s.vehicle_id,
    'staff_id', s.staff_id,
    'customer_first_name', nullif(split_part(btrim(coalesce(s.customer_name, '')), ' ', 1), ''))
  from public.shares s
  join public.vehicles v on v.id = s.vehicle_id and v.status in ('published', 'sold')
  where s.code = p_code
$$;
grant execute on function public.vp_share_public(text) to anon, authenticated;

-- Admin roster with emails (auth.users isn't readable from the client)
create or replace function public.vp_members(p_dealership_id uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.dealership_members m join auth.users u on u.id = m.user_id
  where m.dealership_id = p_dealership_id and public.vp_is_admin(p_dealership_id)
  order by m.created_at
$$;

-- One-time setup helper, run from the SQL editor:
--   select public.vp_add_member('nsbchevy', 'you@example.com', 'owner');
create or replace function public.vp_add_member(p_slug text, p_email text, p_role text default 'owner')
returns text language plpgsql security definer set search_path = public as $$
declare d uuid; u uuid;
begin
  select id into d from public.dealerships where slug = p_slug;
  if d is null then raise exception 'No dealership with slug %', p_slug; end if;
  select id into u from auth.users where lower(email) = lower(p_email);
  if u is null then raise exception 'No user with email % (create it under Authentication > Users first)', p_email; end if;
  insert into public.dealership_members (dealership_id, user_id, role) values (d, u, p_role)
    on conflict (dealership_id, user_id) do update set role = excluded.role;
  return format('%s is now %s of %s', p_email, p_role, p_slug);
end $$;

-- Lock down function execution
revoke execute on function public.vp_record_view(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.vp_feed_sync(uuid, jsonb, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.vp_add_member(text, text, text) from public, anon, authenticated;
revoke execute on function public.vp_members(uuid) from public, anon;
grant execute on function public.vp_record_view(uuid, text, text, text, text) to service_role;
grant execute on function public.vp_feed_sync(uuid, jsonb, boolean, boolean) to service_role;
grant execute on function public.vp_members(uuid) to authenticated;

grant select on public.vehicle_stats to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: one public bucket; writes limited to the member's dealership folder
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 26214400)
on conflict (id) do nothing;

create policy vp_media_read on storage.objects for select using (bucket_id = 'media');
create policy vp_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.vp_is_member_path(name));
create policy vp_media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.vp_is_member_path(name));
create policy vp_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.vp_is_member_path(name));

-- ===== supabase/migrations/0002_messaging_platform.sql =====
-- Vehicle Portfolios: multi-dealership messaging platform
--  * platform operators (you) vs dealership staff
--  * per-dealership sender identity (Twilio subaccount/number/10DLC, email domain/reply-to)
--  * customers, append-only consent records, message history with delivery status
--  * usage + cost ledger and allowance-based billing inside the subscription

-- ---------------------------------------------------------------------------
-- Platform operators
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

create or replace function public.vp_is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;
create policy platform_admins_self on public.platform_admins for select using (user_id = auth.uid());

-- Platform operators get support access to every dealership dashboard.
create or replace function public.vp_is_member(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_platform_admin() or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid())
$$;
create or replace function public.vp_is_admin(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_platform_admin() or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid()
      and m.role in ('owner', 'admin'))
$$;

alter table public.dealerships add column if not exists timezone text not null default 'America/New_York';
alter table public.dealerships add column if not exists active boolean not null default true;

-- ---------------------------------------------------------------------------
-- Rate card (your provider costs) and default plan — one row
-- ---------------------------------------------------------------------------
create table if not exists public.platform_settings (
  id                          int primary key default 1 check (id = 1),
  -- Twilio US long code (twilio.com/en-us/sms/pricing/us, checked Oct 2026)
  sms_out_segment_cost        numeric(10,5) not null default 0.0083,
  sms_in_segment_cost         numeric(10,5) not null default 0.0083,
  sms_carrier_fee_out         numeric(10,5) not null default 0.0045,  -- avg of AT&T .0035 / T-Mobile .0045 / Verizon .005
  sms_carrier_fee_in          numeric(10,5) not null default 0.0030,
  mms_out_cost                numeric(10,5) not null default 0.0220,
  phone_number_monthly        numeric(10,2) not null default 1.15,
  campaign_monthly            numeric(10,2) not null default 10.00,   -- Standard campaign
  brand_registration_fee      numeric(10,2) not null default 46.00,   -- Standard brand incl. secondary vetting
  campaign_vetting_fee        numeric(10,2) not null default 15.00,
  email_cost                  numeric(10,5) not null default 0.0004,  -- your Resend plan cost / emails included
  -- default plan for new dealerships
  default_monthly_fee         numeric(10,2) not null default 995.00,
  default_included_sms_segments int not null default 2500,
  default_included_emails     int not null default 5000,
  default_overage_sms_rate    numeric(10,4) not null default 0.04,
  default_overage_email_rate  numeric(10,4) not null default 0.005,
  updated_at                  timestamptz not null default now()
);
insert into public.platform_settings (id) values (1) on conflict do nothing;
alter table public.platform_settings enable row level security;
create policy platform_settings_admin on public.platform_settings for all
  using (public.vp_is_platform_admin()) with check (public.vp_is_platform_admin());

-- ---------------------------------------------------------------------------
-- Billing plan per dealership (allowance inside the subscription)
-- ---------------------------------------------------------------------------
create table if not exists public.dealership_billing (
  dealership_id          uuid primary key references public.dealerships(id) on delete cascade,
  plan_name              text not null default 'Vehicle Portfolios',
  monthly_fee            numeric(10,2) not null default 995.00,
  included_sms_segments  int not null default 2500,
  included_emails        int not null default 5000,
  overage_sms_rate       numeric(10,4) not null default 0.04,
  overage_email_rate     numeric(10,4) not null default 0.005,
  pass_through_fixed_fees boolean not null default false,  -- bill number/campaign fees on top?
  allow_overage          boolean not null default true,    -- false = pause platform texting at the allowance
  status                 text not null default 'active' check (status in ('trial', 'active', 'paused', 'cancelled')),
  billing_email          text,
  notes                  text,
  updated_at             timestamptz not null default now()
);
alter table public.dealership_billing enable row level security;
create policy billing_read on public.dealership_billing for select using (public.vp_is_admin(dealership_id));
create policy billing_write on public.dealership_billing for all
  using (public.vp_is_platform_admin()) with check (public.vp_is_platform_admin());

-- ---------------------------------------------------------------------------
-- Sender identity + 10DLC registration per dealership
-- ---------------------------------------------------------------------------
create table if not exists public.messaging_profiles (
  dealership_id               uuid primary key references public.dealerships(id) on delete cascade,
  -- Twilio (set by the platform only)
  twilio_subaccount_sid       text unique,
  twilio_messaging_service_sid text,
  twilio_phone_number         text unique,   -- E.164
  twilio_phone_sid            text,
  twilio_address_sid          text,
  a2p_customer_profile_sid    text,
  a2p_business_enduser_sid    text,
  a2p_rep_enduser_sid         text,
  a2p_address_document_sid    text,
  a2p_trust_product_sid       text,
  a2p_trust_enduser_sid       text,
  a2p_brand_sid               text,
  a2p_campaign_sid            text,
  a2p_step                    text not null default 'not_started',
  a2p_status                  text not null default 'not_started'
                              check (a2p_status in ('not_started', 'in_progress', 'brand_pending', 'brand_approved',
                                                    'campaign_pending', 'approved', 'action_needed', 'suspended')),
  a2p_brand_status            text,
  a2p_campaign_status         text,
  a2p_last_error              text,
  a2p_log                     jsonb not null default '[]'::jsonb,
  a2p_last_checked_at         timestamptz,
  sms_enabled                 boolean not null default false,  -- only true once the campaign is VERIFIED
  -- Business info for registration (dealership admins can edit)
  legal_name                  text,
  business_type               text default 'Corporation',
  ein                         text,
  business_industry           text default 'AUTOMOTIVE',
  website_url                 text,
  street                      text,
  city                        text,
  region                      text,
  postal_code                 text,
  rep_first_name              text,
  rep_last_name               text,
  rep_email                   text,
  rep_phone                   text,
  rep_title                   text,
  rep_job_position            text default 'GM',
  company_type                text default 'private' check (company_type in ('private', 'public', 'non-profit', 'government')),
  stock_exchange              text,
  stock_ticker                text,
  campaign_usecase            text default 'MIXED',
  campaign_description        text,
  message_flow                text,
  sample_messages             text[] not null default '{}',
  help_message                text,
  consent_language            text,
  -- Email sender identity
  email_from_name             text,
  email_from_local            text not null default 'sales',
  email_domain                text,          -- e.g. mail.newsmyrnachevy.com (verified with Resend)
  resend_domain_id            text,
  email_domain_status         text not null default 'none'
                              check (email_domain_status in ('none', 'pending', 'verified', 'failed', 'temporary_failure')),
  email_dns_records           jsonb,
  email_reply_to              text,          -- where customer email replies go (dealership inbox)
  email_inbound_alias         text unique check (email_inbound_alias ~ '^[a-z0-9-]+$'),
  updated_at                  timestamptz not null default now()
);
alter table public.messaging_profiles enable row level security;
create policy mp_read on public.messaging_profiles for select using (public.vp_is_admin(dealership_id));
create policy mp_update on public.messaging_profiles for update
  using (public.vp_is_admin(dealership_id)) with check (public.vp_is_admin(dealership_id));
create policy mp_insert on public.messaging_profiles for insert with check (public.vp_is_platform_admin());

-- Dealership admins may edit business info, consent wording and reply-to, never provider IDs or statuses.
create or replace function public.vp_protect_messaging_profile() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if auth.uid() is null or public.vp_is_platform_admin() then return new; end if;  -- service role / operator
  new.twilio_subaccount_sid := old.twilio_subaccount_sid;
  new.twilio_messaging_service_sid := old.twilio_messaging_service_sid;
  new.twilio_phone_number := old.twilio_phone_number;
  new.twilio_phone_sid := old.twilio_phone_sid;
  new.twilio_address_sid := old.twilio_address_sid;
  new.a2p_customer_profile_sid := old.a2p_customer_profile_sid;
  new.a2p_business_enduser_sid := old.a2p_business_enduser_sid;
  new.a2p_rep_enduser_sid := old.a2p_rep_enduser_sid;
  new.a2p_address_document_sid := old.a2p_address_document_sid;
  new.a2p_trust_product_sid := old.a2p_trust_product_sid;
  new.a2p_trust_enduser_sid := old.a2p_trust_enduser_sid;
  new.a2p_brand_sid := old.a2p_brand_sid;
  new.a2p_campaign_sid := old.a2p_campaign_sid;
  new.a2p_step := old.a2p_step;
  new.a2p_status := old.a2p_status;
  new.a2p_brand_status := old.a2p_brand_status;
  new.a2p_campaign_status := old.a2p_campaign_status;
  new.a2p_last_error := old.a2p_last_error;
  new.a2p_log := old.a2p_log;
  new.a2p_last_checked_at := old.a2p_last_checked_at;
  new.sms_enabled := old.sms_enabled;
  new.email_domain := old.email_domain;
  new.resend_domain_id := old.resend_domain_id;
  new.email_domain_status := old.email_domain_status;
  new.email_dns_records := old.email_dns_records;
  new.email_inbound_alias := old.email_inbound_alias;
  return new;
end $$;
create trigger vp_messaging_profiles_protect before update on public.messaging_profiles
  for each row execute function public.vp_protect_messaging_profile();

-- Provider secrets (subaccount auth tokens), AES-GCM encrypted by the server.
-- RLS on with no policies: only the service role (Cloudflare functions) can touch it.
create table if not exists public.provider_credentials (
  dealership_id    uuid not null references public.dealerships(id) on delete cascade,
  provider         text not null check (provider in ('twilio')),
  account_sid      text not null,
  secret_encrypted text not null,
  created_at       timestamptz not null default now(),
  primary key (dealership_id, provider)
);
alter table public.provider_credentials enable row level security;
revoke all on public.provider_credentials from anon, authenticated;

-- New dealerships get a billing plan (from the platform defaults) and a messaging profile
create or replace function public.vp_dealership_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.platform_settings%rowtype;
begin
  select * into p from public.platform_settings where id = 1;
  insert into public.dealership_billing (dealership_id, monthly_fee, included_sms_segments, included_emails,
                                         overage_sms_rate, overage_email_rate)
  values (new.id, p.default_monthly_fee, p.default_included_sms_segments, p.default_included_emails,
          p.default_overage_sms_rate, p.default_overage_email_rate)
  on conflict do nothing;
  insert into public.messaging_profiles (dealership_id, legal_name, website_url, street, city, region, postal_code,
                                         email_from_name, email_inbound_alias)
  values (new.id, new.name, new.website, new.address_line, new.city, new.state, new.zip, new.name, new.slug)
  on conflict do nothing;
  return new;
end $$;
create trigger vp_dealership_defaults after insert on public.dealerships
  for each row execute function public.vp_dealership_defaults();
-- backfill existing dealerships
insert into public.dealership_billing (dealership_id) select id from public.dealerships on conflict do nothing;
insert into public.messaging_profiles (dealership_id, legal_name, website_url, street, city, region, postal_code,
                                       email_from_name, email_inbound_alias)
  select id, name, website, address_line, city, state, zip, name, slug from public.dealerships on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Customers (per dealership — the same person at two stores is two records)
-- ---------------------------------------------------------------------------
create or replace function public.vp_e164(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if length(d) = 10 then return '+1' || d; end if;
  if length(d) = 11 and left(d, 1) = '1' then return '+' || d; end if;
  if left(btrim(p), 1) = '+' and length(d) between 8 and 15 then return '+' || d; end if;
  return null;
end $$;

create table if not exists public.customers (
  id                 uuid primary key default gen_random_uuid(),
  dealership_id      uuid not null references public.dealerships(id) on delete cascade,
  full_name          text,
  phone              text,                      -- E.164
  email              text,
  sms_consent_status text not null default 'unknown' check (sms_consent_status in ('unknown', 'opted_in', 'opted_out')),
  email_opted_out    boolean not null default false,
  assigned_staff_id  uuid references public.staff(id) on delete set null,
  unread_count       int not null default 0,
  last_message_at    timestamptz,
  last_inbound_at    timestamptz,
  created_at         timestamptz not null default now(),
  unique (dealership_id, phone)
);
create index if not exists customers_dealer_recent_idx on public.customers(dealership_id, last_message_at desc nulls last);
create unique index if not exists customers_dealer_email_idx on public.customers(dealership_id, lower(email)) where phone is null and email is not null;

create or replace function public.vp_customer_normalize() returns trigger
language plpgsql as $$
begin
  if new.phone is not null then
    new.phone := public.vp_e164(new.phone);
  end if;
  if new.email is not null then new.email := lower(btrim(new.email)); if new.email = '' then new.email := null; end if; end if;
  if tg_op = 'UPDATE' and auth.uid() is not null and not public.vp_is_platform_admin()
     and coalesce(current_setting('vp.consent_write', true), '') <> 'on' then
    -- consent state only changes through consent_records
    new.sms_consent_status := old.sms_consent_status;
    new.email_opted_out := old.email_opted_out;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.sms_consent_status := 'unknown';
    new.email_opted_out := false;
  end if;
  return new;
end $$;
create trigger vp_customers_normalize before insert or update on public.customers
  for each row execute function public.vp_customer_normalize();

alter table public.customers enable row level security;
create policy customers_member on public.customers for select using (public.vp_is_member(dealership_id));
create policy customers_insert on public.customers for insert with check (public.vp_is_member(dealership_id));
create policy customers_update on public.customers for update
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));
create policy customers_delete on public.customers for delete using (public.vp_is_admin(dealership_id));

alter table public.shares add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.leads  add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.leads  add column if not exists sms_consent boolean not null default false;

-- ---------------------------------------------------------------------------
-- Consent records: append-only evidence (no update/delete for anyone but the DB owner)
-- ---------------------------------------------------------------------------
create table if not exists public.consent_records (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  channel       text not null check (channel in ('sms', 'email')),
  action        text not null check (action in ('opt_in', 'opt_out')),
  method        text not null check (method in ('web_form', 'verbal_attested', 'written', 'inbound_keyword',
                                                'reply_initiated', 'email_unsubscribe', 'email_complaint', 'staff_recorded', 'import')),
  consent_text  text,           -- exact language shown/read to the customer
  phone         text,
  email         text,
  source_url    text,
  ip_address    text,
  user_agent    text,
  keyword       text,           -- STOP / START / etc.
  staff_id      uuid references public.staff(id) on delete set null,
  recorded_by   uuid default auth.uid(),
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists consent_customer_idx on public.consent_records(customer_id, created_at desc);
alter table public.consent_records enable row level security;
create policy consent_read on public.consent_records for select using (public.vp_is_member(dealership_id));
create policy consent_insert on public.consent_records for insert with check (
  public.vp_is_member(dealership_id)
  and recorded_by = auth.uid()
  and method in ('verbal_attested', 'written', 'staff_recorded'));

create or replace function public.vp_consent_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.customers%rowtype;
begin
  select * into c from public.customers where id = new.customer_id for update;
  if c.dealership_id is distinct from new.dealership_id then
    raise exception 'customer belongs to another dealership';
  end if;
  new.phone := coalesce(new.phone, c.phone);
  new.email := coalesce(new.email, c.email);
  if new.channel = 'sms' then
    if new.action = 'opt_in' and c.sms_consent_status = 'opted_out'
       and new.method not in ('inbound_keyword', 'web_form', 'written') then
      raise exception 'This customer texted STOP. They must text START (or opt in on a form) before you can text them again.';
    end if;
    perform set_config('vp.consent_write', 'on', true);
    update public.customers set sms_consent_status = case when new.action = 'opt_in' then 'opted_in' else 'opted_out' end
      where id = c.id;
  else
    perform set_config('vp.consent_write', 'on', true);
    update public.customers set email_opted_out = (new.action = 'opt_out') where id = c.id;
  end if;
  perform set_config('vp.consent_write', '', true);
  return new;
end $$;
create trigger vp_consent_apply before insert on public.consent_records
  for each row execute function public.vp_consent_apply();

-- ---------------------------------------------------------------------------
-- Message history (every SMS/email, in and out) with delivery status and cost
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  dealership_id       uuid not null references public.dealerships(id) on delete cascade,
  customer_id         uuid references public.customers(id) on delete set null,
  staff_id            uuid references public.staff(id) on delete set null,
  vehicle_id          uuid references public.vehicles(id) on delete set null,
  share_id            uuid references public.shares(id) on delete set null,
  lead_id             uuid references public.leads(id) on delete set null,
  channel             text not null check (channel in ('sms', 'mms', 'email')),
  direction           text not null check (direction in ('outbound', 'inbound')),
  audience            text not null default 'customer' check (audience in ('customer', 'staff', 'crm')),
  purpose             text not null default 'conversation'
                      check (purpose in ('portfolio_share', 'conversation', 'lead_alert', 'open_alert', 'reply_alert',
                                         'lead_notification', 'crm_adf', 'help_reply', 'system')),
  sender              text not null default 'dealership' check (sender in ('dealership', 'platform')),
  from_address        text,
  to_address          text,
  subject             text,
  body                text,
  provider            text check (provider in ('twilio', 'resend')),
  provider_message_id text unique,
  status              text not null default 'queued'
                      check (status in ('queued', 'accepted', 'sending', 'sent', 'delivered', 'undelivered', 'failed',
                                        'received', 'bounced', 'complained', 'blocked', 'canceled')),
  error_code          text,
  error_message       text,
  segments            int not null default 1,
  num_media           int not null default 0,
  cost_estimate       numeric(10,5) not null default 0,  -- provider base price estimate at send time
  provider_cost       numeric(10,5),                     -- actual price reported by provider
  carrier_fee         numeric(10,5) not null default 0,  -- estimated carrier pass-through fee
  sent_by             uuid,
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  status_updated_at   timestamptz
);
create index if not exists messages_customer_idx on public.messages(customer_id, created_at);
create index if not exists messages_dealer_month_idx on public.messages(dealership_id, created_at);
create index if not exists messages_unpriced_idx on public.messages(created_at) where provider_cost is null and provider = 'twilio';
alter table public.messages enable row level security;
create policy messages_read on public.messages for select using (public.vp_is_member(dealership_id));

-- One-off and recurring provider charges (phone number rental, 10DLC fees, …)
create table if not exists public.usage_charges (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  month         date not null,             -- first day of month
  kind          text not null check (kind in ('phone_number', 'campaign_monthly', 'brand_registration',
                                              'campaign_vetting', 'email_domain', 'adjustment', 'other')),
  ref           text not null default '',  -- e.g. phone number SID, makes monthly charges idempotent
  description   text not null,
  provider_cost numeric(10,2) not null default 0,
  created_at    timestamptz not null default now(),
  unique (dealership_id, month, kind, ref)
);
alter table public.usage_charges enable row level security;
create policy charges_platform on public.usage_charges for all
  using (public.vp_is_platform_admin()) with check (public.vp_is_platform_admin());

-- ---------------------------------------------------------------------------
-- Usage summary: what the dealership used vs its allowance; costs/margin for operators only
-- ---------------------------------------------------------------------------
create or replace function public.vp_usage_summary(p_dealership_id uuid, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz text;
  m date;
  m_start timestamptz;
  m_end timestamptz;
  b public.dealership_billing%rowtype;
  r record;
  fixed numeric := 0;
  sms_total int;
  sms_over int;
  email_over int;
  overage numeric;
  provider_total numeric;
  result jsonb;
begin
  if not public.vp_is_admin(p_dealership_id) and auth.uid() is not null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select timezone into tz from public.dealerships where id = p_dealership_id;
  m := date_trunc('month', coalesce(p_month, (now() at time zone coalesce(tz, 'America/New_York'))::date))::date;
  m_start := (m::timestamp) at time zone coalesce(tz, 'America/New_York');
  m_end := ((m + interval '1 month')::timestamp) at time zone coalesce(tz, 'America/New_York');
  select * into b from public.dealership_billing where dealership_id = p_dealership_id;

  select
    coalesce(sum(segments) filter (where channel in ('sms','mms') and direction = 'outbound' and audience = 'customer'), 0)::int as sms_out_customer,
    coalesce(sum(segments) filter (where channel in ('sms','mms') and direction = 'outbound' and audience = 'staff'), 0)::int as sms_out_staff,
    coalesce(sum(segments) filter (where channel in ('sms','mms') and direction = 'inbound'), 0)::int as sms_in,
    count(*) filter (where channel in ('sms','mms') and direction = 'outbound')::int as texts_sent,
    count(*) filter (where channel in ('sms','mms') and direction = 'inbound')::int as texts_received,
    count(*) filter (where channel in ('sms','mms') and status in ('undelivered','failed'))::int as texts_failed,
    count(*) filter (where channel = 'email' and direction = 'outbound')::int as emails_sent,
    count(*) filter (where channel = 'email' and status in ('bounced','complained'))::int as emails_bounced,
    coalesce(sum(coalesce(provider_cost, cost_estimate) + carrier_fee) filter (where channel in ('sms','mms')), 0) as sms_cost,
    coalesce(sum(coalesce(provider_cost, cost_estimate)) filter (where channel = 'email'), 0) as email_cost,
    count(*) filter (where provider_cost is null and provider = 'twilio')::int as unpriced
  into r
  from public.messages
  where dealership_id = p_dealership_id and created_at >= m_start and created_at < m_end;

  select coalesce(sum(provider_cost), 0) into fixed from public.usage_charges
   where dealership_id = p_dealership_id and month = m;

  sms_total := r.sms_out_customer + r.sms_out_staff + r.sms_in;
  sms_over := greatest(0, sms_total - coalesce(b.included_sms_segments, 0));
  email_over := greatest(0, r.emails_sent - coalesce(b.included_emails, 0));
  overage := round(sms_over * coalesce(b.overage_sms_rate, 0) + email_over * coalesce(b.overage_email_rate, 0)
                   + case when b.pass_through_fixed_fees then fixed else 0 end, 2);
  provider_total := round(r.sms_cost + r.email_cost + fixed, 2);

  result := jsonb_build_object(
    'dealership_id', p_dealership_id,
    'month', m,
    'sms_segments_total', sms_total,
    'sms_segments_customer_out', r.sms_out_customer,
    'sms_segments_staff_alerts', r.sms_out_staff,
    'sms_segments_in', r.sms_in,
    'texts_sent', r.texts_sent,
    'texts_received', r.texts_received,
    'texts_failed', r.texts_failed,
    'emails_sent', r.emails_sent,
    'emails_bounced', r.emails_bounced,
    'included_sms_segments', b.included_sms_segments,
    'included_emails', b.included_emails,
    'sms_allowance_used_pct', case when coalesce(b.included_sms_segments, 0) > 0
                                   then round(100.0 * sms_total / b.included_sms_segments, 1) else null end,
    'email_allowance_used_pct', case when coalesce(b.included_emails, 0) > 0
                                     then round(100.0 * r.emails_sent / b.included_emails, 1) else null end,
    'sms_overage_segments', sms_over,
    'email_overage', email_over,
    'overage_sms_rate', b.overage_sms_rate,
    'overage_email_rate', b.overage_email_rate,
    'overage_amount', overage,
    'monthly_fee', b.monthly_fee,
    'invoice_total', coalesce(b.monthly_fee, 0) + overage,
    'allow_overage', b.allow_overage
  );
  if auth.uid() is null or public.vp_is_platform_admin() then
    result := result || jsonb_build_object(
      'cost_sms', round(r.sms_cost, 4),
      'cost_email', round(r.email_cost, 4),
      'cost_fixed', fixed,
      'cost_total', provider_total,
      'cost_unreconciled_messages', r.unpriced,
      'margin', round(coalesce(b.monthly_fee, 0) + overage - provider_total, 2),
      'pass_through_fixed_fees', b.pass_through_fixed_fees);
  end if;
  return result;
end $$;
grant execute on function public.vp_usage_summary(uuid, date) to authenticated, service_role;
revoke execute on function public.vp_usage_summary(uuid, date) from anon, public;

create or replace function public.vp_platform_overview(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; d record;
begin
  if auth.uid() is not null and not public.vp_is_platform_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for d in select dl.id, dl.slug, dl.name, dl.active, mp.a2p_status, mp.sms_enabled, mp.twilio_phone_number,
                  mp.email_domain, mp.email_domain_status, db.status as billing_status
           from public.dealerships dl
           left join public.messaging_profiles mp on mp.dealership_id = dl.id
           left join public.dealership_billing db on db.dealership_id = dl.id
           order by dl.name loop
    out := out || jsonb_build_array(jsonb_build_object(
      'id', d.id, 'slug', d.slug, 'name', d.name, 'active', d.active, 'a2p_status', d.a2p_status,
      'sms_enabled', d.sms_enabled, 'phone', d.twilio_phone_number, 'email_domain', d.email_domain,
      'email_domain_status', d.email_domain_status, 'billing_status', d.billing_status,
      'usage', public.vp_usage_summary(d.id, p_month)));
  end loop;
  return out;
end $$;
grant execute on function public.vp_platform_overview(date) to authenticated, service_role;
revoke execute on function public.vp_platform_overview(date) from anon, public;

-- Mark a conversation read
create or replace function public.vp_mark_read(p_customer_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  select dealership_id into d from public.customers where id = p_customer_id;
  if d is null or not public.vp_is_member(d) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.customers set unread_count = 0 where id = p_customer_id;
  update public.messages set read_at = now() where customer_id = p_customer_id and direction = 'inbound' and read_at is null;
end $$;
grant execute on function public.vp_mark_read(uuid) to authenticated;
revoke execute on function public.vp_mark_read(uuid) from anon, public;

-- Inbound-message bookkeeping, called by the server when a reply arrives
create or replace function public.vp_customer_touch(p_customer_id uuid, p_inbound boolean) returns void
language sql security definer set search_path = public as $$
  update public.customers set
    last_message_at = now(),
    last_inbound_at = case when p_inbound then now() else last_inbound_at end,
    unread_count = unread_count + case when p_inbound then 1 else 0 end
  where id = p_customer_id
$$;
revoke execute on function public.vp_customer_touch(uuid, boolean) from public, anon, authenticated;
grant execute on function public.vp_customer_touch(uuid, boolean) to service_role;

-- Setup helper: select public.vp_add_platform_admin('you@example.com');
create or replace function public.vp_add_platform_admin(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  select id into u from auth.users where lower(email) = lower(p_email);
  if u is null then raise exception 'No user with email %', p_email; end if;
  insert into public.platform_admins (user_id) values (u) on conflict do nothing;
  return p_email || ' is a platform admin';
end $$;
revoke execute on function public.vp_add_platform_admin(text) from public, anon, authenticated;

-- The public share lookup and portfolio stats keep working unchanged.

-- Public texting program info for the consent checkbox and the /sms-terms page
create or replace function public.vp_public_sms_info(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'dealership', d.name,
    'website', d.website,
    'phone', mp.twilio_phone_number,
    'sms_enabled', coalesce(mp.sms_enabled, false),
    'consent_language', coalesce(nullif(mp.consent_language, ''),
      'By checking this box, I agree to receive text messages from ' || d.name ||
      ' about my vehicle inquiry at the number provided. Message frequency varies. Msg & data rates may apply. ' ||
      'Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.'),
    'help_message', coalesce(nullif(mp.help_message, ''),
      d.name || ': for help call ' || coalesce(d.phone, 'the dealership') || '. Msg & data rates may apply. Reply STOP to opt out.'))
  from public.dealerships d
  left join public.messaging_profiles mp on mp.dealership_id = d.id
  where d.slug = p_slug
$$;
grant execute on function public.vp_public_sms_info(text) to anon, authenticated;

-- ===== supabase/seed.sql =====
-- Seed: New Smyrna Beach Chevrolet + the 2018 Jeep Wrangler from the prototype packet.
-- Safe to run more than once.

insert into public.dealerships (slug, name, phone, sms_phone, website, address_line, city, state, zip, hours,
                                logo_url, brand_primary, brand_accent, default_fees_note)
values ('nsbchevy', 'New Smyrna Beach Chevrolet', '(386) 427-1313', '(386) 427-1313',
        'https://www.newsmyrnachevy.com', '2375 State Road 44', 'New Smyrna Beach', 'FL', '32168',
        'Mon to Sat 9am to 8pm, Sun 11am to 6pm',
        '/seed/nsb-logo.png', '#013C9E', '#F4BC00',
        'Plus $399 computerized vehicle registration fee and $998 documentation fee.')
on conflict (slug) do nothing;

insert into public.staff (dealership_id, full_name, title, phone, photo_url)
select d.id, 'Kyleigh Johnson', 'Sales Consultant', '(386) 427-1313', '/seed/kyleigh-johnson.jpg'
from public.dealerships d
where d.slug = 'nsbchevy'
  and not exists (select 1 from public.staff s where s.dealership_id = d.id and s.full_name = 'Kyleigh Johnson');

insert into public.vehicles (dealership_id, status, condition, stock_number, vin, year, make, model, trim,
  body_style, exterior_color, interior_color, engine, transmission, drivetrain, fuel_type, mileage,
  price, price_label, fees_note, listing_url, salesperson_id, features, created_by)
select d.id, 'published', 'used', 'R287418B', '1C4GJXAG5JW150863', 2018, 'Jeep', 'Wrangler', 'Sport S',
  'SUV', 'Black Clearcoat', 'Black Cloth', '3.6L V6 24V VVT UPG I w/ESS', '8-Speed Automatic',
  'Four Wheel Drive', 'Gasoline', 81273, 17800, 'Live Market Price',
  'Plus $399 computerized vehicle registration fee and $998 documentation fee. Final price: $19,197.',
  'https://www.newsmyrnachevy.com/inventory/used-2018-jeep-wrangler-sport-s-four-wheel-drive-suv-1c4gjxag5jw150863/',
  (select s.id from public.staff s where s.dealership_id = d.id and s.full_name = 'Kyleigh Johnson' limit 1),
  array['Four Wheel Drive', '3.6L V6', '8-Speed Automatic'], null
from public.dealerships d
where d.slug = 'nsbchevy'
on conflict (dealership_id, vin) do nothing;

insert into public.vehicle_photos (vehicle_id, dealership_id, url, position, source)
select v.id, v.dealership_id, format('/seed/jeep-%s.jpg', lpad(n::text, 2, '0')), n - 1, 'url'
from public.vehicles v cross join generate_series(1, 32) n
where v.vin = '1C4GJXAG5JW150863'
  and not exists (select 1 from public.vehicle_photos p where p.vehicle_id = v.id);

-- Email open tracking (Resend "email.opened" events). Informational only: Apple Mail
-- privacy protection pre-loads images, so an "open" doesn't prove the customer read it.
alter table public.messages add column if not exists opened_at timestamptz;
alter table public.messages add column if not exists open_count int not null default 0;

-- FTC Used Car Rule (16 CFR Part 455) Buyers Guide data.
-- The website guide and the printed window guide both render from these columns, so they always match.
-- Warranty terms are the dealer's to supply; nothing here is ever inferred. A vehicle with no terms
-- (and no dealership default) shows the "AS IS" guide and is flagged "warranty data pending" to staff only.

alter table public.vehicles add column if not exists bg_warranty text
  check (bg_warranty in ('as_is', 'implied_only', 'dealer_warranty'));
alter table public.vehicles add column if not exists bg_warranty_type text check (bg_warranty_type in ('full', 'limited'));
alter table public.vehicles add column if not exists bg_labor_pct int check (bg_labor_pct between 0 and 100);
alter table public.vehicles add column if not exists bg_parts_pct int check (bg_parts_pct between 0 and 100);
alter table public.vehicles add column if not exists bg_deductible text;
-- [{ "system": "Engine block and cylinder heads", "duration": "30 days or 1,000 miles, whichever occurs first" }]
alter table public.vehicles add column if not exists bg_systems jsonb not null default '[]'::jsonb;
alter table public.vehicles add column if not exists bg_mfr_warranty boolean not null default false;
alter table public.vehicles add column if not exists bg_mfr_used_warranty boolean not null default false;
alter table public.vehicles add column if not exists bg_other_used_warranty boolean not null default false;
alter table public.vehicles add column if not exists bg_service_contract boolean not null default false;
alter table public.vehicles add column if not exists bg_updated_at timestamptz;
alter table public.vehicles add column if not exists bg_updated_by uuid;

alter table public.dealerships add column if not exists bg_default_warranty text
  check (bg_default_warranty in ('as_is', 'implied_only'));
alter table public.dealerships add column if not exists bg_default_service_contract boolean not null default false;
alter table public.dealerships add column if not exists bg_complaint_name text;
alter table public.dealerships add column if not exists bg_complaint_phone text;
alter table public.dealerships add column if not exists bg_signature_line boolean not null default false;

-- Shorthand such as "drive train" or "power train" is prohibited by 16 CFR 455.2(b)(2)(ii).
create or replace function public.vp_bg_shorthand(t text) returns boolean
language sql immutable as $$
  select coalesce(t, '') ~* '(drive|power)[\s-]*train';
$$;

create or replace function public.vp_bg_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s jsonb;
  changed boolean;
begin
  changed := (tg_op = 'INSERT' and (new.bg_warranty is not null or new.bg_systems <> '[]'::jsonb)) or
    (tg_op = 'UPDATE' and
    (new.bg_warranty, new.bg_warranty_type, new.bg_labor_pct, new.bg_parts_pct, new.bg_deductible, new.bg_systems,
     new.bg_mfr_warranty, new.bg_mfr_used_warranty, new.bg_other_used_warranty, new.bg_service_contract)
    is distinct from
    (old.bg_warranty, old.bg_warranty_type, old.bg_labor_pct, old.bg_parts_pct, old.bg_deductible, old.bg_systems,
     old.bg_mfr_warranty, old.bg_mfr_used_warranty, old.bg_other_used_warranty, old.bg_service_contract));
  if not changed then return new; end if;

  -- Warranty terms are a legal disclosure: only dealership admins (or the server) may change them.
  if tg_op = 'UPDATE' and auth.uid() is not null and not public.vp_is_admin(new.dealership_id) then
    raise exception 'Only dealership admins can change Buyers Guide warranty terms';
  end if;

  if jsonb_typeof(new.bg_systems) is distinct from 'array' then
    raise exception 'Covered systems must be a list';
  end if;
  if new.bg_warranty = 'dealer_warranty' then
    if new.bg_warranty_type is null then raise exception 'Choose FULL or LIMITED for the dealer warranty'; end if;
    if new.bg_warranty_type = 'limited' and (new.bg_labor_pct is null or new.bg_parts_pct is null) then
      raise exception 'Enter the percentage of labor and parts the dealer will pay';
    end if;
    if jsonb_array_length(new.bg_systems) = 0 then raise exception 'List at least one covered system'; end if;
    for s in select * from jsonb_array_elements(new.bg_systems) loop
      if coalesce(trim(s->>'system'), '') = '' or coalesce(trim(s->>'duration'), '') = '' then
        raise exception 'Every covered system needs a name and a duration';
      end if;
      if public.vp_bg_shorthand(s->>'system') then
        raise exception 'Name each covered system specifically. Shorthand like "drive train" or "power train" is not allowed (16 CFR 455.2)';
      end if;
    end loop;
    if new.bg_warranty_type = 'full' then
      new.bg_labor_pct := 100; new.bg_parts_pct := 100;
    end if;
  else
    -- No dealer warranty: clear dealer-warranty terms so they can never show by mistake.
    new.bg_warranty_type := null; new.bg_labor_pct := null; new.bg_parts_pct := null;
    new.bg_deductible := null; new.bg_systems := '[]'::jsonb;
  end if;

  new.bg_updated_at := now();
  new.bg_updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists vp_bg_validate on public.vehicles;
create trigger vp_bg_validate before insert or update on public.vehicles
  for each row execute function public.vp_bg_validate();

-- ===== supabase/migrations/0005_chomes.sql =====
-- CHOMES vehicle story (Condition, History, Old, Miles, Equipment, Supply & demand).
-- Framework by Jonathan Dawson and Sellchology. Phase 1: data model + team entry.
--
-- One record per used / certified vehicle (vehicles are unique per dealership + VIN).
-- This table is TEAM ONLY: it holds recon cost, acquisition notes and pricing notes, so it is
-- never readable by the public, unlike `vehicles`, which anyone can read once published.
--
-- Old / Miles / Equipment basics are NOT copied here. They stay on the vehicle record
-- (year, mileage, trim, drivetrain, engine), so the CHOMES story and the customer page can never
-- show two different odometers. What this table adds is *where each value came from*:
-- `provenance` = { "<field>": { "source": "...", "by": uuid|null, "by_name": text|null, "at": timestamptz } }
-- Sources: staff, inventory_feed, vin_decode, listing_import, system, existing_record (backfill).
-- A server job may set `vp.source` for the transaction to label its writes (e.g. 'vauto' in phase 2).

create table if not exists public.vehicle_chomes (
  vehicle_id              uuid primary key references public.vehicles(id) on delete cascade,
  dealership_id           uuid not null references public.dealerships(id) on delete cascade,
  -- C: Condition (manual, at the store)
  overall_grade           text check (overall_grade in ('excellent', 'good', 'fair')),
  strengths               text,
  wear_items              text,
  needed_work             text,
  recon_cost              numeric(10,2) check (recon_cost >= 0),
  inspected_by            text,
  inspection_date         date,
  -- H: History (phase 1: keyed in by hand from the report)
  report_provider         text check (report_provider in ('carfax', 'autocheck')),
  accidents_count         int check (accidents_count >= 0),
  accidents_summary       text,
  service_records         int check (service_records >= 0),
  prior_owners            int check (prior_owners >= 0),
  title_issues            boolean,
  title_issue_detail      text,
  open_recalls            int check (open_recalls >= 0),
  history_report_path     text,          -- private "internal" bucket, never public
  history_report_name     text,
  -- O: Old (model year comes from the vehicle record)
  generation_note         text,
  -- E: Equipment (trim / drivetrain / engine come from the vehicle record)
  options_packages        text[] not null default '{}',
  highlight_features      text[] not null default '{}',
  -- S: Supply and demand (manual until the vAuto pipeline lands)
  price_to_market_pct     numeric(6,1) check (price_to_market_pct between 0 and 300),
  market_days_supply      int check (market_days_supply >= 0),
  comparable_units_nearby int check (comparable_units_nearby >= 0),
  demand_note             text,
  -- internal only
  acquisition_notes       text,
  -- bookkeeping
  provenance              jsonb not null default '{}'::jsonb,
  -- FTC consistency (spec section 4): Condition must agree with the Buyers Guide. A Fair grade,
  -- needed work or a title issue sends the record to human review before any customer story publishes.
  review_required         boolean generated always as (
                            overall_grade = 'fair'
                            or coalesce(btrim(needed_work), '') <> ''
                            or coalesce(title_issues, false)) stored,
  review_cleared_at       timestamptz,
  review_cleared_by       uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid
);
create index if not exists vehicle_chomes_dealership_idx on public.vehicle_chomes(dealership_id);

-- (before-triggers run in name order: inherit the dealership first, then validate)
drop trigger if exists vp_chomes_a_inherit on public.vehicle_chomes;
create trigger vp_chomes_a_inherit before insert or update on public.vehicle_chomes
  for each row execute function public.vp_inherit_dealership();
drop trigger if exists vp_chomes_touch on public.vehicle_chomes;
create trigger vp_chomes_touch before update on public.vehicle_chomes
  for each row execute function public.vp_touch_updated_at();

-- Who is making this change, for provenance.
create or replace function public.vp_actor(d uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'by', auth.uid(),
    'by_name', case when auth.uid() is null then null else coalesce(
      (select s.full_name from public.staff s where s.dealership_id = d and s.user_id = auth.uid() limit 1),
      (select u.email::text from auth.users u where u.id = auth.uid())) end,
    'at', now())
$$;

create or replace function public.vp_chomes_source(default_source text) returns text
language sql stable as $$
  select coalesce(nullif(current_setting('vp.source', true), ''),
                  case when auth.uid() is null then default_source else 'staff' end)
$$;

-- Validate and stamp provenance on every CHOMES write.
create or replace function public.vp_chomes_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n jsonb;
  stamp jsonb;
  f text;
  changed text[] := '{}';
  tracked constant text[] := array[
    'overall_grade', 'strengths', 'wear_items', 'needed_work', 'recon_cost', 'inspected_by', 'inspection_date',
    'report_provider', 'accidents_count', 'accidents_summary', 'service_records', 'prior_owners', 'title_issues',
    'title_issue_detail', 'open_recalls', 'history_report_path', 'generation_note', 'options_packages',
    'highlight_features', 'price_to_market_pct', 'market_days_supply', 'comparable_units_nearby', 'demand_note',
    'acquisition_notes'];
  review_fields constant text[] := array['overall_grade', 'wear_items', 'needed_work', 'title_issues', 'title_issue_detail'];
begin
  -- Provenance is written only by these triggers. Staff can't forge where a value came from.
  if auth.uid() is not null and coalesce(current_setting('vp.internal', true), '') <> '1' then
    new.provenance := case when tg_op = 'UPDATE' then old.provenance else '{}'::jsonb end;
  end if;

  -- blank text means "not entered"
  new.strengths := nullif(btrim(new.strengths), '');
  new.wear_items := nullif(btrim(new.wear_items), '');
  new.needed_work := nullif(btrim(new.needed_work), '');
  new.inspected_by := nullif(btrim(new.inspected_by), '');
  new.accidents_summary := nullif(btrim(new.accidents_summary), '');
  new.title_issue_detail := nullif(btrim(new.title_issue_detail), '');
  new.generation_note := nullif(btrim(new.generation_note), '');
  new.demand_note := nullif(btrim(new.demand_note), '');
  new.acquisition_notes := nullif(btrim(new.acquisition_notes), '');
  new.options_packages := coalesce(array(select btrim(x) from unnest(new.options_packages) x where btrim(x) <> ''), '{}');
  new.highlight_features := coalesce(array(select btrim(x) from unnest(new.highlight_features) x where btrim(x) <> ''), '{}');

  if cardinality(new.highlight_features) > 5 then
    raise exception 'Pick at most five highlight features (the ones a salesperson would actually mention)';
  end if;
  if new.inspection_date > current_date then
    raise exception 'Inspection date can''t be in the future';
  end if;
  if coalesce(new.accidents_count, 0) > 0 and new.accidents_summary is null then
    raise exception 'Add a one-line summary of the reported accident(s)';
  end if;
  if new.accidents_count = 0 and new.accidents_summary is null then
    new.accidents_summary := 'No accidents reported';
  end if;
  if new.title_issues then
    if new.title_issue_detail is null then raise exception 'Describe the title issue'; end if;
  else
    new.title_issue_detail := null;
  end if;

  n := to_jsonb(new);
  foreach f in array tracked loop
    if (n -> f) is distinct from (o -> f) and not (tg_op = 'INSERT' and (n -> f) in ('null'::jsonb, '[]'::jsonb)) then
      changed := changed || f;
    end if;
  end loop;

  if cardinality(changed) > 0 then
    stamp := public.vp_actor(new.dealership_id) || jsonb_build_object('source', public.vp_chomes_source('system'));
    foreach f in array changed loop
      new.provenance := jsonb_set(coalesce(new.provenance, '{}'::jsonb), array[f], stamp);
    end loop;
    new.updated_by := auth.uid();
  end if;

  -- A cleared FTC review only holds for the facts that were reviewed.
  if tg_op = 'UPDATE' and changed && review_fields then
    new.review_cleared_at := null;
    new.review_cleared_by := null;
  end if;
  if tg_op = 'UPDATE' and new.review_cleared_at is distinct from old.review_cleared_at and new.review_cleared_at is not null then
    if auth.uid() is not null and not public.vp_is_admin(new.dealership_id) then
      raise exception 'Only dealership admins can clear the FTC consistency review';
    end if;
    new.review_cleared_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists vp_chomes_before_write on public.vehicle_chomes;
create trigger vp_chomes_before_write before insert or update on public.vehicle_chomes
  for each row execute function public.vp_chomes_before_write();

-- Every used / certified vehicle gets a CHOMES record, and every change to the vehicle fields CHOMES
-- reads (model year, odometer, trim, drivetrain, engine) is stamped with where it came from.
create or replace function public.vp_chomes_track_vehicle() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pairs constant text[][] := array[
    ['model_year', 'year'], ['odometer', 'mileage'], ['trim', 'trim'], ['drivetrain', 'drivetrain'], ['engine', 'engine']];
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n jsonb := to_jsonb(new);
  prov jsonb := '{}'::jsonb;
  stamp jsonb;
  src text;
  i int;
begin
  if new.condition = 'new' and not exists (select 1 from public.vehicle_chomes c where c.vehicle_id = new.id) then
    return null;
  end if;
  -- (the feed stamps feed_seen_at on every row it writes, including manual vehicles it matches by VIN)
  src := case
    when tg_op = 'INSERT' and new.source = 'import' then 'listing_import'
    when tg_op = 'INSERT' and new.source = 'feed' then 'inventory_feed'
    when tg_op = 'UPDATE' and new.feed_seen_at is distinct from old.feed_seen_at then 'inventory_feed'
    else 'system' end;
  stamp := public.vp_actor(new.dealership_id) || jsonb_build_object('source', public.vp_chomes_source(src));
  for i in 1 .. array_length(pairs, 1) loop
    if (n -> pairs[i][2]) is distinct from (o -> pairs[i][2]) and (n -> pairs[i][2]) <> 'null'::jsonb then
      prov := prov || jsonb_build_object(pairs[i][1], stamp);
    end if;
  end loop;

  perform set_config('vp.internal', '1', true);
  insert into public.vehicle_chomes (vehicle_id, dealership_id, provenance)
  values (new.id, new.dealership_id, prov)
  on conflict (vehicle_id) do update set provenance = public.vehicle_chomes.provenance || excluded.provenance
    where excluded.provenance <> '{}'::jsonb;
  perform set_config('vp.internal', '', true);
  return null;
end $$;

drop trigger if exists vp_chomes_track_vehicle on public.vehicles;
create trigger vp_chomes_track_vehicle after insert or update of year, mileage, trim, drivetrain, engine, condition
  on public.vehicles for each row execute function public.vp_chomes_track_vehicle();

-- Fill a vehicle's empty basics from a VIN decode, labelled as such in CHOMES provenance.
-- Runs as the caller, so row level security still decides who can change which vehicle.
create or replace function public.vp_vehicle_apply_decode(p_vehicle_id uuid, p_fields jsonb)
returns public.vehicles
language plpgsql security invoker set search_path = public as $$
declare
  v public.vehicles;
begin
  perform set_config('vp.source', 'vin_decode', true);
  update public.vehicles set
    year         = coalesce(year, nullif(p_fields->>'year', '')::int),
    make         = coalesce(make, nullif(p_fields->>'make', '')),
    model        = coalesce(model, nullif(p_fields->>'model', '')),
    trim         = coalesce(trim, nullif(p_fields->>'trim', '')),
    body_style   = coalesce(body_style, nullif(p_fields->>'body_style', '')),
    drivetrain   = coalesce(drivetrain, nullif(p_fields->>'drivetrain', '')),
    engine       = coalesce(engine, nullif(p_fields->>'engine', '')),
    transmission = coalesce(transmission, nullif(p_fields->>'transmission', '')),
    fuel_type    = coalesce(fuel_type, nullif(p_fields->>'fuel_type', '')),
    mpg_city     = coalesce(mpg_city, nullif(p_fields->>'mpg_city', '')::int),
    mpg_hwy      = coalesce(mpg_hwy, nullif(p_fields->>'mpg_hwy', '')::int)
  where id = p_vehicle_id
  returning * into v;
  perform set_config('vp.source', '', true);
  if v.id is null then raise exception 'Vehicle not found'; end if;
  return v;
end $$;
revoke execute on function public.vp_vehicle_apply_decode(uuid, jsonb) from public, anon;
revoke execute on function public.vp_actor(uuid) from public, anon;
grant execute on function public.vp_vehicle_apply_decode(uuid, jsonb) to authenticated, service_role;

-- Backfill: a CHOMES record for every used / certified vehicle that already exists.
insert into public.vehicle_chomes (vehicle_id, dealership_id, provenance)
select v.id, v.dealership_id,
  (select coalesce(jsonb_object_agg(k, jsonb_build_object(
      'source', case when v.source = 'feed' then 'inventory_feed' else 'existing_record' end,
      'by', null, 'by_name', null, 'at', coalesce(v.feed_seen_at, v.updated_at))), '{}'::jsonb)
   from (values ('model_year', v.year::text), ('odometer', v.mileage::text), ('trim', v.trim),
                ('drivetrain', v.drivetrain), ('engine', v.engine)) as t(k, val)
   where val is not null)
from public.vehicles v
where v.condition in ('used', 'certified')
on conflict (vehicle_id) do nothing;

-- Row level security: staff of the dealership only. Nothing here is ever public.
alter table public.vehicle_chomes enable row level security;
revoke all on public.vehicle_chomes from anon;
drop policy if exists chomes_read on public.vehicle_chomes;
drop policy if exists chomes_insert on public.vehicle_chomes;
drop policy if exists chomes_update on public.vehicle_chomes;
drop policy if exists chomes_delete on public.vehicle_chomes;
create policy chomes_read on public.vehicle_chomes for select using (public.vp_is_member(dealership_id));
create policy chomes_insert on public.vehicle_chomes for insert with check (public.vp_is_member(dealership_id));
create policy chomes_update on public.vehicle_chomes for update
  using (public.vp_is_member(dealership_id)) with check (public.vp_is_member(dealership_id));
create policy chomes_delete on public.vehicle_chomes for delete using (public.vp_is_admin(dealership_id));

-- Private storage for history reports (CARFAX / AutoCheck PDFs). Opened with short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit)
values ('internal', 'internal', false, 26214400)
on conflict (id) do nothing;

drop policy if exists vp_internal_read on storage.objects;
drop policy if exists vp_internal_insert on storage.objects;
drop policy if exists vp_internal_delete on storage.objects;
create policy vp_internal_read on storage.objects for select to authenticated
  using (bucket_id = 'internal' and public.vp_is_member_path(name));
create policy vp_internal_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'internal' and public.vp_is_member_path(name));
create policy vp_internal_delete on storage.objects for delete to authenticated
  using (bucket_id = 'internal' and public.vp_is_member_path(name));

-- ===== supabase/migrations/0006_window_stickers.sql =====
-- Window stickers: the dealer's own window sticker (with a pricing stack) and the original factory sticker.
-- Safe to run more than once.

-- Pricing stack: how the dealer gets from a starting price to the selling price.
--   price_stack_base        the starting figure, e.g. MSRP 52,495 or a retail price
--   price_stack_base_label  what that figure is called on the sticker ("MSRP", "Retail price")
--   price_stack             [{ "kind": "discount"|"rebate"|"addon", "label": "...", "amount": -1500, "note": "..." }]
-- Discounts and rebates are negative, add-ons positive. A rebate must say who qualifies (note).
-- The sticker shows the stack only while base + adjustments = vehicles.price. If the price changes (for example
-- the hourly feed), the stack stops printing and staff are told to update it; a stale stack is never shown.
alter table public.vehicles add column if not exists price_stack jsonb not null default '[]'::jsonb;
alter table public.vehicles add column if not exists price_stack_base numeric(12,2) check (price_stack_base >= 0);
alter table public.vehicles add column if not exists price_stack_base_label text;

create or replace function public.vp_price_stack_validate() returns trigger
language plpgsql as $$
declare
  i jsonb;
  amt numeric;
begin
  if tg_op = 'UPDATE' and (new.price_stack, new.price_stack_base, new.price_stack_base_label)
     is not distinct from (old.price_stack, old.price_stack_base, old.price_stack_base_label) then
    return new;
  end if;
  if jsonb_typeof(new.price_stack) is distinct from 'array' then raise exception 'The pricing stack must be a list'; end if;
  new.price_stack_base_label := nullif(btrim(new.price_stack_base_label), '');
  if jsonb_array_length(new.price_stack) = 0 then return new; end if;
  if new.price_stack_base is null then raise exception 'Enter the starting price for the pricing stack'; end if;
  if jsonb_array_length(new.price_stack) > 12 then raise exception 'Keep the pricing stack to 12 lines or fewer'; end if;
  for i in select * from jsonb_array_elements(new.price_stack) loop
    if coalesce(i->>'kind', '') not in ('discount', 'rebate', 'addon') then
      raise exception 'Each pricing line must be a discount, rebate or add-on';
    end if;
    if coalesce(btrim(i->>'label'), '') = '' then raise exception 'Each pricing line needs a name'; end if;
    if jsonb_typeof(i->'amount') is distinct from 'number' then raise exception 'Each pricing line needs an amount'; end if;
    amt := (i->>'amount')::numeric;
    if i->>'kind' in ('discount', 'rebate') and amt >= 0 then raise exception 'Discounts and rebates lower the price (enter them as savings)'; end if;
    if i->>'kind' = 'addon' and amt <= 0 then raise exception 'Add-ons raise the price'; end if;
    if i->>'kind' = 'rebate' and coalesce(btrim(i->>'note'), '') = '' then
      raise exception 'Say who qualifies for the "%" rebate', i->>'label';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists vp_price_stack_validate on public.vehicles;
create trigger vp_price_stack_validate before insert or update on public.vehicles
  for each row execute function public.vp_price_stack_validate();

-- Small print at the foot of every dealer window sticker (admins set it in Settings).
alter table public.dealerships add column if not exists sticker_disclaimer text;

-- Where a document came from. 'oem' = fetched from the manufacturer by VIN, 'provider' = a paid sticker service.
alter table public.vehicle_documents add column if not exists source text not null default 'upload'
  check (source in ('upload', 'link', 'oem', 'provider'));
update public.vehicle_documents set source = 'link' where source = 'upload' and storage_path is null;

-- ===== supabase/migrations/0007_factory_data.sql =====
-- Factory data from a VIN decoder (VinAudit Specifications API). Safe to run more than once.
--
-- One row per vehicle: the decoder's answer for its VIN, normalized (`data`) and as received (`raw`).
-- Staff only: it includes invoice price, which must never reach a customer. Rows are written only by the
-- server (/api/vehicle-specs), which caches them so each VIN is paid for once unless staff refresh it.
create table if not exists public.vehicle_factory_data (
  vehicle_id    uuid primary key references public.vehicles(id) on delete cascade,
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  vin           text not null,
  source        text not null default 'vinaudit' check (source in ('vinaudit')),
  data          jsonb not null,
  raw           jsonb,
  fetched_at    timestamptz not null default now(),
  fetched_by    uuid
);
create index if not exists vehicle_factory_data_dealership_idx on public.vehicle_factory_data(dealership_id);

drop trigger if exists vp_factory_inherit on public.vehicle_factory_data;
create trigger vp_factory_inherit before insert or update on public.vehicle_factory_data
  for each row execute function public.vp_inherit_dealership();

alter table public.vehicle_factory_data enable row level security;
revoke all on public.vehicle_factory_data from anon;
revoke insert, update, delete on public.vehicle_factory_data from authenticated;
drop policy if exists factory_read on public.vehicle_factory_data;
create policy factory_read on public.vehicle_factory_data for select using (public.vp_is_member(dealership_id));

-- The VIN decode fill now also covers fuel economy. Still fills only empty fields, still runs as the caller
-- (row level security decides who can change which vehicle) and labels the change "VIN decode" in CHOMES.
create or replace function public.vp_vehicle_apply_decode(p_vehicle_id uuid, p_fields jsonb)
returns public.vehicles
language plpgsql security invoker set search_path = public as $$
declare
  v public.vehicles;
begin
  perform set_config('vp.source', 'vin_decode', true);
  update public.vehicles set
    year         = coalesce(year, nullif(p_fields->>'year', '')::int),
    make         = coalesce(make, nullif(p_fields->>'make', '')),
    model        = coalesce(model, nullif(p_fields->>'model', '')),
    trim         = coalesce(trim, nullif(p_fields->>'trim', '')),
    body_style   = coalesce(body_style, nullif(p_fields->>'body_style', '')),
    drivetrain   = coalesce(drivetrain, nullif(p_fields->>'drivetrain', '')),
    engine       = coalesce(engine, nullif(p_fields->>'engine', '')),
    transmission = coalesce(transmission, nullif(p_fields->>'transmission', '')),
    fuel_type    = coalesce(fuel_type, nullif(p_fields->>'fuel_type', '')),
    mpg_city     = coalesce(mpg_city, nullif(p_fields->>'mpg_city', '')::int),
    mpg_hwy      = coalesce(mpg_hwy, nullif(p_fields->>'mpg_hwy', '')::int)
  where id = p_vehicle_id
  returning * into v;
  perform set_config('vp.source', '', true);
  if v.id is null then raise exception 'Vehicle not found'; end if;
  return v;
end $$;
revoke execute on function public.vp_vehicle_apply_decode(uuid, jsonb) from public, anon;
grant execute on function public.vp_vehicle_apply_decode(uuid, jsonb) to authenticated, service_role;

-- ===== supabase/migrations/0008_warranty_program.sql =====
-- Dealer warranty program (for example the NSB "Lifetime Limited Powertrain Warranty"). Safe to run more than once.
--
-- The program's terms are set once per dealership (Settings → Buyers Guide). An admin then applies them to the
-- cars that qualify, after reviewing the list; nothing is inferred from a description on its own. Applying writes
-- the car's FTC Buyers Guide fields (dealer warranty, limited, %, deductible, named systems and durations) and
-- records the program on the car, so the dealer window sticker can mention it.
--
-- bg_program = { "name": "...", "match": "lifetime powertrain warranty", "labor_pct": 100, "parts_pct": 100,
--                "deductible": "...", "systems": [{ "system": "...", "duration": "..." }], "sticker_line": "..." }
alter table public.dealerships add column if not exists bg_program jsonb;
alter table public.vehicles add column if not exists bg_program text;

create or replace function public.vp_bg_program_validate() returns trigger
language plpgsql as $$
declare
  p jsonb := new.bg_program;
  s jsonb;
begin
  if p is null or (tg_op = 'UPDATE' and p is not distinct from old.bg_program) then return new; end if;
  if auth.uid() is not null and not public.vp_is_admin(new.id) then
    raise exception 'Only dealership admins can change the warranty program';
  end if;
  if coalesce(btrim(p->>'name'), '') = '' then raise exception 'Name the warranty program'; end if;
  if coalesce(btrim(p->>'match'), '') = '' then raise exception 'Enter the words to look for in vehicle descriptions'; end if;
  if jsonb_typeof(p->'labor_pct') is distinct from 'number' or jsonb_typeof(p->'parts_pct') is distinct from 'number'
     or (p->>'labor_pct')::numeric not between 0 and 100 or (p->>'parts_pct')::numeric not between 0 and 100 then
    raise exception 'Enter the %% of labor and parts the dealer pays (0 to 100)';
  end if;
  if jsonb_typeof(p->'systems') is distinct from 'array' or jsonb_array_length(p->'systems') = 0 then
    raise exception 'List at least one covered system';
  end if;
  for s in select * from jsonb_array_elements(p->'systems') loop
    if coalesce(btrim(s->>'system'), '') = '' or coalesce(btrim(s->>'duration'), '') = '' then
      raise exception 'Every covered system needs a name and a duration';
    end if;
    if public.vp_bg_shorthand(s->>'system') then
      raise exception 'Name each covered system specifically. Shorthand like "drive train" or "power train" is not allowed (16 CFR 455.2)';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists vp_bg_program_validate on public.dealerships;
create trigger vp_bg_program_validate before insert or update on public.dealerships
  for each row execute function public.vp_bg_program_validate();

-- On a vehicle, the program label is part of the warranty disclosure: admins only, and it only stands while the
-- Buyers Guide actually shows a dealer warranty.
create or replace function public.vp_bg_program_guard() returns trigger
language plpgsql as $$
begin
  if new.bg_warranty is distinct from 'dealer_warranty' then new.bg_program := null; end if;
  if tg_op = 'UPDATE' and new.bg_program is distinct from old.bg_program and new.bg_program is not null
     and auth.uid() is not null and not public.vp_is_admin(new.dealership_id) then
    raise exception 'Only dealership admins can apply a warranty program';
  end if;
  return new;
end $$;

drop trigger if exists vp_bg_program_guard on public.vehicles;
create trigger vp_bg_program_guard before insert or update on public.vehicles
  for each row execute function public.vp_bg_program_guard();

-- Apply the dealership's program to the chosen used / certified vehicles. Runs as the caller: row level security
-- and the Buyers Guide rules (admins only, specific systems, % required) all still apply.
create or replace function public.vp_apply_bg_program(p_vehicle_ids uuid[])
returns int
language plpgsql security invoker set search_path = public as $$
declare
  d uuid;
  p jsonb;
  n int;
begin
  select v.dealership_id into d from public.vehicles v where v.id = any(p_vehicle_ids) limit 1;
  if d is null then return 0; end if;
  if (select count(distinct v.dealership_id) from public.vehicles v where v.id = any(p_vehicle_ids)) > 1 then
    raise exception 'Apply the program one dealership at a time';
  end if;
  if not public.vp_is_admin(d) then raise exception 'Only dealership admins can apply a warranty program'; end if;
  select bg_program into p from public.dealerships where id = d;
  if p is null then raise exception 'Set up the warranty program in Settings first'; end if;
  update public.vehicles set
    bg_warranty = 'dealer_warranty', bg_warranty_type = 'limited',
    bg_labor_pct = (p->>'labor_pct')::int, bg_parts_pct = (p->>'parts_pct')::int,
    bg_deductible = nullif(btrim(p->>'deductible'), ''), bg_systems = p->'systems',
    bg_program = p->>'name'
  where id = any(p_vehicle_ids) and dealership_id = d and condition in ('used', 'certified');
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.vp_apply_bg_program(uuid[]) from public, anon;
grant execute on function public.vp_apply_bg_program(uuid[]) to authenticated;

-- ===== supabase/migrations/0009_photographer.sql =====
-- Photographer logins. Safe to run more than once.
--
-- A photographer (staff or an outside lot-photo service) signs in on a phone, enters a stock number and shoots;
-- each photo uploads to that car. They can find the dealership's vehicles and add photos, and nothing else:
-- vp_is_member() no longer counts them, so every existing policy (prices, leads, customers, messages, CHOMES,
-- factory data, settings) stays closed to them, and the server functions' role checks reject them too.

alter table public.dealership_members drop constraint if exists dealership_members_role_check;
alter table public.dealership_members add constraint dealership_members_role_check
  check (role in ('owner', 'admin', 'sales', 'photographer'));

create or replace function public.vp_is_member(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_platform_admin() or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid()
      and m.role <> 'photographer')
$$;

-- Anyone who may add photos for a dealership: its staff and its photographers.
create or replace function public.vp_can_shoot(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_platform_admin() or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid())
$$;

-- Who uploaded each photo, so a photographer can remove only their own.
alter table public.vehicle_photos add column if not exists uploaded_by uuid default auth.uid();

drop policy if exists vehicles_shoot_read on public.vehicles;
create policy vehicles_shoot_read on public.vehicles for select using (public.vp_can_shoot(dealership_id));

drop policy if exists photos_shoot_read on public.vehicle_photos;
drop policy if exists photos_shoot_insert on public.vehicle_photos;
drop policy if exists photos_shoot_delete on public.vehicle_photos;
create policy photos_shoot_read on public.vehicle_photos for select using (public.vp_can_shoot(dealership_id));
create policy photos_shoot_insert on public.vehicle_photos for insert
  with check (public.vp_can_shoot(dealership_id) and source = 'upload' and uploaded_by is not distinct from auth.uid());
create policy photos_shoot_delete on public.vehicle_photos for delete
  using (public.vp_can_shoot(dealership_id) and uploaded_by = auth.uid());

-- Storage: photographers may upload only vehicle photos ("<dealership>/vehicles/<vehicle>/<file>").
create or replace function public.vp_can_shoot_path(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := string_to_array(object_name, '/');
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if array_length(parts, 1) <> 4 or parts[2] <> 'vehicles' or parts[1] !~ uuid_re or parts[3] !~ uuid_re
     or parts[4] !~* '^[0-9a-f-]{36}\.(jpe?g|png|webp|heic|heif)$' then
    return false;
  end if;
  return public.vp_can_shoot(parts[1]::uuid)
    and exists (select 1 from public.vehicles v where v.id = parts[3]::uuid and v.dealership_id = parts[1]::uuid);
end $$;

drop policy if exists vp_media_shoot_insert on storage.objects;
create policy vp_media_shoot_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.vp_can_shoot_path(name));

-- ===== supabase/migrations/0010_photographer_print.sql =====
-- Photographers print window stickers and Buyers Guides. Safe to run more than once.
--
-- The dealer window sticker needs two things a photographer can't read or write directly: the CHOMES facts that
-- print on the window (CHOMES also holds recon cost and notes) and the car's tracked QR link. These two functions
-- hand over exactly that, to anyone allowed to shoot the dealership's cars, and nothing more.

-- The customer-safe part of a car's CHOMES record: what stickerStory() prints. Never recon cost, acquisition notes,
-- the demand note, inspector or provenance.
create or replace function public.vp_sticker_chomes(p_vehicle_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'highlight_features', c.highlight_features, 'options_packages', c.options_packages,
    'report_provider', c.report_provider, 'prior_owners', c.prior_owners, 'accidents_count', c.accidents_count,
    'accidents_summary', c.accidents_summary, 'service_records', c.service_records,
    'title_issues', c.title_issues, 'title_issue_detail', c.title_issue_detail, 'generation_note', c.generation_note,
    'review_required', c.review_required, 'review_cleared_at', c.review_cleared_at)
  from public.vehicle_chomes c
  where c.vehicle_id = p_vehicle_id and public.vp_can_shoot(c.dealership_id)
$$;
revoke execute on function public.vp_sticker_chomes(uuid) from public, anon;
grant execute on function public.vp_sticker_chomes(uuid) to authenticated;

-- The car's QR window link (the same tracked link the QR window card uses), created on first use.
create or replace function public.vp_qr_share(p_vehicle_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v public.vehicles;
  c text;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if v.id is null or not public.vp_can_shoot(v.dealership_id) then raise exception 'Vehicle not found'; end if;
  select code into c from public.shares where vehicle_id = v.id and channel = 'qr' order by created_at limit 1;
  if c is null then
    insert into public.shares (vehicle_id, dealership_id, channel, customer_name, created_by)
    values (v.id, v.dealership_id, 'qr', 'QR window card', auth.uid())
    returning code into c;
  end if;
  return c;
end $$;
revoke execute on function public.vp_qr_share(uuid) from public, anon;
grant execute on function public.vp_qr_share(uuid) to authenticated;

-- ===== supabase/migrations/0011_photo_workflow.sql =====
-- Photo workflow (replacing SlipStream): who may change photos, captions, and the photo standard. Safe to run twice.
--
-- Only photographers and dealership admins upload, caption, reorder or delete photos. Salespeople can see them.
-- One exception: anyone on staff adding a vehicle from a listing URL may bring that listing's photos along
-- (source 'import'), so "Add vehicle" keeps working for sales.

create or replace function public.vp_can_edit_photos(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_admin(d) or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid() and m.role = 'photographer')
$$;

alter table public.vehicle_photos add column if not exists caption text check (caption is null or length(caption) <= 200);

drop policy if exists photos_write on public.vehicle_photos;
drop policy if exists photos_shoot_insert on public.vehicle_photos;
drop policy if exists photos_shoot_delete on public.vehicle_photos;
drop policy if exists photos_edit_insert on public.vehicle_photos;
drop policy if exists photos_edit_update on public.vehicle_photos;
drop policy if exists photos_edit_delete on public.vehicle_photos;
drop policy if exists photos_import_insert on public.vehicle_photos;
create policy photos_edit_insert on public.vehicle_photos for insert
  with check (public.vp_can_edit_photos(dealership_id) and (source <> 'upload' or uploaded_by is not distinct from auth.uid()));
create policy photos_edit_update on public.vehicle_photos for update
  using (public.vp_can_edit_photos(dealership_id)) with check (public.vp_can_edit_photos(dealership_id));
create policy photos_edit_delete on public.vehicle_photos for delete
  using (public.vp_can_edit_photos(dealership_id));
create policy photos_import_insert on public.vehicle_photos for insert
  with check (public.vp_is_member(dealership_id) and source = 'import');

-- Storage: only photo editors may upload vehicle photos (documents and logos keep their own rules).
drop policy if exists vp_media_shoot_insert on storage.objects;
create or replace function public.vp_can_shoot_path(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := string_to_array(object_name, '/');
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if array_length(parts, 1) <> 4 or parts[2] <> 'vehicles' or parts[1] !~ uuid_re or parts[3] !~ uuid_re
     or parts[4] !~* '^[0-9a-f-]{36}\.(jpe?g|png|webp|heic|heif)$' then
    return false;
  end if;
  return public.vp_can_edit_photos(parts[1]::uuid)
    and exists (select 1 from public.vehicles v where v.id = parts[3]::uuid and v.dealership_id = parts[1]::uuid);
end $$;
create policy vp_media_shoot_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.vp_can_shoot_path(name));

-- The photo standard the merchandising audit scores against.
alter table public.dealerships add column if not exists photo_min int not null default 6 check (photo_min between 1 and 100);

-- Photo editors may also remove the files of photos they delete.
drop policy if exists vp_media_shoot_delete on storage.objects;
create policy vp_media_shoot_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.vp_can_shoot_path(name));

-- Equipment lists for the window sticker: the factory data's equipment, never its pricing (invoice), for anyone
-- who may print the car's sticker (staff and photographers).
create or replace function public.vp_sticker_equipment(p_vehicle_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('features', f.data->'features', 'optional', f.data->'optional', 'chassis', f.data->'chassis', 'as_built', f.data->'as_built')
  from public.vehicle_factory_data f
  where f.vehicle_id = p_vehicle_id and public.vp_can_shoot(f.dealership_id)
$$;
revoke execute on function public.vp_sticker_equipment(uuid) from public, anon;
grant execute on function public.vp_sticker_equipment(uuid) to authenticated;

-- ===== supabase/migrations/0012_vehicle_banners.sql =====
-- Photo banners by year, make and model. Safe to run more than once.
--
-- A dealership admin sets a rule ("2024 to 2026 Chevrolet Silverado 1500: 0% APR FOR 72 MONTHS") and the banner shows
-- across the bottom of the first photo of every matching car, on the vehicle page and the inventory grid. Blank
-- year, make or model means "any". The Lifetime Warranty banner keeps the top of the photo.

create table if not exists public.dealership_banners (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  text          text not null check (length(btrim(text)) between 1 and 40),
  note          text check (note is null or length(note) <= 80),
  year_from     int check (year_from is null or year_from between 1900 and 2100),
  year_to       int check (year_to is null or year_to between 1900 and 2100),
  make          text check (make is null or length(make) <= 40),
  model         text check (model is null or length(model) <= 60),
  condition     text not null default 'any' check (condition in ('any', 'new', 'used')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check (year_from is null or year_to is null or year_from <= year_to)
);
create index if not exists dealership_banners_dealer on public.dealership_banners (dealership_id);

alter table public.dealership_banners enable row level security;
drop policy if exists banners_public_read on public.dealership_banners;
drop policy if exists banners_admin_read on public.dealership_banners;
drop policy if exists banners_admin_write on public.dealership_banners;
-- Shoppers see the banners that are switched on; staff and admins see all of them.
create policy banners_public_read on public.dealership_banners for select using (active);
create policy banners_admin_read on public.dealership_banners for select using (public.vp_is_member(dealership_id));
create policy banners_admin_write on public.dealership_banners for all
  using (public.vp_is_admin(dealership_id)) with check (public.vp_is_admin(dealership_id));
grant select on public.dealership_banners to anon, authenticated;
grant insert, update, delete on public.dealership_banners to authenticated;
