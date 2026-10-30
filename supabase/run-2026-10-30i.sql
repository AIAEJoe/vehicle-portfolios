-- Vehicle Portfolios: walkaround video, exterior 360° spin and interior 360° photos. Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0014_vehicle_media.sql.

-- Walkaround videos, exterior 360° spins and interior 360° photos. Safe to run more than once.
--
-- One row per item. A video or an interior 360 is one file (url). A spin is a set of photos taken walking around the
-- car, kept in order in "frames" ([{url, path}]); the customer page turns the car as the shopper drags. Same rules as
-- photos: photographers and admins add, change and delete them; shoppers see them on live cars.

create table if not exists public.vehicle_media (
  id               uuid primary key default gen_random_uuid(),
  vehicle_id       uuid not null references public.vehicles(id) on delete cascade,
  dealership_id    uuid not null references public.dealerships(id) on delete cascade,
  kind             text not null check (kind in ('video', 'interior360', 'spin')),
  url              text,
  storage_path     text,
  poster_url       text,
  poster_path      text,
  frames           jsonb not null default '[]'::jsonb,
  duration_seconds numeric check (duration_seconds is null or duration_seconds between 0 and 600),
  caption          text check (caption is null or length(caption) <= 200),
  position         int not null default 0,
  uploaded_by      uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  check ((kind = 'spin' and jsonb_typeof(frames) = 'array' and jsonb_array_length(frames) between 8 and 72)
      or (kind <> 'spin' and url is not null))
);
create index if not exists vehicle_media_vehicle on public.vehicle_media (vehicle_id, kind, position);
drop trigger if exists vp_media_inherit on public.vehicle_media;
create trigger vp_media_inherit before insert or update on public.vehicle_media
  for each row execute function public.vp_inherit_dealership();

alter table public.vehicle_media enable row level security;
drop policy if exists media_read on public.vehicle_media;
drop policy if exists media_edit_insert on public.vehicle_media;
drop policy if exists media_edit_update on public.vehicle_media;
drop policy if exists media_edit_delete on public.vehicle_media;
create policy media_read on public.vehicle_media for select using (
  public.vp_can_shoot(dealership_id)
  or exists (select 1 from public.vehicles v where v.id = vehicle_id and v.status in ('published', 'sold')));
create policy media_edit_insert on public.vehicle_media for insert
  with check (public.vp_can_edit_photos(dealership_id) and uploaded_by is not distinct from auth.uid());
create policy media_edit_update on public.vehicle_media for update
  using (public.vp_can_edit_photos(dealership_id)) with check (public.vp_can_edit_photos(dealership_id));
create policy media_edit_delete on public.vehicle_media for delete using (public.vp_can_edit_photos(dealership_id));
grant select on public.vehicle_media to anon, authenticated;
grant insert, update, delete on public.vehicle_media to authenticated;

-- Photographers may now also upload video files to a car's folder (same folder rule as photos).
create or replace function public.vp_can_shoot_path(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := string_to_array(object_name, '/');
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if array_length(parts, 1) <> 4 or parts[2] <> 'vehicles' or parts[1] !~ uuid_re or parts[3] !~ uuid_re
     or parts[4] !~* '^[0-9a-f-]{36}\.(jpe?g|png|webp|heic|heif|mp4|m4v|mov|webm)$' then
    return false;
  end if;
  return public.vp_can_edit_photos(parts[1]::uuid)
    and exists (select 1 from public.vehicles v where v.id = parts[3]::uuid and v.dealership_id = parts[1]::uuid);
end $$;

-- Walkaround videos are up to about 45 MB, so the media bucket takes files up to 50 MB (it was 25 MB). On Supabase's
-- free plan 50 MB is also the project-wide maximum.
update storage.buckets set file_size_limit = 52428800 where id = 'media' and coalesce(file_size_limit, 0) < 52428800;
