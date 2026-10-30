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
