-- Photographer role: find cars and add photos; nothing else.
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'photo@lotpics.test');
select public.vp_add_member('nsbchevy', 'photo@lotpics.test', 'photographer');
select pg_temp.fails($$select public.vp_add_member('nsbchevy', 'photo@lotpics.test', 'janitor')$$, 'check constraint', 'unknown roles rejected');
-- a draft (not public) car and a lead the photographer must not see
insert into vehicles (dealership_id, status, stock_number, vin, year, make, model)
select id, 'draft', 'PJ17152', 'KL77LKEP3SC259877', 2025, 'Chevrolet', 'Trax' from dealerships where slug = 'nsbchevy';
insert into leads (dealership_id, name) select id, 'Secret Lead' from dealerships where slug = 'nsbchevy';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check((select count(*) from vehicles where stock_number = 'PJ17152') = 1, 'photographer finds draft cars by stock number');
select pg_temp.check((select count(*) from leads) = 0, 'photographer cannot see leads');
select pg_temp.check((select count(*) from customers) = 0, 'photographer cannot see customers');
select pg_temp.check((select count(*) from vehicle_chomes) = 0, 'photographer cannot see CHOMES (recon cost)');
select pg_temp.check((select count(*) from vehicle_factory_data) = 0, 'photographer cannot see factory pricing');
select pg_temp.check((select count(*) from dealership_settings) = 0, 'photographer cannot see settings');
update vehicles set price = 1 where stock_number = 'PJ17152';
select pg_temp.fails($$insert into vehicles (dealership_id, year) select id, 2020 from dealerships where slug = 'nsbchevy'$$, 'row-level security', 'photographer cannot add cars');

insert into vehicle_photos (vehicle_id, dealership_id, url, storage_path, position, source)
select id, dealership_id, 'https://x/p1.jpg', 'x', -10000, 'upload' from vehicles where stock_number = 'PJ17152';
select pg_temp.fails($$insert into vehicle_photos (vehicle_id, dealership_id, url, position, source) select id, dealership_id, 'https://x/f.jpg', 0, 'feed' from vehicles where stock_number = 'PJ17152'$$,
  'row-level security', 'photographer can only add uploads');
select pg_temp.fails($$insert into vehicle_photos (vehicle_id, dealership_id, url, position, source, uploaded_by) select id, dealership_id, 'u', 0, 'upload', '00000000-0000-0000-0000-00000000000b' from vehicles where stock_number = 'PJ17152'$$,
  'row-level security', 'photographer cannot upload as someone else');
-- storage paths
select pg_temp.check(public.vp_can_shoot_path((select dealership_id || '/vehicles/' || id || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' from vehicles where stock_number = 'PJ17152')), 'vehicle photo path allowed');
select pg_temp.check(not public.vp_can_shoot_path((select dealership_id || '/vehicles/' || id || '/docs/0f8fad5b-d9cb-469f-a165-70867728950e.pdf' from vehicles where stock_number = 'PJ17152')), 'documents path not allowed');
select pg_temp.check(not public.vp_can_shoot_path((select dealership_id || '/brand/0f8fad5b-d9cb-469f-a165-70867728950e.png' from dealerships d join vehicles v on v.dealership_id = d.id limit 1)), 'logo path not allowed');
select pg_temp.check(not public.vp_can_shoot_path((select dealership_id || '/vehicles/' || gen_random_uuid() || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' from vehicles limit 1)), 'unknown vehicle not allowed');
reset role;
select pg_temp.check((select price is distinct from 1 from vehicles where stock_number = 'PJ17152'), 'photographer cannot change prices');
select pg_temp.check((select uploaded_by from vehicle_photos where url = 'https://x/p1.jpg') = '00000000-0000-0000-0000-0000000000a1', 'uploader recorded');

-- deleting: own photos only
insert into vehicle_photos (vehicle_id, url, position, source, uploaded_by) select id, 'https://x/staff.jpg', 1, 'upload', '00000000-0000-0000-0000-00000000000b' from vehicles where stock_number = 'PJ17152';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
delete from vehicle_photos where url in ('https://x/staff.jpg', 'https://x/p1.jpg');
reset role;
select pg_temp.check((select count(*) from vehicle_photos where url = 'https://x/staff.jpg') = 1 and (select count(*) from vehicle_photos where url = 'https://x/p1.jpg') = 0,
  'photographer deletes only their own photos');

-- other dealership's photographer sees nothing here; staff still work as before
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.check((select count(*) from vehicles where stock_number = 'PJ17152') = 0, 'another dealership cannot see the draft');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.check((select count(*) from leads where name = 'Secret Lead') = 1, 'sales staff still see leads');
reset role;
delete from vehicles where stock_number = 'PJ17152';
delete from leads where name = 'Secret Lead';
