// Window stickers: pricing stack math, which CHOMES facts may print, factory sticker option parsing, and the
// factory sticker lookup function (manufacturer PDFs by VIN).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './fake-supabase.js';
import { priceStack, stickerStory, parseFactoryOptions, textItemsToLines } from '../../public/js/sticker.js';
import { oemSource, providerSource } from '../../functions/_lib/window-sticker.js';
import { onRequestPost as fetchSticker } from '../../functions/api/window-sticker.js';

const OCT_2026 = new Date('2026-10-30T12:00:00');
const jeep = { condition: 'used', year: 2018, mileage: 81273, trim: 'Sport S', drivetrain: '4WD', engine: 'V6', price: 18294, features: ['Four Wheel Drive', 'Removable top'] };
const stack = { price_stack_base: 19995, price_stack: [
  { kind: 'discount', label: 'Dealer discount', amount: -1500 },
  { kind: 'rebate', label: 'Military rebate', amount: -500, note: 'Active duty and veterans' },
  { kind: 'addon', label: 'Ceramic tint', amount: 299 }] };

test('pricing stack prints only while it adds up to the current price', () => {
  const ok = priceStack({ ...jeep, ...stack });
  assert.equal(ok.valid, true);
  assert.equal(ok.final, 18294, 'base - discount - rebate + add-on');
  assert.equal(ok.baseLabel, 'Retail price', 'used vehicles default to Retail price');
  assert.equal(ok.savings, 2000);
  const stale = priceStack({ ...jeep, ...stack, price: 18995 });
  assert.equal(stale.valid, false);
  assert.match(stale.reason, /\$18,294.*\$18,995/);
  assert.equal(priceStack({ condition: 'new', price: 50000, price_stack_base: 51000, price_stack: [{ kind: 'discount', label: 'x', amount: -1000 }] }).baseLabel, 'MSRP');
  assert.equal(priceStack({ ...jeep, price_stack: [] }).has, false);
  assert.equal(priceStack({ ...jeep, price: 10.1, price_stack_base: 10, price_stack: [{ kind: 'addon', label: 'x', amount: 0.1 }] }).valid, true, 'no floating point drift');
});

const chomes = { overall_grade: 'good', report_provider: 'carfax', prior_owners: 2, accidents_count: 0, service_records: 14, title_issues: false,
  highlight_features: ['Removable hard top', 'Tow package'], options_packages: ['Cold Weather Group'], recon_cost: 450, acquisition_notes: 'auction',
  demand_note: 'hot', review_required: false };

test('sticker story: CHOMES facts with their source, never internal fields', () => {
  const s = stickerStory(jeep, chomes, OCT_2026);
  assert.deepEqual(s.highlights, ['Removable hard top', 'Tow package']);
  assert.deepEqual(s.options, ['Cold Weather Group']);
  const text = s.story.map((x) => x.join(': ')).join(' | ');
  for (const want of ['2018 · 8 years old', '10,159 a year · average for its age', '2 prior owners (CARFAX report)', 'No accidents reported (CARFAX report)',
    '14 service records', 'No title issues reported']) assert.ok(text.includes(want), want);
  for (const bad of ['450', 'auction', 'hot']) assert.ok(!JSON.stringify(s).includes(bad), 'leaked ' + bad);
  assert.ok(!/CHOMES|Sellchology|Jonathan Dawson/.test(JSON.stringify(s)), 'nothing internal names CHOMES on the window');
});

test('sticker story is held while an FTC review is pending, and shown once cleared', () => {
  const pending = stickerStory(jeep, { ...chomes, needed_work: 'Brakes', review_required: true }, OCT_2026);
  assert.equal(pending.story, null);
  assert.equal(pending.held, true);
  assert.deepEqual(pending.highlights, ['Removable hard top', 'Tow package'], 'equipment still prints');
  const cleared = stickerStory(jeep, { ...chomes, title_issues: true, title_issue_detail: 'Prior rental', review_required: true, review_cleared_at: '2026-10-29' }, OCT_2026);
  assert.ok(cleared.story.some(([k, v]) => k === 'Title' && v === 'Prior rental (CARFAX report)'), 'title issue disclosed after review');
});

