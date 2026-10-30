-- Photo banners by year, make and model. Safe to run more than once.
--
-- A dealership admin sets a rule ("2024 to 2026 Chevrolet Silverado 1500: 0% APR FOR 72 MONTHS") and the banner shows
-- across the bottom of the first photo of every matching car, on the vehicle page and the inventory grid. Blank
-- year, make or model means "any". The Lifetime Warranty banner keeps the top of the photo.

create table if not exists public.dealership_banners (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships(id) on delete cascade,
  text          text not null check (length(btrim(text)) between 1 and 40),
  note          text check (note is null or length(note) <= 80),
  year_from     int check (year_from is null or year_from between 1900 and 2100),
  year_to       int check (year_to is null or year_to between 1900 and 2100),
  make          text check (make is null or length(make) <= 40),
  model         text check (model is null or length(model) <= 60),
  condition     text not null default 'any' check (condition in ('any', 'new', 'used')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check (year_from is null or year_to is null or year_from <= year_to)
);
create index if not exists dealership_banners_dealer on public.dealership_banners (dealership_id);

alter table public.dealership_banners enable row level security;
drop policy if exists banners_public_read on public.dealership_banners;
drop policy if exists banners_admin_read on public.dealership_banners;
drop policy if exists banners_admin_write on public.dealership_banners;
-- Shoppers see the banners that are switched on; staff and admins see all of them.
create policy banners_public_read on public.dealership_banners for select using (active);
create policy banners_admin_read on public.dealership_banners for select using (public.vp_is_member(dealership_id));
create policy banners_admin_write on public.dealership_banners for all
  using (public.vp_is_admin(dealership_id)) with check (public.vp_is_admin(dealership_id));
grant select on public.dealership_banners to anon, authenticated;
grant insert, update, delete on public.dealership_banners to authenticated;
