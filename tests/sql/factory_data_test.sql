-- Factory data (VIN decoder): staff only, server-written; decode fill now includes MPG.
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

-- the server (service role) writes; dealership comes from the vehicle and can't be spoofed
set role service_role;
insert into vehicle_factory_data (vehicle_id, dealership_id, vin, data)
select id, (select id from dealerships where slug = 'otherdealer'), vin, '{"pricing":{"invoice":22500}}' from vehicles where vin = '1C4GJXAG5JW150863';
reset role;
select pg_temp.check((select f.dealership_id = v.dealership_id from vehicle_factory_data f join vehicles v on v.id = f.vehicle_id), 'dealership inherited from the vehicle');

set role anon;
select pg_temp.fails($$select count(*) from vehicle_factory_data$$, 'permission denied', 'public cannot read factory data (invoice price)');
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check((select count(*) from vehicle_factory_data) = 1, 'staff of the dealership can read it');
select pg_temp.fails($$update vehicle_factory_data set data = '{}'$$, 'permission denied', 'staff cannot edit it (only the server writes)');
select pg_temp.fails($$delete from vehicle_factory_data$$, 'permission denied', 'staff cannot delete it');
select pg_temp.fails($$insert into vehicle_factory_data (vehicle_id, dealership_id, vin, data) select id, dealership_id, vin, '{}' from vehicles limit 1$$, 'permission denied', 'staff cannot insert it');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.check((select count(*) from vehicle_factory_data) = 0, 'another dealership cannot read it');

-- decode fill: MPG filled only when empty, labelled VIN decode
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update vehicles set mpg_city = null, mpg_hwy = 21 where vin = '1C4GJXAG5JW150863';
select (public.vp_vehicle_apply_decode((select id from vehicles where vin = '1C4GJXAG5JW150863'), '{"mpg_city":"17","mpg_hwy":"23"}')).id;
reset role;
select pg_temp.check((select mpg_city = 17 and mpg_hwy = 21 from vehicles where vin = '1C4GJXAG5JW150863'), 'decode fills empty MPG, keeps existing MPG');
delete from vehicle_factory_data;
select pg_temp.check(true, 'cleanup');
