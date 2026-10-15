-- Messaging platform: tenant isolation, consent rules, credential secrecy, usage/billing math.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ff', 'platform@aiautoengine.test');
select public.vp_add_platform_admin('platform@aiautoengine.test');

select pg_temp.check((select count(*) from dealership_billing) = 2, 'billing plan auto-created for each dealership');
select pg_temp.check((select monthly_fee from dealership_billing b join dealerships d on d.id=b.dealership_id where d.slug='nsbchevy') = 995, 'default $995 plan');
select pg_temp.check((select email_inbound_alias from messaging_profiles m join dealerships d on d.id=m.dealership_id where d.slug='nsbchevy') = 'nsbchevy', 'messaging profile auto-created');

-- service role sets up NSB as live, with a secret
update messaging_profiles set twilio_subaccount_sid = 'ACnsb', twilio_phone_number = '+13865550000', sms_enabled = true, a2p_status = 'approved'
  where dealership_id = (select id from dealerships where slug='nsbchevy');
insert into provider_credentials (dealership_id, provider, account_sid, secret_encrypted)
  select id, 'twilio', 'ACnsb', 'v1:ciphertext' from dealerships where slug='nsbchevy';

-- customers + messages for both dealerships
insert into customers (id, dealership_id, full_name, phone, sms_consent_status)
  select '00000000-0000-0000-0000-00000000c001', id, 'Mike Smith', '(386) 555-0100', 'unknown' from dealerships where slug='nsbchevy';
insert into customers (id, dealership_id, full_name, phone)
  select '00000000-0000-0000-0000-00000000c002', id, 'Mike Smith', '386-555-0100' from dealerships where slug='otherdealer';
select pg_temp.check((select phone from customers where id='00000000-0000-0000-0000-00000000c001') = '+13865550100', 'phone normalised to E.164');

insert into messages (dealership_id, customer_id, channel, direction, audience, purpose, segments, cost_estimate, provider_cost, carrier_fee, provider, provider_message_id, status, created_at)
select d.id, '00000000-0000-0000-0000-00000000c001', 'sms', 'outbound', 'customer', 'portfolio_share', 2, 0.0166, 0.0166, 0.009, 'twilio', 'SM1', 'delivered', now()
from dealerships d where d.slug='nsbchevy';
insert into messages (dealership_id, customer_id, channel, direction, audience, segments, cost_estimate, carrier_fee, provider, provider_message_id, status)
select d.id, '00000000-0000-0000-0000-00000000c001', 'sms', 'inbound', 'customer', 1, 0.0083, 0.003, 'twilio', 'SM2', 'received' from dealerships d where d.slug='nsbchevy';
insert into messages (dealership_id, channel, direction, audience, purpose, segments, cost_estimate, carrier_fee, provider, provider_message_id, status, sender)
select d.id, 'sms', 'outbound', 'staff', 'open_alert', 1, 0.0083, 0.0045, 'twilio', 'SM3', 'delivered', 'platform' from dealerships d where d.slug='nsbchevy';
insert into messages (dealership_id, channel, direction, audience, purpose, cost_estimate, provider, provider_message_id, status)
select d.id, 'email', 'outbound', 'customer', 'portfolio_share', 0.0004, 'resend', 'em1', 'delivered' from dealerships d where d.slug='nsbchevy';
-- last month's message must not count
insert into messages (dealership_id, channel, direction, segments, cost_estimate, provider, provider_message_id, status, created_at)
select d.id, 'sms', 'outbound', 50, 0.4, 'twilio', 'SMold', 'delivered', now() - interval '45 days' from dealerships d where d.slug='nsbchevy';
insert into messages (dealership_id, customer_id, channel, direction, segments, provider, provider_message_id, status)
select d.id, '00000000-0000-0000-0000-00000000c002', 'sms', 'outbound', 1, 'twilio', 'SMother', 'delivered' from dealerships d where d.slug='otherdealer';
insert into usage_charges (dealership_id, month, kind, ref, description, provider_cost)
select id, date_trunc('month', (now() at time zone 'America/New_York'))::date, 'phone_number', 'PN1', 'Phone number', 1.15 from dealerships where slug='nsbchevy';
insert into usage_charges (dealership_id, month, kind, ref, description, provider_cost)
select id, date_trunc('month', (now() at time zone 'America/New_York'))::date, 'campaign_monthly', 'CM1', '10DLC campaign', 10 from dealerships where slug='nsbchevy';