test('sticker story: history lines need a report; new cars and missing records get no story', () => {
  const noReport = stickerStory(jeep, { ...chomes, report_provider: null }, OCT_2026);
  assert.ok(!noReport.story.some(([k]) => ['Owners', 'Accidents', 'Service'].includes(k)), 'no history claims without a report');
  assert.equal(stickerStory({ ...jeep, condition: 'new' }, chomes).story, null);
  const none = stickerStory(jeep, null);
  assert.equal(none.story, null);
  assert.deepEqual(none.highlights, ['Four Wheel Drive', 'Removable top'], 'falls back to listed features');
});

test('factory sticker: option packages are read from the optional equipment section only', () => {
  const lines = [
    'MONRONEY LABEL', 'STANDARD VEHICLE PRICE $36,295.00',
    'STANDARD EQUIPMENT\tOPTIONAL EQUIPMENT',
    'Remote start\tZ71 OFF-ROAD PACKAGE\t$1,195.00',
    'Heated seats\tSkid plates and hill descent control',
    '\tSUMMIT WHITE\tN/C',
    '\tTECHNOLOGY PACKAGE ............\t$2,050.00',
    '\tBOSE PREMIUM AUDIO $595.00',
    '\tTECHNOLOGY PACKAGE\t$2,050.00',
    '\tTOTAL OPTIONS\t$3,840.00',
    '\tDESTINATION CHARGE\t$1,995.00',
    'Something after the section $99.00',
  ];
  assert.deepEqual(parseFactoryOptions(lines), ['Z71 Off-Road Package', 'Summit White', 'Technology Package', 'BOSE Premium Audio']);
  assert.deepEqual(parseFactoryOptions(['Nothing useful $5']), [], 'no optional equipment section, no suggestions');
});

test('factory sticker: pdf.js text items become lines with column breaks', () => {
  const t = (str, x, y, width) => ({ str, transform: [1, 0, 0, 1, x, y], width });
  const lines = textItemsToLines([t('Remote start', 40, 500, 50), t('Z71', 300, 500.6, 15), t('PACKAGE', 318, 500, 40), t('$1,195.00', 520, 500, 40), t('OPTIONAL EQUIPMENT', 300, 700, 90), t(' ', 0, 0, 1)]);
  assert.deepEqual(lines, ['OPTIONAL EQUIPMENT', 'Remote start\tZ71 PACKAGE\t$1,195.00']);
});

test('which manufacturers publish stickers', () => {
  assert.match(oemSource('1GCUYDED5RZ100001', 'Chevrolet').url, /^https:\/\/cws\.gm\.com\/.*vin=1GCUYDED5RZ100001$/);
  assert.match(oemSource('1FTFW1E50PFA00001', 'Ford').url, /forddirect\.com\/windowsticker\.pdf\?vin=/);
  assert.match(oemSource('1C4GJXAG5JW150863', 'Jeep').url, /^https:\/\/www\.jeep\.com\/hostd\/windowsticker\/getWindowStickerPdf\.do\?vin=/);
  assert.match(oemSource('3C6UR5DL0PG000001', 'RAM').url, /ramtrucks\.com/);
  assert.equal(oemSource('1GKS2DKL0RR000001', null).brand, 'GM', 'falls back to the VIN when the make is missing');
  assert.equal(oemSource('JTDKB20U793000001', 'Toyota'), null);
  assert.equal(providerSource('JTDKB20U793000001', {}), null);
  assert.equal(providerSource('JTDKB20U793000001', { VINAUDIT_API_KEY: 'k' }), null, 'decoder key alone does not call the sticker API');
  assert.match(providerSource('JTDKB20U793000001', { VINAUDIT_API_KEY: 'k&y', VINAUDIT_WINDOW_STICKERS: '1' }).url, /key=k%26y/);
});

