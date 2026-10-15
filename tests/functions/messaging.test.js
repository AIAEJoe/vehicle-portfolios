// Messaging platform tests: crypto, Twilio webhooks, STOP/HELP/START, routing, sending gates,
// email identity, unsubscribe, Resend webhooks, 10DLC runner, number purchase, cost reconciliation.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { fakeSupabase } from './fake-supabase.js';

import { encryptSecret, decryptSecret, signToken, verifyToken, twilioSignature, validSvixRequest } from '../../functions/_lib/crypto.js';
import { smsSegments, keywordOf } from '../../functions/_lib/twilio.js';
import { onRequestPost as inbound } from '../../functions/api/twilio/inbound.js';
import { onRequestPost as statusCb } from '../../functions/api/twilio/status.js';
import { onRequestPost as send } from '../../functions/api/messages/send.js';
import { onRequestGet as unsubscribe } from '../../functions/api/unsubscribe.js';
import { onRequestPost as resendHook } from '../../functions/api/resend/webhook.js';
import { onRequestPost as a2p } from '../../functions/api/platform/a2p.js';
import { onRequestPost as reconcile } from '../../functions/api/platform/reconcile.js';
import { onRequestPost as emailDomain } from '../../functions/api/platform/email-domain.js';
import { onRequestPost as emailInbound } from '../../functions/api/email/inbound.js';
import { onRequestPost as lead } from '../../functions/api/lead.js';
import { plainText } from '../../workers/email-inbound/index.js';

const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), TWILIO_ACCOUNT_SID: 'ACparent', TWILIO_AUTH_TOKEN: 'parent-token',
  TWILIO_FROM: '+18885550000', TWILIO_PRIMARY_CUSTOMER_PROFILE_SID: 'BUprimary', RESEND_API_KEY: 're_test',
  RESEND_WEBHOOK_SECRET: 'whsec_' + randomBytes(24).toString('base64'), PLATFORM_EMAIL_DOMAIN: 'mail.aiautoengine.com',
  INBOUND_EMAIL_DOMAIN: 'reply.aiautoengine.com', INBOUND_EMAIL_SECRET: 'inbound-secret', CRON_SECRET: 'cron', ROOT_DOMAIN: 'aiautoengine.com',
};
const ORIGIN = 'https://nsbchevy.aiautoengine.com';
const D = '11111111-0000-4000-8000-000000000001';
const D2 = '11111111-0000-4000-8000-000000000002';
const S = '22222222-0000-4000-8000-000000000001';
const V = '33333333-0000-4000-8000-000000000001';
const C = '44444444-0000-4000-8000-000000000001';
const USER = { id: 'u-sales', email: 'kyleigh@nsb.test' };
const OPERATOR = { id: 'u-op', email: 'op@aiautoengine.test' };

let fake, tw, rs, SUB_SECRET;

async function seed() {
  SUB_SECRET = await encryptSecret(ENV, 'sub-token');
  return {
    dealerships: [
      { id: D, slug: 'nsbchevy', name: 'New Smyrna Beach Chevrolet', phone: '(386) 427-1313', email: 'sales@nsb.test', address_line: '2375 State Road 44', city: 'New Smyrna Beach', state: 'FL', zip: '32168', brand_primary: '#013C9E' },
      { id: D2, slug: 'otherdealer', name: 'Other Dealer' },
    ],
    platform_settings: [{ id: 1, sms_out_segment_cost: 0.0083, sms_in_segment_cost: 0.0083, sms_carrier_fee_out: 0.0045, sms_carrier_fee_in: 0.003, email_cost: 0.0004, phone_number_monthly: 1.15, campaign_monthly: 10, brand_registration_fee: 46, campaign_vetting_fee: 15 }],
    dealership_billing: [{ dealership_id: D, status: 'active', allow_overage: true, included_sms_segments: 2500 }],
    dealership_settings: [{ dealership_id: D, lead_email: 'internet@nsb.test', crm_adf_email: 'nsb@eleadtrack.net' }],
    messaging_profiles: [
      { dealership_id: D, twilio_subaccount_sid: 'ACsub', twilio_messaging_service_sid: 'MGnsb', twilio_phone_number: '+13865550000', sms_enabled: true,
        a2p_status: 'approved', a2p_step: 'done', email_from_name: 'NSB Chevy', email_from_local: 'sales', email_inbound_alias: 'nsbchevy',
        email_domain_status: 'none', consent_language: 'NSB consent text', a2p_log: [] },
      { dealership_id: D2, a2p_step: 'not_started', a2p_status: 'not_started', email_inbound_alias: 'otherdealer', a2p_log: [], sample_messages: [] },
    ],
    provider_credentials: [{ dealership_id: D, provider: 'twilio', account_sid: 'ACsub', secret_encrypted: SUB_SECRET }],
    staff: [{ id: S, dealership_id: D, full_name: 'Kyleigh Johnson', phone: '(386) 555-0101', email: 'kyleigh@nsb.test', user_id: USER.id, active: true, notify_sms: true, notify_email: true }],
    dealership_members: [{ dealership_id: D, user_id: USER.id, role: 'sales' }],
    platform_admins: [{ user_id: OPERATOR.id }],
    vehicles: [{ id: V, dealership_id: D, slug: '2018-jeep-wrangler-sport-s-r287418b', status: 'published', year: 2018, make: 'Jeep', model: 'Wrangler', trim: 'Sport S', salesperson_id: S }],
    customers: [{ id: C, dealership_id: D, full_name: 'Mike Smith', phone: '+13865550100', email: 'mike@test.com', sms_consent_status: 'unknown', email_opted_out: false, assigned_staff_id: S }],
    shares: [], messages: [], consent_records: [], leads: [], usage_charges: [],
  };
}