-- ---------- tenant isolation ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';   -- NSB admin (promoted earlier)
select pg_temp.check((select count(*) from customers) = 1, 'NSB staff see only NSB customers');
select pg_temp.check((select count(*) from messages) = 5, 'NSB staff see only NSB messages');
select pg_temp.check((select count(*) from messaging_profiles) = 1, 'NSB admin sees only its sender identity');
do $$ begin
  begin perform * from provider_credentials; exception when insufficient_privilege then raise notice 'ok: credentials table not even selectable'; end;
end $$;
select pg_temp.check((select count(*) from usage_charges) = 0, 'raw cost ledger is platform-only');
select pg_temp.check((select count(*) from platform_settings) = 0, 'rate card is platform-only');

-- dealer admin can edit business info but not provider IDs / approval
update messaging_profiles set legal_name = 'NSB Chevrolet LLC', ein = '12-3456789', twilio_phone_number = '+19999999999', sms_enabled = true, a2p_status = 'not_started';
reset role;
select pg_temp.check((select legal_name from messaging_profiles where twilio_subaccount_sid='ACnsb') = 'NSB Chevrolet LLC', 'dealer edits business info');
select pg_temp.check((select twilio_phone_number from messaging_profiles where twilio_subaccount_sid='ACnsb') = '+13865550000', 'dealer cannot change sender number');
select pg_temp.check((select a2p_status from messaging_profiles where twilio_subaccount_sid='ACnsb') = 'approved', 'dealer cannot change registration status');

-- ---------- consent ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update customers set sms_consent_status = 'opted_in' where id = '00000000-0000-0000-0000-00000000c001';
reset role;
select pg_temp.check((select sms_consent_status from customers where id='00000000-0000-0000-0000-00000000c001') = 'unknown', 'staff cannot flip consent directly');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
insert into consent_records (dealership_id, customer_id, channel, action, method, consent_text)
  select dealership_id, id, 'sms', 'opt_in', 'verbal_attested', 'May we text you about this vehicle?' from customers where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.check((select sms_consent_status from customers where id='00000000-0000-0000-0000-00000000c001') = 'opted_in', 'verbal attestation records opt-in');
select pg_temp.check((select recorded_by from consent_records limit 1) = '00000000-0000-0000-0000-00000000000b', 'consent records who attested');
do $$ begin
  begin insert into consent_records (dealership_id, customer_id, channel, action, method)
          select dealership_id, id, 'sms', 'opt_in', 'inbound_keyword' from customers limit 1;
        raise exception 'FAIL: staff forged a keyword opt-in';
  exception when insufficient_privilege then raise notice 'ok: staff cannot forge keyword/web consent'; end;
  begin insert into consent_records (dealership_id, customer_id, channel, action, method, recorded_by)
          select dealership_id, id, 'sms', 'opt_in', 'verbal_attested', '00000000-0000-0000-0000-00000000000a' from customers limit 1;
        raise exception 'FAIL: staff attested as someone else';
  exception when insufficient_privilege then raise notice 'ok: cannot attest as another user'; end;
end $$;
update consent_records set consent_text = 'tampered';
delete from consent_records;
reset role;
select pg_temp.check((select count(*) from consent_records where consent_text = 'May we text you about this vehicle?') = 1, 'consent records are append-only');

-- STOP via server, then staff cannot override with verbal consent
set role service_role;
insert into consent_records (dealership_id, customer_id, channel, action, method, keyword, recorded_by)
  select dealership_id, id, 'sms', 'opt_out', 'inbound_keyword', 'STOP', null from customers where id = '00000000-0000-0000-0000-00000000c001';
reset role;
select pg_temp.check((select sms_consent_status from customers where id='00000000-0000-0000-0000-00000000c001') = 'opted_out', 'STOP opts out');
select pg_temp.check((select sms_consent_status from customers where id='00000000-0000-0000-0000-00000000c002') = 'unknown', 'STOP at one dealership does not affect another');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  begin insert into consent_records (dealership_id, customer_id, channel, action, method)
          select dealership_id, id, 'sms', 'opt_in', 'verbal_attested' from customers where id = '00000000-0000-0000-0000-00000000c001';
        raise exception 'FAIL: verbal consent overrode STOP';
  exception when raise_exception then raise notice 'ok: verbal consent cannot override STOP'; end;
