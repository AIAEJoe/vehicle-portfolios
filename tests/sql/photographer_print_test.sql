-- Photographers print: customer-safe CHOMES facts and the QR link, nothing else.
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

update vehicle_chomes set recon_cost = 450, acquisition_notes = 'Auction buy', demand_note = 'Hot', highlight_features = array['Tow package'],
  report_provider = 'carfax', prior_owners = 2 where vehicle_id = pg_temp.jeep();
delete from shares where vehicle_id = pg_temp.jeep() and channel = 'qr';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';  -- photographer (photographer_test)
select pg_temp.check((select public.vp_sticker_chomes(pg_temp.jeep())->'highlight_features' = '["Tow package"]'::jsonb), 'photographer gets the sticker facts');
select pg_temp.check((select (public.vp_sticker_chomes(pg_temp.jeep())->>'prior_owners')::int = 2), 'history facts included');
select pg_temp.check((select not (public.vp_sticker_chomes(pg_temp.jeep()) ?| array['recon_cost', 'acquisition_notes', 'demand_note', 'inspected_by', 'provenance', 'needed_work'])),
  'no recon cost, notes, demand note, inspector, provenance or needed work');
select pg_temp.check((select count(*) from vehicle_chomes) = 0, 'still no direct access to CHOMES');
select pg_temp.check(length(public.vp_qr_share(pg_temp.jeep())) = 8, 'photographer gets a QR link');
select pg_temp.check(public.vp_qr_share(pg_temp.jeep()) = public.vp_qr_share(pg_temp.jeep()), 'the same link every time');
select pg_temp.check((select count(*) from shares) = 0, 'still no direct access to shares');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';  -- another dealership
select pg_temp.check(public.vp_sticker_chomes(pg_temp.jeep()) is null, 'another dealership gets nothing');
select pg_temp.fails($$select public.vp_qr_share(pg_temp.jeep())$$, 'Vehicle not found', 'another dealership cannot make a link');
reset role;
set role anon;
select pg_temp.fails($$select public.vp_sticker_chomes(pg_temp.jeep())$$, 'permission denied', 'public cannot call it');
select pg_temp.fails($$select public.vp_qr_share(pg_temp.jeep())$$, 'permission denied', 'public cannot make links');
reset role;
select pg_temp.check((select count(*) from shares where vehicle_id = pg_temp.jeep() and channel = 'qr') = 1, 'one QR link recorded, tracked like the window card');
