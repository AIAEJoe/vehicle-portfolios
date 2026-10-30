// Browser tests: real UI code against an in-memory Supabase stub and mocked /api routes.
// Run: node tests/e2e/run.mjs   (uses the globally installed playwright + Chromium)
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = join(ROOT, 'public');
const SHOTS = join(ROOT, 'tests/e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = 'https://nsbchevy.aiautoengine.com';

// ---- schema from the real migration ----
function schemaFromSql() {
  const sql = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8')).join('\n');
  const out = {};
  for (const m of sql.matchAll(/alter table public\.(\w+)\s+add column if not exists (\w+)/g)) (out['__alter_' + m[1]] ||= []).push(m[2]);
  for (const m of sql.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    out[m[1]] = m[2].split('\n').map((l) => l.trim().match(/^([a-z_]+)\s+(?!key\b)/)).filter(Boolean).map((x) => x[1])
      .filter((c) => !['unique', 'primary', 'check', 'constraint'].includes(c));
  }
  for (const k of Object.keys(out)) if (k.startsWith('__alter_')) { out[k.slice(8)].push(...out[k]); delete out[k]; }
  out.vehicle_stats = ['vehicle_id', 'dealership_id', 'views', 'visitors', 'last_viewed_at', 'leads', 'shares'];
  return out;
}
const SCHEMA = schemaFromSql();

// A factory (Monroney-style) sticker PDF with two columns, built with pdf-lib, for the "read options" test.
const { PDFDocument, StandardFonts } = require(join(execSync('npm root -g').toString().trim(), 'pdf-lib'));
const FACTORY_PDF = await (async () => {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const t = (str, x, y, size = 9) => pg.drawText(str, { x, y, size, font });
  t('2024 CHEVROLET TAHOE LT', 40, 740, 14);
  t('STANDARD VEHICLE PRICE', 40, 715); t('$58,195.00', 220, 715);
  t('STANDARD EQUIPMENT', 40, 690, 10); t('OPTIONAL EQUIPMENT', 320, 690, 10);
  t('Remote start', 40, 672); t('Z71 OFF-ROAD PACKAGE', 320, 672); t('$1,195.00', 520, 672);
  t('Heated front seats', 40, 658); t('Skid plates, hill descent control', 330, 658);
  t('Apple CarPlay', 40, 644); t('SUMMIT WHITE', 320, 644); t('N/C', 520, 644);
  t('TECHNOLOGY PACKAGE', 320, 630); t('$2,050.00', 520, 630);
  t('MAX TRAILERING PACKAGE', 320, 616); t('$495.00', 520, 616);
  t('TOTAL OPTIONS', 320, 590); t('$3,740.00', 520, 590);
  t('DESTINATION CHARGE', 320, 576); t('$1,995.00', 520, 576);
  t('FUEL ECONOMY AND ENVIRONMENT', 40, 520, 11);
  return Buffer.from(await doc.save());
})();
const { normalizeSpecs } = await import('../../functions/_lib/vinaudit.js');
const TRAX_VIN = 'KL77LKEP3SC259877';
const TRAX_DATA = normalizeSpecs(JSON.parse(readFileSync(join(ROOT, 'tests/functions/fixtures/vinaudit-trax-2025.json'), 'utf8')));
const PDFJS_DIR = join(execSync('npm root -g').toString().trim(), 'pdfjs-dist/build');

// ---- seed data (mirrors supabase/seed.sql) ----
const D = '9d2c1f1e-0000-4000-8000-000000000001';
const S = '9d2c1f1e-0000-4000-8000-0000000000aa';
const V = '9d2c1f1e-0000-4000-8000-0000000000bb';
const OWNER = '9d2c1f1e-0000-4000-8000-0000000000cc';
const OP = '9d2c1f1e-0000-4000-8000-0000000000dd';
const SALES = '9d2c1f1e-0000-4000-8000-0000000000ee';
const PHOTO = '9d2c1f1e-0000-4000-8000-0000000000f0';
const CUST = '9d2c1f1e-0000-4000-8000-0000000000c1';
const NOW = Date.now();
const CV = '1G1YY23P6P5100917';
const SEED = {
  users: [{ id: OWNER, email: 'owner@nsb.test', password: 'correct-horse' }, { id: OP, email: 'op@aiautoengine.test', password: 'operator-pass' },
    { id: SALES, email: 'sales@nsb.test', password: 'sales-pass' }, { id: PHOTO, email: 'photo@lotpics.test', password: 'photo-pass' }],
  platform_admins: [{ user_id: OP, created_at: '2026-01-01T00:00:00Z' }],
  dealerships: [{ id: D, slug: 'nsbchevy', name: 'New Smyrna Beach Chevrolet', phone: '(386) 427-1313', sms_phone: '(386) 427-1313',
    website: 'https://www.newsmyrnachevy.com', address_line: '2375 State Road 44', city: 'New Smyrna Beach', state: 'FL', zip: '32168',
    hours: 'Mon to Sat 9am to 8pm, Sun 11am to 6pm', logo_url: '/seed/nsb-logo.png', brand_primary: '#013C9E', brand_accent: '#F4BC00',
    default_fees_note: 'Plus $399 computerized vehicle registration fee and $998 documentation fee.' }],
  dealership_settings: [{ dealership_id: D, notify_on_open: true, open_alert_cooldown_minutes: 60, feed_auto_publish: true, feed_mark_missing_sold: true, feed_ingest_token: 'tok123', lead_email: null, crm_adf_email: null }],
  dealership_members: [{ dealership_id: D, user_id: OWNER, role: 'owner', created_at: '2026-10-01T00:00:00Z' }, { dealership_id: D, user_id: SALES, role: 'sales', created_at: '2026-10-02T00:00:00Z' },
    { dealership_id: D, user_id: PHOTO, role: 'photographer', created_at: '2026-10-30T00:00:00Z' }],
  dealership_billing: [{ dealership_id: D, plan_name: 'Vehicle Portfolios', monthly_fee: 995, included_sms_segments: 2500, included_emails: 5000, overage_sms_rate: 0.04, overage_email_rate: 0.005, pass_through_fixed_fees: false, allow_overage: true, status: 'active', billing_email: null, notes: null }],
  platform_settings: [{ id: 1, sms_out_segment_cost: 0.0083, sms_in_segment_cost: 0.0083, sms_carrier_fee_out: 0.0045, sms_carrier_fee_in: 0.003, mms_out_cost: 0.022, phone_number_monthly: 1.15, campaign_monthly: 10, brand_registration_fee: 46, campaign_vetting_fee: 15, email_cost: 0.0004, default_monthly_fee: 995, default_included_sms_segments: 2500, default_included_emails: 5000, default_overage_sms_rate: 0.04, default_overage_email_rate: 0.005 }],
  messaging_profiles: [{ dealership_id: D, twilio_subaccount_sid: 'ACsub', twilio_messaging_service_sid: 'MGnsb', twilio_phone_number: '+13865550000', sms_enabled: true, a2p_status: 'approved', a2p_step: 'done', a2p_log: [],
    legal_name: 'New Smyrna Beach Chevrolet', business_type: 'Corporation', company_type: 'private', sample_messages: [], email_from_name: 'New Smyrna Beach Chevrolet', email_from_local: 'sales', email_domain: null, email_domain_status: 'none', email_inbound_alias: 'nsbchevy',
    consent_language: 'By checking this box, I agree to receive texts from New Smyrna Beach Chevrolet about my inquiry. Msg & data rates may apply. Reply STOP to opt out.' }],
  customers: [{ id: CUST, dealership_id: D, full_name: 'Mike Smith', phone: '+13865550100', email: 'mike@test.com', sms_consent_status: 'unknown', email_opted_out: false, assigned_staff_id: S, unread_count: 1,
    last_message_at: new Date(NOW - 600000).toISOString(), last_inbound_at: new Date(NOW - 600000).toISOString(), created_at: new Date(NOW - 7200000).toISOString() }],
  messages: [
    { id: 'msg1', dealership_id: D, customer_id: CUST, staff_id: S, vehicle_id: V, channel: 'sms', direction: 'outbound', audience: 'customer', purpose: 'portfolio_share', sender: 'dealership', from_address: '+13865550000', to_address: '+13865550100', body: 'Hi Mike, here is the Jeep: https://nsbchevy.aiautoengine.com/v/2018-jeep?s=MikeCode Reply STOP to opt out.', status: 'delivered', segments: 1, cost_estimate: 0.0083, provider_cost: 0.0083, carrier_fee: 0.0045, created_at: new Date(NOW - 3600000).toISOString() },
    { id: 'msg2', dealership_id: D, customer_id: CUST, channel: 'sms', direction: 'inbound', audience: 'customer', purpose: 'conversation', sender: 'dealership', from_address: '+13865550100', to_address: '+13865550000', body: 'Does it have the soft top?', status: 'received', segments: 1, cost_estimate: 0.0083, carrier_fee: 0.003, created_at: new Date(NOW - 600000).toISOString() },
  ],
  consent_records: [],
  usage_charges: [{ id: 'uc1', dealership_id: D, month: new Date().toISOString().slice(0, 7) + '-01', kind: 'phone_number', ref: 'PN1', description: 'Phone number +13865550000', provider_cost: 1.15, created_at: '2026-10-01T00:00:00Z' }],
  staff: [{ id: S, dealership_id: D, full_name: 'Kyleigh Johnson', title: 'Sales Consultant', phone: '(386) 427-1313', email: null, photo_url: '/seed/kyleigh-johnson.jpg', active: true, notify_email: true, notify_sms: true, user_id: null }],
  vehicles: [{ id: V, dealership_id: D, slug: '2018-jeep-wrangler-sport-s-r287418b', status: 'published', condition: 'used', stock_number: 'R287418B',
    vin: '1C4GJXAG5JW150863', year: 2018, make: 'Jeep', model: 'Wrangler', trim: 'Sport S', body_style: 'SUV', exterior_color: 'Black Clearcoat',
    interior_color: 'Black Cloth', engine: '3.6L V6 24V VVT UPG I w/ESS', transmission: '8-Speed Automatic', drivetrain: 'Four Wheel Drive',
    fuel_type: 'Gasoline', mileage: 81273, price: 17800, price_label: 'Live Market Price',
    fees_note: 'Plus $399 computerized vehicle registration fee and $998 documentation fee. Final price: $19,197.',
    listing_url: 'https://www.newsmyrnachevy.com/inventory/used-2018-jeep-wrangler-sport-s-four-wheel-drive-suv-1c4gjxag5jw150863/',
    salesperson_id: S, features: ['Four Wheel Drive', '3.6L V6', '8-Speed Automatic'], specs: {}, source: 'manual', feed_locked: false,
    recalls: null, created_at: '2026-10-14T12:00:00Z', updated_at: '2026-10-14T12:00:00Z' }],
  vehicle_photos: Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, vehicle_id: V, dealership_id: D, url: `/seed/jeep-${String(i + 1).padStart(2, '0')}.jpg`, position: i, source: 'url', created_at: '2026-10-14T12:00:00Z' })),
  vehicle_documents: [],
  vehicle_factory_data: [],
  vehicle_chomes: [{ vehicle_id: V, dealership_id: D, options_packages: [], highlight_features: [], review_required: false, created_at: '2026-10-23T12:00:00Z', updated_at: '2026-10-23T12:00:00Z',
    provenance: Object.fromEntries(['model_year', 'odometer', 'trim', 'drivetrain', 'engine'].map((k) => [k, { source: 'existing_record', by: null, by_name: null, at: '2026-10-14T12:00:00Z' }])) }],
  shares: [{ id: 'sh1', code: 'MikeCode', vehicle_id: V, dealership_id: D, staff_id: S, customer_name: 'Mike Smith', customer_phone: '386-555-0100', channel: 'sms', open_count: 2, last_opened_at: new Date(Date.now() - 300000).toISOString(), created_at: new Date(Date.now() - 3600000).toISOString() }],
  portfolio_views: [{ id: 1, vehicle_id: V, dealership_id: D, share_id: 'sh1', visitor_id: 'a', user_agent: 'iPhone', viewed_at: new Date(Date.now() - 300000).toISOString() }],
  leads: [],
  dealership_banners: [],
};

// ---- static server + mocks ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const api = { leads: [], tracks: [], imports: 0, ingests: 0, sends: [], a2p: [], domains: [], dealers: [] };
const indexHtml = readFileSync(join(PUB, 'index.html'), 'utf8').replace('</head>',
  `<script>window.VP_CONFIG={"supabaseUrl":"https://proj.supabase.co","supabaseAnonKey":"anon","dealer":"nsbchevy"}</script></head>`);
