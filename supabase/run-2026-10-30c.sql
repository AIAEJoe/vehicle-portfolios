-- Vehicle Portfolios: dealer warranty program (Lifetime Limited Powertrain Warranty). Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0008_warranty_program.sql.

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
