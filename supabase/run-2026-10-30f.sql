-- Vehicle Portfolios: photographers print window stickers and Buyers Guides. Safe to run more than once.
-- Paste into Supabase → SQL Editor → Run. Same as supabase/migrations/0010_photographer_print.sql.

-- Photographers print window stickers and Buyers Guides. Safe to run more than once.
--
-- The dealer window sticker needs two things a photographer can't read or write directly: the CHOMES facts that
-- print on the window (CHOMES also holds recon cost and notes) and the car's tracked QR link. These two functions
-- hand over exactly that, to anyone allowed to shoot the dealership's cars, and nothing more.

-- The customer-safe part of a car's CHOMES record: what stickerStory() prints. Never recon cost, acquisition notes,
-- the demand note, inspector or provenance.
create or replace function public.vp_sticker_chomes(p_vehicle_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'highlight_features', c.highlight_features, 'options_packages', c.options_packages,
    'report_provider', c.report_provider, 'prior_owners', c.prior_owners, 'accidents_count', c.accidents_count,
    'accidents_summary', c.accidents_summary, 'service_records', c.service_records,
    'title_issues', c.title_issues, 'title_issue_detail', c.title_issue_detail, 'generation_note', c.generation_note,
    'review_required', c.review_required, 'review_cleared_at', c.review_cleared_at)
  from public.vehicle_chomes c
  where c.vehicle_id = p_vehicle_id and public.vp_can_shoot(c.dealership_id)
$$;
revoke execute on function public.vp_sticker_chomes(uuid) from public, anon;
grant execute on function public.vp_sticker_chomes(uuid) to authenticated;

-- The car's QR window link (the same tracked link the QR window card uses), created on first use.
create or replace function public.vp_qr_share(p_vehicle_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v public.vehicles;
  c text;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if v.id is null or not public.vp_can_shoot(v.dealership_id) then raise exception 'Vehicle not found'; end if;
  select code into c from public.shares where vehicle_id = v.id and channel = 'qr' order by created_at limit 1;
  if c is null then
    insert into public.shares (vehicle_id, dealership_id, channel, customer_name, created_by)
    values (v.id, v.dealership_id, 'qr', 'QR window card', auth.uid())
    returning code into c;
  end if;
  return c;
end $$;
revoke execute on function public.vp_qr_share(uuid) from public, anon;
grant execute on function public.vp_qr_share(uuid) to authenticated;
