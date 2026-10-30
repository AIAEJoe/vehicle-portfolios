-- Assertions for schema, RLS, and RPC behaviour.
\set ON_ERROR_STOP 1

create or replace function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;

-- users: owner of nsbchevy, a salesperson, and an outsider with their own dealership
insert into auth.users (id, email) values
 ('00000000-0000-0000-0000-00000000000a', 'owner@nsb.test'),
 ('00000000-0000-0000-0000-00000000000b', 'sales@nsb.test'),
 ('00000000-0000-0000-0000-00000000000c', 'other@else.test');
insert into public.dealerships (slug, name) values ('otherdealer', 'Other Dealer');
select public.vp_add_member('nsbchevy', 'owner@nsb.test', 'owner');
select public.vp_add_member('nsbchevy', 'sales@nsb.test', 'sales');
select public.vp_add_member('otherdealer', 'other@else.test', 'owner');

select pg_temp.check((select count(*) from dealership_settings) = 2, 'settings auto-created per dealership');
select pg_temp.check((select slug from vehicles where vin = '1C4GJXAG5JW150863') = '2018-jeep-wrangler-sport-s-r287418b', 'slug generated');
select pg_temp.check((select count(*) from vehicle_photos) = 32, 'seed photos');

-- a draft vehicle that the public must not see
insert into vehicles (dealership_id, year, make, model, stock_number, created_by)
select id, 2024, 'Chevrolet', 'Silverado 1500', 'N1001', null from dealerships where slug = 'nsbchevy';
insert into vehicles (dealership_id, year, make, model, stock_number, created_by)
select id, 2024, 'Chevrolet', 'Silverado 1500', 'N1001', null from dealerships where slug = 'nsbchevy';
select pg_temp.check((select count(*) from vehicles where slug like '2024-chevrolet-silverado-1500-n1001%') = 2, 'duplicate slug gets suffix');
select pg_temp.check(exists(select 1 from vehicles where slug = '2024-chevrolet-silverado-1500-n1001-2'), 'suffix -2');

-- ---------- anon ----------
set role anon;
select pg_temp.check((select count(*) from vehicles) = 1, 'anon sees only published vehicle');
select pg_temp.check((select count(*) from vehicle_photos) = 32, 'anon sees published photos');
select pg_temp.check((select count(*) from dealership_settings) = 0, 'anon cannot read settings');
select pg_temp.check((select count(*) from leads) = 0, 'anon cannot read leads');
select pg_temp.check((select count(*) from staff) = 1, 'anon sees active staff');
do $$ begin
  begin insert into leads (dealership_id, name) select id, 'x' from dealerships limit 1;
        raise exception 'FAIL: anon inserted lead';
  exception when insufficient_privilege then raise notice 'ok: anon cannot insert leads'; end;
  begin perform public.vp_record_view(gen_random_uuid());
        raise exception 'FAIL: anon called record_view';
  exception when insufficient_privilege then raise notice 'ok: anon cannot call vp_record_view'; end;
  begin perform public.vp_add_member('nsbchevy', 'other@else.test', 'owner');
        raise exception 'FAIL: anon called add_member';
  exception when insufficient_privilege then raise notice 'ok: anon cannot call vp_add_member'; end;
end $$;
update vehicles set price = 1;  -- silently affects 0 rows under RLS
reset role;
select pg_temp.check((select price from vehicles where vin = '1C4GJXAG5JW150863') = 17800, 'anon update blocked');

-- ---------- salesperson ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check((select count(*) from vehicles) = 3, 'sales sees drafts of own dealership');
select pg_temp.check((select count(*) from dealership_settings) = 0, 'sales cannot read settings');
update vehicles set price = 18500 where vin = '1C4GJXAG5JW150863';
insert into shares (vehicle_id, customer_name, customer_phone, staff_id, dealership_id)
select v.id, 'Mike Smith', '3865550100', (select id from staff limit 1), '00000000-0000-0000-0000-000000000000'
from vehicles v where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select dealership_id from shares limit 1) = (select id from dealerships where slug='nsbchevy'), 'share dealership_id cannot be spoofed');
select pg_temp.check(length((select code from shares limit 1)) = 8, 'share code generated');
insert into storage.objects (bucket_id, name)
select 'media', id || '/vehicles/x.jpg' from dealerships where slug = 'nsbchevy';
do $$ begin
  begin insert into storage.objects (bucket_id, name)
        select 'media', id || '/vehicles/x.jpg' from dealerships where slug = 'otherdealer';
        raise exception 'FAIL: wrote to other dealer folder';
  exception when insufficient_privilege then raise notice 'ok: storage write blocked for other dealership'; end;
  begin insert into storage.objects (bucket_id, name) values ('media', 'not-a-uuid/x.jpg');
        raise exception 'FAIL: wrote to bad path';
  exception when insufficient_privilege then raise notice 'ok: storage write blocked for bad path'; end;
  begin delete from vehicles where stock_number = 'N1001';
        if found then raise exception 'FAIL: sales deleted vehicle'; end if;
        raise notice 'ok: sales cannot delete vehicles';
  end;
