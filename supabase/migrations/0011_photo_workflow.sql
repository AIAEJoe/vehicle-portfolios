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