const stub = readFileSync(join(ROOT, 'tests/e2e/supabase-stub.js'), 'utf8');
const qrStub = `export default function qrcode(){ let d=''; return { addData(x){d=x}, make(){}, createSvgTag(){ return '<svg data-qr="'+d.replace(/"/g,'')+'" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'; } }; }`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(context) {
  await context.addInitScript(({ seed, schema }) => {
    window.__SCHEMA = schema;
    window.__CALLS = []; window.__UPLOADS = []; window.__STUB_ERRORS = [];
    const saved = localStorage.getItem('stub-db');
    window.__DB = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(seed));
    window.__SAVE = () => localStorage.setItem('stub-db', JSON.stringify(window.__DB));
  }, { seed: SEED, schema: SCHEMA });

  await context.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
  await context.route('https://cdn.jsdelivr.net/npm/qrcode-generator**', (r) => r.fulfill({ contentType: 'text/javascript', body: qrStub }));
  await context.route('https://maps.google.com/**', (r) => r.abort());
  await context.route('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/*', (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(join(PDFJS_DIR, new URL(r.request().url()).pathname.split('/').pop())) }));
  // A Dealer Inspire page like the real site: lazy-loaded gallery, photos named by VIN, "similar vehicles" with other VINs

  const corvette = `<!doctype html><html><head><title>Pre-Owned 1993 Chevrolet Corvette 2DR CPE Coupe | NSB Chevy</title>
    <meta property="og:image" content="https://vehicle-images.carscommerce.inc/58ad-1/${CV}/thumbnails/large/p0.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org/","@type":["Product","Car"],"@id":"PL17115B","name":"Pre-Owned 1993 Chevrolet Corvette 2DR CPE",
      "image":"https://vehicle-images.carscommerce.inc/58ad-1/${CV}/thumbnails/large/p0.jpg","description":"Blue 1993 Chevrolet Corvette 4-Speed Automatic 5.7L V8 16V&lt;br&gt;Priced to sell.",
      "sku":"PL17115B","vehicleEngine":"","vehicleTransmission":"","bodyType":"Coupe","vehicleConfiguration":"Used 1993 Chevrolet Corvette 2DR CPE Coupe","fuelType":"Gasoline Fuel",
      "brand":{"@type":"Brand","name":"Chevrolet"},"model":"Corvette","vehicleModelDate":"1993","itemCondition":"https://schema.org/UsedCondition","vehicleIdentificationNumber":"${CV}",
      "color":"Blue","mileageFromOdometer":{"@type":"QuantitativeValue","value":"56974"},"offers":{"@type":"Offer","price":"16896"}}</script></head>
    <body><h1>1993 Chevrolet Corvette</h1>
    <img src="https://vehicle-images.carscommerce.inc/58ad-1/${CV}/thumbnails/large/p0.jpg">
    ${Array.from({ length: 12 }, (_, i) => `<div class="slide"><img data-src="https://vehicle-images.carscommerce.inc/x${i}-1/${CV}/p${i}.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>`).join('')}
    <section class="similar"><img src="https://vehicle-images.carscommerce.inc/aa-1/1GNSKNKD1MR100099/thumbnails/large/other.jpg"></section></body></html>`;
  await context.route('https://vehicle-images.carscommerce.inc/**', (route) => route.fulfill({ contentType: 'image/jpeg', body: readFileSync(join(PUB, 'seed/jeep-06.jpg')) }));
  await context.route('https://www.newsmyrnachevy.com/inventory/used-1993-chevrolet-corvette/', (route) => route.fulfill({ contentType: 'text/html', body: corvette }));
  await context.route(/https:\/\/www\.newsmyrnachevy\.com\/(?!inventory\/used-1993-chevrolet-corvette\/).*/, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Used 2021 Chevrolet Tahoe LT | NSB Chevy</title>
    <meta property="og:image" content="https://pictures.dealer.com/n/nsb/tahoe/1.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":["Product","Car"],"name":"2021 Chevrolet Tahoe LT","vehicleIdentificationNumber":"1GNSKNKD1MR100099",
      "brand":{"@type":"Brand","name":"Chevrolet"},"model":"Tahoe","vehicleConfiguration":"LT","color":"Black","mileageFromOdometer":{"value":"42,100"},"sku":"T5521",
      "itemCondition":"https://schema.org/UsedCondition","offers":{"@type":"Offer","price":"48995"},"image":["https://pictures.dealer.com/n/nsb/tahoe/1.jpg","https://pictures.dealer.com/n/nsb/tahoe/2.jpg"]}</script></head>
    <body><h1>2021 Chevrolet Tahoe LT</h1><img src="https://pictures.dealer.com/n/nsb/tahoe/3.jpg"><img src="https://pictures.dealer.com/n/nsb/logo.png"></body></html>` }));
  await context.route('https://pictures.dealer.com/**', (route) => route.fulfill({ contentType: 'image/jpeg', body: readFileSync(join(PUB, 'seed/jeep-05.jpg')) }));
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/lead') { const b = route.request().postDataJSON(); api.leads.push(b); return json(route, b.name === 'FAIL' ? { error: 'Boom' } : { ok: true, id: 'L1' }, b.name === 'FAIL' ? 500 : 200); }
    if (p === '/api/track') { api.tracks.push({ body: route.request().postDataJSON(), ua: route.request().headers()['user-agent'] }); return json(route, { recorded: true }); }
    if (p.startsWith('/api/vin/')) {
      const vin = p.split('/').pop();
      if (vin === '1GNSKNKD1MR100001') return json(route, { ok: true, vin, year: 2021, make: 'Chevrolet', model: 'Tahoe', trim: 'LT', engine: '5.3L V8', transmission: '10-Speed Automatic', drivetrain: '4WD', body_style: 'SUV', fuel_type: 'Gasoline', specs: { Doors: '4' } });
      return json(route, { error: 'NHTSA could not decode that VIN' }, 422);
    }
    if (p === '/api/recalls') return json(route, { recalls: [{ campaign: '18V332000', component: 'AIR BAGS', summary: 'Airbag may not deploy.', remedy: 'Dealers will replace the clockspring.' }], checked_at: new Date().toISOString() });
    if (p === '/api/import-listing') {
      api.imports++;
      if (String(route.request().postDataJSON().url).includes('blocked')) return json(route, { error: 'The listing page returned an error (403)' }, 502);
      assert(route.request().headers().authorization, 'import sends auth');
      return json(route, { vehicle: { vin: '1GCUYDED5RZ100777', year: 2024, make: 'Chevrolet', model: 'Silverado 1500', trim: 'RST', price: 51995, mileage: 5, condition: 'new', photos: ['/seed/jeep-03.jpg', '/seed/jeep-04.jpg'], listing_url: 'https://www.newsmyrnachevy.com/inventory/x/' } });
    }
    if (p.startsWith('/api/inventory/')) { api.ingests++; return json(route, { ok: true, result: { inserted: 4, updated: 10, marked_sold: 1, rows: 14 } }); }
    if (p === '/api/invite') return json(route, { ok: true, invited: true, user_id: 'x' });
    if (p === '/api/messages/send') {
      const b = route.request().postDataJSON();
      api.sends.push({ body: b, auth: route.request().headers().authorization });
      if (b.channel === 'sms' && !b.customer_id && !(b.consent && b.consent.attested)) return json(route, { error: 'We need the customer\'s permission to text them first.' }, 409);
      return json(route, { ok: true, customer: { id: b.customer_id || CUST }, message: { id: 'new' } });
    }
    if (p === '/api/platform/a2p') {
      const b = route.request().postDataJSON(); api.a2p.push(b);
      return json(route, { ok: true, profile: { ...SEED.messaging_profiles[0], dealership_id: b.dealership_id, twilio_subaccount_sid: 'ACnew', twilio_messaging_service_sid: 'MGnew', a2p_step: 'wait_brand', a2p_status: 'brand_pending', a2p_brand_sid: 'BN1', a2p_brand_status: 'PENDING', sms_enabled: false, twilio_phone_number: b.action === 'buy_number' ? '+13865551234' : null, a2p_log: [{ at: new Date().toISOString(), step: 'brand', ok: true, sid: 'BN1' }] }, ran: [{ step: 'brand', ok: true, wait: true }] });
    }
    if (p === '/api/platform/email-domain') {
      const b = route.request().postDataJSON(); api.domains.push(b);
      return json(route, { ok: true, profile: { ...SEED.messaging_profiles[0], email_domain: 'mail.newsmyrnachevy.com', email_domain_status: b.action === 'verify' ? 'verified' : 'pending', email_dns_records: [{ type: 'TXT', name: 'resend._domainkey.mail', value: 'p=MIGfMA0' }] } });
    }
    if (p === '/api/platform/dealerships') {
      const b = route.request().postDataJSON(); api.dealers.push(b);
      return json(route, { ok: true, dealership: { id: D, name: b.name }, invited: b.owner_email || null });
    }
    if (p === '/api/window-sticker') {
      const b = route.request().postDataJSON();
      api.stickers = (api.stickers || 0) + 1;
      assert(route.request().headers().authorization, 'sticker lookup sends auth');
      if (b.vehicle_id !== V) return json(route, { error: "Toyota doesn't publish original window stickers online." }, 422);
      return json(route, { ok: true, from: 'GM', document: { id: 'fws', vehicle_id: V, dealership_id: D, kind: 'window_sticker', source: 'oem', title: 'Original factory window sticker', url: `${ORIGIN}/test/factory-sticker.pdf?v=1`, storage_path: 'x' } });
    }
    if (p === '/api/vehicle-specs') {
      const b = route.request().postDataJSON();
      (api.specs ||= []).push(b);
      assert(route.request().headers().authorization, 'factory lookup sends auth');
      return json(route, { ok: true, cached: false, factory: { vehicle_id: b.vehicle_id, vin: TRAX_VIN, source: 'vinaudit', data: TRAX_DATA, fetched_at: TRAX_DATA.fetched_at },
        vehicle: { id: b.vehicle_id, engine: '1.2L I3', transmission: '6-Speed Automatic', drivetrain: 'Front-Wheel Drive', fuel_type: 'Gasoline', mpg_city: 28, mpg_hwy: 32 } });
    }
    if (p === '/test/factory-sticker.pdf') return route.fulfill({ contentType: 'application/pdf', body: FACTORY_PDF, headers: { 'access-control-allow-origin': '*' } });
    if (p.startsWith('/api/')) return json(route, { error: 'not mocked' }, 404);
    const file = join(PUB, p);
    if (p !== '/' && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] || 'application/octet-stream' });
    if (method !== 'GET') return json(route, {}, 405);
    return route.fulfill({ contentType: 'text/html', body: indexHtml });
  });
}

// Pages in the PDF Chromium would print (letter, the page's own @page size).
async function pdfPages(p) {
  await p.emulateMedia({ media: null }); // print with the page's print styles, as a real printer would
  const buf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
  const sizes = [...buf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/g)].map((m) => [Math.round(m[1]), Math.round(m[2])]);
  if (sizes.some(([w, h]) => w !== 612 || h !== 792)) throw new Error('not letter: ' + JSON.stringify(sizes));
  return sizes.length;
}

// ---- tiny test harness ----
let failures = 0;
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
async function step(name, fn) {
  try { await fn(); console.log('  ok -', name); }
  catch (e) { failures++; console.log('  FAIL -', name, '\n     ', e.message.split('\n')[0]); }
}

const browser = await chromium.launch();
const consoleErrors = [];
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('dialog', (d) => d.accept());
}

