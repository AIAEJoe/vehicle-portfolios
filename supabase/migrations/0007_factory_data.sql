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
