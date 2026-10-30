-- Manager role and go-live approval.
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'manager@nsb.test');
select public.vp_add_member('nsbchevy', 'manager@nsb.test', 'manager');
select pg_temp.check((select publish_approval from dealerships where slug = 'nsbchevy') = 'used', 'approval on for used cars by default');
insert into vehicles (dealership_id, status, condition, stock_number, vin, year, make, model)
select id, 'draft', 'used', 'MG1', '1G1YC3D46P5136301', 2023, 'Chevrolet', 'Corvette' from dealerships where slug = 'nsbchevy';
insert into vehicles (dealership_id, status, condition, stock_number, vin, year, make, model)
select id, 'draft', 'new', 'MG2', '1G1YC3D46P5136302', 2026, 'Chevrolet', 'Corvette' from dealerships where slug = 'nsbchevy';

-- sales: can't publish an unapproved used car; can publish a new one; can't fake an approval
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.fails($$update vehicles set status = 'published' where stock_number = 'MG1'$$, 'manager needs to approve', 'sales cannot put an unapproved used car live');
update vehicles set approved_at = now(), approved_by = auth.uid() where stock_number = 'MG1';
select pg_temp.check((select approved_at is null from vehicles where stock_number = 'MG1'), 'approval cannot be written by hand');
update vehicles set status = 'published' where stock_number = 'MG2';
select pg_temp.check((select status from vehicles where stock_number = 'MG2') = 'published', 'new cars go live without approval (setting: used)');
select pg_temp.fails($$insert into vehicles (dealership_id, status, condition, vin) select id, 'published', 'used', '1G1YC3D46P5136399' from dealerships where slug = 'nsbchevy'$$, 'manager needs to approve', 'sales cannot add a used car straight to live');

-- manager: everything sales and photographers can do, and approves
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.check((select count(*) from leads) >= 0 and (select count(*) from vehicles where stock_number = 'MG1') = 1, 'manager sees vehicles and leads like sales');
select pg_temp.check(public.vp_can_edit_photos((select id from dealerships where slug = 'nsbchevy')), 'manager can edit photos like a photographer');
insert into vehicle_photos (vehicle_id, url, storage_path, position, source, uploaded_by) select id, 'https://x/m.jpg', 'x', 0, 'upload', auth.uid() from vehicles where stock_number = 'MG1';
select pg_temp.check((select count(*) from dealership_settings) = 0, 'manager does not read settings');
update vehicles set status = 'published' where stock_number = 'MG1';
select pg_temp.check((select status = 'published' and approved_by = '00000000-0000-0000-0000-0000000000b1' and approved_at is not null from vehicles where stock_number = 'MG1'), 'manager publishing approves the car');

-- once approved, sales may take it down and put it back up
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicles set status = 'draft' where stock_number = 'MG1';
update vehicles set status = 'published' where stock_number = 'MG1';
select pg_temp.check((select status from vehicles where stock_number = 'MG1') = 'published', 'approved car can be republished by sales');
reset role;

-- the inventory feed (server): new used cars wait as drafts
update vehicles set status = 'draft' where stock_number in ('MG1', 'MG2');
reset request.jwt.claim.sub;
insert into vehicles (dealership_id, status, source, condition, stock_number, vin) select id, 'published', 'feed', 'used', 'MG3', '1G1YC3D46P5136303' from dealerships where slug = 'nsbchevy';
insert into vehicles (dealership_id, status, source, condition, stock_number, vin) select id, 'published', 'feed', 'new', 'MG4', '1G1YC3D46P5136304' from dealerships where slug = 'nsbchevy';
select pg_temp.check((select status from vehicles where stock_number = 'MG3') = 'draft' and (select status from vehicles where stock_number = 'MG4') = 'published', 'feed: used cars wait for approval, new cars go live');
update dealerships set publish_approval = 'off' where slug = 'nsbchevy';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicles set status = 'published' where stock_number = 'MG3';
select pg_temp.check((select status from vehicles where stock_number = 'MG3') = 'published', 'with approval off, sales publishes as before');
reset role;
update dealerships set publish_approval = 'used' where slug = 'nsbchevy';
select pg_temp.fails($$update dealerships set publish_approval = 'sometimes' where slug = 'nsbchevy'$$, 'check constraint', 'approval setting is off/used/all');
select pg_temp.fails($$update dealership_members set role = 'boss' where user_id = '00000000-0000-0000-0000-0000000000b1'$$, 'check constraint', 'roles are owner/admin/manager/sales/photographer');
delete from vehicles where stock_number like 'MG%';
