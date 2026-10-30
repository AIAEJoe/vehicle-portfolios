-- Vehicle Portfolios: copy SlipStream photos in. Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0015_copy_in_photos.sql.

-- Copy SlipStream / feed photos into our own storage. Safe to run more than once.
--
-- Settings → "Copy SlipStream photos in" downloads each car's feed, listing and URL photos (the ones SlipStream
-- shot, hosted by HomeNet/SlipStream) into the media bucket and turns them into our own photos (source 'upload'),
-- so they keep working after SlipStream is cancelled and go out in our photo feed. copied_from keeps the old address.
alter table public.vehicle_photos add column if not exists copied_from text;
