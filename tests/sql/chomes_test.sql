-- CHOMES vehicle story: privacy, validation, provenance, FTC review flag.
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
create or replace function pg_temp.jeep() returns uuid language sql as $$
  select id from public.vehicles where vin = '1C4GJXAG5JW150863' $$;
create or replace function pg_temp.src(f text) returns text language sql as $$
  select provenance -> f ->> 'source' from public.vehicle_chomes where vehicle_id = pg_temp.jeep() $$;

-- users: a CHOMES salesperson and admin at nsbchevy (the outsider "c" owns otherdealer)
insert into auth.users (id, email) values
 ('00000000-0000-0000-0000-00000000000e', 'sales3@nsb.test'),
 ('00000000-0000-0000-0000-00000000000f', 'ucm@nsb.test');
select public.vp_add_member('nsbchevy', 'sales3@nsb.test', 'sales');
select public.vp_add_member('nsbchevy', 'ucm@nsb.test', 'admin');
insert into staff (dealership_id, user_id, full_name)
select id, '00000000-0000-0000-0000-00000000000f', 'Dana Used-Car-Manager' from dealerships where slug = 'nsbchevy';

-- ---------- record creation + backfill ----------
select pg_temp.check(exists(select 1 from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'used vehicle gets a CHOMES record automatically');
delete from vehicle_chomes where vehicle_id = pg_temp.jeep();
\ir ../../supabase/migrations/0005_chomes.sql
select pg_temp.check(pg_temp.src('odometer') = 'existing_record', 'migration backfills existing vehicles (and can run twice)');
select pg_temp.check((select provenance->'model_year' ? 'at' from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'backfill records a timestamp');

insert into vehicles (dealership_id, condition, year, make, model, vin)
select id, 'new', 2027, 'Chevrolet', 'Equinox', '3GNAXHEG0SL000001' from dealerships where slug = 'nsbchevy';
select pg_temp.check(not exists(select 1 from vehicle_chomes c join vehicles v on v.id = c.vehicle_id where v.vin = '3GNAXHEG0SL000001'),
  'new vehicles get no CHOMES record');
update vehicles set condition = 'used' where vin = '3GNAXHEG0SL000001';
select pg_temp.check(exists(select 1 from vehicle_chomes c join vehicles v on v.id = c.vehicle_id where v.vin = '3GNAXHEG0SL000001'),
  'switching to used creates one');
delete from vehicles where vin = '3GNAXHEG0SL000001';
select pg_temp.check((select count(*) from vehicle_chomes c where not exists (select 1 from vehicles v where v.id = c.vehicle_id)) = 0,
  'deleting the vehicle deletes its CHOMES record');

-- ---------- privacy ----------
set role anon;
select pg_temp.fails($$select count(*) from vehicle_chomes$$, 'permission denied', 'public visitors cannot read CHOMES (recon cost etc.)');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.check((select count(*) from vehicle_chomes) = 0, 'another dealership cannot see the record');
update vehicle_chomes set recon_cost = 1 where vehicle_id = pg_temp.jeep();
select pg_temp.fails($$select public.vp_vehicle_apply_decode(pg_temp.jeep(), '{"trim":"X"}')$$, 'not found', 'another dealership cannot apply a VIN decode');
reset role;
select pg_temp.check((select recon_cost from vehicle_chomes where vehicle_id = pg_temp.jeep()) is null, 'another dealership cannot write it');

-- ---------- team entry, provenance, validation ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicle_chomes set overall_grade = 'good', strengths = '  New tires  ', wear_items = '', inspected_by = 'Dana',
  inspection_date = current_date, report_provider = 'carfax', accidents_count = 0, title_issues = false,
  title_issue_detail = 'ignored', recon_cost = 450, highlight_features = array['Soft top', '', 'Tow package'],
  provenance = '{"overall_grade":{"source":"inventory_feed"}}'
  where vehicle_id = pg_temp.jeep();
reset role;
select pg_temp.check((select strengths = 'New tires' and wear_items is null from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'text is trimmed; blank means not entered');
select pg_temp.check((select accidents_summary from vehicle_chomes where vehicle_id = pg_temp.jeep()) = 'No accidents reported', 'zero accidents gets a summary');
select pg_temp.check((select title_issue_detail is null from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'no title issue clears the detail');
select pg_temp.check((select highlight_features = array['Soft top', 'Tow package'] from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'empty highlights dropped');
select pg_temp.check(pg_temp.src('overall_grade') = 'staff', 'staff cannot forge where a value came from');
select pg_temp.check((select provenance->'recon_cost'->>'by' from vehicle_chomes where vehicle_id = pg_temp.jeep()) = '00000000-0000-0000-0000-00000000000e',
  'who entered it is recorded');
select pg_temp.check((select provenance->'recon_cost'->>'by_name' from vehicle_chomes where vehicle_id = pg_temp.jeep()) = 'sales3@nsb.test',
  'by_name falls back to the login email');
select pg_temp.check(pg_temp.src('demand_note') is null, 'untouched fields have no provenance');
select pg_temp.check(not (select review_required from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'Good grade, no work, clean title: no FTC review needed');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.fails($$update vehicle_chomes set highlight_features = array['a','b','c','d','e','f'] where vehicle_id = pg_temp.jeep()$$, 'at most five', 'max five highlight features');
select pg_temp.fails($$update vehicle_chomes set accidents_count = 1, accidents_summary = '' where vehicle_id = pg_temp.jeep()$$, 'summary', 'accidents need a one-line summary');
select pg_temp.fails($$update vehicle_chomes set title_issues = true where vehicle_id = pg_temp.jeep()$$, 'Describe the title issue', 'title issue needs detail');
select pg_temp.fails($$update vehicle_chomes set inspection_date = current_date + 1 where vehicle_id = pg_temp.jeep()$$, 'future', 'inspection date cannot be in the future');
select pg_temp.fails($$update vehicle_chomes set overall_grade = 'poor' where vehicle_id = pg_temp.jeep()$$, 'check constraint', 'grade is Excellent, Good or Fair');
select pg_temp.fails($$update vehicle_chomes set report_provider = 'kbb' where vehicle_id = pg_temp.jeep()$$, 'check constraint', 'provider is CARFAX or AutoCheck');
select pg_temp.fails($$update vehicle_chomes set recon_cost = -5 where vehicle_id = pg_temp.jeep()$$, 'check constraint', 'recon cost cannot be negative');

-- ---------- FTC consistency review ----------
update vehicle_chomes set needed_work = 'Replace rear brake pads' where vehicle_id = pg_temp.jeep();
select pg_temp.check((select review_required from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'needed work flags the record for FTC review');
select pg_temp.fails($$update vehicle_chomes set review_cleared_at = now() where vehicle_id = pg_temp.jeep()$$, 'Only dealership admins', 'sales cannot clear the review');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
update vehicle_chomes set review_cleared_at = now() where vehicle_id = pg_temp.jeep();
reset role;
select pg_temp.check((select review_cleared_by from vehicle_chomes where vehicle_id = pg_temp.jeep()) = '00000000-0000-0000-0000-00000000000f', 'admin clears it; who is recorded');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
update vehicle_chomes set demand_note = 'Wranglers turn fast here' where vehicle_id = pg_temp.jeep();
reset role;
select pg_temp.check((select review_cleared_at is not null from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'unrelated edits keep the clearance');
select pg_temp.check((select provenance->'demand_note'->>'by_name' from vehicle_chomes where vehicle_id = pg_temp.jeep()) = 'Dana Used-Car-Manager', 'by_name uses the staff name');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicle_chomes set needed_work = 'Replace rear brake pads and rotors' where vehicle_id = pg_temp.jeep();
reset role;
select pg_temp.check((select review_cleared_at is null and review_cleared_by is null from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'changing needed work re-opens the review');
update vehicle_chomes set needed_work = null where vehicle_id = pg_temp.jeep();
update vehicle_chomes set overall_grade = 'fair' where vehicle_id = pg_temp.jeep();
select pg_temp.check((select review_required from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'Fair grade flags the record');
update vehicle_chomes set overall_grade = 'good', title_issues = true, title_issue_detail = 'Prior rental' where vehicle_id = pg_temp.jeep();
select pg_temp.check((select review_required from vehicle_chomes where vehicle_id = pg_temp.jeep()), 'title issue flags the record');
update vehicle_chomes set title_issues = false where vehicle_id = pg_temp.jeep();

-- ---------- Old / Miles / Equipment provenance from the vehicle record ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicles set mileage = 81400 where id = pg_temp.jeep();
update vehicles set trim = null, engine = null where id = pg_temp.jeep();
select (public.vp_vehicle_apply_decode(pg_temp.jeep(), '{"trim":"Sport S","engine":"3.6L V6","year":"1999","drivetrain":"4WD"}')).id;
reset role;
select pg_temp.check(pg_temp.src('odometer') = 'staff', 'odometer edited by staff is labelled staff');
select pg_temp.check(pg_temp.src('trim') = 'vin_decode' and pg_temp.src('engine') = 'vin_decode', 'VIN decode fills are labelled vin_decode');
select pg_temp.check((select year = 2018 and drivetrain = 'Four Wheel Drive' from vehicles where id = pg_temp.jeep()), 'VIN decode never overwrites existing values');
select pg_temp.check(pg_temp.src('model_year') = 'existing_record', 'unchanged fields keep their source');
select pg_temp.check(current_setting('vp.source', true) is distinct from 'vin_decode', 'decode label does not leak into later writes');

set request.jwt.claim.sub = '';   -- the hourly feed job runs with no signed-in user
select public.vp_feed_sync((select id from dealerships where slug = 'nsbchevy'),
  '[{"vin":"1C4GJXAG5JW150863","mileage":"81500"},{"vin":"1GCUYDED5LZ000002","year":"2020","make":"Chevrolet","model":"Silverado 1500","mileage":"42000","condition":"used"}]'::jsonb,
  true, false);
select pg_temp.check(pg_temp.src('odometer') = 'inventory_feed', 'feed mileage update is labelled inventory_feed');
select pg_temp.check((select c.provenance->'odometer'->>'source' = 'inventory_feed' and c.provenance ? 'model_year'
  from vehicle_chomes c join vehicles v on v.id = c.vehicle_id where v.vin = '1GCUYDED5LZ000002'), 'a vehicle added by the feed gets a CHOMES record with its sources');

-- ---------- private report storage ----------
select pg_temp.check((select not public from storage.buckets where id = 'internal'), 'history reports go to a private bucket');
