// VinAudit VIN decoder: normalizing a real response (2025 Chevrolet Trax ACTIV, Oct 30 2026) and the
// /api/vehicle-specs function (caching, errors, key handling, empty-field fill).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fake-supabase.js';
import { normalizeSpecs, decodeFill, specsUrl } from '../../functions/_lib/vinaudit.js';
import { onRequestPost as specs } from '../../functions/api/vehicle-specs.js';

const TRAX = JSON.parse(readFileSync(new URL('./fixtures/vinaudit-trax-2025.json', import.meta.url), 'utf8'));

test('real response: basics, fuel economy and where it was built', () => {
  const d = normalizeSpecs(TRAX);
  assert.deepEqual({ ...d.vehicle }, { year: 2025, make: 'Chevrolet', model: 'Trax', trim: 'ACTIV', style: 'ACTIV SUV FWD 6AT 1.2L I3', body_style: 'Sport Utility Vehicle',
    engine: '1.2L I3', transmission: '6-Speed Automatic', drivetrain: 'Front-Wheel Drive', fuel_type: 'Gasoline', mpg_city: 28, mpg_hwy: 32, mpg_combined: null,
    fuel_capacity: '13.2 gallons', seating: 5, doors: '4-Door', made_in: 'Changwon, Korea', ev_range_miles: null, ev_battery_kwh: null });
});

test('real response: standard equipment grouped and de-duplicated; dimensions dropped', () => {
  const d = normalizeSpecs(TRAX);
  const all = d.features.flatMap((g) => g.items);
  assert.equal(all.filter((x) => x === 'Front Side Airbag With Head Protection').length, 1, 'duplicate removed');
  assert.ok(all.includes('Heated Steering Wheel') && all.includes('Remote Ignition'));
  assert.equal(d.features.find((g) => g.group === 'Interior Features').items.length, 8);
  assert.ok(!d.features.some((g) => /dimension|capacit/i.test(g.group)), 'no dimension groups');
  assert.deepEqual(d.chassis.find((c) => c.name === 'Tires'), { name: 'Tires', value: '225/55R18' });
  assert.equal(d.chassis.find((c) => c.name === 'Front Suspension').value, 'Independent', 'codes spelled out');
  assert.equal(d.as_built, false, 'everything is "Standard": this is trim data, not this car\'s options');
});

test('real response: contradictions are recorded, not printed', () => {
  const d = normalizeSpecs(TRAX);
  assert.deepEqual(d.conflicts, ['Overall length: 168.5 in. vs 178.6 in.', 'Wheelbase: 100.6 in. vs 106 in.']);
  assert.equal(d.pricing.consistent, false);
  assert.equal(d.pricing.notes.length, 3);
  assert.match(d.pricing.notes[0], /\$23,870.*\$24,985/);
  assert.deepEqual(d.warranties, [], 'zero-mile, zero-month warranties mean no data');
  assert.deepEqual(d.colors, []);
});

test('consistent factory pricing is recognised', () => {
  const r = JSON.parse(JSON.stringify(TRAX));
  Object.assign(r.attributes, { vehicle_oem_base_msrp: '23615', vehicle_oem_total_options: '275', vehicle_oem_destination_charges: '1095', vehicle_oem_total_msrp: '24985', delivery_charges: '$1,095', invoice_price: '$22,900' });
  r.equipments.push({ group: 'Packages', name: 'ACTIV Convenience Package', value: '', availability: 'Optional' });
  const d = normalizeSpecs(r);
  assert.equal(d.pricing.consistent, true, d.pricing.notes.join(' '));
  assert.equal(d.as_built, true);
  assert.deepEqual(d.optional, [{ group: 'Packages', name: 'ACTIV Convenience Package' }]);
});

test('decode fill and URL', () => {
  const f = decodeFill(normalizeSpecs(TRAX));
  assert.equal(f.mpg_city, 28);
  assert.equal(f.engine, '1.2L I3');
  assert.ok(!('invoice' in f) && !('pricing' in f));
  assert.equal(specsUrl('KL77LKEP3SC259877', 'a&b'), 'https://specifications.vinaudit.com/v3/specifications?vin=KL77LKEP3SC259877&include=attributes,equipment,colors,recalls,warranties&format=json&key=a%26b');
});

