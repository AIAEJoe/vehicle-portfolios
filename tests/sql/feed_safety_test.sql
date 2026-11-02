-- Feed safety: preview, held-run review, price history.
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

reset role; reset request.jwt.claim.sub;
-- three feed cars in stock
insert into vehicles (dealership_id, status, source, condition, vin, stock_number, year, make, model, price, feed_seen_at)
select d.id, 'published', 'feed', 'new', v, 'FS' || right(v, 2), 2026, 'Chevrolet', 'Trax', 24000, now() - interval '1 day'
from dealerships d, unnest(array['1GCUYDED5RZ900001', '1GCUYDED5RZ900002', '1GCUYDED5RZ900003']) v where d.slug = 'nsbchevy';
select pg_temp.check((select count(*) from vehicle_price_history h join vehicles v on v.id = h.vehicle_id where v.stock_number like 'FS%' and h.source = 'initial') = 3, 'first price recorded');

select pg_temp.check((select (public.vp_feed_preview(id, array['1GCUYDED5RZ900001']))->'missing_sample' @> '[{"vin":"1GCUYDED5RZ900002"}]' from dealerships where slug = 'nsbchevy'), 'preview lists the cars a file leaves out');

-- the feed (server) changes a price; staff changes another
update vehicles set price = 23500 where vin = '1GCUYDED5RZ900001';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
update vehicles set price = 22999 where vin = '1GCUYDED5RZ900002';
select pg_temp.check((select count(*) from vehicle_price_history h join vehicles v on v.id = h.vehicle_id where v.stock_number like 'FS%') = 5, 'staff see price history');
reset role;
select pg_temp.check((select h.source = 'feed' and old_price = 24000 and new_price = 23500 from vehicle_price_history h join vehicles v on v.id = h.vehicle_id where v.vin = '1GCUYDED5RZ900001' and h.source <> 'initial'), 'feed price change recorded with old and new');
select pg_temp.check((select h.source = 'staff' and changed_by = '00000000-0000-0000-0000-00000000000e' from vehicle_price_history h join vehicles v on v.id = h.vehicle_id where v.vin = '1GCUYDED5RZ900002' and h.source <> 'initial'), 'staff price change recorded with who');

-- a held run that would have removed cars 2 and 3; car 3 comes back in a later import before review
reset request.jwt.claim.sub;
insert into feed_runs (id, dealership_id, source, status, hold_reasons, remove_ids, would_remove, created_at)
select '00000000-0000-0000-0000-00000000f001', d.id, 'sftp: x.csv', 'held', array['The file lists 1 vehicle.'],
  array(select id from vehicles where vin in ('1GCUYDED5RZ900002', '1GCUYDED5RZ900003')), 2, now() - interval '1 hour'
from dealerships d where d.slug = 'nsbchevy';
update vehicles set feed_seen_at = now() where vin = '1GCUYDED5RZ900003';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.check((select count(*) from feed_runs where status = 'held') = 1, 'staff can see import history');
select pg_temp.fails($$select public.vp_feed_review('00000000-0000-0000-0000-00000000f001', true)$$, 'Only dealership admins', 'sales cannot approve removals');
select pg_temp.fails($$insert into feed_runs (dealership_id, source, status) select id, 'x', 'applied' from dealerships where slug = 'nsbchevy'$$, 'row-level security', 'staff cannot write import history');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select pg_temp.check(public.vp_feed_review('00000000-0000-0000-0000-00000000f001', true) = 1, 'admin approves: only the car not seen since is removed');
select pg_temp.check((select status from vehicles where vin = '1GCUYDED5RZ900002') = 'sold' and (select status from vehicles where vin = '1GCUYDED5RZ900003') = 'published', 'the car that came back stays live');
select pg_temp.fails($$select public.vp_feed_review('00000000-0000-0000-0000-00000000f001', true)$$, 'already reviewed', 'a run is reviewed once');
reset role;
select pg_temp.check((select status = 'removals_approved' and reviewed_by = '00000000-0000-0000-0000-00000000000a' from feed_runs where id = '00000000-0000-0000-0000-00000000f001'), 'review recorded');
reset request.jwt.claim.sub;
delete from feed_runs; delete from vehicles where stock_number like 'FS%';