function consentTrigger(r, db) {
  const c = db.customers.find((x) => x.id === r.customer_id);
  if (r.channel === 'sms') {
    if (r.action === 'opt_in' && c.sms_consent_status === 'opted_out' && !['inbound_keyword', 'web_form', 'written'].includes(r.method)) {
      throw new Error('This customer texted STOP. They must text START (or opt in on a form) before you can text them again.');
    }
    c.sms_consent_status = r.action === 'opt_in' ? 'opted_in' : 'opted_out';
  } else c.email_opted_out = r.action === 'opt_out';
}

function twilioMock() {
  const calls = [];
  const state = { brand: 'PENDING', campaign: 'IN_PROGRESS', evaluation: 'compliant', n: 0, sendError: null };
  const sid = (p) => `${p}${String(++state.n).padStart(4, '0')}`;
  async function handler(url, opts) {
    const u = new URL(url);
    const params = opts.body ? Object.fromEntries(new URLSearchParams(opts.body).entries()) : {};
    const multi = opts.body ? new URLSearchParams(opts.body) : null;
    calls.push({ host: u.host, path: u.pathname, method: opts.method, params, multi, auth: opts.headers.authorization, headers: opts.headers });
    const p = u.pathname;
    const ok = (d) => new Response(JSON.stringify(d), { status: 201, headers: { 'content-type': 'application/json' } });
    if (p.endsWith('/Messages.json') && opts.method === 'POST') {
      if (state.sendError) return new Response(JSON.stringify(state.sendError), { status: 400 });
      return ok({ sid: sid('SM'), status: 'accepted', num_segments: String(smsSegments(params.Body)) });
    }
    if (/\/Messages\/SM\w+\.json$/.test(p)) return ok({ price: '-0.00830', num_segments: '1' });
    if (p === '/2010-04-01/Accounts.json') return ok({ sid: 'ACnew', auth_token: 'new-sub-token' });
    if (u.host === 'messaging.twilio.com' && p === '/v1/Services') return ok({ sid: sid('MG') });
    if (p.endsWith('/Evaluations')) return ok({ status: state.evaluation, results: state.evaluation === 'compliant' ? [] : [{ friendly_name: 'Business Information', fields: [{ passed: false, friendly_name: 'EIN', failure_reason: 'does not match IRS records' }] }] });
    if (u.host === 'trusthub.twilio.com' && /\/(CustomerProfiles|TrustProducts)\/BU\w+$/.test(p)) return ok({ status: 'pending-review' });
    if (u.host === 'trusthub.twilio.com' && p.endsWith('/EntityAssignments')) return ok({ sid: sid('BV') });
    if (u.host === 'trusthub.twilio.com' && (p === '/v1/CustomerProfiles' || p === '/v1/TrustProducts')) return ok({ sid: sid('BU') });
    if (u.host === 'trusthub.twilio.com' && p === '/v1/EndUsers') return ok({ sid: sid('IT') });
    if (u.host === 'trusthub.twilio.com' && p === '/v1/SupportingDocuments') return ok({ sid: sid('RD') });
    if (p.endsWith('/Addresses.json')) return ok({ sid: sid('AD') });
    if (p === '/v1/a2p/BrandRegistrations') return ok({ sid: 'BN0001', status: 'PENDING' });
    if (p.startsWith('/v1/a2p/BrandRegistrations/')) return ok({ sid: 'BN0001', status: state.brand, failure_reason: 'EIN mismatch' });
    if (/\/Compliance\/Usa2p$/.test(p)) return ok({ sid: 'QE0001', campaign_status: 'IN_PROGRESS' });
    if (/\/Compliance\/Usa2p\/QE\w+$/.test(p)) return ok({ sid: 'QE0001', campaign_status: state.campaign, errors: [] });
    if (p.endsWith('/AvailablePhoneNumbers/US/Local.json')) return ok({ available_phone_numbers: u.searchParams.get('AreaCode') === '999' ? [] : [{ phone_number: '+13865551234' }] });
    if (p.endsWith('/IncomingPhoneNumbers.json')) return ok({ sid: 'PN0001', phone_number: params.PhoneNumber });
    if (/\/Services\/MG\w+\/PhoneNumbers$/.test(p)) return ok({ sid: 'PN0001' });
    return new Response(JSON.stringify({ message: 'twilio mock: unhandled ' + p }), { status: 404 });
  }
  return { calls, state, handler };
}

