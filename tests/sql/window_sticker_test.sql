-- Window stickers: pricing stack rules, document source.
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

select pg_temp.check((select price_stack = '[]'::jsonb from vehicles where vin = '1C4GJXAG5JW150863'), 'vehicles start with no pricing stack');
select pg_temp.fails($$update vehicles set price_stack = '[{"kind":"discount","label":"Dealer discount","amount":-500}]' where vin = '1C4GJXAG5JW150863'$$,
  'starting price', 'a stack needs a starting price');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"discount","label":"Dealer discount","amount":500}]' where vin = '1C4GJXAG5JW150863'$$,
  'lower the price', 'discounts must be savings');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"rebate","label":"Loyalty","amount":-500}]' where vin = '1C4GJXAG5JW150863'$$,
  'who qualifies', 'rebates must say who qualifies');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"addon","label":"Tint","amount":-5}]' where vin = '1C4GJXAG5JW150863'$$,
  'raise the price', 'add-ons raise the price');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"coupon","label":"x","amount":-5}]' where vin = '1C4GJXAG5JW150863'$$,
  'discount, rebate or add-on', 'unknown line kind rejected');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"discount","label":" ","amount":-5}]' where vin = '1C4GJXAG5JW150863'$$,
  'needs a name', 'lines need a name');
select pg_temp.fails($$update vehicles set price_stack_base = 20000, price_stack = '[{"kind":"discount","label":"x","amount":"-5"}]' where vin = '1C4GJXAG5JW150863'$$,
  'needs an amount', 'amount must be a number');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update vehicles set price_stack_base = 19995, price_stack_base_label = ' Retail price ',
  price_stack = '[{"kind":"discount","label":"Dealer discount","amount":-1500},{"kind":"rebate","label":"Military rebate","amount":-500,"note":"Active duty and veterans"},{"kind":"addon","label":"Ceramic tint","amount":299}]'
  where vin = '1C4GJXAG5JW150863';
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
update vehicles set price_stack = '[]' where vin = '1C4GJXAG5JW150863';
reset role;
select pg_temp.check((select jsonb_array_length(price_stack) = 3 and price_stack_base_label = 'Retail price' from vehicles where vin = '1C4GJXAG5JW150863'),
  'staff save a valid stack; another dealership cannot clear it');
set role anon;
select pg_temp.check((select price_stack_base = 19995 from vehicles where vin = '1C4GJXAG5JW150863'), 'the pricing stack is public with the vehicle (it is printed on the window)');
reset role;

-- the feed can still change the price; the stack just stops adding up (the sticker then hides it)
select public.vp_feed_sync((select id from dealerships where slug = 'nsbchevy'), '[{"vin":"1C4GJXAG5JW150863","price":"18995"}]'::jsonb, true, false);
select pg_temp.check((select price = 18995 and jsonb_array_length(price_stack) = 3 from vehicles where vin = '1C4GJXAG5JW150863'), 'feed price updates are never blocked by the stack');
update vehicles set price_stack = '[]', price_stack_base = null where vin = '1C4GJXAG5JW150863';

-- documents
insert into vehicle_documents (vehicle_id, kind, title, url, source)
select id, 'window_sticker', 'Original factory window sticker', 'https://x/s.pdf', 'oem' from vehicles where vin = '1C4GJXAG5JW150863';
select pg_temp.check((select source from vehicle_documents where title = 'Original factory window sticker') = 'oem', 'document records it came from the manufacturer');
select pg_temp.fails($$insert into vehicle_documents (vehicle_id, kind, title, url, source) select id, 'other', 'x', 'y', 'scraped' from vehicles limit 1$$,
  'check constraint', 'document source is a known value');
delete from vehicle_documents where title = 'Original factory window sticker';
