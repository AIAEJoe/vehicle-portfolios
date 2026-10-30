-- Vehicle Portfolios: photo feed for third-party sites. Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0013_photo_feed.sql.

-- Photo feed for third-party sites (HomeNet, vAuto, Dealer Inspire…). Safe to run more than once.
--
-- GET /api/feeds/photos?token=<photo_feed_token> lists every live car's photographer photos, in display order, as a
-- CSV a syndicator can pull on a schedule. Its token is separate from the inventory-ingest token, so giving it to a
-- vendor lets them read photos and nothing else.
alter table public.dealership_settings add column if not exists photo_feed_token text not null default encode(gen_random_bytes(18), 'hex');

-- Once our photographer has shot a car, the inventory feed no longer adds its own photos for that car. Otherwise,
-- when HomeNet re-hosts our photos and sends them back in the hourly feed, every car would show each photo twice.
-- Feed photos already on a car stay until the feed's photo list for it changes.
create or replace function public.vp_photos_skip_feed_when_shot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'feed' and exists (select 1 from public.vehicle_photos p where p.vehicle_id = new.vehicle_id and p.source = 'upload') then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists vp_photos_skip_feed_when_shot on public.vehicle_photos;
create trigger vp_photos_skip_feed_when_shot before insert on public.vehicle_photos
  for each row execute function public.vp_photos_skip_feed_when_shot();