function resendMock() {
  const calls = [];
  async function handler(url, opts) {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname, method: opts.method, body });
    if (u.pathname === '/emails') return new Response(JSON.stringify({ id: 'em_' + calls.length }), { status: 200 });
    if (u.pathname === '/domains' && opts.method === 'POST') return new Response(JSON.stringify({ id: 'dom_1', status: 'not_started', records: [{ record: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com' }, { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIGf...' }] }), { status: 200 });
    if (u.pathname.endsWith('/verify')) return new Response('{}', { status: 200 });
    if (u.pathname === '/domains/dom_1') return new Response(JSON.stringify({ id: 'dom_1', status: 'verified', records: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }
  return { calls, handler };
}

beforeEach(async () => {
  fake = fakeSupabase(await seed(), {
    users: { 'jwt-sales': USER, 'jwt-op': OPERATOR },
    triggers: { consent_records: consentTrigger },
    rpc: {
      vp_customer_touch: ({ p_customer_id, p_inbound }, db) => {
        const c = db.customers.find((x) => x.id === p_customer_id);
        c.last_message_at = new Date().toISOString();
        if (p_inbound) { c.last_inbound_at = c.last_message_at; c.unread_count = (c.unread_count || 0) + 1; }
        return '';
      },
      vp_usage_summary: (b, db) => ({ sms_segments_total: 10, included_sms_segments: db.dealership_billing[0].included_sms_segments }),
      vp_record_view: () => ({ recorded: true, notify: false }),
    },
  });
  tw = twilioMock();
  rs = resendMock();
  globalThis.fetch = async (url, opts = {}) => {
    const h = new URL(String(url)).host;
    if (h === 'proj.supabase.co') return fake.handler(String(url), opts);
    if (h.endsWith('twilio.com')) return tw.handler(String(url), opts);
    if (h === 'api.resend.com') return rs.handler(String(url), opts);
    throw new Error('unexpected fetch ' + url);
  };
});

const ctx = (request) => ({ request, env: ENV, params: {} });
async function signedTwilio(path, params, token = 'sub-token') {
  const url = `${ORIGIN}${path}`;
  const sig = await twilioSignature(token, url, params);
  return new Request(url, { method: 'POST', body: new URLSearchParams(params).toString(), headers: { 'x-twilio-signature': sig, 'content-type': 'application/x-www-form-urlencoded' } });
}
const authed = (path, body, jwt = 'jwt-sales') => new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' } });

// ------------------------------------------------------------------ crypto
test('secrets are encrypted at rest and tokens are tamper-proof', async () => {
  const enc = await encryptSecret(ENV, 'my-auth-token');
  assert.ok(enc.startsWith('v1:') && !enc.includes('my-auth-token'));
  assert.equal(await decryptSecret(ENV, enc), 'my-auth-token');
  await assert.rejects(decryptSecret({ ...ENV, ENCRYPTION_KEY: randomBytes(32).toString('base64') }, enc));
  const t = await signToken(ENV, { c: C, d: D });
  assert.deepEqual(await verifyToken(ENV, t), { c: C, d: D });
  assert.equal(await verifyToken(ENV, t.slice(0, -2) + 'xx'), null);
});

test('Twilio signature matches an independent HMAC-SHA1', async () => {
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', '12345').update(data).digest('base64');
  assert.equal(await twilioSignature('12345', url, params), expected);
});

test('Svix (Resend) signature verification', async () => {
  const body = '{"type":"email.delivered"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(ENV.RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  const h = new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` });
  assert.equal(await validSvixRequest(ENV.RESEND_WEBHOOK_SECRET, h, body), true);
  assert.equal(await validSvixRequest(ENV.RESEND_WEBHOOK_SECRET, h, body + ' '), false);
  const old = new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': String(Number(ts) - 600), 'svix-signature': `v1,${sig}` });
  assert.equal(await validSvixRequest(ENV.RESEND_WEBHOOK_SECRET, old, body), false);
});

test('segment counting (GSM-7 vs Unicode) and keywords', () => {
  assert.equal(smsSegments('a'.repeat(160)), 1);
  assert.equal(smsSegments('a'.repeat(161)), 2);
  assert.equal(smsSegments('a'.repeat(306)), 2);
  assert.equal(smsSegments('€'.repeat(80)), 1);
  assert.equal(smsSegments('€'.repeat(81)), 2);
  assert.equal(smsSegments('🚗' + 'a'.repeat(68)), 1);
  assert.equal(smsSegments('🚗' + 'a'.repeat(69)), 2);
  assert.equal(keywordOf(' stop '), 'STOP');
  assert.equal(keywordOf('Unsubscribe!'), 'STOP');
  assert.equal(keywordOf('please stop texting me'), null);
  assert.equal(keywordOf('yes'), 'START');
  assert.equal(keywordOf('anything', 'HELP'), 'HELP');
});

// ------------------------------------------------------------------ inbound
const inboundParams = (body, extra = {}) => ({ MessageSid: 'SMin' + Math.random().toString(36).slice(2, 8), AccountSid: 'ACsub', From: '+13865550100', To: '+13865550000', Body: body, NumSegments: '1', NumMedia: '0', ...extra });

test('inbound reply is logged, counted, and routed to the assigned salesperson', async () => {
  const res = await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('Is it still available?'))));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Response><\/Response>/);
  const m = fake.db.messages.find((x) => x.direction === 'inbound');
  assert.equal(m.dealership_id, D);
  assert.equal(m.customer_id, C);
  assert.equal(m.cost_estimate, 0.0083);
  assert.equal(m.staff_id, S);
  assert.equal(fake.db.customers[0].unread_count, 1);
  const alert = fake.db.messages.find((x) => x.purpose === 'reply_alert' && x.channel === 'sms');
  assert.equal(alert.audience, 'staff');
  assert.equal(alert.sender, 'platform', 'staff alerts use the platform sender');
  assert.equal(alert.dealership_id, D, 'but are costed to the dealership');
  const sent = tw.calls.find((c) => c.path.endsWith('/Messages.json'));
  assert.equal(sent.params.From, ENV.TWILIO_FROM);
  assert.match(sent.params.Body, /Mike Smith replied: "Is it still available\?"/);
  assert.match(sent.params.StatusCallback, /\/api\/twilio\/status\?m=/);
  const email = rs.calls.find((c) => c.path === '/emails');
  assert.deepEqual(email.body.to, ['kyleigh@nsb.test']);
});

