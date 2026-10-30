-- Photo banners: admins write, shoppers read the active ones, nobody touches another dealership's.
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

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a'; -- owner
insert into dealership_banners (dealership_id, text, note, year_from, year_to, make, model, condition)
select id, 'TRUCK MONTH', 'See dealer', 2024, 2026, 'Chevrolet', 'Silverado 1500', 'new' from dealerships where slug = 'nsbchevy';
insert into dealership_banners (dealership_id, text, active) select id, 'Off for now', false from dealerships where slug = 'nsbchevy';
select pg_temp.fails($$insert into dealership_banners (dealership_id, text, year_from, year_to) select id, 'x', 2026, 2024 from dealerships where slug = 'nsbchevy'$$, 'check constraint', 'year range must run forward');
select pg_temp.fails($$insert into dealership_banners (dealership_id, text) select id, '  ' from dealerships where slug = 'nsbchevy'$$, 'check constraint', 'banner text required');
select pg_temp.fails($$insert into dealership_banners (dealership_id, text) select id, repeat('x', 41) from dealerships where slug = 'nsbchevy'$$, 'check constraint', 'banner text fits the photo');
select pg_temp.fails($$insert into dealership_banners (dealership_id, text, condition) select id, 'x', 'cpo' from dealerships where slug = 'nsbchevy'$$, 'check constraint', 'condition is any/new/used');
select pg_temp.fails($$insert into dealership_banners (dealership_id, text) select id, 'x' from dealerships where slug = 'otherdealer'$$, 'row-level security', 'owner cannot add banners to another dealership');
select pg_temp.check((select count(*) from dealership_banners) = 2, 'owner sees active and switched-off banners');

set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e'; -- sales
select pg_temp.check((select count(*) from dealership_banners) = 2, 'sales sees the banners');
update dealership_banners set text = 'hacked';
delete from dealership_banners;
select pg_temp.fails($$insert into dealership_banners (dealership_id, text) select id, 'x' from dealerships where slug = 'nsbchevy'$$, 'row-level security', 'sales cannot add banners');

set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c'; -- another dealership
update dealership_banners set active = false;

set role anon;
select pg_temp.check((select count(*) from dealership_banners) = 1 and (select text from dealership_banners) = 'TRUCK MONTH', 'shoppers see only the active banner');
reset role;
select pg_temp.check((select count(*) from dealership_banners where text = 'TRUCK MONTH' and active) = 1, 'sales and outsiders changed nothing');
select pg_temp.check((select count(*) from dealership_banners) = 2, 'nothing deleted');
delete from dealership_banners;