end $$;
reset role;
set role service_role;
insert into consent_records (dealership_id, customer_id, channel, action, method, keyword, recorded_by)
  select dealership_id, id, 'sms', 'opt_in', 'inbound_keyword', 'START', null from customers where id = '00000000-0000-0000-0000-00000000c001';
reset role;
select pg_temp.check((select sms_consent_status from customers where id='00000000-0000-0000-0000-00000000c001') = 'opted_in', 'START re-opts in');

-- ---------- usage & billing ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare u jsonb;
begin
  u := public.vp_usage_summary((select id from dealerships where slug='nsbchevy'));
  perform pg_temp.check((u->>'sms_segments_total')::int = 4, 'segments this month: 2 out + 1 in + 1 staff alert');
  perform pg_temp.check((u->>'emails_sent')::int = 1, 'emails counted');
  perform pg_temp.check((u->>'invoice_total')::numeric = 995, 'within allowance: invoice = subscription');
  perform pg_temp.check(not (u ? 'cost_total') and not (u ? 'margin'), 'dealer does not see your costs or margin');
end $$;
do $$ begin
  begin perform public.vp_usage_summary((select id from dealerships where slug='otherdealer'));
        raise exception 'FAIL: read other dealer usage';
  exception when insufficient_privilege then raise notice 'ok: cannot read another dealership usage'; end;
  begin perform public.vp_platform_overview();
        raise exception 'FAIL: dealer read platform overview';
  exception when insufficient_privilege then raise notice 'ok: platform overview is operator-only'; end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ff';   -- platform operator
do $$
declare u jsonb; o jsonb;
begin
  u := public.vp_usage_summary((select id from dealerships where slug='nsbchevy'));
  -- sms: (0.0166+0.009) + (0.0083+0.003) + (0.0083+0.0045) = 0.0497 ; email 0.0004 ; fixed 11.15
  perform pg_temp.check((u->>'cost_sms')::numeric = 0.0497, 'sms provider cost incl. carrier fees: ' || (u->>'cost_sms'));
  perform pg_temp.check((u->>'cost_total')::numeric = 11.20, 'total provider cost incl. number + campaign: ' || (u->>'cost_total'));
  perform pg_temp.check((u->>'margin')::numeric = 983.80, 'margin inside $995: ' || (u->>'margin'));
  o := public.vp_platform_overview();
  perform pg_temp.check(jsonb_array_length(o) = 2, 'operator sees every dealership');
  perform pg_temp.check((select count(*) from customers) = 2, 'operator has support access to all customers');
end $$;
-- allowance exceeded: set a tiny allowance and pass-through fees
update dealership_billing set included_sms_segments = 1, included_emails = 0, pass_through_fixed_fees = true
  where dealership_id = (select id from dealerships where slug='nsbchevy');
do $$
declare u jsonb;
begin
  u := public.vp_usage_summary((select id from dealerships where slug='nsbchevy'));
  -- 3 segments over * 0.04 = 0.12 ; 1 email * 0.005 = 0.005 → 0.125 ; + fixed 11.15 = 11.275 → 11.28 (rounded 2dp)
  perform pg_temp.check((u->>'sms_overage_segments')::int = 3, 'overage segments');
  perform pg_temp.check((u->>'overage_amount')::numeric = 11.28, 'overage amount incl. pass-through: ' || (u->>'overage_amount'));
  perform pg_temp.check((u->>'invoice_total')::numeric = 1006.28, 'invoice total');
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update dealership_billing set monthly_fee = 1;
reset role;
select pg_temp.check((select monthly_fee from dealership_billing b join dealerships d on d.id=b.dealership_id where d.slug='nsbchevy') = 995, 'dealer cannot change own plan');

-- mark read
update customers set unread_count = 3 where id = '00000000-0000-0000-0000-00000000c001';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select public.vp_mark_read('00000000-0000-0000-0000-00000000c001');
do $$ begin
  begin perform public.vp_mark_read('00000000-0000-0000-0000-00000000c002'); raise exception 'FAIL: marked other dealer read';
  exception when insufficient_privilege then raise notice 'ok: cannot touch other dealership conversation'; end;
end $$;
reset role;
select pg_temp.check((select unread_count from customers where id='00000000-0000-0000-0000-00000000c001') = 0, 'conversation marked read');