test('inbound from an unknown number creates a customer and falls back to the store inbox', async () => {
  fake.db.customers = [];
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('Hi, saw your ad', { From: '+13865550999' }))));
  assert.equal(fake.db.customers.length, 1);
  assert.equal(fake.db.customers[0].dealership_id, D);
  assert.equal(fake.db.customers[0].phone, '+13865550999');
  assert.deepEqual(rs.calls[0].body.to, ['internet@nsb.test']);
});

test('inbound: bad signature, wrong subaccount, duplicates are rejected', async () => {
  const bad = await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('hi'), 'wrong-token')));
  assert.equal(bad.status, 403);
  const wrongAcct = await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('hi', { AccountSid: 'ACother' }))));
  assert.equal(wrongAcct.status, 403);
  const p = inboundParams('hello');
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', p)));
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', p)));
  assert.equal(fake.db.messages.filter((m) => m.direction === 'inbound').length, 1);
});

test('STOP opts out with evidence and no salesperson alert; START opts back in; HELP is left to Twilio', async () => {
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('STOP'))));
  assert.equal(fake.db.customers[0].sms_consent_status, 'opted_out');
  const rec = fake.db.consent_records[0];
  assert.equal(rec.method, 'inbound_keyword');
  assert.equal(rec.keyword, 'STOP');
  assert.equal(rec.recorded_by, null);
  assert.equal(tw.calls.length, 0, 'no alert text for STOP');
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('HELP'))));
  assert.equal(tw.calls.length, 0);
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('START'))));
  assert.equal(fake.db.customers[0].sms_consent_status, 'opted_in');
  assert.equal(fake.db.consent_records.length, 2);
});

test('"Yes" from a customer who never opted out is a normal reply, not a keyword', async () => {
  await inbound(ctx(await signedTwilio('/api/twilio/inbound', inboundParams('Yes'))));
  assert.equal(fake.db.consent_records.length, 0);
  assert.ok(tw.calls.some((c) => /replied: "Yes"/.test(c.params.Body)), 'routed to salesperson');
});