// ================= public portfolio (mobile) =================
console.log('Public portfolio');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile', hasTouch: true });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
  await page.waitForSelector('h1.hero-title');

  await step('title, price, fees, stock/VIN', async () => {
    assert((await page.textContent('h1.hero-title')).includes('Pre-Owned 2018 Jeep Wrangler Sport S'), 'title');
    assert((await page.textContent('.price')).includes('$17,800'), 'price');
    assert((await page.textContent('.price')).includes('Live Market Price'), 'price label');
    assert((await page.content()).includes('Final price: $19,197'), 'fees');
    assert((await page.title()).includes('2018 Jeep Wrangler Sport S'), 'doc title');
  });
  await page.screenshot({ path: join(SHOTS, '01-portfolio-mobile.png'), fullPage: false });
  await step('32 photos with working gallery', async () => {
    assert((await page.$$('#thumbs button')).length === 32, 'thumbs');
    await page.click('#gal .next');
    assert((await page.textContent('#gal-count')) === '2 / 32', 'next');
    await page.click('#thumbs button[data-i="10"]');
    assert((await page.textContent('#gal-count')) === '11 / 32', 'thumb jump');
    await page.click('#gal-img');
    await page.waitForSelector('.lightbox');
    await page.keyboard.press('ArrowRight');
    assert((await page.textContent('.lightbox .count')) === '12 / 32', 'lightbox next');
    await page.keyboard.press('Escape');
    assert(!(await page.$('.lightbox')), 'lightbox closed');
    assert((await page.textContent('#gal-count')) === '12 / 32', 'gallery synced to lightbox');
  });
  await step('salesperson card with call/text', async () => {
    assert((await page.textContent('.person')).includes('Kyleigh Johnson'), 'name');
    const sms = await page.getAttribute('.action-bar a[href^="sms:"]', 'href');
    assert(sms.startsWith('sms:3864271313?&body=') && decodeURIComponent(sms).includes('2018 Jeep Wrangler Sport S'), 'sms link ' + sms);
  });
  await step('specs table', async () => {
    const t = await page.textContent('.specs');
    for (const s of ['3.6L V6 24V VVT UPG I w/ESS', '8-Speed Automatic', 'Four Wheel Drive', '81,273', 'Black Cloth', '1C4GJXAG5JW150863']) assert(t.includes(s), s);
  });
  await step('FTC Buyers Guide: below specs, above test drive, As Is by default', async () => {
    const order = await page.evaluate(() => [...document.querySelectorAll('main section h2')].map((h) => h.textContent));
    const i = order.indexOf('FTC Buyers Guide');
    assert(i === order.indexOf('Specifications') + 1 && i < order.indexOf('Request a test drive'), order.join(' | '));
    const t = await page.textContent('#buyers-guide');
    for (const s of ['BUYERS GUIDE', 'AS IS - NO DEALER WARRANTY', 'THE DEALER DOES NOT PROVIDE A WARRANTY FOR ANY REPAIRS AFTER SALE.',
      'Spoken promises are difficult to enforce. Ask the dealer to put all promises in writing. Keep this form.',
      'ASK THE DEALER IF YOUR MECHANIC CAN INSPECT THE VEHICLE ON OR OFF THE LOT.', 'visit ftc.gov/usedcars', 'safercar.gov',
      'Here is a list of some major defects that may occur in used vehicles.', 'Catalytic Converter', 'Air Bags',
      'FOR COMPLAINTS AFTER SALE, CONTACT:', 'New Smyrna Beach Chevrolet · (386) 427-1313', '1C4GJXAG5JW150863',
      'Removing this label before consumer purchase (except for purpose of test-driving) violates federal law (16 C.F.R. 455).']) assert(t.includes(s), s);
    assert((await page.$$('#buyers-guide .bg-box.on')).length === 1, 'only As Is box checked');
    assert(!t.includes('SERVICE CONTRACT') && !/pending/i.test(t), 'no service contract and no staff-only flag');
  });
  await step('Buyers Guide in Spanish', async () => {
    await page.click('[data-bg-lang=es]');
    const t = await page.textContent('#buyers-guide');
    for (const s of ['GUÍA DEL COMPRADOR', 'COMO ESTÁ - SIN GARANTÍA DEL CONCESIONARIO', 'Convertidor catalítico', 'PARA QUEJAS DESPUÉS DE LA VENTA COMUNÍQUESE CON:']) assert(t.includes(s), s);
    assert((await page.getAttribute('#bg-print', 'href')).endsWith('/buyers-guide?lang=es'), 'print link follows language');
    await page.click('[data-bg-lang=en]');
  });
  await page.$eval('#buyers-guide', (e) => e.scrollIntoView());
  await page.screenshot({ path: join(SHOTS, '02b-buyers-guide-mobile.png') });
  await step('view tracked once with visitor id', async () => {
    await page.waitForTimeout(300);
    assert(api.tracks.length === 1 && api.tracks[0].body.vehicle_id === V && api.tracks[0].body.visitor_id, JSON.stringify(api.tracks));
  });
  await step('test drive form validation + submit', async () => {
    await page.click('#td-jump');
    await page.fill('#f-name', 'Mike Smith');
    await page.click('#lead-form button[type=submit]');
    assert((await page.textContent('#lead-msg')).includes('phone number or email'), 'needs contact');
    await page.fill('#f-phone', '386-555-0100');
    await page.fill('#f-date', '2026-10-20');
    await page.selectOption('#f-time', 'Afternoon');
    await page.fill('#f-msg', 'Does it have a soft top?');
    await page.click('#lead-form button[type=submit]');
    await page.waitForSelector('.form-ok');
    const l = api.leads[0];
    assert(l.name === 'Mike Smith' && l.phone === '386-555-0100' && l.preferred_time === 'Afternoon' && l.vehicle_id === V && l.website === '', JSON.stringify(l));
    assert((await page.inputValue('#f-name')) === '', 'form reset');
  });
  await page.screenshot({ path: join(SHOTS, '02-portfolio-mobile-form.png') });
  await step('server error shown nicely', async () => {
    await page.fill('#f-name', 'FAIL'); await page.fill('#f-phone', '1');
    await page.click('#lead-form button[type=submit]');
    await page.waitForSelector('#lead-msg .notice.bad');
    assert((await page.textContent('#lead-msg')).includes('Boom'), 'error text');
  });

  await step('personal link greets customer and passes share code', async () => {
    await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b?s=MikeCode`);
    await page.waitForSelector('.greeting');
    assert((await page.textContent('.greeting')).includes('Hi Mike! Kyleigh put together'), await page.textContent('.greeting'));
    await page.waitForTimeout(300);
    assert(api.tracks.at(-1).body.share_code === 'MikeCode', 'share code tracked');
  });
  await step('unknown vehicle shows friendly not found', async () => {
    await page.goto(`${ORIGIN}/v/nope`);
    await page.waitForSelector('text=Not found');
  });
  await step('showroom lists vehicle and searches', async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForSelector('.inv-card');
    assert((await page.textContent('.inv-card')).includes('$17,800'), 'card');
    await page.fill('#q', 'tahoe');
    assert(!(await page.isVisible('.inv-card')), 'filtered');
    await page.fill('#q', 'jeep');
    await page.click('.inv-card');
    await page.waitForSelector('h1.hero-title');
  });
  await context.close();
}

// ================= public portfolio (desktop screenshot) =================
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
  await page.waitForSelector('h1.hero-title');
  await page.screenshot({ path: join(SHOTS, '03-portfolio-desktop.png'), fullPage: true });
  await context.close();
}

// ================= admin =================
console.log('Dashboard');
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  const db = () => page.evaluate(() => window.__DB);

  await step('redirects to login and rejects bad password', async () => {
    await page.goto(`${ORIGIN}/admin`);
    await page.waitForSelector('#pw');
    assert(page.url().includes('/admin/login?next=%2Fadmin'), page.url());
    await page.fill('#email', 'owner@nsb.test'); await page.fill('#password', 'nope');
    await page.click('#pw button');
    await page.waitForSelector('#msg .notice.bad');
  });
  await step('signs in and lists vehicles with stats', async () => {
    await page.fill('#password', 'correct-horse');
    await page.click('#pw button');
    await page.waitForSelector('.vrow');
    const t = await page.textContent('.vrow');
    assert(t.includes('2018 Jeep Wrangler Sport S') && t.includes('1 open · 0 leads') && t.includes('Last opened 5 min ago') && t.includes('Live'), t);
  });
  await page.screenshot({ path: join(SHOTS, '04-admin-vehicles.png') });

  await step('edit details and save', async () => {
    await page.click('.vrow');
    await page.waitForSelector('#details');
    await page.fill('#d-price', '17,500'.replace(',', ''));
    await page.fill('#d-features', 'Four Wheel Drive\nRemovable top\n\n');
    await page.click('#details button.btn:not([type=button])');
    await page.waitForSelector('text=Saved');
    const v = (await db()).vehicles[0];
    assert(v.price === 17500, 'price ' + v.price);
    assert(JSON.stringify(v.features) === '["Four Wheel Drive","Removable top"]', JSON.stringify(v.features));
  });
  await step('photos: reorder, cover, delete, upload', async () => {
    await page.click('[data-tab=photos]');
    await page.waitForSelector('.photo-tile');
    await page.click('[data-cover="p5"]');
    await page.waitForTimeout(200);
    let photos = (await db()).vehicle_photos.sort((a, b) => a.position - b.position);
    assert(photos[0].id === 'p5' && photos[1].id === 'p0', photos.slice(0, 3).map((p) => p.id).join());
    await page.click('[data-move="1"][data-id="p5"]');
    await page.waitForTimeout(200);
    photos = (await db()).vehicle_photos.sort((a, b) => a.position - b.position);
    assert(photos[0].id === 'p0' && photos[1].id === 'p5', 'moved right');
    await page.click('[data-del="p31"]');
    await page.waitForTimeout(200);
    assert((await db()).vehicle_photos.length === 31, 'deleted');
    await page.setInputFiles('#files', [join(PUB, 'seed/jeep-01.jpg'), join(PUB, 'seed/jeep-02.jpg')]);
    await page.waitForSelector('text=Uploaded 2 photos');
    const after = (await db()).vehicle_photos;
    assert(after.length === 33, 'uploaded ' + after.length);
    const up = after.filter((p) => p.source === 'upload');
    assert(up.every((p) => p.storage_path.startsWith(`${D}/vehicles/${V}/`)), 'storage path ' + up[0].storage_path);
  });
  await page.screenshot({ path: join(SHOTS, '05-admin-photos.png') });
  await step('documents: add a linked history report', async () => {
    await page.click('[data-tab=documents]');
    await page.selectOption('#dk', 'history_report');
    await page.fill('#du', 'https://www.carfax.com/vehiclehistory/ar20/abc');
    await page.click('#docform button');
    await page.waitForSelector('text=Document added');
    const doc = (await db()).vehicle_documents[0];
    assert(doc.kind === 'history_report' && doc.title === 'Vehicle history report', JSON.stringify(doc));
  });
  await step('recalls: check and save', async () => {
    await page.click('[data-tab=recalls]');
    await page.click('#check');
    await page.waitForSelector('.recall');
    assert((await db()).vehicles[0].recalls.length === 1, 'saved');
  });
  await step('Buyers Guide tab: pending flag, shorthand blocked, limited warranty saved', async () => {
    assert(await page.$('[data-tab=guide] .badge'), 'pending badge on tab');
    await page.click('[data-tab=guide]');
    await page.waitForSelector('#bg-form');
    assert((await page.textContent('#bg-form')).includes('Warranty data pending'), 'pending notice');
    await page.check('input[name=bg_warranty][value=dealer_warranty]');
    await page.fill('#bg-labor', '100'); await page.fill('#bg-parts', '50');
    await page.fill('#bg-ded', 'A $50 deductible applies to each repair visit');
    await page.fill('[data-sys="0"][data-k=system]', 'Power train');
    await page.fill('[data-sys="0"][data-k=duration]', '30 days or 1,000 miles, whichever occurs first');
    assert((await page.textContent('#sys')).includes("isn't allowed"), 'inline shorthand warning');
    await page.click('#bg-form button[type=submit]');
    await page.waitForSelector('#toast >> text=specifically');
    assert(!(await db()).vehicles[0].bg_warranty, 'not saved with shorthand');
    await page.fill('[data-sys="0"][data-k=system]', 'Engine block, cylinder heads and internal parts');
    await page.click('#sys-add');
    await page.fill('[data-sys="1"][data-k=system]', 'Transmission case and internal parts');
    await page.fill('[data-sys="1"][data-k=duration]', '30 days or 1,000 miles, whichever occurs first');
    await page.check('input[name=bg_service_contract]');
    const prev = await page.textContent('#bg-preview');
    assert(prev.includes('The dealer will pay  100 % of the labor and  50 % of the parts') || /pay\s+100\s*% of the labor and\s+50\s*% of the parts/.test(prev), 'preview percentages: ' + prev.slice(0, 600));
    await page.click('#bg-form button[type=submit]');
    await page.waitForSelector('#toast >> text=Buyers Guide saved');
    const v = (await db()).vehicles[0];
    assert(v.bg_warranty === 'dealer_warranty' && v.bg_warranty_type === 'limited' && v.bg_labor_pct === 100 && v.bg_parts_pct === 50 && v.bg_service_contract === true, JSON.stringify(v));
    assert(v.bg_systems.length === 2 && v.bg_systems[1].system === 'Transmission case and internal parts', JSON.stringify(v.bg_systems));
    assert(!(await page.$('[data-tab=guide] .badge')), 'pending badge gone');
  });
  await step('FULL warranty requires every Magnuson-Moss condition', async () => {
    await page.check('input[name=bg_warranty_type][value=full]');
    await page.click('#bg-form button[type=submit]');
    await page.waitForSelector('#toast >> text=must meet every condition');
    assert((await db()).vehicles[0].bg_warranty_type === 'limited', 'still limited');
    await page.check('input[name=bg_warranty_type][value=limited]');
  });
  await page.screenshot({ path: join(SHOTS, '05b-admin-buyers-guide.png'), fullPage: true });
  await step('customer page shows the saved dealer warranty; print page matches', async () => {
    const p2 = await context.newPage();
    await p2.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b/buyers-guide?lang=en`);
    await p2.waitForSelector('.bg-print-page .bg-front');
    const t = await p2.textContent('.bg-print-page');
    for (const s of ['DEALER WARRANTY', 'LIMITED WARRANTY.', 'Engine block, cylinder heads and internal parts', 'Transmission case and internal parts',
      'A $50 deductible applies to each repair visit', 'SERVICE CONTRACT. A service contract on this vehicle is available for an extra charge.']) assert(t.includes(s), s);
    assert((t.match(/30 days or 1,000 miles, whichever occurs first/g) || []).length === 1, 'shared duration stated once');
    const checked = await p2.$$eval('.bg-front .bg-box.on', (b) => b.length);
    assert(checked === 3, 'dealer warranty + limited + service contract checked, got ' + checked);
    assert((await p2.$$('.bg-side')).length === 2, 'front and back');
    await p2.emulateMedia({ media: 'print' });
    const w = await p2.$eval('.bg-front', (e) => e.getBoundingClientRect());
    // Letter paper (8½" × 11", above the Rule's 7¼" × 11" minimum): the guide fills the printable area at 100%.
    assert(w.width >= 7.25 * 96 - 1 && w.width <= 8 * 96 + 1 && w.height >= 10 * 96 && w.height <= 10.5 * 96 + 1, `print size ${w.width}x${w.height}`);
    assert(!(await p2.isVisible('#print')), 'toolbar hidden when printing');
    assert(await pdfPages(p2) === 2, 'prints as exactly two letter pages: front and back');
    await p2.screenshot({ path: join(SHOTS, '05c-buyers-guide-print.png'), fullPage: true });
    await p2.close();
  });
  await step('CHOMES tab: auto-filled Old/Miles/Equipment with sources, missing count on the tab', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#details`);
    await page.waitForSelector('#details');
    assert((await page.textContent('[data-tab=chomes] .badge')) === '6', 'six required fields to fill');
    await page.click('[data-tab=chomes]');
    await page.waitForSelector('#chomes');
    const t = await page.textContent('#tab');
    for (const x of ['2018', '8 years', '81,273 mi', '10,159 / yr', 'Average', 'Sport S', 'Four Wheel Drive', 'Already on the vehicle record', 'Market data pending', 'team only'])
      assert(t.includes(x), x);
    assert((await page.$$('.ch-chip.warn')).length === 2 && (await page.$$('.ch-chip.ok')).length === 3, 'C and H missing, S pending');
    assert(!(await page.$('#ch-review')), 'no FTC flag yet');
  });
  await page.screenshot({ path: join(SHOTS, '05d-admin-chomes-empty.png'), fullPage: true });
  await step('CHOMES: validation mirrors the database rules', async () => {
    await page.click('.seg-opt:has(input[name=title_issues][value=true]) span');
    assert(await page.isVisible('#ch-title_issue_detail'), 'title detail appears');
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=Describe the title issue');
    await page.click('.seg-opt:has(input[name=title_issues][value=false]) span');
    await page.fill('#ch-accidents_count', '1');
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=one-line summary');
    await page.fill('#ch-highlight_features', 'a\nb\nc\nd\ne\nf');
    assert((await page.textContent('#ch-hl-count')).includes('Keep it to five'), 'live highlight count');
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=at most five');
    assert(!(await db()).vehicle_chomes[0].overall_grade, 'nothing saved yet');
  });
  await step('CHOMES: full entry saves, records who entered it, flags FTC review for needed work', async () => {
    await page.click('.seg-opt:has(input[name=overall_grade][value=good]) span');
    await page.fill('#ch-strengths', 'New tires, clean interior');
    await page.fill('#ch-wear_items', 'Small scratch on rear bumper');
    await page.fill('#ch-needed_work', 'Rear brake pads at 3 mm');
    await page.fill('#ch-recon_cost', '450');
    await page.fill('#ch-inspected_by', 'Kyleigh Johnson');
    await page.fill('#ch-inspection_date', new Date().toLocaleDateString('en-CA'));
    await page.click('.seg-opt:has(input[name=report_provider][value=carfax]) span');
    await page.fill('#ch-accidents_summary', 'Minor damage, rear bumper, 2021');
    await page.fill('#ch-prior_owners', '2'); await page.fill('#ch-service_records', '14'); await page.fill('#ch-open_recalls', '0');
    await page.fill('#ch-generation_note', 'First model year of this generation');
    await page.click('#ch-from-feed');
    assert((await page.inputValue('#ch-options_packages')) === 'Four Wheel Drive\nRemovable top', 'options start from listed features');
    await page.fill('#ch-highlight_features', 'Removable hard top\nTow package\nApple CarPlay');
    await page.fill('#ch-price_to_market_pct', '97.5'); await page.fill('#ch-market_days_supply', '41'); await page.fill('#ch-comparable_units_nearby', '7');
    await page.fill('#ch-demand_note', 'Wranglers turn in under 30 days here');
    await page.fill('#ch-acquisition_notes', 'Trade-in on a 2024 Silverado');
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=CHOMES saved');
    const c = (await db()).vehicle_chomes[0];
    assert(c.overall_grade === 'good' && c.recon_cost === 450 && c.accidents_count === 1 && c.title_issues === false && c.report_provider === 'carfax', JSON.stringify(c));
    assert(c.highlight_features.length === 3 && c.options_packages.length === 2 && c.price_to_market_pct === 97.5, 'lists and numbers');
    assert(c.provenance.recon_cost.source === 'staff' && c.provenance.recon_cost.by_name === 'owner@nsb.test', JSON.stringify(c.provenance.recon_cost));
    await page.waitForSelector('#ch-review');
    const r = await page.textContent('#ch-review');
    assert(r.includes('Needed work is listed') && r.includes('DEALER WARRANTY'), r);
    assert(!(await page.$('[data-tab=chomes] .badge')), 'badge gone when complete');
    assert(!(await page.textContent('#tab')).includes('Market data pending'), 'market data entered');
    assert((await page.$$('.ch-chip.ok')).length === 6, 'all six complete');
  });
  await step('CHOMES: history report goes to the private bucket and opens with a signed link', async () => {
    await page.setInputFiles('#ch-report', { name: 'carfax-1C4GJXAG5JW150863.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await page.waitForSelector('#toast >> text=History report saved');
    const up = await page.evaluate(() => window.__UPLOADS.at(-1));
    assert(up.bucket === 'internal' && up.path.startsWith(`${D}/vehicles/${V}/history/`), JSON.stringify(up));
    const c = (await db()).vehicle_chomes[0];
    assert(c.history_report_path === up.path && c.history_report_name === 'carfax-1C4GJXAG5JW150863.pdf', JSON.stringify(c));
    assert(!(await db()).vehicle_documents.some((d) => d.url && d.url.includes('/history/')), 'not added to customer documents');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#ch-report-open')]);
    await popup.waitForURL(/signed=/, { timeout: 5000 }); // opens blank first (popup blockers), then the signed link
    await popup.close();
  });
  await page.screenshot({ path: join(SHOTS, '05e-admin-chomes.png'), fullPage: true });
  await step('CHOMES: the customer page never loads or shows CHOMES data', async () => {
    const p2 = await context.newPage();
    await p2.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await p2.waitForSelector('h1.hero-title');
    const t = await p2.textContent('body');
    for (const x of ['Rear brake pads', 'Trade-in on a 2024', 'Wranglers turn', 'CHOMES', 'carfax-1C4G']) assert(!t.includes(x), 'leaked: ' + x);
    const calls = await p2.evaluate(() => window.__CALLS.filter((c) => c.table === 'vehicle_chomes' || c.signed));
    assert(!calls.length, 'portfolio queried CHOMES');
    await p2.close();
  });
  await step('CHOMES: Decode VIN fills only the empty basics and labels them', async () => {
    const id = '9d2c1f1e-0000-4000-8000-0000000000f1';
    await page.evaluate(({ id, D }) => {
      window.__DB.vehicles.push({ id, dealership_id: D, slug: '2021-chevrolet-tahoe', status: 'draft', condition: 'used', vin: '1GNSKNKD1MR100001', year: 2021, make: 'Chevrolet', model: 'Tahoe',
        trim: null, engine: null, drivetrain: 'Four Wheel Drive', mileage: 61000, features: [], specs: {}, source: 'manual', created_at: '2026-10-20T12:00:00Z' });
      window.__DB.vehicle_chomes.push({ vehicle_id: id, dealership_id: D, options_packages: [], highlight_features: [], provenance: {}, review_required: false });
      window.__SAVE();
    }, { id, D });
    await page.goto(`${ORIGIN}/admin/vehicles/${id}#chomes`);
    await page.waitForSelector('#ch-decode');
    await page.click('#ch-decode');
    await page.waitForSelector('#toast >> text=Filled trim, engine');
    const v = (await db()).vehicles.find((x) => x.id === id);
    assert(v.trim === 'LT' && v.engine === '5.3L V8' && v.drivetrain === 'Four Wheel Drive', JSON.stringify(v));
    const c = (await db()).vehicle_chomes.find((x) => x.vehicle_id === id);
    assert(c.provenance.trim.source === 'vin_decode' && !c.provenance.drivetrain, JSON.stringify(c.provenance));
    assert((await page.textContent('#tab')).includes('VIN decode'), 'source shown');
    assert(!(await page.$('#ch-decode')), 'decode button gone once filled');
    await page.evaluate((id) => { window.__DB.vehicles = window.__DB.vehicles.filter((x) => x.id !== id); window.__DB.vehicle_chomes = window.__DB.vehicle_chomes.filter((x) => x.vehicle_id !== id); window.__SAVE(); }, id);
  });
  await step('window sticker tab: pricing stack checks rebates and offers to fix the price', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#sticker`);
    await page.waitForSelector('#stack-form');
    assert((await page.textContent('.st-checks')).includes('No pricing stack'), 'checklist');
    await page.fill('#st-base', '19995');
    await page.click('#st-add');
    await page.fill('[data-i="0"][data-k=label]', 'Dealer discount'); await page.fill('[data-i="0"][data-k=amount]', '1500');
    await page.click('#st-add');
    await page.selectOption('[data-i="1"][data-k=kind]', 'rebate');
    await page.fill('[data-i="1"][data-k=label]', 'Military rebate'); await page.fill('[data-i="1"][data-k=amount]', '500');
    await page.click('#st-add');
    await page.selectOption('[data-i="2"][data-k=kind]', 'addon');
    await page.fill('[data-i="2"][data-k=label]', 'Ceramic tint'); await page.fill('[data-i="2"][data-k=amount]', '299');
    assert((await page.textContent('#st-total')).includes('$18,294'), 'live total');
    await page.click('#stack-form button[type=submit]');
    await page.waitForSelector('#toast >> text=who qualifies');
    await page.fill('[data-i="1"][data-k=note]', 'Active duty and veterans');
    await page.click('#st-setprice');
    await page.waitForSelector('#toast >> text=Price updated');
    const v = (await db()).vehicles[0];
    assert(v.price === 18294 && v.price_stack_base === 19995 && v.price_stack.length === 3, JSON.stringify(v.price_stack));
    assert(JSON.stringify(v.price_stack.map((l) => l.amount)) === '[-1500,-500,299]' && v.price_stack[1].note === 'Active duty and veterans', 'signed amounts');
    await page.waitForSelector('.st-checks >> text=Pricing stack adds up');
    assert((await page.textContent('.st-checks')).includes('held until the FTC review'), 'CHOMES story held (needed work listed)');
  });
  await step('settings: sticker disclaimer', async () => {
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.fill('#s-sticker_disclaimer', 'Prices exclude tax, tag, title and dealer fees.');
    await page.click('#ws button');
    await page.waitForSelector('#toast >> text=Window sticker settings saved');
  });
  await step('printed sticker: pricing stack, QR, Buyers Guide pointer; CHOMES story held for FTC review', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}/sticker`);
    await page.waitForSelector('.ws');
    const t = await page.textContent('.ws');
    for (const x of ['Pre-Owned', '2018 Jeep Wrangler Sport S', 'Retail price', '$19,995', 'Dealer discount', '−$1,500', 'Active duty and veterans', '+$299', '$18,294', 'You save $2,000',
      'Removable hard top', 'Four Wheel Drive', 'see the FTC Buyers Guide displayed on this vehicle', 'Prices exclude tax, tag, title and dealer fees.', 'VIN:1C4GJXAG5JW150863', 'Mileage:81,273', 'Stock #:R287418B', 'Transmission:8-Speed Automatic', 'Color:Black Clearcoat', 'www.newsmyrnachevy.com'])
      assert(t.includes(x), x);
    assert(!t.includes('Vehicle story') && !t.includes('CHOMES'), 'story held');
    assert((await page.textContent('main')).includes('until the FTC consistency review is cleared'), 'staff told why');
    assert(await page.$('.ws-qr svg[data-qr*="?s="]'), 'QR to the tracked vehicle page');
    for (const bad of ['Rear brake pads', 'Trade-in', 'Wranglers turn', '450', 'warranty for', 'Monroney']) assert(!t.includes(bad), 'should not print: ' + bad);
  });
  await step('printed sticker: story prints once the review is cleared; no internal fields', async () => {
    await page.evaluate(() => { window.__DB.vehicle_chomes[0].review_cleared_at = new Date().toISOString(); window.__SAVE(); });
    await page.reload();
    await page.waitForSelector('.ws-story');
    const t = await page.textContent('.ws');
    for (const x of ['Vehicle story', '8 years old', 'a year · average for its age', '2 prior owners (CARFAX report)', '1 reported: Minor damage, rear bumper, 2021 (CARFAX report)',
      '14 service records', 'Four Wheel Drive']) assert(t.includes(x), x);
    for (const bad of ['Rear brake pads', 'Trade-in', 'Wranglers turn', '$450', 'CHOMES', 'Sellchology', 'Jonathan Dawson']) assert(!t.includes(bad), 'leaked ' + bad);
    await page.emulateMedia({ media: 'print' });
    assert(!(await page.isVisible('.admin-top')) && !(await page.isVisible('.page-head')), 'chrome hidden when printing');
    const box = await page.$eval('.ws', (e) => e.getBoundingClientRect());
    assert(Math.abs(box.width - 7.8 * 96) < 2 && box.height <= 10.35 * 96, `fits letter: ${box.width}x${box.height}`);
    await page.emulateMedia({ media: 'screen' });
  });
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.screenshot({ path: join(SHOTS, '05f-window-sticker.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await step('factory sticker: lookup, then option packages read off the PDF into CHOMES', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#sticker`);
    await page.click('#st-find');
    await page.waitForSelector('#toast >> text=Found the original sticker (GM)');
    assert((await page.textContent('#factory')).includes('From the manufacturer'), 'factory card');
    await page.click('[data-goto=chomes]');
    await page.waitForSelector('#ch-from-sticker');
    await page.click('#ch-from-sticker');
    await page.waitForSelector('#ch-add-opts, #ch-sticker-opts .notice', { timeout: 15000 });
    assert(await page.$('#ch-add-opts'), await page.textContent('#ch-sticker-opts'));
    const found = await page.$$eval('#ch-sticker-opts label', (ls) => ls.map((l) => l.textContent.trim()));
    assert(JSON.stringify(found) === JSON.stringify(['Z71 Off-Road Package', 'Summit White', 'Technology Package', 'Max Trailering Package']), JSON.stringify(found));
    await page.uncheck('[data-opt="1"]');
    await page.click('#ch-add-opts');
    assert((await page.inputValue('#ch-options_packages')) === 'Four Wheel Drive\nRemovable top\nZ71 Off-Road Package\nTechnology Package\nMax Trailering Package', await page.inputValue('#ch-options_packages'));
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=CHOMES saved');
    assert((await db()).vehicle_chomes[0].options_packages.includes('Max Trailering Package'), 'saved');
  });
  await step('a price change makes the stack stop printing until it is updated', async () => {
    await page.evaluate(() => { window.__DB.vehicles[0].price = 18995; window.__SAVE(); });
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#sticker`);
    await page.waitForSelector('[data-tab=sticker] .badge');
    assert((await page.textContent('.st-checks')).includes("Pricing stack won't print"), 'warned');
    await page.goto(`${ORIGIN}/admin/vehicles/${V}/sticker`);
    await page.waitForSelector('.ws');
    const t = await page.textContent('.ws');
    assert(t.includes('$18,995') && !t.includes('Dealer discount') && !t.includes('You save'), 'stale stack hidden');
    assert((await page.textContent('main')).includes("The pricing stack isn't printed"), 'staff told why');
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#details`);
    await page.waitForSelector('#details');
  });
  await step('factory data: VIN decoder lookup fills basics, shows trim caveat, conflicts and staff-only pricing', async () => {
    const T = '9d2c1f1e-0000-4000-8000-0000000000f7';
    await page.evaluate(({ T, D, TRAX_VIN }) => {
      window.__DB.vehicles.push({ id: T, dealership_id: D, slug: '2025-chevrolet-trax-activ', status: 'published', condition: 'used', vin: TRAX_VIN, year: 2025, make: 'Chevrolet',
        model: 'Trax', trim: 'ACTIV', engine: null, mileage: 9120, price: 21995, features: [], specs: {}, price_stack: [], source: 'manual', created_at: '2026-10-29T12:00:00Z' });
      window.__DB.vehicle_chomes.push({ vehicle_id: T, dealership_id: D, options_packages: [], highlight_features: [], provenance: {}, review_required: false });
      window.__SAVE();
    }, { T, D, TRAX_VIN });
    await page.goto(`${ORIGIN}/admin/vehicles/${T}#sticker`);
    await page.waitForSelector('#fdata [data-specs=get]');
    await page.click('#fdata [data-specs=get]');
    await page.waitForSelector('#toast >> text=Factory data saved');
    await page.waitForSelector('.fd-facts');
    const t = await page.textContent('#fdata');
    for (const x of ['1.2L I3', '28 city / 32 highway MPG', 'Changwon, Korea', '29 features', 'Equipment is what this trim comes with', 'dimensions disagree', "Don't advertise these without checking"])
      assert(t.includes(x), x);
    assert(!(await page.isVisible('.fd-price table')), 'pricing collapsed by default');
    assert(api.specs.at(-1).refresh === false && api.specs.at(-1).vehicle_id === T, JSON.stringify(api.specs.at(-1)));
    await page.click('#fdata [data-specs=refresh]');
    await page.waitForFunction(() => true);
    await page.waitForSelector('#toast >> text=Factory data saved');
    assert(api.specs.at(-1).refresh === true, 'look up again asks for a refresh');
    // the server wrote the row; mirror it into the stub database
    await page.evaluate(({ T, TRAX_VIN, data }) => { window.__DB.vehicle_factory_data = [{ vehicle_id: T, vin: TRAX_VIN, source: 'vinaudit', data, fetched_at: data.fetched_at }];
      Object.assign(window.__DB.vehicles.find((v) => v.id === T), { engine: '1.2L I3', mpg_city: 28, mpg_hwy: 32 }); window.__SAVE(); }, { T, TRAX_VIN, data: TRAX_DATA });
  });
  await step('factory data: pick CHOMES highlights from standard equipment (max five, toggles)', async () => {
    const T = '9d2c1f1e-0000-4000-8000-0000000000f7';
    await page.goto(`${ORIGIN}/admin/vehicles/${T}#chomes`);
    await page.waitForSelector('.ch-pick');
    await page.click('.ch-pick summary');
    for (const f of ['Heated Steering Wheel', 'Remote Ignition', 'Front Heated Seat', 'Keyless Entry', 'Cruise Control']) await page.click(`[data-hl="${f}"]`);
    await page.click('[data-hl="Power Windows"]');
    await page.waitForSelector('#toast >> text=Five highlights is the limit');
    await page.click('[data-hl="Keyless Entry"]');
    assert((await page.inputValue('#ch-highlight_features')) === 'Heated Steering Wheel\nRemote Ignition\nFront Heated Seat\nCruise Control', await page.inputValue('#ch-highlight_features'));
    assert((await page.$$('.chip-btn.on')).length === 4, 'chips reflect the list');
    await page.click('#chomes button[type=submit]');
    await page.waitForSelector('#toast >> text=Saved');
    assert((await db()).vehicle_chomes.find((c) => c.vehicle_id === T).highlight_features.length === 4, 'saved');
  });
  await step('factory equipment sheet: trim caveat, specs, equipment; no prices or dimensions', async () => {
    const T = '9d2c1f1e-0000-4000-8000-0000000000f7';
    await page.goto(`${ORIGIN}/admin/vehicles/${T}/factory-sheet`);
    await page.waitForSelector('.fs');
    const t = await page.textContent('.fs');
    for (const x of ['Factory equipment', '2025 Chevrolet Trax ACTIV', 'VIN KL77LKEP3SC259877', 'options and packages added to this particular vehicle are not included',
      'This is not the manufacturer\'s window sticker', '28 city / 32 hwy MPG', 'Changwon, Korea', 'Heated Steering Wheel', 'Remote Ignition', 'Tires: 225/55R18', 'Front Suspension: Independent', 'VinAudit'])
      assert(t.includes(x), x);
    for (const bad of ['$', '22,500', '24,985', 'Invoice', 'MSRP', '178.6', '168.5', 'Headroom', 'Legroom']) assert(!t.includes(bad), 'should not print: ' + bad);
    assert((t.match(/Front Side Airbag With Head Protection/g) || []).length === 1, 'no duplicates');
    await page.emulateMedia({ media: 'print' });
    const box = await page.$eval('.fs', (e) => e.getBoundingClientRect());
    assert(box.height <= 10.35 * 96 && !(await page.isVisible('.admin-top')), `fits one letter page: ${box.height}`);
    await page.emulateMedia({ media: 'screen' });
  });
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.screenshot({ path: join(SHOTS, '05g-factory-sheet.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await step('dealer sticker uses the picked highlights and decoded MPG', async () => {
    const T = '9d2c1f1e-0000-4000-8000-0000000000f7';
    await page.goto(`${ORIGIN}/admin/vehicles/${T}/sticker`);
    await page.waitForSelector('.ws');
    const t = await page.textContent('.ws');
    for (const x of ['Heated Steering Wheel', 'Remote Ignition', '28 city / 32 hwy', '1.2L I3', 'Equipment', 'standard for this model and trim',
      'Standard', 'Exterior', 'Interior', 'Safety', 'Daytime Running Lights', 'Passenger Airbag', 'Tires: 225/55R18']) assert(t.includes(x), x);
    assert((await page.$$('.ws-equip-col')).length === 4, 'four equipment lists');
    assert(await pdfPages(page) === 1, 'sticker with full equipment lists prints on one letter page');
    await page.click('[data-bw="1"]');
    assert(await page.$('.ws.ws-bw'), 'black & white mode');
    const head = await page.$eval('.ws-head', (e) => getComputedStyle(e).backgroundColor);
    assert(head === 'rgb(255, 255, 255)', 'no colored header in black & white: ' + head);
    await page.reload();
    await page.waitForSelector('.ws');
    assert(await page.$('.ws.ws-bw'), 'black & white is remembered');
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.screenshot({ path: join(SHOTS, '05i-sticker-bw-equipment.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('[data-bw="0"]');
    assert(!t.includes('22,500') && !t.includes('Invoice'), 'no factory pricing on the sticker');
    await page.evaluate((T) => { for (const k of ['vehicles']) window.__DB[k] = window.__DB[k].filter((x) => x.id !== T);
      window.__DB.vehicle_chomes = window.__DB.vehicle_chomes.filter((x) => x.vehicle_id !== T); window.__DB.shares = window.__DB.shares.filter((x) => x.vehicle_id !== T);
      window.__DB.vehicle_factory_data = []; window.__SAVE(); }, T);
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#details`);
    await page.waitForSelector('#details');
  });
  await step('warranty program: set up from the NSB form; shorthand blocked', async () => {
    await page.evaluate(() => { const v = window.__DB.vehicles[0]; v.description = 'Clean CARFAX. Lifetime Warranty - Unlimited Time & Miles'; window.__SAVE(); });
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.waitForSelector('#wp-form');
    const t = await page.textContent('#wp-form');
    assert(t.includes('TWS-LW-AMSI F 06/24') && t.includes('confirm the covered-systems wording'), 'pre-filled with a confirmation warning');
    assert((await page.inputValue('#wp-name')) === 'Lifetime Limited Powertrain Warranty' && (await page.inputValue('#wp-labor')) === '100', 'defaults');
    assert((await page.inputValue('#wp-ded')).includes('$100'), 'deductible');
    await page.fill('[data-sys="0"][data-f=system]', 'Powertrain');
    await page.locator('[data-sys="0"][data-f=system]').dispatchEvent('change');
    await page.waitForSelector('#wp-sys >> text=isn\'t allowed');
    await page.click('#wp-form button:not([type=button])');
    await page.waitForSelector('#toast >> text=on its own isn\'t allowed');
    assert(!(await db()).dealerships[0].bg_program, 'not saved');
    await page.fill('[data-sys="0"][data-f=system]', 'Engine: cylinder block, cylinder heads and internal lubricated parts');
    await page.click('#wp-form button:not([type=button])');
    await page.waitForSelector('#toast >> text=Warranty program saved');
    const p = (await db()).dealerships[0].bg_program;
    assert(p.name === 'Lifetime Limited Powertrain Warranty' && p.systems.length === 3 && p.parts_pct === 100, JSON.stringify(p));
  });
  await step('warranty program: cars whose ad mentions it but whose Buyers Guide lacks it are flagged', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles`);
    await page.waitForSelector('.vrow');
    assert((await page.textContent('.vrow')).includes('Warranty missing from Buyers Guide'), 'list badge');
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#guide`);
    await page.waitForSelector('#bg-program');
    assert((await page.textContent('#bg-program')).includes("mentions the Lifetime Limited Powertrain Warranty, but this Buyers Guide doesn't include it"), 'tab notice');
    assert(await page.$('[data-tab=guide] .badge'), 'tab badge');
    await page.goto(`${ORIGIN}/admin/vehicles/${V}/sticker`);
    await page.waitForSelector('.ws');
    assert(!(await page.textContent('.ws')).includes('Lifetime'), 'sticker does not mention it before it is on the Buyers Guide');
    assert((await page.textContent('main')).includes("this car's Buyers Guide doesn't include it"), 'staff told why');
  });
  await step('warranty program: review list in Settings, apply, Buyers Guide and sticker updated', async () => {
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.waitForSelector('#wp-cars .wp-car');
    const t = await page.textContent('#wp-cars');
    assert(t.includes('2018 Jeep Wrangler Sport S') && t.includes('Buyers Guide shows a different dealer warranty'), t);
    await page.click('#wp-apply');
    await page.waitForSelector('#toast >> text=Applied to 1 car');
    const v = (await db()).vehicles[0];
    assert(v.bg_program === 'Lifetime Limited Powertrain Warranty' && v.bg_labor_pct === 100 && v.bg_parts_pct === 100 && v.bg_systems.length === 3
      && v.bg_deductible === 'A $100 deductible applies to each covered repair', JSON.stringify(v));
    await page.waitForSelector('#wp-cars >> text=Nothing to do');
    const p2 = await context.newPage();
    await p2.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b/buyers-guide?lang=en`);
    await p2.waitForSelector('.bg-print-page .bg-front');
    const g = await p2.textContent('.bg-print-page');
    for (const x of ['DEALER WARRANTY', 'LIMITED WARRANTY.', 'Engine: cylinder block, cylinder heads and internal lubricated parts', 'Transmission or transaxle: case and internal parts, torque converter',
      'Drive axles: axle housings and internal parts, axle shafts, constant-velocity joints', 'For as long as the original purchaser owns the vehicle, with no mileage limit (not transferable)', 'A $100 deductible applies to each covered repair'])
      assert(g.includes(x), x);
    assert((g.match(/For as long as the original purchaser owns the vehicle/g) || []).length === 1, 'shared duration printed once');
    assert(!/power[\s-]*train/i.test(g), 'no powertrain shorthand on the guide');
    assert(await pdfPages(p2) === 2, 'the longer lifetime-warranty guide still prints on two letter pages');
    await p2.screenshot({ path: join(SHOTS, '05h-buyers-guide-lifetime.png'), fullPage: true });
    await p2.goto(`${ORIGIN}/admin/vehicles/${V}/sticker`);
    await p2.waitForSelector('.ws-warranty');
    assert((await p2.textContent('.ws-warranty')).includes('Lifetime Limited Powertrain Warranty – unlimited time & miles while you own it'), 'sticker line');
    await p2.close();
  });
  await step('LIFETIME WARRANTY banner on the first photo of qualifying cars only', async () => {
    const p3 = await context.newPage();
    await p3.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await p3.waitForSelector('#wbanner');
    assert((await p3.textContent('#wbanner')).includes('LIFETIME WARRANTY') && (await p3.textContent('#wbanner')).includes('Limited powertrain · see Buyers Guide'), 'banner text');
    await p3.click('#gal .next');
    assert(!(await p3.isVisible('#wbanner')), 'hidden on the second photo');
    await p3.click('#gal .prev');
    assert(await p3.isVisible('#wbanner'), 'back on the first photo');
    await p3.screenshot({ path: join(SHOTS, '18-lifetime-banner.png'), clip: { x: 0, y: 0, width: 1280, height: 760 } });
    await p3.goto(`${ORIGIN}/`);
    await p3.waitForSelector('.inv-card');
    assert((await p3.$$('.inv-card .wbanner')).length === 1, 'inventory grid shows it on the qualifying car');
    // a car whose ad mentions it but whose Buyers Guide doesn't: no banner
    await p3.evaluate(() => { const v = window.__DB.vehicles[0]; v._saved = { bg_warranty: v.bg_warranty, bg_program: v.bg_program }; v.bg_warranty = 'as_is'; v.bg_program = null; window.__SAVE(); });
    await p3.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await p3.waitForSelector('#gal-img');
    assert(!(await p3.$('#wbanner')), 'no banner without the warranty on the Buyers Guide');
    await p3.evaluate(() => { const v = window.__DB.vehicles[0]; Object.assign(v, v._saved); delete v._saved; window.__SAVE(); });
    await p3.close();
  });
  await step('settings: Buyers Guide complaint contact and default', async () => {
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.waitForSelector('#bg');
    await page.fill('#s-bg_complaint_name', 'General Manager');
    await page.fill('#s-bg_complaint_phone', '(386) 555-0199');
    await page.selectOption('#s-bg_default_warranty', 'as_is');
    await page.click('#bg button');
    await page.waitForSelector('#toast >> text=Buyers Guide settings saved');
    const d = (await db()).dealerships[0];
    assert(d.bg_complaint_name === 'General Manager' && d.bg_default_warranty === 'as_is', JSON.stringify(d));
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#details`);
    await page.waitForSelector('#details');
  });
  await step('share: activity shows opens; send personal link', async () => {
    await page.click('[data-tab=shares]');
    await page.waitForSelector('#sendform');
    const t = await page.textContent('#tab');
    assert(t.includes('Mike Smith') && t.includes('Opened 2×'), 'existing share');
    await page.fill('#cn', 'Sarah Lee');
    await page.click('[data-channel=link]');
    await page.waitForSelector('text=Link copied');
    const shares = (await db()).shares;
    const s = shares.find((x) => x.customer_name === 'Sarah Lee');
    assert(s && s.channel === 'link' && s.staff_id === S, JSON.stringify(s));
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip === `${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b?s=${s.code}`, clip);
    await page.waitForSelector('text=Sarah Lee');
    assert(await page.isVisible('text=Not opened yet'), 'new share not opened');
  });
  await page.screenshot({ path: join(SHOTS, '06-admin-share.png'), fullPage: true });
  await step('share by text requires phone; opens sms: link', async () => {
    await page.fill('#cn', 'Tom Ray');
    await page.click('[data-channel=sms]');
    await page.waitForSelector('text=Enter a mobile number');
    await page.fill('#cp', '3865550199');
    const smsNav = page.waitForRequest((r) => r.url().startsWith('sms:'), { timeout: 3000 }).catch(() => null);
    await page.click('[data-channel=sms]');
    await page.waitForTimeout(400);
    const s = (await db()).shares.find((x) => x.customer_name === 'Tom Ray');
    assert(s && s.channel === 'sms' && s.customer_phone === '3865550199', 'sms share');
    await smsNav;
  });
  await step('unpublish / publish', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}`);
    await page.click('[data-status=draft]');
    await page.waitForSelector('text=Moved to drafts');
    assert((await db()).vehicles[0].status === 'draft', 'draft');
    await page.click('[data-status=published]');
    await page.waitForSelector('text=Published. Customers');
    assert((await db()).vehicles[0].status === 'published', 'published');
  });
  await step('QR window card creates a tracked QR link', async () => {
    await page.click('text=QR window card');
    await page.waitForSelector('.qr-card svg');
    const data = await page.getAttribute('.qr-card svg', 'data-qr');
    const qr = (await db()).shares.find((x) => x.channel === 'qr');
    assert(qr && data === `${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b?s=${qr.code}`, data);
    await page.screenshot({ path: join(SHOTS, '07-qr-card.png') });
    await page.reload();
    await page.waitForSelector('.qr-card svg');
    assert((await db()).shares.filter((x) => x.channel === 'qr').length === 1, 'QR share reused');
  });
  await step('add vehicle by VIN (and duplicate VIN goes to existing)', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/new`);
    await page.fill('#vin', '1c4gjxag5jw150863');
    await page.click('#f-vin button');
    await page.waitForURL(`**/admin/vehicles/${V}`);
    await page.goto(`${ORIGIN}/admin/vehicles/new`);
    await page.fill('#vin', '1GNSKNKD1MR100001');
    await page.click('#f-vin button');
    await page.waitForSelector('#details');
    const v = (await db()).vehicles.find((x) => x.vin === '1GNSKNKD1MR100001');
    assert(v && v.make === 'Chevrolet' && v.engine === '5.3L V8' && v.status === 'draft' && v.specs.Doors === '4', JSON.stringify(v));
    assert((await page.textContent('h1')).includes('2021 Chevrolet Tahoe LT'), 'editor title');
  });
  await step('import from listing URL', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/new`);
    await page.fill('#url', 'https://www.newsmyrnachevy.com/inventory/x/');
    await page.click('#f-import button');
    await page.waitForSelector('#details');
    const v = (await db()).vehicles.find((x) => x.vin === '1GCUYDED5RZ100777');
    assert(v && v.source === 'import' && v.condition === 'new', JSON.stringify(v));
    assert((await db()).vehicle_photos.filter((p) => p.vehicle_id === v.id).length === 2, 'photos imported');
  });
  await step('blocked website: helpful message, URL pasted in VIN box is moved to import', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/new`);
    await page.fill('#vin', 'https://www.newsmyrnachevy.com/inventory/blocked-tahoe/');
    await page.click('#f-vin button');
    await page.waitForSelector('text=blocks automatic imports');
    assert(await page.evaluate(() => document.querySelector('#bm-help').open), 'bookmarklet help opened');
    assert((await page.inputValue('#url')).startsWith('https://www.newsmyrnachevy.com/inventory/blocked'), 'moved to import box');
  });
  await step('one-click bookmarklet imports from the dealer page', async () => {
    const href = await page.getAttribute('#bm', 'href');
    assert(href.startsWith('javascript:'), 'bookmarklet href');
    const dealer = await context.newPage();
    watch(dealer);
    await dealer.goto('https://www.newsmyrnachevy.com/inventory/used-2021-chevrolet-tahoe/');
    await dealer.waitForFunction(() => [...document.images].every((i) => i.complete));
    const popup = context.waitForEvent('page');
    await dealer.evaluate((code) => { (0, eval)(code); }, decodeURIComponent(href.slice('javascript:'.length)));
    const opened = await popup;
    await opened.waitForSelector('#save-incoming');
    const banner = await opened.textContent('#incoming');
    assert(banner.includes('2021 Chevrolet Tahoe LT') && banner.includes('1GNSKNKD1MR100099') && banner.includes('3 photos'), banner);
    await opened.click('#save-incoming');
    await opened.waitForSelector('#details');
    const d = await opened.evaluate(() => window.__DB);
    const v = d.vehicles.find((x) => x.vin === '1GNSKNKD1MR100099');
    assert(v && v.price === 48995 && v.mileage === 42100 && v.year === 2021 && v.stock_number === 'T5521' && v.source === 'import', JSON.stringify(v));
    assert(d.vehicle_photos.filter((p) => p.vehicle_id === v.id).length === 3, 'photos (logo excluded)');
    await opened.close(); await dealer.close();
    await page.reload();
  });
  await step('bookmark on a VIN that already exists fills in the details and all gallery photos', async () => {
    // A vehicle created earlier from its VIN alone, like the real Corvette
    await page.evaluate((vin) => { window.__DB.vehicles.push({ id: 'cv-existing', dealership_id: window.__DB.dealerships[0].id, slug: '1993-chevrolet-corvette', status: 'published', condition: 'used', vin, year: 1993, make: 'Chevrolet', model: 'Corvette', price: 15000, features: [], specs: {}, source: 'manual', feed_locked: false, bg_systems: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }, CV);
    const href = await page.getAttribute('#bm', 'href');
    const dealer = await context.newPage();
    watch(dealer);
    await dealer.goto('https://www.newsmyrnachevy.com/inventory/used-1993-chevrolet-corvette/');
    const popup = context.waitForEvent('page');
    await dealer.evaluate((code) => { (0, eval)(code); }, decodeURIComponent(href.slice('javascript:'.length)));
    const opened = await popup;
    await opened.waitForSelector('#save-incoming');
    const banner = await opened.textContent('#incoming');
    assert(banner.includes('1993 Chevrolet Corvette 2DR CPE') && banner.includes('13 photos'), banner);
    await opened.evaluate((db) => { window.__DB.vehicles = db.vehicles; window.__DB.vehicle_photos = db.vehicle_photos; }, await page.evaluate(() => window.__DB));
    await opened.click('#save-incoming');
    await opened.waitForSelector('#details');
    assert(opened.url().includes('/admin/vehicles/cv-existing'), opened.url());
    const d = await opened.evaluate(() => window.__DB);
    const v = d.vehicles.find((x) => x.id === 'cv-existing');
    assert(v.stock_number === 'PL17115B' && v.mileage === 56974 && v.trim === '2DR CPE' && v.engine === '5.7L V8 16V' && v.transmission === '4-Speed Automatic', JSON.stringify(v));
    assert(v.price === 15000, 'price staff already set is kept');
    const ph = d.vehicle_photos.filter((p) => p.vehicle_id === 'cv-existing');
    assert(ph.length === 13 && ph.every((p) => p.url.includes(CV) && !p.url.includes('/thumbnails/')), JSON.stringify(ph.map((p) => p.url)));
    await opened.close(); await dealer.close();
    await page.reload();
  });
  await step('vehicle list filters', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles`);
    await page.waitForSelector('.vrow');
    assert((await page.$$('.vrow')).length === 5, 'five vehicles');
    await page.selectOption('#status', 'draft');
    await page.waitForTimeout(200);
    assert((await page.$$('.vrow')).length === 3, 'three drafts');
    await page.fill('#q', 'silverado');
    assert((await page.$$('.vrow')).length === 1, 'search');
  });
  await step('leads page shows and updates a lead', async () => {
    await page.evaluate(([D, V, S]) => {
      window.__DB.leads.push({ id: 'L1', dealership_id: D, vehicle_id: V, staff_id: S, kind: 'test_drive', name: 'Mike Smith', phone: '386-555-0100', email: 'mike@test.com', preferred_date: '2026-10-20', preferred_time: 'Afternoon', message: 'Soft top?', status: 'new', crm_sent_at: new Date().toISOString(), email_sent_at: new Date().toISOString(), created_at: new Date().toISOString() });
      window.__SAVE();
    }, [D, V, S]);
    await page.goto(`${ORIGIN}/admin/leads`);
    await page.waitForSelector('.lead');
    const t = await page.textContent('.lead');
    assert(t.includes('Mike Smith') && t.includes('Sent to CRM') && t.includes('Tue, Oct 20, Afternoon'), t);
    await page.selectOption('[data-lead=L1]', 'contacted');
    await page.waitForSelector('text=Lead updated');
    assert((await db()).leads[0].status === 'contacted', 'status saved');
  });
  await page.screenshot({ path: join(SHOTS, '08-admin-leads.png') });
  await step('staff: add salesperson with alert prefs, invite', async () => {
    await page.goto(`${ORIGIN}/admin/staff`);
    await page.click('#add');
    await page.fill('#sn', 'Carlos Diaz');
    await page.fill('#sp', '386-555-0123');
    await page.fill('#se', 'carlos@nsb.test');
    await page.uncheck('input[name=notify_email]');
    await page.click('#staff-form button');
    await page.waitForSelector('text=Carlos Diaz');
    const c = (await db()).staff.find((x) => x.full_name === 'Carlos Diaz');
    assert(c && c.notify_sms === true && c.notify_email === false && c.active === true, JSON.stringify(c));
    await page.fill('#ie', 'carlos@nsb.test');
    await page.selectOption('#is', c.id);
    await page.click('#invite button');
    await page.waitForSelector('text=Invite sent');
  });
  await step('settings: Elead ADF address, feed URL, manual upload', async () => {
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.fill('#s-crm_adf_email', 'nsbchevy@eleadtrack.net');
    await page.fill('#s-lead_email', 'internet@nsbchevy.com');
    await page.click('#routing button');
    await page.waitForSelector('text=Saved');
    await page.fill('#s-feed_url', 'https://feeds.homenet.test/nsb.csv');
    await page.click('#feed button.btn:not([type=button])');
    await page.waitForTimeout(300);
    const s = (await db()).dealership_settings[0];
    assert(s.crm_adf_email === 'nsbchevy@eleadtrack.net' && s.feed_url === 'https://feeds.homenet.test/nsb.csv' && s.notify_on_open === true, JSON.stringify(s));
    assert((await page.inputValue('input[aria-label="Ingest URL"]')).endsWith('/api/inventory/ingest?token=tok123'), 'ingest url');
    await page.click('#sync');
    await page.waitForSelector('text=Feed synced: 4 added');
    await page.setInputFiles('#upload input[type=file]', { name: 'feed.csv', mimeType: 'text/csv', buffer: Buffer.from('VIN,Stock\n1C4GJXAG5JW150863,R1\n') });
    await page.click('#upload button');
    await page.waitForTimeout(500);
    assert(api.ingests === 2, 'sync + upload ' + api.ingests);
  });
  await page.screenshot({ path: join(SHOTS, '09-admin-settings.png'), fullPage: true });
  await step('staff preview does not count as a customer open', async () => {
    const before = api.tracks.length;
    await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await page.waitForSelector('h1.hero-title');
    await page.waitForTimeout(300);
    assert(api.tracks.length === before, 'no track while signed in');
    assert(await page.isVisible('text=Vehicle history report'), 'document shows publicly');
    assert(await page.isVisible('text=Safety recalls'), 'recalls show publicly');
  });
  await step('photo banners: admin adds one by year, make and model; it shows on the first photo of matching cars only', async () => {
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.waitForSelector('#newbanner');
    await page.waitForSelector('#newbanner');
    await page.fill('#b-text', 'Jeep Days: 2.9% APR');
    await page.fill('#b-note', 'On approved credit.');
    await page.fill('#b-year_from', '2017'); await page.fill('#b-year_to', '2019');
    await page.fill('#b-make', ' jeep '); await page.fill('#b-model', 'WRANGLER');
    assert((await page.textContent('#b-preview')).includes('1 car in stock'), await page.textContent('#b-preview'));
    await page.click('#newbanner button');
    await page.waitForSelector('#toast >> text=Banner added');
    await page.fill('#b-text', 'Silverado Event'); await page.fill('#b-make', 'Chevrolet'); await page.fill('#b-model', 'Silverado 1500');
    await page.fill('#b-year_from', '2030'); await page.fill('#b-year_to', '2020');
    await page.click('#newbanner button');
    await page.waitForSelector('#toast >> text=is after');
    await page.fill('#b-year_from', ''); await page.fill('#b-year_to', '');
    await page.click('#newbanner button');
    await page.waitForSelector('#toast >> text=Banner added');
    const rows = (await db()).dealership_banners;
    assert(rows.length === 2 && rows[0].make === 'jeep' && rows[0].year_from === 2017 && rows[0].active === true && rows[0].condition === 'any', JSON.stringify(rows[0]));
    assert((await page.textContent('#banners')).includes('2017 to 2019 jeep WRANGLER'), 'rule described');
    await page.screenshot({ path: join(SHOTS, '09b-photo-banners.png') });

    await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await page.waitForSelector('#pbanner');
    assert((await page.textContent('#pbanner')).includes('Jeep Days: 2.9% APR') && (await page.textContent('#pbanner')).includes('On approved credit.'), 'banner text');
    assert(!(await page.textContent('#gal')).includes('Silverado Event'), 'non-matching rule not shown');
    await page.click('#gal .nav.next');
    assert(await page.isHidden('#pbanner'), 'only on the first photo');
    await page.click('#gal .nav.prev');
    assert(await page.isVisible('#pbanner'), 'back on the first photo');
    await page.goto(`${ORIGIN}/`);
    await page.waitForSelector('.inv-card');
    const jeep = page.locator('.inv-card[href*="2018-jeep"] .pbanner');
    assert((await jeep.count()) === 1 && (await jeep.textContent()).includes('Jeep Days'), 'grid banner');

    await page.goto(`${ORIGIN}/admin/settings`);
    await page.click(`[data-toggle="${rows[0].id}"]`);
    await page.waitForSelector('#toast >> text=Banner turned off');
    await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await page.waitForSelector('h1.hero-title'); await page.waitForTimeout(200);
    assert(!(await page.$('#pbanner')), 'switched off');
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.click(`[data-toggle="${rows[0].id}"]`);
    await page.waitForSelector('#toast >> text=Banner turned on');
    await page.click(`[data-delrule="${rows[1].id}"]`);
    await page.waitForSelector('#toast >> text=Banner deleted');
    assert((await db()).dealership_banners.length === 1, 'deleted');
  });
  await step('delete vehicle', async () => {
    const id = (await db()).vehicles.find((x) => x.vin === '1GNSKNKD1MR100001').id;
    await page.goto(`${ORIGIN}/admin/vehicles/${id}`);
    await page.click('#delete');
    await page.waitForURL('**/admin/vehicles');
    assert(!(await db()).vehicles.some((x) => x.id === id), 'deleted');
  });
  await step('account + sign out', async () => {
    await page.goto(`${ORIGIN}/admin/account`);
    await page.fill('#p1', 'newpassword1'); await page.fill('#p2', 'newpassword1');
    await page.click('#pw button');
    await page.waitForSelector('text=Password saved');
    await page.click('#so');
    await page.waitForSelector('#pw');
    await page.goto(`${ORIGIN}/admin/settings`);
    await page.waitForURL('**/admin/login**');
  });
  const stubErrors = await page.evaluate(() => window.__STUB_ERRORS);
  await step('no schema/stub errors', async () => assert(!stubErrors.length, stubErrors.join('; ')));
  await context.close();
}

// ================= messaging: consent, inbox, sending, usage, sender identity =================
console.log('Messaging');
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  const db = () => page.evaluate(() => window.__DB);

  await step('test-drive form offers SMS consent with the dealership wording', async () => {
    api.leads.length = 0;
    await page.goto(`${ORIGIN}/v/2018-jeep-wrangler-sport-s-r287418b`);
    await page.waitForSelector('input[name=sms_consent]');
    assert(!(await page.isChecked('input[name=sms_consent]')), 'unchecked by default');
    assert((await page.textContent('#lead-form')).includes('I agree to receive texts from New Smyrna Beach Chevrolet'), 'consent wording');
    await page.fill('#f-name', 'Ana Ruiz'); await page.fill('#f-phone', '386-555-0144');
    await page.check('input[name=sms_consent]');
    await page.click('#lead-form button[type=submit]');
    await page.waitForSelector('.form-ok');
    const l = api.leads[0];
    assert(l.sms_consent === true && l.consent_text.includes('I agree to receive texts') && l.page_url.endsWith('/v/2018-jeep-wrangler-sport-s-r287418b'), JSON.stringify(l));
  });
  await step('public SMS terms + privacy page', async () => {
    await page.goto(`${ORIGIN}/sms-terms#privacy`);
    await page.waitForSelector('#privacy');
    const t = await page.textContent('main');
    for (const x of ['reply STOP', 'HELP', 'Message and data rates may apply', 'do not sell, rent or share your mobile number', 'I agree to receive texts']) assert(t.includes(x), x);
  });

  await page.goto(`${ORIGIN}/admin/login`);
  await page.fill('#email', 'owner@nsb.test'); await page.fill('#password', 'correct-horse');
  await page.click('#pw button');
  await page.waitForSelector('.vrow');

  await step('inbox: unread badge, thread with delivery status, mark read', async () => {
    assert((await page.textContent('.nav-badge')) === '1', 'unread badge');
    await page.click('a[href="/admin/inbox"]');
    await page.waitForSelector('.convo');
    assert((await page.textContent('.convo')).includes('Does it have the soft top?'), 'snippet');
    await page.click('.convo');
    await page.waitForSelector('.bubble.in');
    const t = await page.textContent('#thread');
    assert(t.includes('Does it have the soft top?') && t.includes('✓✓') && t.includes('No text permission yet'), t.slice(0, 300));
    await page.waitForTimeout(200);
    assert((await db()).customers[0].unread_count === 0, 'marked read');
  });
  await page.screenshot({ path: join(SHOTS, '11-inbox.png') });
  await step('inbox: reply inside the customer-initiated window (no attestation needed)', async () => {
    assert(!(await page.$('#attest-row')), 'no attestation prompt when customer texted first');
    await page.fill('#compose textarea', 'Yes, it has the soft top. Want to see it Saturday?');
    await page.click('#compose button');
    await page.waitForSelector('text=Text sent');
    const last = api.sends.at(-1);
    assert(last.body.channel === 'sms' && last.body.kind === 'conversation' && last.body.customer_id === CUST && last.auth === 'Bearer jwt-' + OWNER, JSON.stringify(last));
  });
  await step('inbox: "Do not text" records a staff opt-out', async () => {
    await page.click('#optout');
    await page.waitForSelector('.consent-pill.opted_out');
    const r = (await db()).consent_records[0];
    assert(r.action === 'opt_out' && r.method === 'staff_recorded' && r.recorded_by === OWNER, JSON.stringify(r));
  });
  await step('share tab: send from the dealership number with consent attestation', async () => {
    await page.goto(`${ORIGIN}/admin/vehicles/${V}#shares`);
    await page.waitForSelector('[data-channel=dealer-sms]');
    assert((await page.textContent('[data-channel=dealer-sms]')).includes('+13865550000'), 'shows dealership number');
    await page.fill('#cn', 'Sarah Lee'); await page.fill('#cp', '386-555-0177');
    await page.click('[data-channel=dealer-sms]');
    await page.waitForSelector('text=permission');
    await page.check('#sendform input[name=attested]');
    await page.fill('#cn', 'Sarah Lee'); await page.fill('#cp', '386-555-0177');
    await page.click('[data-channel=dealer-sms]');
    await page.waitForSelector('text=Text sent from the dealership number');
    const b = api.sends.at(-1).body;
    assert(b.kind === 'portfolio_share' && b.vehicle_id === V && b.customer.phone === '386-555-0177' && b.consent.attested === true, JSON.stringify(b));
  });
  await step('usage page: allowance meters (no provider costs for dealers)', async () => {
    await page.goto(`${ORIGIN}/admin/usage`);
    await page.waitForSelector('.meter');
    const t = await page.textContent('main');
    assert(t.includes('of 2,500 included') && t.includes('$995/month') && !t.includes('Margin'), t.slice(0, 400));
  });
  await page.screenshot({ path: join(SHOTS, '12-usage.png'), fullPage: true });
  await step('settings: registration details, suggested wording, sending domain', async () => {
    await page.goto(`${ORIGIN}/admin/settings/messaging`);
    await page.waitForSelector('#biz');
    await page.fill('#b-ein', '59-1234567');
    await page.click('#fill');
    await page.click('#biz button.btn:not([type=button])');
    await page.waitForSelector('text=Saved');
    const p = (await db()).messaging_profiles[0];
    assert(p.ein === '59-1234567' && p.sample_messages.length === 2 && /unchecked SMS consent box/.test(p.message_flow), JSON.stringify(p).slice(0, 300));
    await page.fill('#domform input', 'mail.newsmyrnachevy.com');
    await page.click('#domform button');
    await page.waitForSelector('text=resend._domainkey.mail');
    await page.click('#verify');
    await page.waitForSelector('text=Domain verified');
    assert(api.domains.map((d) => d.action).join() === 'create,verify', JSON.stringify(api.domains));
  });
  await page.screenshot({ path: join(SHOTS, '13-settings-messaging.png'), fullPage: true });
  const stubErrors = await page.evaluate(() => window.__STUB_ERRORS);
  await step('no schema/stub errors (messaging)', async () => assert(!stubErrors.length, stubErrors.join('; ')));
  await context.close();
}

