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