// ------------------------------------------------------------------ status callbacks
test('delivery status updates, never regresses, and reconciles real price', async () => {
  fake.db.messages.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', dealership_id: D, customer_id: C, channel: 'sms', direction: 'outbound', sender: 'dealership', provider: 'twilio', provider_message_id: 'SM9', status: 'accepted', provider_cost: null, cost_estimate: 0.0083, carrier_fee: 0.0045 });
  const path = '/api/twilio/status?m=aaaaaaaa-0000-4000-8000-000000000001';
  await statusCb(ctx(await signedTwilio(path, { MessageSid: 'SM9', MessageStatus: 'delivered', AccountSid: 'ACsub' })));
  const m = fake.db.messages[0];
  assert.equal(m.status, 'delivered');
  assert.equal(m.provider_cost, 0.0083, 'actual price fetched');
  await statusCb(ctx(await signedTwilio(path, { MessageSid: 'SM9', MessageStatus: 'sent', AccountSid: 'ACsub' })));
  assert.equal(m.status, 'delivered', 'late "sent" does not overwrite "delivered"');
  const forged = await statusCb(ctx(await signedTwilio(path, { MessageSid: 'SM9', MessageStatus: 'failed' }, 'parent-token')));
  assert.equal(forged.status, 403, 'dealership messages must be signed by that dealership subaccount');
});

test('error 21610 marks the customer opted out', async () => {
  fake.db.messages.push({ id: 'aaaaaaaa-0000-4000-8000-000000000002', dealership_id: D, customer_id: C, channel: 'sms', direction: 'outbound', sender: 'dealership', provider: 'twilio', provider_message_id: 'SM10', status: 'accepted', provider_cost: null });
  await statusCb(ctx(await signedTwilio('/api/twilio/status?m=aaaaaaaa-0000-4000-8000-000000000002', { MessageSid: 'SM10', MessageStatus: 'failed', ErrorCode: '21610' })));
  assert.equal(fake.db.messages[0].error_message, 'Recipient has opted out (STOP)');
  assert.equal(fake.db.customers[0].sms_consent_status, 'opted_out');
});

// ------------------------------------------------------------------ sending
test('texting a customer without consent is blocked', async () => {
  const res = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'portfolio_share', vehicle_id: V, customer_id: C })));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /permission/);
  assert.equal(fake.db.shares.length, 0, 'no share created when blocked');
  assert.equal(tw.calls.length, 0);
});

test('salesperson attests consent → evidence saved → share created → sent from the dealership number', async () => {
  const res = await send(ctx(authed('/api/messages/send', {
    channel: 'sms', kind: 'portfolio_share', vehicle_id: V, customer: { name: 'Sarah Lee', phone: '386-555-0177' },
    consent: { attested: true, text: 'Customer said yes on the phone' },
  })));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  const cust = fake.db.customers.find((c) => c.phone === '+13865550177');
  assert.equal(cust.dealership_id, D);
  assert.equal(cust.assigned_staff_id, S);
  const rec = fake.db.consent_records[0];
  assert.equal(rec.method, 'verbal_attested');
  assert.equal(rec.recorded_by, USER.id);
  assert.equal(rec.staff_id, S);
  assert.equal(rec.consent_text, 'Customer said yes on the phone');
  const share = fake.db.shares[0];
  assert.equal(share.customer_id, cust.id);
  const call = tw.calls.find((c) => c.path === '/2010-04-01/Accounts/ACsub/Messages.json');
  assert.ok(call, 'sent through the dealership subaccount');
  assert.equal(call.auth, 'Basic ' + btoa('ACsub:sub-token'));
  assert.equal(call.params.MessagingServiceSid, 'MGnsb');
  assert.match(call.params.Body, new RegExp(`Hi Sarah, it's Kyleigh at New Smyrna Beach Chevrolet\\. .*${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b\\?s=${share.code || ''}`));
  assert.match(call.params.Body, /Reply STOP to opt out\.$/, 'first text carries opt-out notice');
  const msg = fake.db.messages.find((m) => m.direction === 'outbound');
  assert.equal(msg.audience, 'customer');
  assert.equal(msg.from_address, '+13865550000');
  assert.ok(msg.provider_message_id.startsWith('SM'));
  assert.equal(msg.sent_by, USER.id);

  // second text to the same customer: no repeated STOP footer
  tw.calls.length = 0;
  await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: cust.id, body: 'See you at 10!' })));
  assert.equal(tw.calls[0].params.Body, 'See you at 10!');
});

test('a customer who texted STOP cannot be re-opted-in by a salesperson', async () => {
  fake.db.customers[0].sms_consent_status = 'opted_out';
  const res = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: C, body: 'hi', consent: { attested: true } })));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /texted STOP/);
  assert.equal(tw.calls.length, 0);
});

