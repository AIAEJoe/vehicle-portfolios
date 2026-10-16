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
