-- Vehicle Portfolios: Manager role and go-live approval. Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0016_manager_role.sql.

-- Manager role and manager approval before a car goes live. Safe to run more than once.
--
-- Manager: everything a salesperson can do (vehicles, sharing, leads, inbox) plus everything a photographer can do
-- (Photos page, upload/reorder/caption/delete photos, video & 360°), and approves cars to go live. Not Settings,
-- Usage or Staff logins: those stay with admins.
--
-- Approval (Settings → Go-live approval, used and certified cars by default): only a manager or admin can publish a car
-- that hasn't been approved; publishing it records who approved it and when. Once approved, anyone on staff may take
-- it down and put it back up. Cars the inventory feed adds while approval is on arrive as drafts. Cars already live
-- are not affected.

alter table public.dealership_members drop constraint if exists dealership_members_role_check;
alter table public.dealership_members add constraint dealership_members_role_check
  check (role in ('owner', 'admin', 'manager', 'sales', 'photographer'));

create or replace function public.vp_is_manager(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_admin(d) or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid() and m.role = 'manager')
$$;

create or replace function public.vp_can_edit_photos(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.vp_is_admin(d) or exists (
    select 1 from public.dealership_members m where m.dealership_id = d and m.user_id = auth.uid() and m.role in ('photographer', 'manager'))
$$;

alter table public.dealerships add column if not exists publish_approval text not null default 'used'
  check (publish_approval in ('off', 'used', 'all'));
alter table public.vehicles add column if not exists approved_by uuid;
alter table public.vehicles add column if not exists approved_at timestamptz;

create or replace function public.vp_vehicle_publish_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  mode text;
  needs boolean;
begin
  -- approval is never carried over or written by hand
  if tg_op = 'UPDATE' then
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  else
    new.approved_by := null; new.approved_at := null;
  end if;
  if new.status <> 'published' or (tg_op = 'UPDATE' and old.status = 'published') then
    return new;
  end if;
  select publish_approval into mode from public.dealerships where id = new.dealership_id;
  needs := coalesce(mode, 'used') = 'all' or (coalesce(mode, 'used') = 'used' and new.condition <> 'new');
  if auth.uid() is null then
    -- the server: a new car from the inventory feed waits for approval; anything else (SQL editor, returning cars)
    -- is left as it is
    if needs and tg_op = 'INSERT' and new.source = 'feed' then new.status := 'draft'; end if;
    return new;
  end if;
  if public.vp_is_manager(new.dealership_id) then
    if new.approved_at is null then new.approved_by := auth.uid(); new.approved_at := now(); end if;
    return new;
  end if;
  if needs and new.approved_at is null then
    raise exception 'A manager needs to approve this car before it goes live.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists vp_vehicle_publish_gate on public.vehicles;
create trigger vp_vehicle_publish_gate before insert or update on public.vehicles
  for each row execute function public.vp_vehicle_publish_gate();
