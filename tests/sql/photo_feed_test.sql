-- Photo feed: its own token; feed photos stop once the photographer has shot the car.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;

select pg_temp.check((select length(photo_feed_token) = 36 and photo_feed_token <> feed_ingest_token from dealership_settings s join dealerships d on d.id = s.dealership_id where d.slug = 'nsbchevy'), 'photo feed has its own token');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e'; -- sales
select pg_temp.check((select count(*) from dealership_settings) = 0, 'sales cannot read the photo feed token');
reset role;

insert into vehicles (dealership_id, status, stock_number, vin, year, make, model)
select id, 'published', 'PF1', '1G1YC3D46P5136227', 2023, 'Chevrolet', 'Corvette' from dealerships where slug = 'nsbchevy';
insert into vehicle_photos (vehicle_id, url, position, source) select id, 'https://homenet/1.jpg', 0, 'feed' from vehicles where stock_number = 'PF1';
select pg_temp.check((select count(*) from vehicle_photos p join vehicles v on v.id = p.vehicle_id where v.stock_number = 'PF1') = 1, 'feed photos land before the car is shot');
insert into vehicle_photos (vehicle_id, url, storage_path, position, source) select id, 'https://ours/a.jpg', 'x', -1, 'upload' from vehicles where stock_number = 'PF1';
insert into vehicle_photos (vehicle_id, url, position, source) select id, 'https://homenet/copy-of-a.jpg', 1, 'feed' from vehicles where stock_number = 'PF1';
select pg_temp.check((select count(*) from vehicle_photos p join vehicles v on v.id = p.vehicle_id where v.stock_number = 'PF1' and p.url like '%copy-of-a%') = 0, 'feed copies are skipped once the car is shot');
insert into vehicle_photos (vehicle_id, url, position, source) select id, 'https://listing/b.jpg', 2, 'import' from vehicles where stock_number = 'PF1';
select pg_temp.check((select count(*) from vehicle_photos p join vehicles v on v.id = p.vehicle_id where v.stock_number = 'PF1') = 3, 'uploads, imports and earlier feed photos untouched');
delete from vehicles where stock_number = 'PF1';
select pg_temp.check(exists (select 1 from information_schema.columns where table_name = 'vehicle_photos' and column_name = 'copied_from'), 'copied photos remember where they came from');
