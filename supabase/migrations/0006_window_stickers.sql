-- Window stickers: the dealer's own window sticker (with a pricing stack) and the original factory sticker.
-- Safe to run more than once.

-- Pricing stack: how the dealer gets from a starting price to the selling price.
--   price_stack_base        the starting figure, e.g. MSRP 52,495 or a retail price
--   price_stack_base_label  what that figure is called on the sticker ("MSRP", "Retail price")
--   price_stack             [{ "kind": "discount"|"rebate"|"addon", "label": "...", "amount": -1500, "note": "..." }]
-- Discounts and rebates are negative, add-ons positive. A rebate must say who qualifies (note).
-- The sticker shows the stack only while base + adjustments = vehicles.price. If the price changes (for example
-- the hourly feed), the stack stops printing and staff are told to update it; a stale stack is never shown.
alter table public.vehicles add column if not exists price_stack jsonb not null default '[]'::jsonb;
alter table public.vehicles add column if not exists price_stack_base numeric(12,2) check (price_stack_base >= 0);
alter table public.vehicles add column if not exists price_stack_base_label text;

create or replace function public.vp_price_stack_validate() returns trigger
language plpgsql as $$
declare
  i jsonb;
  amt numeric;
begin
  if tg_op = 'UPDATE' and (new.price_stack, new.price_stack_base, new.price_stack_base_label)
     is not distinct from (old.price_stack, old.price_stack_base, old.price_stack_base_label) then
    return new;
  end if;
  if jsonb_typeof(new.price_stack) is distinct from 'array' then raise exception 'The pricing stack must be a list'; end if;
  new.price_stack_base_label := nullif(btrim(new.price_stack_base_label), '');
  if jsonb_array_length(new.price_stack) = 0 then return new; end if;
  if new.price_stack_base is null then raise exception 'Enter the starting price for the pricing stack'; end if;
  if jsonb_array_length(new.price_stack) > 12 then raise exception 'Keep the pricing stack to 12 lines or fewer'; end if;
  for i in select * from jsonb_array_elements(new.price_stack) loop
    if coalesce(i->>'kind', '') not in ('discount', 'rebate', 'addon') then
      raise exception 'Each pricing line must be a discount, rebate or add-on';
    end if;
    if coalesce(btrim(i->>'label'), '') = '' then raise exception 'Each pricing line needs a name'; end if;
    if jsonb_typeof(i->'amount') is distinct from 'number' then raise exception 'Each pricing line needs an amount'; end if;
    amt := (i->>'amount')::numeric;
    if i->>'kind' in ('discount', 'rebate') and amt >= 0 then raise exception 'Discounts and rebates lower the price (enter them as savings)'; end if;
    if i->>'kind' = 'addon' and amt <= 0 then raise exception 'Add-ons raise the price'; end if;
    if i->>'kind' = 'rebate' and coalesce(btrim(i->>'note'), '') = '' then
      raise exception 'Say who qualifies for the "%" rebate', i->>'label';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists vp_price_stack_validate on public.vehicles;
create trigger vp_price_stack_validate before insert or update on public.vehicles
  for each row execute function public.vp_price_stack_validate();

-- Small print at the foot of every dealer window sticker (admins set it in Settings).
alter table public.dealerships add column if not exists sticker_disclaimer text;

-- Where a document came from. 'oem' = fetched from the manufacturer by VIN, 'provider' = a paid sticker service.
alter table public.vehicle_documents add column if not exists source text not null default 'upload'
  check (source in ('upload', 'link', 'oem', 'provider'));
update public.vehicle_documents set source = 'link' where source = 'upload' and storage_path is null;
