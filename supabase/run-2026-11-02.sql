-- Vehicle Portfolios: inventory feed safety (held imports, import history, price history). Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0017_feed_safety.sql.

-- Inventory feed safety: import history, a guard against damaged files, and price history. Safe to run twice.
--
-- Every import is logged in feed_runs with what the file contained and what changed. Before any vehicle is marked
-- sold because it's missing from a file, the import is checked: if the file is much smaller than current inventory,
-- or would remove more than the allowed share of it, or is missing key columns, the import still adds and updates
-- vehicles but removes NOTHING. It's "held", and an admin reviews the list and approves the removals (or not).
-- Files can also be marked as "incremental" (changes only), in which case missing cars are never removed.

alter table public.dealership_settings add column if not exists feed_mode text not null default 'snapshot'
  check (feed_mode in ('snapshot', 'incremental'));
alter table public.dealership_settings add column if not exists feed_max_removal_pct int not null default 15
  check (feed_max_removal_pct between 1 and 100);
alter table public.dealership_settings add column if not exists feed_alert_email text;

create table if not exists public.feed_runs (
  id             uuid primary key default gen_random_uuid(),
  dealership_id  uuid not null references public.dealerships(id) on delete cascade,
  source         text not null,
  status         text not null check (status in ('applied', 'held', 'failed', 'removals_approved', 'removals_dismissed')),
  hold_reasons   text[] not null default '{}',
  file_lines     int,
  usable_rows    int,
  columns        text[] not null default '{}',
  no_vin_rows    int not null default 0,
  duplicate_vins text[] not null default '{}',
  other_dealer_rows int not null default 0,
  active_before  int,
  would_remove   int not null default 0,
  remove_ids     uuid[] not null default '{}',     -- vehicles a held run would have marked sold
  remove_sample  jsonb not null default '[]'::jsonb, -- [{id, vin, stock_number, title}] for the review screen
  result         jsonb,                              -- inserted / updated / locked / skipped / marked_sold / photos
  file_sha256    text,
  file_path      text,                               -- copy of the file in the private "internal" bucket
  error          text,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists feed_runs_dealer on public.feed_runs (dealership_id, created_at desc);
alter table public.feed_runs enable row level security;
drop policy if exists feed_runs_read on public.feed_runs;
create policy feed_runs_read on public.feed_runs for select using (public.vp_is_member(dealership_id));
-- written by the server (service role) only; admins act on held runs through vp_feed_review()

-- What a file would do before it's applied: how many active feed vehicles exist and which ones the file doesn't list.
create or replace function public.vp_feed_preview(p_dealership_id uuid, p_vins text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  with active as (
    select id, vin, stock_number, concat_ws(' ', year, make, model, trim) as title
    from public.vehicles
    where dealership_id = p_dealership_id and source = 'feed' and not feed_locked
      and status in ('published', 'draft') and vin is not null)
  select jsonb_build_object(
    'active', (select count(*) from active),
    'missing_ids', coalesce((select jsonb_agg(id) from active where not (vin = any(p_vins))), '[]'::jsonb),
    'missing_sample', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'vin', vin, 'stock_number', stock_number, 'title', title))
      from (select * from active where not (vin = any(p_vins)) order by stock_number limit 300) s), '[]'::jsonb),
    'new', (select count(*) from unnest(p_vins) v where not exists (select 1 from public.vehicles x where x.dealership_id = p_dealership_id and x.vin = v)))
$$;
revoke execute on function public.vp_feed_preview(uuid, text[]) from public, anon, authenticated;
grant execute on function public.vp_feed_preview(uuid, text[]) to service_role;

-- An admin approves (or dismisses) the removals a held run would have made. Only vehicles still active and not seen
-- in any later import are marked sold, so approving an old hold never removes a car that has come back since.
create or replace function public.vp_feed_review(p_run_id uuid, p_approve boolean) returns int
language plpgsql security definer set search_path = public as $$
declare
  run public.feed_runs%rowtype;
  n int := 0;
begin
  select * into run from public.feed_runs where id = p_run_id;
  if not found then raise exception 'Import not found'; end if;
  if not public.vp_is_admin(run.dealership_id) then raise exception 'Only dealership admins can review held imports' using errcode = '42501'; end if;
  if run.status <> 'held' then raise exception 'This import was already reviewed'; end if;
  if p_approve then
    with gone as (
      update public.vehicles set status = 'sold', sold_reason = 'feed_missing'
      where id = any(run.remove_ids) and dealership_id = run.dealership_id and status in ('published', 'draft')
        and not feed_locked and (feed_seen_at is null or feed_seen_at <= run.created_at)
      returning 1)
    select count(*) into n from gone;
  end if;
  update public.feed_runs set status = case when p_approve then 'removals_approved' else 'removals_dismissed' end,
    reviewed_by = auth.uid(), reviewed_at = now(),
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object('approved_removals', n)
  where id = p_run_id;
  return n;
end $$;
revoke execute on function public.vp_feed_review(uuid, boolean) from public, anon;
grant execute on function public.vp_feed_review(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- price history
create table if not exists public.vehicle_price_history (
  id            bigint generated always as identity primary key,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  old_price     numeric,
  new_price     numeric,
  old_msrp      numeric,
  new_msrp      numeric,
  source        text not null check (source in ('feed', 'staff', 'initial')),
  changed_by    uuid,
  changed_at    timestamptz not null default now()
);
create index if not exists vehicle_price_history_vehicle on public.vehicle_price_history (vehicle_id, changed_at desc);
alter table public.vehicle_price_history enable row level security;
drop policy if exists price_history_read on public.vehicle_price_history;
create policy price_history_read on public.vehicle_price_history for select using (public.vp_is_member(dealership_id));

create or replace function public.vp_record_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.price is not null or new.msrp is not null then
      insert into public.vehicle_price_history (vehicle_id, dealership_id, new_price, new_msrp, source, changed_by)
      values (new.id, new.dealership_id, new.price, new.msrp, 'initial', auth.uid());
    end if;
  elsif new.price is distinct from old.price or new.msrp is distinct from old.msrp then
    insert into public.vehicle_price_history (vehicle_id, dealership_id, old_price, new_price, old_msrp, new_msrp, source, changed_by)
    values (new.id, new.dealership_id, old.price, new.price, old.msrp, new.msrp, case when auth.uid() is null then 'feed' else 'staff' end, auth.uid());
  end if;
  return null;
end $$;
drop trigger if exists vp_record_price_change on public.vehicles;
create trigger vp_record_price_change after insert or update of price, msrp on public.vehicles
  for each row execute function public.vp_record_price_change();