end $$;
select pg_temp.check((select count(*) from vehicle_stats) = 3, 'stats view readable');
reset role;
select pg_temp.check((select price from vehicles where vin = '1C4GJXAG5JW150863') = 18500, 'sales update ok');

-- ---------- outsider ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.check((select count(*) from vehicles) = 1, 'outsider sees only public vehicle of other dealer');
select pg_temp.check((select count(*) from shares) = 0, 'outsider cannot see shares');
select pg_temp.check((select count(*) from public.vp_members((select id from dealerships where slug='nsbchevy'))) = 0, 'outsider cannot list roster');
do $$ begin
  begin insert into vehicles (dealership_id, make) select id, 'X' from dealerships where slug = 'nsbchevy';
        raise exception 'FAIL: outsider inserted vehicle';
  exception when insufficient_privilege then raise notice 'ok: outsider cannot insert vehicle'; end;
  begin insert into vehicle_photos (vehicle_id, dealership_id, url)
        select id, (select id from dealerships where slug='otherdealer'), 'x' from vehicles where vin = '1C4GJXAG5JW150863';
        raise exception 'FAIL: outsider attached photo via spoofed dealership_id';
  exception when insufficient_privilege then raise notice 'ok: outsider photo spoof blocked'; end;
end $$;
reset role;

-- ---------- owner ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select pg_temp.check((select count(*) from dealership_settings) = 1, 'owner reads own settings');
select pg_temp.check((select count(*) from public.vp_members((select id from dealerships where slug='nsbchevy'))) = 2, 'owner lists roster');
update dealership_settings set crm_adf_email = 'leads@nsb.eleadtrack.net';
reset role;

-- ---------- record_view (service role) ----------
set role service_role;
select pg_temp.check((public.vp_record_view((select id from vehicles where vin='1C4GJXAG5JW150863'), null, 'visitor1'))->>'recorded' = 'true', 'anonymous view recorded');
select pg_temp.check((public.vp_record_view((select id from vehicles where vin='1C4GJXAG5JW150863'), null, 'visitor1'))->>'reason' = 'duplicate', 'refresh deduped');
select pg_temp.check((public.vp_record_view((select id from vehicles where stock_number='N1001' limit 1), null, 'v'))->>'reason' = 'not_found', 'draft not trackable');
do $$
declare r jsonb; vid uuid; code text;
begin
  select id into vid from vehicles where vin = '1C4GJXAG5JW150863';
  select s.code into code from shares s limit 1;
  r := public.vp_record_view(vid, code, 'cust1', 'sms', 'iPhone');
  perform pg_temp.check(r->>'notify' = 'true', 'first share open notifies salesperson');
  perform pg_temp.check(r->'staff'->>'full_name' = 'Kyleigh Johnson', 'payload includes staff');
  perform pg_temp.check((r->>'open_count')::int = 1, 'open count 1');
  r := public.vp_record_view(vid, code, 'cust1-other-device');
  perform pg_temp.check(r->>'notify' = 'false', 'second open within cooldown does not notify');
  perform pg_temp.check((r->>'open_count')::int = 2, 'open count 2');
  update shares set last_notified_at = now() - interval '2 hours';
  r := public.vp_record_view(vid, code, 'cust1-third');
  perform pg_temp.check(r->>'notify' = 'true', 'open after cooldown notifies again');
end $$;
reset role;

