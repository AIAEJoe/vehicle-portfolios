// Unit tests for Cloudflare Pages Functions. Run: node --test tests/functions/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { parseDelimited, feedToRows } from '../../functions/_lib/inventory.js';
import { buildAdf } from '../../functions/_lib/adf.js';
import { parseListing } from '../../functions/_lib/listing.js';
import { mapVpic, mapRecalls } from '../../functions/_lib/nhtsa.js';
import { dealerSlugFromHost } from '../../functions/_lib/util.js';
import { normalizeUsPhone } from '../../functions/_lib/notify.js';
import { onRequest as middleware } from '../../functions/_middleware.js';
import { onRequestPost as leadPost } from '../../functions/api/lead.js';
import { onRequestPost as trackPost } from '../../functions/api/track.js';
import { onRequestPost as ingestPost } from '../../functions/api/inventory/ingest.js';
import { onRequestPost as syncPost } from '../../functions/api/inventory/sync.js';
import { onRequestPost as invitePost } from '../../functions/api/invite.js';
import { onRequestGet as photoFeedGet } from '../../functions/api/feeds/photos.js';

const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  RESEND_API_KEY: 're_x', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+13865550000',
  CRON_SECRET: 'cron-secret', ROOT_DOMAIN: 'aiautoengine.com', DEFAULT_DEALER: 'nsbchevy',
};
const DEALER = { id: 'd1', slug: 'nsbchevy', name: 'New Smyrna Beach Chevrolet', logo_url: '/seed/nsb-logo.png' };
const VEHICLE = { id: '11111111-1111-1111-1111-111111111111', dealership_id: 'd1', slug: '2018-jeep-wrangler-sport-s-r287418b', year: 2018,
  make: 'Jeep', model: 'Wrangler', trim: 'Sport S', vin: '1C4GJXAG5JW150863', stock_number: 'R287418B', price: 17800,
  mileage: 81273, condition: 'used', exterior_color: 'Black Clearcoat', salesperson_id: 's1', status: 'published' };
const STAFF = { id: 's1', full_name: 'Kyleigh Johnson', email: 'kyleigh@nsb.test', phone: '(386) 555-0101', notify_sms: true, notify_email: true };

