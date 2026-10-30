-- Video & 360°: photographers and admins add them; sales can't; shoppers see them on live cars only.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;
create or replace function pg_temp.fails(stmt text, want text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm ilike '%' || want || '%' then raise notice 'ok: %', msg; return; end if;
    raise exception 'FAIL: % (wrong error: %)', msg, sqlerrm;
  end;
  raise exception 'FAIL: % (no error)', msg;
end $$;

insert into vehicles (dealership_id, status, stock_number, vin, year, make, model)
select id, 'published', 'VM1', '1G1YC3D46P5136227', 2023, 'Chevrolet', 'Corvette' from dealerships where slug = 'nsbchevy';
insert into vehicles (dealership_id, status, stock_number, vin, year, make, model)
select id, 'draft', 'VM2', '1G1YC3D46P5136228', 2023, 'Chevrolet', 'Corvette' from dealerships where slug = 'nsbchevy';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1'; -- photographer
insert into vehicle_media (vehicle_id, dealership_id, kind, url, storage_path)
select id, '00000000-0000-0000-0000-000000000000', 'video', 'https://x/walk.mp4', 'p' from vehicles where stock_number = 'VM1';
insert into vehicle_media (vehicle_id, kind, frames) select id, 'spin', (select jsonb_agg(jsonb_build_object('url', 'https://x/' || g || '.jpg')) from generate_series(1, 24) g) from vehicles where stock_number = 'VM1';
insert into vehicle_media (vehicle_id, kind, url) select id, 'interior360', 'https://x/pano.jpg' from vehicles where stock_number = 'VM2';
select pg_temp.fails($$insert into vehicle_media (vehicle_id, kind, frames) select id, 'spin', '[{"url":"a"},{"url":"b"}]' from vehicles where stock_number = 'VM1'$$, 'check constraint', 'a spin needs at least 8 frames');
select pg_temp.fails($$insert into vehicle_media (vehicle_id, kind) select id, 'video' from vehicles where stock_number = 'VM1'$$, 'check constraint', 'a video needs its file');
select pg_temp.fails($$insert into vehicle_media (vehicle_id, kind, url) select id, 'hologram', 'x' from vehicles where stock_number = 'VM1'$$, 'check constraint', 'only video, spin, interior360');
select pg_temp.check((select count(*) from vehicle_media) = 3, 'photographer sees all three, draft car included');
select pg_temp.check(public.vp_can_shoot_path((select dealership_id || '/vehicles/' || id || '/0f8fad5b-d9cb-469f-a165-70867728950e.mp4' from vehicles where stock_number = 'VM1')), 'video files allowed in the car folder');
select pg_temp.check(not public.vp_can_shoot_path((select dealership_id || '/vehicles/' || id || '/0f8fad5b-d9cb-469f-a165-70867728950e.exe' from vehicles where stock_number = 'VM1')), 'other file types refused');
reset role;
select pg_temp.check((select bool_and(m.dealership_id = v.dealership_id) from vehicle_media m join vehicles v on v.id = m.vehicle_id), 'dealership comes from the car, not the client');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e'; -- sales
select pg_temp.check((select count(*) from vehicle_media) = 3, 'sales sees them');
delete from vehicle_media;
update vehicle_media set caption = 'x';
select pg_temp.fails($$insert into vehicle_media (vehicle_id, kind, url) select id, 'video', 'u' from vehicles where stock_number = 'VM1'$$, 'row-level security', 'sales cannot add video');
select pg_temp.check(not public.vp_can_shoot_path((select dealership_id || '/vehicles/' || id || '/0f8fad5b-d9cb-469f-a165-70867728950e.mp4' from vehicles where stock_number = 'VM1')), 'sales cannot upload video files');
reset request.jwt.claim.sub;
set role anon;
select pg_temp.check((select count(*) from vehicle_media) = 2, 'shoppers see the live car''s video and spin, not the draft''s');
reset role;
select pg_temp.check((select count(*) from vehicle_media where caption is null) = 3, 'sales changed nothing');
select pg_temp.check((select file_size_limit from storage.buckets where id = 'media') = 52428800, 'media bucket takes 50 MB files');
delete from vehicles where stock_number in ('VM1', 'VM2');
select pg_temp.check((select count(*) from vehicle_media) = 0, 'removed with the car');