test('replying inside the customer-initiated conversation window is allowed', async () => {
  fake.db.customers[0].last_inbound_at = new Date(Date.now() - 3600e3).toISOString();
  const res = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: C, body: 'Yes it is!' })));
  assert.equal(res.status, 200);
});

test('texting is off until 10DLC approval, and other dealerships\' customers are unreachable', async () => {
  fake.db.messaging_profiles[0].sms_enabled = false;
  fake.db.customers[0].sms_consent_status = 'opted_in';
  const res = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: C, body: 'hi' })));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /10DLC/);
  fake.db.customers.push({ id: '44444444-0000-4000-8000-000000000002', dealership_id: D2, full_name: 'X', phone: '+13865550123', sms_consent_status: 'opted_in' });
  const other = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: '44444444-0000-4000-8000-000000000002', body: 'hi' })));
  assert.equal(other.status, 404);
});

test('allowance cap pauses texting when overage is off', async () => {
  fake.db.customers[0].sms_consent_status = 'opted_in';
  fake.db.dealership_billing[0].allow_overage = false;
  fake.db.dealership_billing[0].included_sms_segments = 10; // rpc reports 10 used
  const res = await send(ctx(authed('/api/messages/send', { channel: 'sms', kind: 'conversation', customer_id: C, body: 'hi' })));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /included texts/);
});

test('email comes from the dealership identity with a tracked reply address and unsubscribe', async () => {
  const res = await send(ctx(authed('/api/messages/send', { channel: 'email', kind: 'portfolio_share', vehicle_id: V, customer_id: C })));
  assert.equal(res.status, 200, await res.clone().text());
  const e = rs.calls.find((c) => c.path === '/emails').body;
  assert.equal(e.from, 'NSB Chevy via Vehicle Portfolios <nsbchevy@mail.aiautoengine.com>');
  assert.equal(e.reply_to, `nsbchevy+${C.slice(0, 8)}@reply.aiautoengine.com`);
  assert.match(e.headers['List-Unsubscribe'], /\/api\/unsubscribe\?t=/);
  assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(e.html, /View the 2018 Jeep Wrangler Sport S/);
  assert.match(e.html, /Unsubscribe from New Smyrna Beach Chevrolet emails/);
  // verified domain → dealership's own From
  fake.db.messaging_profiles[0].email_domain = 'mail.newsmyrnachevy.com';
  fake.db.messaging_profiles[0].email_domain_status = 'verified';
  await send(ctx(authed('/api/messages/send', { channel: 'email', kind: 'conversation', customer_id: C, body: 'Thanks!' })));
  assert.equal(rs.calls.filter((c) => c.path === '/emails').at(-1).body.from, 'NSB Chevy <sales@mail.newsmyrnachevy.com>');
});

test('unsubscribe link records an email opt-out; tampered links fail', async () => {
  const t = await signToken(ENV, { c: C, d: D });
  const res = await unsubscribe(ctx(new Request(`${ORIGIN}/api/unsubscribe?t=${encodeURIComponent(t)}`)));
  assert.match(await res.text(), /unsubscribed\. New Smyrna Beach Chevrolet won/);
  assert.equal(fake.db.customers[0].email_opted_out, true);
  assert.equal(fake.db.consent_records[0].method, 'email_unsubscribe');
  const bad = await unsubscribe(ctx(new Request(`${ORIGIN}/api/unsubscribe?t=${encodeURIComponent(t + 'x')}`)));
  assert.equal(bad.status, 400);
  const blocked = await send(ctx(authed('/api/messages/send', { channel: 'email', kind: 'conversation', customer_id: C, body: 'hi' })));
  assert.equal(blocked.status, 409);
});