// ---------- the function ----------
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', DEFAULT_DEALER: 'nsbchevy', VINAUDIT_API_KEY: 'test-key' };
const D = '11111111-0000-4000-8000-000000000001';
const V = '33333333-0000-4000-8000-000000000001';
let fake, va, decodeCalls;
beforeEach(() => {
  decodeCalls = [];
  fake = fakeSupabase({
    dealerships: [{ id: D, slug: 'nsbchevy', name: 'NSB Chevy' }],
    dealership_members: [{ dealership_id: D, user_id: 'u1', role: 'sales' }],
    platform_admins: [],
    vehicles: [{ id: V, dealership_id: D, vin: 'KL77LKEP3SC259877', make: 'Chevrolet', engine: null },
      { id: '33333333-0000-4000-8000-000000000009', dealership_id: D, vin: null }],
    vehicle_factory_data: [],
  }, {
    users: { 'jwt-1': { id: 'u1', email: 's@nsb.test' } },
    rpc: { vp_vehicle_apply_decode: (b, db) => { decodeCalls.push(b); const v = db.vehicles.find((x) => x.id === b.p_vehicle_id); v.engine = v.engine || b.p_fields.engine; return v; } },
  });
  va = { calls: 0, respond: () => new Response(JSON.stringify(TRAX), { status: 200 }) };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.host === 'proj.supabase.co') return fake.handler(String(url), opts);
    if (u.host === 'specifications.vinaudit.com') { va.calls++; va.lastKey = u.searchParams.get('key'); return va.respond(); }
    return new Response('{}', { status: 404 });
  };
});
const call = (body, token = 'jwt-1', env = ENV) => specs({ env, request: new Request('https://nsbchevy.aiautoengine.com/api/vehicle-specs', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

test('lookup: saves normalized data, hides the key, fills empty basics as the user', async () => {
  const res = await call({ vehicle_id: V });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.cached, false);
  assert.equal(va.lastKey, 'test-key');
  const row = fake.db.vehicle_factory_data[0];
  assert.equal(row.vin, 'KL77LKEP3SC259877');
  assert.equal(row.data.vehicle.mpg_city, 28);
  assert.equal(row.raw.input.key, '(hidden)', 'API key is never stored');
  assert.equal(row.fetched_by, 'u1');
  assert.equal(decodeCalls[0].p_fields.engine, '1.2L I3');
  const rpcCall = fake.calls.find((c) => c.path.includes('vp_vehicle_apply_decode'));
  assert.equal(rpcCall.headers.authorization, 'Bearer jwt-1', 'fill runs as the signed-in user, not the service role');
  assert.equal(out.vehicle.engine, '1.2L I3');
});

test('lookup: each VIN is paid for once unless refreshed', async () => {
  await call({ vehicle_id: V });
  let out = await (await call({ vehicle_id: V })).json();
  assert.equal(out.cached, true);
  assert.equal(va.calls, 1, 'second request served from the cache');
  out = await (await call({ vehicle_id: V, refresh: true })).json();
  assert.equal(out.cached, false);
  assert.equal(va.calls, 2);
  assert.equal(fake.db.vehicle_factory_data.length, 1, 'refresh replaces the row');
  fake.db.vehicles[0].vin = '1GCUYDED5RZ100001';
  await call({ vehicle_id: V });
  assert.equal(va.calls, 3, 'a changed VIN is looked up again');
});

test('lookup: VinAudit errors in plain English; missing key; no VIN; signed out', async () => {
  va.respond = () => new Response(JSON.stringify({ success: false, error: 'api_not_enabled' }), { status: 200 });
  let res = await call({ vehicle_id: V });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /isn't enabled for VIN decoding/);
  va.respond = () => new Response(JSON.stringify({ success: false, error: 'weird_thing' }), { status: 200 });
  assert.match((await (await call({ vehicle_id: V })).json()).error, /weird_thing/);
  assert.equal(fake.db.vehicle_factory_data.length, 0, 'nothing saved on failure');
  res = await call({ vehicle_id: V }, 'jwt-1', { ...ENV, VINAUDIT_API_KEY: '' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /VINAUDIT_API_KEY/);
  res = await call({ vehicle_id: '33333333-0000-4000-8000-000000000009' });
  assert.match((await res.json()).error, /VIN first/);
  assert.equal((await call({ vehicle_id: V }, 'nope')).status, 401);
});