-- ---------- feed sync ----------
set role service_role;
do $$
declare r jsonb; d uuid;
begin
  select id into d from dealerships where slug = 'nsbchevy';
  r := public.vp_feed_sync(d, '[
    {"vin":"1GCUYDED5RZ100001","stock_number":"N2001","year":"2024","make":"Chevrolet","model":"Silverado 1500","trim":"LT","mileage":"12","price":"48995","condition":"new","photos":["https://img.test/1.jpg","https://img.test/2.jpg"],"features":["Heated Seats"]},
    {"vin":"1GCUYDED5RZ100002","stock_number":"N2002","year":"2024","make":"Chevrolet","model":"Tahoe","price":"61000","photos":[]},
    {"vin":"BAD","stock_number":"X"}
  ]'::jsonb, true, true);
  perform pg_temp.check((r->>'inserted')::int = 2, 'feed inserted 2');
  perform pg_temp.check((r->>'skipped')::int = 1, 'feed skipped bad vin');
  perform pg_temp.check((select count(*) from vehicle_photos p join vehicles v on v.id=p.vehicle_id where v.vin='1GCUYDED5RZ100001') = 2, 'feed photos inserted');
  perform pg_temp.check((select features from vehicles where vin='1GCUYDED5RZ100001') = array['Heated Seats'], 'feed features');

  -- price change, Tahoe dropped from feed, manual Jeep untouched (source=manual)
  update vehicles set feed_locked = false where vin = '1GCUYDED5RZ100001';
  insert into vehicle_photos (vehicle_id, url, dealership_id, position, source)
    select id, 'https://my.upload/x.jpg', dealership_id, 99, 'upload' from vehicles where vin='1GCUYDED5RZ100001';
  r := public.vp_feed_sync(d, '[{"vin":"1GCUYDED5RZ100001","price":"47995","photos":["https://img.test/1.jpg","https://img.test/3.jpg"]}]'::jsonb, true, true);
  perform pg_temp.check((r->>'updated')::int = 1 and (r->>'marked_sold')::int = 1, 'feed update + mark missing sold');
  perform pg_temp.check((select price from vehicles where vin='1GCUYDED5RZ100001') = 47995, 'price updated');
  perform pg_temp.check((select model from vehicles where vin='1GCUYDED5RZ100001') = 'Silverado 1500', 'blank feed fields keep existing values');
  perform pg_temp.check((select status from vehicles where vin='1GCUYDED5RZ100002') = 'sold', 'missing unit sold');
  perform pg_temp.check((select status from vehicles where vin='1C4GJXAG5JW150863') = 'published', 'manual vehicle untouched');
  perform pg_temp.check((select count(*) from vehicle_photos p join vehicles v on v.id=p.vehicle_id where v.vin='1GCUYDED5RZ100001') = 1
    and exists (select 1 from vehicle_photos p join vehicles v on v.id=p.vehicle_id where v.vin='1GCUYDED5RZ100001' and p.source='upload'),
    'once the car has photographer photos, a changed feed photo list is not re-added (0013); the upload is kept');

  -- comes back + locked behaviour
  update vehicles set feed_locked = true, price = 1 where vin = '1GCUYDED5RZ100001';
  r := public.vp_feed_sync(d, '[{"vin":"1GCUYDED5RZ100001","price":"40000"},{"vin":"1GCUYDED5RZ100002"}]'::jsonb, true, true);
  perform pg_temp.check((select price from vehicles where vin='1GCUYDED5RZ100001') = 1, 'locked vehicle not overwritten');
  perform pg_temp.check((select status from vehicles where vin='1GCUYDED5RZ100002') = 'published', 'returning unit republished');
end $$;
reset role;

-- ---------- membership guard rails ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
update dealership_members set role = 'admin' where user_id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check((select role from dealership_members where user_id = '00000000-0000-0000-0000-00000000000b') = 'admin', 'owner promotes sales to admin');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update dealership_members set role = 'sales' where user_id = '00000000-0000-0000-0000-00000000000a';
delete from dealership_members where user_id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin update dealership_members set role = 'owner' where user_id = '00000000-0000-0000-0000-00000000000b';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.check((select role from dealership_members where user_id = '00000000-0000-0000-0000-00000000000a') = 'owner', 'admin cannot demote or remove owner');
select pg_temp.check((select role from dealership_members where user_id = '00000000-0000-0000-0000-00000000000b') = 'admin', 'admin cannot self-promote to owner');
set role anon;
select pg_temp.check((select public.vp_share_public((select code from shares where channel='sms' limit 1)))->>'customer_first_name' = 'Mike', 'share public lookup gives first name only');
select pg_temp.check(public.vp_share_public('nope') is null, 'unknown share code returns null');
reset role;