test('Resend webhook: delivered, then spam complaint opts the customer out', async () => {
  fake.db.messages.push({ id: 'm-e1', dealership_id: D, customer_id: C, channel: 'email', audience: 'customer', provider: 'resend', provider_message_id: 'em_9', status: 'sent' });
  const post = async (type) => {
    const body = JSON.stringify({ type, data: { email_id: 'em_9' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(ENV.RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64')).update(`id1.${ts}.${body}`).digest('base64');
    return resendHook(ctx(new Request(`${ORIGIN}/api/resend/webhook`, { method: 'POST', body, headers: { 'svix-id': 'id1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } })));
  };
  await post('email.delivered');
  assert.equal(fake.db.messages[0].status, 'delivered');
  await post('email.complained');
  assert.equal(fake.db.messages[0].status, 'complained');
  assert.equal(fake.db.customers[0].email_opted_out, true);
  const unsigned = await resendHook(ctx(new Request(`${ORIGIN}/api/resend/webhook`, { method: 'POST', body: '{}' })));
  assert.equal(unsigned.status, 403);
});

test('inbound email reply is logged against the right dealership and forwarded to the salesperson', async () => {
  const res = await emailInbound(ctx(new Request(`${ORIGIN}/api/email/inbound`, {
    method: 'POST', headers: { 'x-inbound-secret': 'inbound-secret' },
    body: JSON.stringify({ to: `nsbchevy+${C.slice(0, 8)}@reply.aiautoengine.com`, from: 'Mike <mike@test.com>', subject: 'Re: Jeep', text: 'Can I come Saturday?' }),
  })));
  assert.deepEqual(await res.json(), { forward_to: 'kyleigh@nsb.test' });
  const m = fake.db.messages[0];
  assert.equal(m.dealership_id, D);
  assert.equal(m.customer_id, C);
  assert.equal(m.direction, 'inbound');
  const denied = await emailInbound(ctx(new Request(`${ORIGIN}/api/email/inbound`, { method: 'POST', body: '{}' })));
  assert.equal(denied.status, 403);
  assert.equal(plainText('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nSee you Saturday=21\n\nOn Tue, Oct 14 Kyleigh wrote:\n> old'), 'See you Saturday!');
});

test('test-drive form with the SMS box checked stores web-form consent', async () => {
  const res = await lead(ctx(new Request(`${ORIGIN}/api/lead`, {
    method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'iPhone' },
    body: JSON.stringify({ name: 'Ana Ruiz', phone: '386-555-0144', vehicle_id: V, sms_consent: true, consent_text: 'NSB consent text', page_url: `${ORIGIN}/v/x` }),
  })));
  assert.equal(res.status, 200, await res.clone().text());
  const c = fake.db.customers.find((x) => x.phone === '+13865550144');
  assert.equal(c.sms_consent_status, 'opted_in');
  const rec = fake.db.consent_records[0];
  assert.deepEqual([rec.method, rec.ip_address, rec.consent_text, rec.source_url], ['web_form', '203.0.113.9', 'NSB consent text', `${ORIGIN}/v/x`]);
  assert.equal(fake.db.leads[0].customer_id, c.id);
  assert.equal(fake.db.leads[0].sms_consent, true);
  const adf = fake.db.messages.find((m) => m.purpose === 'crm_adf');
  assert.equal(adf.audience, 'crm');
  assert.equal(adf.dealership_id, D);
});

// ------------------------------------------------------------------ 10DLC onboarding
function fillBusinessInfo(p) {
  Object.assign(p, {
    legal_name: 'Other Dealer LLC', ein: '12-3456789', website_url: 'https://otherdealer.com', street: '1 Main St', city: 'Deland', region: 'FL', postal_code: '32720',
    rep_first_name: 'Pat', rep_last_name: 'Lee', rep_email: 'pat@otherdealer.com', rep_phone: '386-555-0000', rep_title: 'GM',
    campaign_description: 'Customer care texts', message_flow: 'Web form checkbox', sample_messages: ['Hi', 'Hello'],
  });
}

test('10DLC runner: refuses to start with missing business info', async () => {
  const res = await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'run' }, 'jwt-op')));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Legal business name|EIN/);
  assert.equal(fake.db.provider_credentials.length, 2, 'subaccount provisioned before the check');
});

test('10DLC runner: subaccount → profile → trust product → brand, then waits for review', async () => {
  fillBusinessInfo(fake.db.messaging_profiles[1]);
  const res = await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'run' }, 'jwt-op')));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  const p = fake.db.messaging_profiles[1];
  assert.equal(p.twilio_subaccount_sid, 'ACnew');
  assert.ok(p.twilio_messaging_service_sid.startsWith('MG'));
  const cred = fake.db.provider_credentials.find((c) => c.dealership_id === D2);
  assert.ok(cred.secret_encrypted.startsWith('v1:') && !cred.secret_encrypted.includes('new-sub-token'), 'subaccount token encrypted');
  assert.equal(await decryptSecret(ENV, cred.secret_encrypted), 'new-sub-token');
  assert.equal(p.a2p_step, 'wait_brand');
  assert.equal(p.a2p_status, 'brand_pending');
  assert.equal(p.a2p_brand_sid, 'BN0001');
  const svc = tw.calls.find((c) => c.path === '/v1/Services');
  assert.equal(svc.params.InboundRequestUrl, `${ORIGIN}/api/twilio/inbound`);
  const biz = tw.calls.find((c) => c.path === '/v1/EndUsers' && c.params.Type === 'customer_profile_business_information');
  assert.deepEqual(JSON.parse(biz.params.Attributes).business_registration_number, '123456789');
  assert.ok(tw.calls.some((c) => c.params.ObjectSid === 'BUprimary'), 'linked to your primary profile');
  assert.ok(tw.calls.filter((c) => c.host === 'trusthub.twilio.com' || c.path.includes('a2p')).every((c) => c.auth === 'Basic ' + btoa('ACnew:new-sub-token')), 'registration runs inside the subaccount');
  assert.ok(fake.db.usage_charges.some((c) => c.kind === 'brand_registration' && c.provider_cost === 46 && c.dealership_id === D2));
  assert.ok(p.a2p_log.length >= 18);

  // brand approved → campaign registered with privacy/terms URLs → still waiting on campaign
  tw.state.brand = 'APPROVED';
  await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'run' }, 'jwt-op')));
  assert.equal(p.a2p_step, 'wait_campaign');
  const camp = tw.calls.find((c) => /Compliance\/Usa2p$/.test(c.path));
  assert.equal(camp.params.PrivacyPolicyUrl, 'https://otherdealer.aiautoengine.com/sms-terms#privacy');
  assert.equal(camp.params.TermsAndConditionsUrl, 'https://otherdealer.aiautoengine.com/sms-terms');
  assert.deepEqual(camp.multi.getAll('MessageSamples'), ['Hi', 'Hello']);
  assert.equal(camp.headers['X-Twilio-Api-Version'], 'v1.2');

  // number purchase, then campaign verified → texting on
  await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'buy_number', area_code: '386' }, 'jwt-op')));
  assert.equal(p.twilio_phone_number, '+13865551234');
  assert.equal(p.sms_enabled, false, 'not enabled before campaign approval');
  tw.state.campaign = 'VERIFIED';
  await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'refresh' }, 'jwt-op')));
  assert.equal(p.a2p_status, 'approved');
  assert.equal(p.sms_enabled, true);
});