// ================= roles =================
console.log('Roles');
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  await step('an expired or used email link explains itself on the sign-in page', async () => {
    await page.goto(`${ORIGIN}/admin/account#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    await page.waitForSelector('#link-error');
    assert(new URL(page.url()).pathname === '/admin/login', page.url());
    assert((await page.textContent('#link-error')).includes('expired or was already used'), 'explained');
    await page.fill('#email', 'sales@nsb.test');
    await page.evaluate(() => { window.__OTP_ERROR = 'email rate limit exceeded'; });
    await page.click('#magic');
    await page.waitForSelector('#msg >> text=Too many emails were sent');
    await page.evaluate(() => { window.__OTP_ERROR = null; });
    await page.click('#magic');
    await page.waitForSelector('#msg >> text=open it on this device');
    const otp = (await page.evaluate(() => window.__CALLS.filter((c) => c.otp))).at(-1).otp;
    assert(otp.email === 'sales@nsb.test' && otp.options.shouldCreateUser === false && otp.options.emailRedirectTo.endsWith('/admin/account?welcome=1'), JSON.stringify(otp));
  });
  await step('admins can send a teammate a sign-in link from Staff', async () => {
    await page.fill('#email', 'owner@nsb.test'); await page.fill('#password', 'correct-horse');
    await page.click('#pw button');
    await page.waitForSelector('.admin-top');
    await page.goto(`${ORIGIN}/admin/staff`);
    await page.waitForSelector('[data-link="sales@nsb.test"]');
    await page.evaluate(() => { window.__OTP_ERROR = 'email rate limit exceeded'; });
    await page.click('[data-link="sales@nsb.test"]');
    await page.waitForSelector('#toast >> text=custom SMTP');
    await page.evaluate(() => { window.__OTP_ERROR = null; });
    await page.click('[data-link="sales@nsb.test"]');
    await page.waitForSelector('#toast >> text=Sign-in link sent to sales@nsb.test');
    assert((await page.evaluate(() => window.__CALLS.filter((c) => c.otp))).at(-1).otp.email === 'sales@nsb.test', 'sent to them');
    await page.click('.admin-top .me');
    await page.waitForSelector('#so');
    await page.click('#so');
    await page.waitForSelector('#pw');
  });
  await step('salesperson sees no Usage/Settings/Platform and is refused the platform console', async () => {
    await page.goto(`${ORIGIN}/admin/login`);
    await page.fill('#email', 'sales@nsb.test'); await page.fill('#password', 'sales-pass');
    await page.click('#pw button');
    await page.waitForSelector('.vrow');
    const nav = await page.textContent('.admin-top nav');
    assert(nav.includes('Inbox') && !nav.includes('Usage') && !nav.includes('Settings') && !nav.includes('Platform'), nav);
    await page.goto(`${ORIGIN}/platform`);
    await page.waitForSelector('text=Platform operators only');
  });
  await context.close();
}

// ================= platform console =================
console.log('Platform console');
{
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  const db = () => page.evaluate(() => window.__DB);
  await page.goto(`${ORIGIN}/admin/login?next=/platform`);
  await page.fill('#email', 'op@aiautoengine.test'); await page.fill('#password', 'operator-pass');
  await page.click('#pw button');
  await step('overview: every dealership with cost, invoice and margin', async () => {
    await page.waitForSelector('table.data tbody tr');
    const t = await page.textContent('table.data');
    assert(t.includes('New Smyrna Beach Chevrolet') && t.includes('Approved') && t.includes('+13865550000') && t.includes('$995.00'), t.slice(0, 500));
    const kpis = await page.textContent('.kpis');
    assert(kpis.includes('Messaging cost') && kpis.includes('Margin'), kpis);
  });
  await page.screenshot({ path: join(SHOTS, '14-platform-overview.png') });
  await step('dealership: edit plan allowance and see cost breakdown', async () => {
    await page.click('table.data a');
    await page.waitForSelector('#plan');
    await page.fill('#b-sms', '3000');
    await page.uncheck('input[name=allow_overage]');
    await page.click('#plan button');
    await page.waitForSelector('text=Plan saved');
    const b = (await db()).dealership_billing[0];
    assert(b.included_sms_segments === 3000 && b.allow_overage === false, JSON.stringify(b));
    await page.waitForSelector('#usage table');
    const t = await page.textContent('#usage');
    assert(t.includes('Total messaging cost') && t.includes('Margin') && t.includes('Phone number +13865550000'), t.slice(0, 400));
  });
  await page.screenshot({ path: join(SHOTS, '15-platform-dealer-billing.png'), fullPage: true });
  await step('dealership: 10DLC onboarding actions', async () => {
    await page.click('[data-tab=texting]');
    await page.waitForSelector('.steps');
    assert((await page.$$('.steps li.done')).length === 22, 'approved dealership shows all steps done');
    await page.evaluate(() => { const p = window.__DB.messaging_profiles[0]; Object.assign(p, { twilio_subaccount_sid: null, twilio_messaging_service_sid: null, twilio_phone_number: null, a2p_step: 'not_started', a2p_status: 'not_started', sms_enabled: false }); window.__SAVE(); });
    await page.reload();
    await page.waitForSelector('[data-act=provision]');
    await page.click('[data-act=run]');
    await page.waitForSelector('text=Brand review (TCR');
    assert(api.a2p.at(-1).action === 'run', JSON.stringify(api.a2p));
    await page.waitForFunction(() => document.querySelectorAll('.steps li.done').length === 18, null, { timeout: 5000 });
    await page.fill('#buy input', '386');
    await page.click('#buy button');
    await page.waitForSelector('text=Bought +13865551234');
    assert(api.a2p.at(-1).action === 'buy_number' && api.a2p.at(-1).area_code === '386', 'buy number');
  });
  await page.screenshot({ path: join(SHOTS, '16-platform-onboarding.png'), fullPage: true });
  await step('rates & plans save', async () => {
    await page.goto(`${ORIGIN}/platform/settings`);
    await page.waitForSelector('#r-default_monthly_fee');
    assert((await page.inputValue('#r-default_monthly_fee')) === '995', 'default fee');
    await page.fill('#r-sms_out_segment_cost', '0.0079');
    await page.click('#f button');
    await page.waitForSelector('text=Saved');
    assert((await db()).platform_settings[0].sms_out_segment_cost === 0.0079, 'rate saved');
  });
  await step('create a new dealership', async () => {
    await page.goto(`${ORIGIN}/platform/dealerships/new`);
    await page.fill('#n', 'Daytona Chevrolet');
    assert((await page.inputValue('#s')) === 'daytonachevy', 'slug suggestion ' + (await page.inputValue('#s')));
    await page.fill('#o', 'gm@daytonachevy.test');
    await page.click('#f button');
    await page.waitForSelector('text=Created Daytona Chevrolet');
    assert(api.dealers[0].slug === 'daytonachevy' && api.dealers[0].owner_email === 'gm@daytonachevy.test', JSON.stringify(api.dealers));
  });
  const stubErrors = await page.evaluate(() => window.__STUB_ERRORS);
  await step('no schema/stub errors (platform)', async () => assert(!stubErrors.length, stubErrors.join('; ')));
  await context.close();
}

// ================= photographer (phone) =================
console.log('Photographer');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  const db = () => page.evaluate(() => window.__DB);
  const jpg = (n) => ({ name: `IMG_00${n}.jpg`, mimeType: 'image/jpeg', buffer: readFileSync(join(PUB, `seed/jeep-0${n}.jpg`)) });
  const TRAX = '9d2c1f1e-0000-4000-8000-0000000000f9';
  await step('photographer signs in and only gets the Photos page', async () => {
    await page.goto(`${ORIGIN}/admin/login`);
    await page.fill('#email', 'photo@lotpics.test'); await page.fill('#password', 'photo-pass');
    await page.click('#pw button');
    await page.waitForSelector('#stock');
    assert(new URL(page.url()).pathname === '/admin/shoot', page.url());
    const nav = (await page.textContent('.admin-top nav')).replace(/\s+/g, ' ').trim();
    assert(nav === 'Photos', nav);
    for (const p of ['/admin/vehicles', '/admin/leads', '/admin/settings', `/admin/vehicles/${V}`]) {
      await page.goto(`${ORIGIN}${p}`);
      await page.waitForSelector('#stock');
      assert(new URL(page.url()).pathname === '/admin/shoot', `${p} → ${page.url()}`);
    }
  });
  await step('find a car by stock number (any case, with #) or the last 6 of the VIN', async () => {
    await page.fill('#stock', 'zz999');
    await page.click('#find button');
    await page.waitForSelector('#find-msg >> text=No car in stock matches "ZZ999"');
    await page.fill('#stock', '150863');
    await page.click('#find button');
    await page.waitForSelector('.shoot-car >> text=2018 Jeep Wrangler Sport S');
    await page.click('#next');
    await page.fill('#stock', '#r287418b');
    await page.click('#find button');
    await page.waitForSelector('.shoot-car');
    const t = await page.textContent('.shoot-car');
    assert(t.includes('2018 Jeep Wrangler Sport S') && t.includes('R287418B') && t.includes('…JW150863') && t.includes('32 of 6 photos ✓'), t);
    assert(await page.isChecked('#cover'), 'only stock photos on file, so new photos go first by default');
    assert((await page.getAttribute('#cam', 'capture')) === 'environment' && (await page.getAttribute('#cam', 'accept')) === 'image/*', 'opens the rear camera');
  });
  await step('each shot uploads to that car, in order, ahead of the stock photos', async () => {
    await page.setInputFiles('#cam', jpg(1));
    await page.setInputFiles('#cam', jpg(2));
    await page.setInputFiles('#roll', [jpg(3), jpg(4)]);
    await page.waitForSelector('.shoot-status >> text=All 4 photos uploaded', { timeout: 15000 });
    const photos = (await db()).vehicle_photos.filter((p) => p.vehicle_id === V).sort((a, b) => a.position - b.position);
    const mine = photos.filter((p) => p.uploaded_by === PHOTO);
    assert(mine.length === 4 && mine.every((p) => p.source === 'upload'), JSON.stringify(mine));
    assert(photos.slice(0, 4).every((p) => p.uploaded_by === PHOTO), 'new photos first; the first shot is the cover');
    const ups = await page.evaluate(() => window.__UPLOADS);
    assert(ups.slice(-4).every((u) => new RegExp(`^${D}/vehicles/${V}/[0-9a-f-]{36}\\.jpg$`).test(u.path)), JSON.stringify(ups.slice(-4).map((u) => u.path)));
  });
  await page.screenshot({ path: join(SHOTS, '17-photographer-phone.png'), fullPage: true });
  await step('a dropped upload retries by itself; moving to the next car keeps photos with the right car', async () => {
    await page.evaluate((T) => {
      window.__DB.vehicles.push({ id: T, dealership_id: window.__DB.dealerships[0].id, slug: '2025-chevrolet-trax', status: 'draft', condition: 'used', stock_number: 'PJ17152',
        vin: 'KL77LKEP3SC259877', year: 2025, make: 'Chevrolet', model: 'Trax', trim: 'ACTIV', features: [], specs: {}, price_stack: [], source: 'feed', created_at: '2026-10-30T12:00:00Z' });
      window.__FAIL_UPLOADS = 1; window.__SAVE();
    }, TRAX);
    await page.setInputFiles('#cam', jpg(5));                 // the Jeep's 5th photo: its first upload attempt fails
    await page.click('#next');
    await page.fill('#stock', 'pj17152');
    await page.click('#find button');
    await page.waitForSelector('.shoot-car >> text=2025 Chevrolet Trax ACTIV');
    assert((await page.textContent('.shoot-car')).includes('0 of 6 photos'), 'draft car with no photos is found');
    await page.setInputFiles('#cam', jpg(6));                 // the Trax's first photo
    await page.waitForSelector('.shoot-thumb.retrying, .shoot-thumb.done', { timeout: 5000 });
    await page.waitForSelector('.shoot-status >> text=All 6 photos uploaded', { timeout: 20000 });
    const all = (await db()).vehicle_photos.filter((p) => p.uploaded_by === PHOTO);
    assert(all.filter((p) => p.vehicle_id === V).length === 5 && all.filter((p) => p.vehicle_id === TRAX).length === 1, all.map((p) => p.vehicle_id).join());
    const ups = await page.evaluate(() => window.__UPLOADS);
    assert(ups.some((u) => u.path.includes(`/vehicles/${TRAX}/`)) && ups.filter((u) => u.path.includes(`/vehicles/${V}/`)).length === 5, 'storage paths per car');
  });
  await step('photographer prints the window sticker and Buyers Guide from the Photos page', async () => {
    await page.evaluate(() => { const c = window.__DB.vehicle_chomes[0]; Object.assign(c, { highlight_features: ['Removable hard top'], recon_cost: 450, acquisition_notes: 'Auction buy',
      report_provider: 'carfax', prior_owners: 2, accidents_count: 0, title_issues: false }); window.__SAVE(); });
    await page.click('#next');
    await page.fill('#stock', 'R287418B');
    await page.click('#find button');
    await page.waitForSelector('.shoot-print');
    const [st] = await Promise.all([context.waitForEvent('page'), page.click('.shoot-print a:has-text("Window sticker")')]);
    await st.waitForSelector('.ws');
    const t = await st.textContent('.ws');
    for (const x of ['2018 Jeep Wrangler Sport S', 'Removable hard top', '2 prior owners (CARFAX report)', 'Scan for photos']) assert(t.includes(x), x);
    for (const bad of ['450', 'Auction buy']) assert(!t.includes(bad), 'leaked ' + bad);
    assert(await st.$('.ws-qr svg[data-qr*="?s="]'), 'tracked QR code');
    assert((await st.textContent('.page-head')).includes('Photos'), 'back link goes to Photos');
    const calls = await st.evaluate(() => window.__CALLS.map((c) => c.table || c.rpc));
    assert(!calls.includes('vehicle_chomes') && !calls.includes('shares') && calls.includes('vp_sticker_chomes') && calls.includes('vp_qr_share'), calls.join());
    await st.close();
    const [bg] = await Promise.all([context.waitForEvent('page'), page.click('.shoot-print a:has-text("Buyers Guide")')]);
    await bg.waitForSelector('.bg-print-page .bg-front');
    assert((await bg.textContent('.bg-print-page')).includes('BUYERS GUIDE'), 'Buyers Guide opens');
    await bg.close();
    await page.goto(`${ORIGIN}/admin/vehicles/${V}/print`);
    await page.waitForSelector('#stock');
    assert(new URL(page.url()).pathname === '/admin/shoot', 'other admin print pages stay closed');
  });
  await step('nothing else is loaded for a photographer (no inbox counts, no leads)', async () => {
    const calls = await page.evaluate(() => window.__CALLS.map((c) => c.table).filter(Boolean));
    for (const t of ['customers', 'leads', 'messages', 'vehicle_chomes', 'vehicle_factory_data', 'dealership_settings']) assert(!calls.includes(t), `queried ${t}`);
  });
  const stubErrors = await page.evaluate(() => window.__STUB_ERRORS);
  await step('no schema/stub errors (photographer)', async () => assert(!stubErrors.length, stubErrors.join('; ')));
  await context.close();
}

// ================= admin mobile screenshot =================
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await setup(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${ORIGIN}/admin/login`);
  await page.fill('#email', 'owner@nsb.test'); await page.fill('#password', 'correct-horse');
  await page.click('#pw button');
  await page.waitForSelector('.vrow');
  await page.goto(`${ORIGIN}/admin/vehicles/${V}#shares`);
  await page.waitForSelector('#sendform');
  await page.screenshot({ path: join(SHOTS, '10-admin-share-mobile.png'), fullPage: true });
  await context.close();
}

await browser.close();
const relevant = consoleErrors.filter((e) => !/STUB/.test(e));
if (relevant.length) { failures++; console.log('  FAIL - console errors:\n    ' + relevant.join('\n    ')); }
console.log(failures ? `\n${failures} FAILED` : '\nALL BROWSER TESTS PASSED');
process.exit(failures ? 1 : 0);