// ---------- fetch mock ----------
let calls = [];
let routes = [];
function mock(match, respond) { routes.push({ match, respond }); }
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const call = { url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
  calls.push(call);
  for (const r of routes) {
    if (typeof r.match === 'string' ? url.includes(r.match) : r.match(url, call)) {
      const out = await r.respond(url, call);
      if (out instanceof Response) return out;
      return new Response(out === undefined ? '' : JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 404 });
};
beforeEach(() => { calls = []; routes = []; });
const req = (url, init = {}) => new Request(url, init);
const ctx = (request, extra = {}) => ({ request, env: ENV, params: {}, waitUntil: undefined, ...extra });
const sent = (frag) => calls.filter((c) => c.url.includes(frag));

// ---------- pure libs ----------
test('host to dealer slug', () => {
  assert.equal(dealerSlugFromHost('nsbchevy.aiautoengine.com', ENV), 'nsbchevy');
  assert.equal(dealerSlugFromHost('otherdealer.aiautoengine.com:443', ENV), 'otherdealer');
  assert.equal(dealerSlugFromHost('vehicle-portfolios.pages.dev', ENV), 'nsbchevy');
  assert.equal(dealerSlugFromHost('www.aiautoengine.com', ENV), 'nsbchevy');
});

test('phone normalisation', () => {
  assert.equal(normalizeUsPhone('(386) 427-1313'), '+13864271313');
  assert.equal(normalizeUsPhone('1-386-427-1313'), '+13864271313');
  assert.equal(normalizeUsPhone('123'), null);
});

test('HomeNet CSV feed parsing', () => {
  const csv = '﻿"DealerId","Type","Stock","VIN","Year","Make","Model","Trim","ExteriorColor","Miles","SellingPrice","Internet Price","MSRP","Options","ImageList","Certified","Description"\r\n' +
    '"1234","Used","R287418B","1C4GJXAG5JW150863","2018","JEEP","Wrangler","Sport S","Black Clearcoat","81,273","$18,900","$17,800","","Bluetooth,Cruise Control,""Premium"" Audio","https://img.test/a.jpg,https://img.test/b.jpg","False","Nice, clean ""Jeep""\nwith a new line"\r\n' +
    '"1234","New","N1","1GCUYDED5RZ100001","2024","Chevrolet","Silverado 1500","LT","Summit White","12","","","52000","","https://img.test/c.jpg|https://img.test/d.jpg","",""\r\n' +
    '"9999","Used","X1","1GCUYDED5RZ100009","2020","Chevrolet","Malibu","LS","Red","50000","15000","","","","","True",""\r\n' +
    '"1234","Used","DUP","1C4GJXAG5JW150863","2018","Jeep","Wrangler","","","","","","","","","",""\r\n';
  const { rows, totalLines } = feedToRows(csv, { dealerId: '1234' });
  assert.equal(totalLines, 4);
  assert.equal(rows.length, 2, 'filters DealerId and duplicate VIN');
  const jeep = rows[0];
  assert.equal(jeep.make, 'Jeep');
  assert.equal(jeep.mileage, 81273);
  assert.equal(jeep.price, 17800, 'internet price preferred over selling price');
  assert.equal(jeep.condition, 'used');
  assert.deepEqual(jeep.photos, ['https://img.test/a.jpg', 'https://img.test/b.jpg']);
  assert.deepEqual(jeep.features, ['Bluetooth', 'Cruise Control', '"Premium" Audio']);
  assert.equal(jeep.description, 'Nice, clean "Jeep"\nwith a new line');
  const silverado = rows[1];
  assert.equal(silverado.condition, 'new');
  assert.equal(silverado.price, null);
  assert.equal(silverado.msrp, 52000);
  assert.deepEqual(silverado.photos, ['https://img.test/c.jpg', 'https://img.test/d.jpg']);
  const all = feedToRows(csv).rows;
  assert.equal(all.find((r) => r.vin === '1GCUYDED5RZ100009').condition, 'certified');
});

test('tab-delimited vAuto-style feed', () => {
  const tsv = 'VIN\tStock #\tYear\tMake\tModel\tOdometer\tPrice\tPhoto URLs\n1C4GJXAG5JW150863\tR1\t2018\tJeep\tWrangler\t1000\t20000\thttps://x.test/1.jpg https://x.test/2.jpg\n';
  const { rows } = feedToRows(tsv);
  assert.equal(rows[0].stock_number, 'R1');
  assert.equal(rows[0].mileage, 1000);
  assert.equal(rows[0].photos.length, 2);
  assert.equal(parseDelimited('').length, 0);
});

test('ADF/XML is well-formed and complete', () => {
  const xml = buildAdf({
    lead: { id: 'L1', name: 'Mike & Sue Smith', phone: '3865550100', email: 'mike@test.com', kind: 'test_drive', preferred_date: '2026-10-20', preferred_time: 'Morning', message: 'Is it <still> available?' },
    vehicle: VEHICLE, dealership: DEALER, staff: STAFF, portfolioUrl: 'https://nsbchevy.aiautoengine.com/v/x',
  });
  for (const s of ['<?adf version="1.0"?>', '<vin>1C4GJXAG5JW150863</vin>', '<stock>R287418B</stock>', '<name part="first">Mike &amp; Sue</name>',
    '<name part="last">Smith</name>', '<price type="asking" currency="USD">17800</price>', 'Kyleigh Johnson', 'Is it &lt;still&gt; available?']) {
    assert.ok(xml.includes(s), `ADF contains ${s}`);
  }
  // validate XML with python's parser
  execFileSync('python3', ['-c', 'import sys,xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.read().encode())'], { input: xml });
});

test('listing import parses JSON-LD and photos', () => {
  const page = `<html><head><title>Used 2018 Jeep Wrangler Sport S</title>
    <meta property="og:image" content="https://pictures.dealer.com/n/nsb/0001/abc.jpg?impolicy=resize">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"AutoDealer","name":"NSB"},
      {"@type":["Product","Car"],"name":"2018 Jeep Wrangler Sport S","vehicleIdentificationNumber":"1C4GJXAG5JW150863","brand":{"@type":"Brand","name":"Jeep"},
       "model":"Wrangler","vehicleConfiguration":"Sport S","color":"Black Clearcoat","mileageFromOdometer":{"value":"81273","unitCode":"SMI"},
       "vehicleEngine":{"name":"3.6L V6 24V VVT"},"driveWheelConfiguration":"4WD","sku":"R287418B","itemCondition":"https://schema.org/UsedCondition",
       "offers":{"@type":"Offer","price":"17800","priceCurrency":"USD"},"image":["https://pictures.dealer.com/n/nsb/0001/abc.jpg","https://pictures.dealer.com/n/nsb/0001/def.jpg"]}]}</script>
    </head><body><img src="https://pictures.dealer.com/n/nsb/logo.png"><img src="https://pictures.dealer.com/n/nsb/0001/ghi.jpg"></body></html>`;
  const v = parseListing(page, 'https://www.newsmyrnachevy.com/inventory/x/');
  assert.equal(v.vin, '1C4GJXAG5JW150863');
  assert.equal(v.make, 'Jeep');
  assert.equal(v.model, 'Wrangler');
  assert.equal(v.trim, 'Sport S');
  assert.equal(v.year, 2018);
  assert.equal(v.mileage, 81273);
  assert.equal(v.price, 17800);
  assert.equal(v.condition, 'used');
  assert.equal(v.engine, '3.6L V6 24V VVT');
  assert.equal(v.stock_number, 'R287418B');
  assert.deepEqual(v.photos, ['https://pictures.dealer.com/n/nsb/0001/abc.jpg', 'https://pictures.dealer.com/n/nsb/0001/def.jpg', 'https://pictures.dealer.com/n/nsb/0001/ghi.jpg']);
});

test('listing import skips dealer promo banners and cleans a full-name trim', () => {
  const vin = '1G1YB3D45T5107735';
  const page = `<html><head><script type="application/ld+json">{"@type":"Car","name":"Used 2026 Chevrolet Corvette Stingray 2LT Convertible",
      "vehicleIdentificationNumber":"${vin}","brand":"Chevrolet","model":"Corvette Stingray","vehicleConfiguration":"Used 2026 Chevrolet Corvette Stingray 2LT Convertible",
      "bodyType":"Convertible","vehicleModelDate":"2026"}</script></head><body>
    <img src="https://pictures.dealer.com/n/nsb/0001/${vin}a.jpg"><img src="https://pictures.dealer.com/n/nsb/0001/${vin}b.jpg">
    <img src="https://pictures.dealer.com/n/nsb/0002/lower-prices-banner.jpg"><img src="https://pictures.dealer.com/n/nsb/0003/specials/start-here.jpg"></body></html>`;
  const v = parseListing(page, 'https://www.newsmyrnachevy.com/inventory/x/');
  assert.deepEqual(v.photos, [`https://pictures.dealer.com/n/nsb/0001/${vin}a.jpg`, `https://pictures.dealer.com/n/nsb/0001/${vin}b.jpg`]);
  assert.equal(v.trim, '2LT');

  // No VIN in the photo names: still drop images named like banners/specials
  const page2 = page.replaceAll(vin, 'X').replace('"vehicleIdentificationNumber":"X"', `"vehicleIdentificationNumber":"${vin}"`);
  const v2 = parseListing(page2, 'https://www.newsmyrnachevy.com/inventory/x/');
  assert.deepEqual(v2.photos, ['https://pictures.dealer.com/n/nsb/0001/Xa.jpg', 'https://pictures.dealer.com/n/nsb/0001/Xb.jpg']);
});

test('listing import falls back to page text', () => {
  const v = parseListing('<html><head><meta property="og:title" content="2021 Chevrolet Tahoe LT"></head><body>VIN: 1GNSKNKD1MR100001 Stock #: T5521 42,100 miles</body></html>', 'https://x.test/');
  assert.equal(v.vin, '1GNSKNKD1MR100001');
  assert.equal(v.year, 2021);
  assert.equal(v.make, 'Chevrolet');
  assert.equal(v.model, 'Tahoe');
  assert.equal(v.stock_number, 'T5521');
  assert.equal(v.mileage, 42100);
});

test('NHTSA mapping', () => {
  const v = mapVpic({ ErrorCode: '0', VIN: '1C4GJXAG5JW150863', ModelYear: '2018', Make: 'JEEP', Model: 'Wrangler', Trim: 'Sport S', BodyClass: 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)',
    DriveType: '4WD/4-Wheel Drive/4x4', EngineCylinders: '6', DisplacementL: '3.6', EngineConfiguration: 'V-Shaped', TransmissionStyle: 'Automatic', TransmissionSpeeds: '8', FuelTypePrimary: 'Gasoline', Doors: '2', EngineHP: '285' });
  assert.equal(v.make, 'Jeep');
  assert.equal(v.engine, '3.6L V6');
  assert.equal(v.transmission, '8-Speed Automatic');
  assert.equal(v.specs.Horsepower, '285 hp');
  assert.equal(mapRecalls({ results: [{ NHTSACampaignNumber: '18V1', Component: 'AIR BAGS', Summary: 's', Remedy: 'r' }] })[0].campaign, '18V1');
});