// ---------- the lookup function ----------
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', DEFAULT_DEALER: 'nsbchevy', ROOT_DOMAIN: 'aiautoengine.com' };
const D = '11111111-0000-4000-8000-000000000001';
const V = '33333333-0000-4000-8000-000000000001';
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new Uint8Array(4096).fill(32), ...new TextEncoder().encode('\n%%EOF')]);
let fake, uploads, oem;
beforeEach(() => {
  fake = fakeSupabase({
    dealerships: [{ id: D, slug: 'nsbchevy', name: 'NSB Chevy' }, { id: 'd2', slug: 'other', name: 'Other' }],
    dealership_members: [{ dealership_id: D, user_id: 'u1', role: 'sales' }],
    platform_admins: [],
    vehicles: [{ id: V, dealership_id: D, vin: '1GCUYDED5RZ100001', make: 'Chevrolet', year: 2024 },
      { id: '33333333-0000-4000-8000-000000000002', dealership_id: D, vin: 'JTDKB20U793000001', make: 'Toyota' },
      { id: '33333333-0000-4000-8000-000000000003', dealership_id: 'd2', vin: '1GCUYDED5RZ100003', make: 'Chevrolet' },
      { id: '33333333-0000-4000-8000-000000000004', dealership_id: D, vin: '1FTFW1E50PFA00001', make: 'Ford' }],
    vehicle_documents: [{ id: 'old', vehicle_id: V, kind: 'window_sticker', source: 'oem', title: 'Original factory window sticker', url: 'x' },
      { id: 'mine', vehicle_id: V, kind: 'window_sticker', source: 'upload', title: 'Dealer upload', url: 'y' }],
  }, { users: { 'jwt-1': { id: 'u1', email: 's@nsb.test' } } });
  uploads = [];
  oem = () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.host === 'proj.supabase.co' && u.pathname.startsWith('/storage/')) { uploads.push({ path: u.pathname, opts }); return new Response('{"Key":"x"}', { status: 200 }); }
    if (u.host === 'proj.supabase.co') return fake.handler(String(url), opts);
    if (u.host === 'cws.gm.com' || u.host === 'www.windowsticker.forddirect.com') return oem(u);
    return new Response('nope', { status: 404 });
  };
});
const call = (body, token = 'jwt-1') => fetchSticker({ env: ENV, request: new Request('https://nsbchevy.aiautoengine.com/api/window-sticker', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

test('lookup: saves the GM sticker PDF and replaces only the earlier fetched copy', async () => {
  const res = await call({ vehicle_id: V });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.from, 'GM');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, `/storage/v1/object/media/${D}/vehicles/${V}/docs/factory-window-sticker-1GCUYDED5RZ100001.pdf`);
  assert.equal(uploads[0].opts.headers['content-type'], 'application/pdf');
  const docs = fake.db.vehicle_documents.filter((d) => d.vehicle_id === V);
  assert.deepEqual(docs.map((d) => d.id === 'old' ? 'old' : d.source).sort(), ['oem', 'upload'], 'old fetched copy replaced, dealer upload kept');
  const doc = docs.find((d) => d.source === 'oem');
  assert.match(doc.url, /\/storage\/v1\/object\/public\/media\/.*factory-window-sticker-1GCUYDED5RZ100001\.pdf\?v=\d+$/);
  assert.equal(doc.title, 'Original factory window sticker');
});

test('lookup: refuses things that are not a real PDF', async () => {
  oem = () => new Response('<html>Sticker not found</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  let res = await call({ vehicle_id: V });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /GlobalConnect/);
  oem = () => new Response(new TextEncoder().encode('%PDF-1.4\n%%EOF'), { status: 200 });
  res = await call({ vehicle_id: V });
  assert.match((await res.json()).error, /GlobalConnect/, 'GM always points staff to GlobalConnect');
  const FORD = '33333333-0000-4000-8000-000000000004';
  res = await call({ vehicle_id: FORD });
  assert.match((await res.json()).error, /Ford returned an empty sticker.*upload the sticker on the Documents tab/);
  oem = () => new Response('', { status: 500 });
  res = await call({ vehicle_id: FORD });
  assert.match((await res.json()).error, /Ford has no sticker for this VIN \(500\)/);
  assert.equal(uploads.length, 0);
  assert.ok(fake.db.vehicle_documents.some((d) => d.id === 'old'), 'nothing deleted on failure');
});

test('lookup: brands without an online sticker, other dealerships and signed-out callers', async () => {
  let res = await call({ vehicle_id: '33333333-0000-4000-8000-000000000002' });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /Toyota doesn't publish/);
  res = await call({ vehicle_id: '33333333-0000-4000-8000-000000000003' });
  assert.equal(res.status, 404, "can't fetch for another dealership's vehicle");
  res = await call({ vehicle_id: V }, 'bad');
  assert.equal(res.status, 401);
  res = await call({ vehicle_id: 'x' });
  assert.equal(res.status, 400);
});
