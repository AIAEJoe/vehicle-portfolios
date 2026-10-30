-- Dealer warranty program: admin-only, Buyers Guide rules enforced, applied only on review.
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
create or replace function pg_temp.jeep() returns uuid language sql as $$ select id from public.vehicles where vin = '1C4GJXAG5JW150863' $$;

-- 0000000b is an nsbchevy admin by now (rls_test promoted it); 0000000e is a salesperson (chomes_test)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update dealerships set bg_program = '{"name":"x","match":"x","labor_pct":100,"parts_pct":100,"systems":[{"system":"Engine","duration":"1 yr"}]}' where slug = 'nsbchevy';
reset role;
select pg_temp.check((select bg_program is null from dealerships where slug = 'nsbchevy'), 'sales cannot set up the program');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.fails($$update dealerships set bg_program = '{"name":"Lifetime","match":"lifetime","labor_pct":100,"parts_pct":100,"systems":[{"system":"Power train","duration":"Lifetime"}]}' where slug = 'nsbchevy'$$,
  'Shorthand', '"power train" shorthand rejected in the program');
select pg_temp.fails($$update dealerships set bg_program = '{"name":"Lifetime","match":"lifetime","labor_pct":100,"systems":[{"system":"Engine","duration":"Lifetime"}]}' where slug = 'nsbchevy'$$,
  'labor and parts', 'program needs labor and parts %');
select pg_temp.fails($$update dealerships set bg_program = '{"name":"Lifetime","match":"lifetime","labor_pct":100,"parts_pct":100,"systems":[{"system":"Engine","duration":""}]}' where slug = 'nsbchevy'$$,
  'duration', 'each system needs a duration');
update dealerships set bg_program = '{"name":"Lifetime Limited Powertrain Warranty","match":"lifetime powertrain warranty","labor_pct":100,"parts_pct":100,
  "deductible":"A $100 deductible applies to each covered repair",
  "systems":[{"system":"Engine: cylinder block, cylinder heads and internal lubricated parts","duration":"For as long as the original purchaser owns the vehicle"},
             {"system":"Transmission or transaxle: case and internal parts, torque converter","duration":"For as long as the original purchaser owns the vehicle"}],
  "sticker_line":"Lifetime Limited Powertrain Warranty included"}' where slug = 'nsbchevy';

-- applying
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.fails($$select public.vp_apply_bg_program(array[pg_temp.jeep()])$$, 'Only dealership admins', 'sales cannot apply it');
update vehicles set bg_program = 'Lifetime Limited Powertrain Warranty' where id = pg_temp.jeep();
select pg_temp.check((select bg_program is null from vehicles where id = pg_temp.jeep()), 'a label without a dealer warranty never sticks');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.fails($$select public.vp_apply_bg_program(array[pg_temp.jeep()])$$, 'Only dealership admins', 'another dealership cannot apply it');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check(public.vp_apply_bg_program(array[pg_temp.jeep()]) = 1, 'admin applies the program to the reviewed car');
reset role;
select pg_temp.check((select bg_warranty = 'dealer_warranty' and bg_warranty_type = 'limited' and bg_labor_pct = 100 and bg_parts_pct = 100
  and bg_deductible = 'A $100 deductible applies to each covered repair' and jsonb_array_length(bg_systems) = 2
  and bg_program = 'Lifetime Limited Powertrain Warranty' from vehicles where id = pg_temp.jeep()), 'Buyers Guide filled from the program and labelled');
select pg_temp.check((select bg_updated_by from vehicles where id = pg_temp.jeep()) = '00000000-0000-0000-0000-00000000000b', 'who applied it is recorded');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.fails($$update vehicles set bg_program = 'Something else' where id = pg_temp.jeep()$$, 'Only dealership admins', 'sales cannot relabel a car that has a dealer warranty');
reset role;

insert into vehicles (dealership_id, condition, year, make, model, vin)
select id, 'new', 2027, 'Chevrolet', 'Blazer', '3GNKBHR40SS000001' from dealerships where slug = 'nsbchevy';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check(public.vp_apply_bg_program(array[(select id from vehicles where vin = '3GNKBHR40SS000001')]) = 0, 'new vehicles are skipped (no Buyers Guide)');
update vehicles set bg_warranty = 'as_is' where id = pg_temp.jeep();
reset role;
select pg_temp.check((select bg_program is null from vehicles where id = pg_temp.jeep()), 'switching the car to As Is drops the program label');
delete from vehicles where vin = '3GNKBHR40SS000001';
update vehicles set bg_warranty = null where id = pg_temp.jeep();
update dealerships set bg_program = null where slug = 'nsbchevy';