// ---------- middleware ----------
test('middleware injects config and OG tags for portfolio pages', async () => {
  mock('/rest/v1/vehicles', () => [{ ...VEHICLE, dealerships: DEALER, vehicle_photos: [{ url: '/seed/jeep-01.jpg', position: 0 }] }]);
  const page = '<html><head><title>Vehicle Portfolios</title></head><body></body></html>';
  const res = await middleware({
    request: req('https://nsbchevy.aiautoengine.com/v/2018-jeep-wrangler-sport-s-r287418b?s=abc'), env: ENV,
    next: async () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const out = await res.text();
  assert.ok(out.includes('window.VP_CONFIG={"supabaseUrl":"https://proj.supabase.co","supabaseAnonKey":"anon","dealer":"nsbchevy","rootDomain":"aiautoengine.com"}'));
  assert.ok(out.includes('<meta property="og:image" content="https://nsbchevy.aiautoengine.com/seed/jeep-01.jpg">'));
  assert.ok(out.includes('<title>2018 Jeep Wrangler Sport S | New Smyrna Beach Chevrolet</title>'));
  assert.ok(out.includes('$17,800 · 81,273 miles'));
  assert.equal((out.match(/<title>/g) || []).length, 1);
  assert.ok(!calls[0].url.includes('service'), 'uses anon key');
  assert.equal(calls[0].headers.apikey, 'anon');
});

test('middleware leaves non-HTML alone', async () => {
  const res = await middleware({ request: req('https://nsbchevy.aiautoengine.com/x.json'), env: ENV, next: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(await res.text(), '{}');
});

// ---------- lead ----------
function mockSupabaseForLead(store) {
  mock((u) => u.includes('/rest/v1/dealerships'), () => [DEALER]);
  mock((u) => u.includes('/rest/v1/vehicles'), () => [VEHICLE]);
  mock((u) => u.includes('/rest/v1/shares'), () => [{ id: 'sh1', staff_id: 's1' }]);
  mock((u, c) => u.includes('/rest/v1/leads') && c.method === 'GET', () => store.dupes || []);
  mock((u, c) => u.includes('/rest/v1/leads') && c.method === 'POST', (u, c) => { store.lead = { id: 'L1', ...JSON.parse(c.body) }; return [store.lead]; });
  mock((u, c) => u.includes('/rest/v1/leads') && c.method === 'PATCH', (u, c) => { store.patch = JSON.parse(c.body); return ''; });
  mock((u) => u.includes('/rest/v1/dealership_settings'), () => [{ lead_email: 'sales@nsb.test, gm@nsb.test', crm_adf_email: 'nsb@eleadtrack.net' }]);
  mock((u) => u.includes('/rest/v1/staff'), () => [STAFF]);
  mock('api.resend.com', (u, c) => { (store.emails ||= []).push(JSON.parse(c.body)); return { id: 'e' }; });
  mock('api.twilio.com', (u, c) => { (store.sms ||= []).push(new URLSearchParams(c.body)); return { sid: 'SM' }; });
  mockMessaging(store);
}

// shared mocks for the messaging layer (customers, consent, message log, rate card)
function mockMessaging(store) {
  mock((u) => u.includes('/rest/v1/messaging_profiles'), () => [{ dealership_id: 'd1', email_inbound_alias: 'nsbchevy' }]);
  mock((u) => u.includes('/rest/v1/platform_settings'), () => [{ sms_out_segment_cost: 0.0083, sms_carrier_fee_out: 0.0045, email_cost: 0.0004 }]);
  mock((u, c) => u.includes('/rest/v1/customers') && c.method === 'GET', () => []);
  mock((u, c) => u.includes('/rest/v1/customers') && c.method === 'POST', (u, c) => [{ id: 'c1', ...JSON.parse(c.body) }]);
  mock((u) => u.includes('/rest/v1/consent_records'), (u, c) => { (store.consents ||= []).push(JSON.parse(c.body)); return [{ id: 'cr1' }]; });
  mock((u, c) => u.includes('/rest/v1/messages') && c.method === 'POST', (u, c) => { const m = { id: 'm' + ((store.log ||= []).length + 1), ...JSON.parse(c.body) }; store.log.push(m); return [m]; });
  mock((u, c) => u.includes('/rest/v1/messages') && c.method === 'PATCH', () => '');
}

test('lead: saves, emails dealership + salesperson, sends ADF to Elead, texts salesperson', async () => {
  const store = {};
  mockSupabaseForLead(store);
  const res = await leadPost(ctx(req('https://nsbchevy.aiautoengine.com/api/lead', {
    method: 'POST', body: JSON.stringify({ name: 'Mike Smith', phone: '386-555-0100', email: 'mike@test.com', preferred_date: '2026-10-20', preferred_time: 'Morning', vehicle_id: VEHICLE.id, share_code: 'abc12345' }),
  })));
  assert.equal(res.status, 200);
  assert.equal(store.lead.share_id, 'sh1');
  assert.equal(store.lead.staff_id, 's1');
  assert.equal(store.lead.dealership_id, 'd1');
  assert.equal(store.emails.length, 2);
  assert.deepEqual(store.emails[0].to.sort(), ['gm@nsb.test', 'kyleigh@nsb.test', 'sales@nsb.test']);
  assert.equal(store.emails[0].reply_to, 'mike@test.com');
  assert.deepEqual(store.emails[1].to, ['nsb@eleadtrack.net']);
  assert.ok(store.emails[1].text.startsWith('<?xml'));
  assert.ok(store.emails[1].text.includes('<vin>1C4GJXAG5JW150863</vin>'));
  assert.equal(store.sms[0].get('To'), '+13865550101');
  assert.match(store.sms[0].get('Body'), /Test drive request from Mike Smith/);
  assert.ok(store.patch.crm_sent_at && store.patch.email_sent_at);
  assert.deepEqual(store.log.map((m) => m.purpose).sort(), ['crm_adf', 'lead_alert', 'lead_notification'], 'every notification is logged + costed');
  assert.ok(store.log.every((m) => m.dealership_id === 'd1'));
  // service key used for writes
  assert.equal(sent('/rest/v1/leads').find((c) => c.method === 'POST').headers.authorization, 'Bearer service');
});

test('lead: validation, honeypot, duplicates', async () => {
  const store = { dupes: [{ id: 'old' }] };
  mockSupabaseForLead(store);
  const post = (body) => leadPost(ctx(req('https://nsbchevy.aiautoengine.com/api/lead', { method: 'POST', body: JSON.stringify(body) })));
  assert.equal((await post({ name: '', phone: '1' })).status, 400);
  assert.equal((await post({ name: 'A' })).status, 400);
  assert.equal((await post({ name: 'A', email: 'bad' })).status, 400);
  const hp = await post({ name: 'Bot', phone: '1', website: 'spam.com' });
  assert.equal(hp.status, 200);
  const dup = await (await post({ name: 'A', phone: '386', vehicle_id: VEHICLE.id })).json();
  assert.equal(dup.duplicate, true);
  assert.equal(store.lead, undefined, 'nothing inserted');
});

// ---------- track ----------
test('track: records view and alerts salesperson by text + email', async () => {
  const store = {};
  mock('/rest/v1/rpc/vp_record_view', (u, c) => {
    store.rpc = JSON.parse(c.body);
    return { recorded: true, notify: true, open_count: 3, share: { customer_name: 'Mike Smith', customer_phone: '386-555-0100' }, staff: STAFF, vehicle: VEHICLE };
  });
  mock('api.resend.com', (u, c) => { (store.emails ||= []).push(JSON.parse(c.body)); return { id: 'e' }; });
  mock('api.twilio.com', (u, c) => { (store.sms ||= []).push(new URLSearchParams(c.body)); return { sid: 'SM1', status: 'accepted' }; });
  mock((u) => u.includes('/rest/v1/dealerships'), () => [DEALER]);
  mockMessaging(store);
  const res = await trackPost(ctx(req('https://nsbchevy.aiautoengine.com/api/track', {
    method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    body: JSON.stringify({ vehicle_id: VEHICLE.id, share_code: 'abc12345', visitor_id: 'v1' }),
  })));
  assert.deepEqual(await res.json(), { recorded: true });
  assert.equal(store.rpc.p_share_code, 'abc12345');
  assert.match(store.sms[0].get('Body'), /^Mike Smith just opened the 2018 Jeep Wrangler Sport S portfolio \(3rd view\)\. Call or text them now: 386-555-0100\./);
  assert.equal(store.emails[0].subject, 'Mike Smith just opened the 2018 Jeep Wrangler Sport S (3rd view)');
  assert.equal(store.sms[0].get('From'), '+13865550000', 'staff alerts go out from the platform sender');
  const logged = store.log.find((m) => m.channel === 'sms');
  assert.deepEqual([logged.audience, logged.purpose, logged.dealership_id, logged.sender], ['staff', 'open_alert', 'd1', 'platform']);
});

test('track: ignores link-preview bots', async () => {
  const res = await trackPost(ctx(req('https://x.aiautoengine.com/api/track', {
    method: 'POST', headers: { 'user-agent': 'facebookexternalhit/1.1' }, body: JSON.stringify({ vehicle_id: VEHICLE.id }),
  })));
  assert.equal((await res.json()).reason, 'bot');
  assert.equal(calls.length, 0);
});

// ---------- inventory ----------
const FEED = 'VIN,Stock,Year,Make,Model,Miles,SellingPrice,ImageList\n' +
  '1C4GJXAG5JW150863,R1,2018,Jeep,Wrangler,1,100,https://i.test/1.jpg\n1GCUYDED5RZ100001,N1,2024,Chevrolet,Silverado,2,200,\n1GCUYDED5RZ100002,N2,2024,Chevrolet,Tahoe,3,300,\n';

function mockFeedSupabase(store, settings = {}) {
  mock((u) => u.includes('/rest/v1/dealerships'), () => [DEALER]);
  mock((u, c) => u.includes('/rest/v1/dealership_settings') && c.method === 'GET', () => [{ feed_ingest_token: 'secret-token', feed_url: 'https://feeds.homenet.test/nsb.csv', feed_auto_publish: true, feed_mark_missing_sold: true, ...settings }]);
  mock((u, c) => u.includes('/rest/v1/dealership_settings') && c.method === 'PATCH', (u, c) => { store.saved = JSON.parse(c.body); return ''; });
  mock('/rest/v1/rpc/vp_feed_sync', (u, c) => { store.rpc = JSON.parse(c.body); return { inserted: 3, updated: 0, marked_sold: 0, rows: 3 }; });
  mock('/auth/v1/user', (u, c) => (c.headers.authorization === 'Bearer user-jwt' ? { id: 'u1' } : new Response('{}', { status: 401 })));
  mock('/rest/v1/dealership_members', () => [{ role: 'admin' }]);
}

test('ingest: relay upload with token', async () => {
  const store = {};
  mockFeedSupabase(store);
  const res = await ingestPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/ingest?token=secret-token', { method: 'POST', body: FEED, headers: { 'content-type': 'text/csv' } })));
  assert.equal(res.status, 200);
  assert.equal(store.rpc.p_rows.length, 3);
  assert.equal(store.rpc.p_dealership_id, 'd1');
  assert.equal(store.rpc.p_mark_missing_sold, true);
  assert.equal(store.saved.feed_last_result.source, 'relay upload');
});

test('ingest: wrong token and no session is rejected', async () => {
  mockFeedSupabase({});
  const res = await ingestPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/ingest?token=nope', { method: 'POST', body: FEED })));
  assert.equal(res.status, 401);
});

test('ingest: admin multipart upload', async () => {
  const store = {};
  mockFeedSupabase(store);
  const fd = new FormData();
  fd.set('file', new Blob([FEED], { type: 'text/csv' }), 'feed.csv');
  const res = await ingestPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/ingest', { method: 'POST', body: fd, headers: { authorization: 'Bearer user-jwt' } })));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(store.saved.feed_last_result.source, 'manual upload');
});

test('sync: cron secret pulls the feed URL; tiny files never mass-mark sold', async () => {
  const store = {};
  mockFeedSupabase(store, { feed_auth_header: 'Basic abc' });
  mock('feeds.homenet.test', (u, c) => { store.feedAuth = c.headers.authorization; return new Response('VIN\n1C4GJXAG5JW150863\n'); });
  const res = await syncPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/sync', { method: 'POST', headers: { authorization: 'Bearer cron-secret' } })));
  assert.equal(res.status, 200);
  assert.equal(store.feedAuth, 'Basic abc');
  assert.equal(store.rpc.p_mark_missing_sold, false);
  const denied = await syncPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/sync', { method: 'POST', headers: { authorization: 'Bearer wrong' } })));
  assert.equal(denied.status, 401);
});

test('sync: feed URL error is recorded', async () => {
  const store = {};
  mockFeedSupabase(store);
  mock('feeds.homenet.test', () => new Response('nope', { status: 403 }));
  const res = await syncPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/sync', { method: 'POST', headers: { authorization: 'Bearer cron-secret' } })));
  assert.equal(res.status, 502);
  assert.match(store.saved.feed_last_result.error, /403/);
});

// ---------- invite ----------
test('invite: admin invites new user and links salesperson', async () => {
  const store = {};
  mockFeedSupabase(store);
  mock('/auth/v1/invite', (u, c) => { store.invite = { url: u, body: JSON.parse(c.body) }; return { id: 'new-user' }; });
  mock((u, c) => u.includes('/rest/v1/dealership_members?on_conflict'), (u, c) => { store.member = JSON.parse(c.body); return ''; });
  mock((u, c) => u.includes('/rest/v1/staff'), (u, c) => { store.staff = { u, body: JSON.parse(c.body) }; return ''; });
  routes.unshift(routes.pop(), routes.pop()); // give the specific routes priority
  const res = await invitePost(ctx(req('https://nsbchevy.aiautoengine.com/api/invite', {
    method: 'POST', headers: { authorization: 'Bearer user-jwt' }, body: JSON.stringify({ email: 'New@NSB.test', role: 'sales', staff_id: 's1' }),
  })));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(store.invite.body.email, 'new@nsb.test');
  assert.ok(store.invite.url.includes('redirect_to=https%3A%2F%2Fnsbchevy.aiautoengine.com%2Fadmin%2Faccount'));
  assert.deepEqual(store.member, { dealership_id: 'd1', user_id: 'new-user', role: 'sales' });
  assert.deepEqual(store.staff.body, { user_id: 'new-user' });
});

// ---------- SFTP To Go inventory feed ----------
import { onRequestPost as sftpPost, validSftpToGoSignature } from '../../functions/api/inventory/sftp.js';
import { signedS3Request } from '../../functions/_lib/s3.js';

const SFTP_ENV = { ...ENV, SFTPTOGO_WEBHOOK_SECRET: 'Very Secret Secret', SFTPTOGO_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  SFTPTOGO_SECRET_ACCESS_KEY: 'secret/key', SFTPTOGO_BUCKET: 'sftptogo-bucket' };
async function hubSig(secret, body) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('SFTP To Go signature matches their documented test vector', async () => {
  const sig = 'sha256=8ba4c47558de1872150c3ec82211c34bf0cbd6d60fc4f9875b97853af06de917';
  assert.equal(await validSftpToGoSignature('Very Secret Secret', 'Hello! This is a test payload.', sig), true);
  assert.equal(await validSftpToGoSignature('Very Secret Secret', 'Hello! This is a test payload!', sig), false);
  assert.equal(await validSftpToGoSignature('', 'x', sig), false);
});

test('S3 request is signed for the right host and path', async () => {
  const r = await signedS3Request({ bucket: 'b1', key: 'nsbchevy/Inventory File.csv', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', now: new Date('2026-10-17T12:00:00Z') });
  assert.equal(r.url, 'https://b1.s3.amazonaws.com/nsbchevy/Inventory%20File.csv');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20261017\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('SFTP upload from Dealer Inspire imports the dealership inventory', async () => {
  const csv = 'VIN,Stock,Type,Year,Make,Model,Price,Miles,ImageList\n1G1YY23P6P5100917,PL17115B,Used,1993,Chevrolet,Corvette,16896,56974,https://img/1.jpg|https://img/2.jpg\n2C3CDXBG7FH874715,C1,Used,2015,Dodge,Charger,12995,90000,\n1GNSKNKD1MR100099,T5521,Used,2021,Chevrolet,Tahoe,48995,42100,';
  let synced = null; let patched = null;
  mock((u) => u.includes('/rest/v1/dealerships?slug=eq.nsbchevy'), () => [DEALER]);
  mock((u) => u.includes('/rest/v1/dealerships?slug=eq.'), () => []);
  mock('/rest/v1/dealership_settings?dealership_id=eq.d1&select', () => [{ dealership_id: 'd1', feed_auto_publish: true, feed_mark_missing_sold: true }]);
  mock((u, c) => u.includes('/rest/v1/dealership_settings') && c.method === 'PATCH', (u, c) => { patched = JSON.parse(c.body); return ''; });
  mock('/rest/v1/rpc/vp_feed_sync', (u, c) => { synced = JSON.parse(c.body); return { inserted: 2, updated: 1, marked_sold: 0 }; });
  mock((u) => u.startsWith('https://sftptogo-bucket.s3.amazonaws.com/'), (u, c) => {
    assert.match(c.headers.authorization, /Credential=AKIDEXAMPLE\//);
    return u.endsWith('/nsbchevy/inventory.csv') ? new Response(csv) : new Response('NoSuchKey', { status: 404 });
  });
  const body = JSON.stringify({ Id: 'e1', Topic: 'file.created', Actor: { Type: 'User', Id: 'nsbchevy' }, Resource: 'File', Data: { Path: 'inventory.csv', Size: csv.length } });
  const res = await sftpPost(ctx(req('https://nsbchevy.aiautoengine.com/api/inventory/sftp', { method: 'POST', body, headers: { 'x-hub-signature': await hubSig('Very Secret Secret', body) } }), { env: SFTP_ENV }));
  assert.equal(res.status, 204);
  assert.ok(synced, 'feed sync ran');
  assert.equal(synced.p_dealership_id, 'd1');
  assert.equal(synced.p_rows.length, 3);
  assert.deepEqual(synced.p_rows[0].photos, ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.equal(patched.feed_last_result.source, 'sftp: inventory.csv');
});

test('SFTP webhook rejects bad signatures and ignores non-feed events', async () => {
  const body = JSON.stringify({ Topic: 'file.created', Actor: { Type: 'User', Id: 'nsbchevy' }, Data: { Path: 'inventory.csv' } });
  const bad = await sftpPost(ctx(req('https://x.aiautoengine.com/api/inventory/sftp', { method: 'POST', body, headers: { 'x-hub-signature': 'sha256=00' } }), { env: SFTP_ENV }));
  assert.equal(bad.status, 401);
  const ping = JSON.stringify({ Topic: 'webhook.ping', Data: {} });
  const ok = await sftpPost(ctx(req('https://x.aiautoengine.com/api/inventory/sftp', { method: 'POST', body: ping, headers: { 'x-hub-signature': await hubSig('Very Secret Secret', ping) } }), { env: SFTP_ENV }));
  assert.equal(ok.status, 204);
  const folder = JSON.stringify({ Topic: 'file.created', Actor: { Type: 'User', Id: 'nsbchevy' }, Data: { Path: 'archive/' } });
  const r2 = await sftpPost(ctx(req('https://x.aiautoengine.com/api/inventory/sftp', { method: 'POST', body: folder, headers: { 'x-hub-signature': await hubSig('Very Secret Secret', folder) } }), { env: SFTP_ENV }));
  assert.equal(r2.status, 204);
  assert.equal(sent('s3.amazonaws.com').length, 0, 'folders are not downloaded');
});

// ---------- photo feed for third-party sites ----------
function mockPhotoFeed(store = {}) {
  mock((u) => u.includes('/rest/v1/dealerships'), () => [DEALER]);
  mock((u) => u.includes('/rest/v1/dealership_settings'), () => [{ photo_feed_token: 'photo-token', feed_ingest_token: 'secret-token' }]);
  mock((u) => u.includes('/rest/v1/vehicles?'), (u) => { store.vehicles = u; return [
    { id: 'v1', vin: '1G1YC3D46P5136227', stock_number: '5302353A', year: 2023, make: 'Chevrolet', model: 'Corvette', trim: '3LT, "Z51"', condition: 'used' },
    { id: 'v2', vin: '1GCUYDED5RZ100001', stock_number: 'N1', year: 2024, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT', condition: 'new' },
    { id: 'v3', vin: null, stock_number: 'NOVIN', year: 2020, make: 'Ford', model: 'F-150', condition: 'used' }]; });
  mock((u) => u.includes('/rest/v1/vehicle_photos?'), (u) => { store.photos = u; return [
    { vehicle_id: 'v1', url: 'https://proj.supabase.co/storage/v1/object/public/media/d1/vehicles/v1/b.jpg', position: 1, created_at: '2026-10-30T15:00:00Z' },
    { vehicle_id: 'v1', url: 'https://proj.supabase.co/storage/v1/object/public/media/d1/vehicles/v1/a.jpg', position: -2, created_at: '2026-10-30T16:00:00Z' },
    { vehicle_id: 'v3', url: 'https://x/c.jpg', position: 0, created_at: '2026-10-30T15:00:00Z' }]; });
}

test('photo feed: CSV of shot cars, photos in display order, uploads only, published only', async () => {
  const store = {};
  mockPhotoFeed(store);
  const res = await photoFeedGet(ctx(req('https://nsbchevy.aiautoengine.com/api/feeds/photos?token=photo-token')));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines[0], 'VIN,StockNumber,Year,Make,Model,Trim,Type,PhotoCount,PhotosUpdated,PhotoURLs');
  assert.equal(lines.length, 2, 'only cars with photographer photos and a VIN');
  assert.equal(lines[1], '1G1YC3D46P5136227,5302353A,2023,Chevrolet,Corvette,"3LT, ""Z51""",Used,2,2026-10-30T16:00:00Z,"https://proj.supabase.co/storage/v1/object/public/media/d1/vehicles/v1/a.jpg,https://proj.supabase.co/storage/v1/object/public/media/d1/vehicles/v1/b.jpg"');
  assert.match(store.vehicles, /status=eq\.published/);
  assert.match(store.photos, /source=eq\.upload/);
});

test('photo feed: pipe separator and JSON', async () => {
  mockPhotoFeed();
  const csv = await (await photoFeedGet(ctx(req('https://nsbchevy.aiautoengine.com/api/feeds/photos?token=photo-token&sep=pipe')))).text();
  assert.match(csv, /"[^"]*a\.jpg\|[^"]*b\.jpg"/);
  const j = await (await photoFeedGet(ctx(req('https://nsbchevy.aiautoengine.com/api/feeds/photos?token=photo-token&format=json')))).json();
  assert.equal(j.vehicles.length, 1);
  assert.equal(j.vehicles[0].photos[0].endsWith('/a.jpg'), true);
});

test('photo feed: the inventory token or no token is refused', async () => {
  mockPhotoFeed();
  for (const t of ['secret-token', '', 'photo-tokem']) {
    const res = await photoFeedGet(ctx(req(`https://nsbchevy.aiautoengine.com/api/feeds/photos?token=${t}`)));
    assert.equal(res.status, 401, t);
  }
});
