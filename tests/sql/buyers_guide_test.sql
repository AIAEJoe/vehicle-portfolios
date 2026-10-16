-- FTC Buyers Guide data rules.
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d', 'sales2@nsb.test');
select public.vp_add_member('nsbchevy', 'sales2@nsb.test', 'sales');

select pg_temp.check((select bg_warranty from vehicles where vin = '1C4GJXAG5JW150863') is null, 'seed vehicle starts with no warranty data (pending)');

set role authenticated;
-- a salesperson can edit the vehicle but not its warranty disclosure
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
update vehicles set price = 27990 where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select price from vehicles where vin = '1C4GJXAG5JW150863') = 27990, 'sales can still edit other fields');
select pg_temp.fails($$update vehicles set bg_warranty = 'as_is' where vin = '1C4GJXAG5JW150863'$$, 'Only dealership admins', 'sales cannot change warranty terms');

-- admin
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.fails($$update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'limited', bg_labor_pct = 100, bg_parts_pct = 50,
  bg_systems = '[{"system":"Power train","duration":"30 days"}]' where vin = '1C4GJXAG5JW150863'$$, 'Shorthand', '"power train" shorthand rejected');
select pg_temp.fails($$update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'limited', bg_labor_pct = 100, bg_parts_pct = 50,
  bg_systems = '[{"system":"Drive-train","duration":"30 days"}]' where vin = '1C4GJXAG5JW150863'$$, 'Shorthand', '"drive-train" shorthand rejected');
select pg_temp.fails($$update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'limited', bg_systems = '[{"system":"Engine","duration":"30 days"}]'
  where vin = '1C4GJXAG5JW150863'$$, 'percentage', 'limited warranty needs labor and parts %');
select pg_temp.fails($$update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'full' where vin = '1C4GJXAG5JW150863'$$,
  'covered system', 'dealer warranty needs covered systems');
select pg_temp.fails($$update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'full', bg_systems = '[{"system":"Engine","duration":""}]'
  where vin = '1C4GJXAG5JW150863'$$, 'duration', 'each system needs a duration');

update vehicles set bg_warranty = 'dealer_warranty', bg_warranty_type = 'limited', bg_labor_pct = 100, bg_parts_pct = 50,
  bg_deductible = 'A $50 deductible applies to each repair visit',
  bg_systems = '[{"system":"Engine block, cylinder heads and internal parts","duration":"30 days or 1,000 miles, whichever occurs first"},
                 {"system":"Transmission case and internal parts","duration":"30 days or 1,000 miles, whichever occurs first"}]',
  bg_service_contract = true
  where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select bg_parts_pct from vehicles where vin = '1C4GJXAG5JW150863') = 50, 'limited warranty saved');
select pg_temp.check((select bg_updated_by from vehicles where vin = '1C4GJXAG5JW150863') = '00000000-0000-0000-0000-00000000000b', 'who changed the terms is recorded');

update vehicles set bg_warranty_type = 'full', bg_labor_pct = 20 where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select bg_labor_pct = 100 and bg_parts_pct = 100 from vehicles where vin = '1C4GJXAG5JW150863'), 'full warranty is always 100% labor and parts');

update vehicles set bg_warranty = 'as_is' where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select bg_warranty_type is null and bg_systems = '[]'::jsonb and bg_deductible is null from vehicles where vin = '1C4GJXAG5JW150863'),
  'switching to As Is clears dealer warranty terms');

-- another dealership cannot touch it
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
update vehicles set bg_warranty = 'implied_only' where vin = '1C4GJXAG5JW150863';
reset role;
select pg_temp.check((select bg_warranty from vehicles where vin = '1C4GJXAG5JW150863') = 'as_is', 'other dealership cannot change terms');

-- the public page can read the guide data and the dealership's complaint contact
update dealerships set bg_complaint_name = 'General Manager', bg_complaint_phone = '(386) 555-0199' where slug = 'nsbchevy';
set role anon;
select pg_temp.check((select bg_warranty from vehicles where vin = '1C4GJXAG5JW150863') = 'as_is', 'anon can read guide data of a published vehicle');
select pg_temp.check((select bg_complaint_name from dealerships where slug = 'nsbchevy') = 'General Manager', 'anon can read complaint contact');
reset role;

-- the server (feed sync, no user) is not blocked
set request.jwt.claim.sub = '';
update vehicles set bg_warranty = 'implied_only' where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select bg_warranty from vehicles where vin = '1C4GJXAG5JW150863') = 'implied_only', 'service role may set terms');
update vehicles set bg_warranty = null where vin = '1C4GJXAG5JW150863';
