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
