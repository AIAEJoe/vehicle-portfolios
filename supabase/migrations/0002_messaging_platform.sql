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