test('10DLC runner: Twilio evaluation problems stop the run with a clear reason', async () => {
  fillBusinessInfo(fake.db.messaging_profiles[1]);
  tw.state.evaluation = 'noncompliant';
  await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D2, action: 'run' }, 'jwt-op')));
  const p = fake.db.messaging_profiles[1];
  assert.equal(p.a2p_status, 'action_needed');
  assert.equal(p.a2p_step, 'evaluate_profile', 'resumes from the failed step');
  assert.match(p.a2p_last_error, /EIN \(does not match IRS records\)/);
});

test('platform endpoints are operator-only', async () => {
  const res = await a2p(ctx(authed('/api/platform/a2p', { dealership_id: D, action: 'run' }, 'jwt-sales')));
  assert.equal(res.status, 403);
});

test('email domain: dealership admin adds domain, gets DNS records, verifies', async () => {
  fake.db.dealership_members.push({ dealership_id: D, user_id: 'u-admin', role: 'admin' });
  fake.db.__users = 1;
  const res = await emailDomain(ctx(authed('/api/platform/email-domain', { dealership_id: D, action: 'create', domain: 'https://Mail.NewSmyrnaChevy.com/' }, 'jwt-op')));
  assert.equal(res.status, 200, await res.clone().text());
  const p = fake.db.messaging_profiles[0];
  assert.equal(p.email_domain, 'mail.newsmyrnachevy.com');
  assert.equal(p.email_dns_records.length, 2);
  assert.equal(p.email_domain_status, 'pending');
  await emailDomain(ctx(authed('/api/platform/email-domain', { dealership_id: D, action: 'verify' }, 'jwt-op')));
  assert.equal(p.email_domain_status, 'verified');
  const sales = await emailDomain(ctx(authed('/api/platform/email-domain', { dealership_id: D, action: 'verify' }, 'jwt-sales')));
  assert.equal(sales.status, 403, 'sales role cannot change sender domain');
});

test('daily reconcile books real prices and monthly fixed fees once', async () => {
  fake.db.messaging_profiles[0].twilio_phone_sid = 'PNnsb';
  fake.db.messaging_profiles[0].a2p_campaign_sid = 'QEnsb';
  fake.db.messaging_profiles[0].a2p_campaign_status = 'VERIFIED';
  fake.db.messages.push({ id: 'm1', dealership_id: D, sender: 'dealership', provider: 'twilio', provider_message_id: 'SMa', status: 'delivered', provider_cost: null, created_at: '2026-01-01T00:00:00Z' });
  const run = () => reconcile(ctx(new Request(`${ORIGIN}/api/platform/reconcile`, { method: 'POST', headers: { authorization: 'Bearer cron' } })));
  const out = await (await run()).json();
  assert.equal(out.priced, 1);
  assert.equal(fake.db.messages[0].provider_cost, 0.0083);
  assert.deepEqual(fake.db.usage_charges.map((c) => [c.kind, c.provider_cost]).sort(), [['campaign_monthly', 10], ['phone_number', 1.15]]);
  await run();
  assert.equal(fake.db.usage_charges.length, 2, 'monthly fees are idempotent');
});
