// The feed safety guard: a damaged or partial file never mass-removes vehicles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideHold, runFeedSync } from '../../functions/_lib/feed.js';
import { feedToRows } from '../../functions/_lib/inventory.js';

const vin = (i) => `1GCUYDED5RZ${String(100000 + i).padStart(6, '0')}`;
const csv = (n, cols = 'VIN,Stock,Price') => [cols, ...Array.from({ length: n }, (_, i) => `${vin(i)},S${i},${20000 + i}`)].join('\n');
const preview = (active, missing) => ({ active, missing_ids: Array.from({ length: missing }, (_, i) => `id${i}`), missing_sample: Array.from({ length: missing }, (_, i) => ({ id: `id${i}`, vin: vin(1000 + i), stock_number: `X${i}`, title: '2024 Chevrolet' })), new: 0 });
const S = { feed_mark_missing_sold: true, feed_mode: 'snapshot', feed_max_removal_pct: 15 };

test('the handoff example: 200 in stock, a damaged file with 10 → nothing removed, held for review', () => {
  const d = decideHold({ parsed: feedToRows(csv(10)), preview: preview(200, 190), settings: S });
  assert.equal(d.remove, false);
  assert.equal(d.held, true);
  assert.ok(d.reasons.some((r) => /less than half/.test(r)) && d.reasons.some((r) => /would remove 190 of 200 vehicles \(95%\)/.test(r)), d.reasons.join(' | '));
});

test('a normal day (a few cars sold) removes them', () => {
  const d = decideHold({ parsed: feedToRows(csv(195)), preview: preview(200, 5), settings: S });
  assert.deepEqual(d, { remove: true, reasons: [] });
});

test('more than the allowed share in one import is held; the limit is a setting', () => {
  assert.equal(decideHold({ parsed: feedToRows(csv(160)), preview: preview(200, 40), settings: S }).held, true);
  assert.equal(decideHold({ parsed: feedToRows(csv(160)), preview: preview(200, 40), settings: { ...S, feed_max_removal_pct: 25 } }).remove, true);
});

test('missing price or stock columns hold removals; incremental files and the setting never remove', () => {
  const noPrice = decideHold({ parsed: feedToRows(csv(195, 'VIN,Stock,Miles')), preview: preview(200, 5), settings: S });
  assert.ok(noPrice.held && noPrice.reasons.includes('The file has no price column.'));
  assert.deepEqual(decideHold({ parsed: feedToRows(csv(10)), preview: preview(200, 190), settings: { ...S, feed_mode: 'incremental' } }).remove, false);
  assert.equal(decideHold({ parsed: feedToRows(csv(10)), preview: preview(200, 190), settings: { ...S, feed_mode: 'incremental' } }).held, undefined, 'incremental is not a hold');
  assert.equal(decideHold({ parsed: feedToRows(csv(195)), preview: preview(200, 5), settings: { ...S, feed_mark_missing_sold: false } }).remove, false);
  assert.deepEqual(decideHold({ parsed: feedToRows(csv(3)), preview: preview(3, 0), settings: S }), { remove: false, reasons: [] }, 'nothing missing, nothing to hold');
});

test('file details: columns found, duplicate VINs, rows without VIN', () => {
  const p = feedToRows(`VIN,Stock,Price\n${vin(1)},A,1\n${vin(1)},B,2\n,C,3\n${vin(2)},D,4`);
  assert.deepEqual(p.columns.sort(), ['price', 'stock_number', 'vin']);
  assert.deepEqual([p.rows.length, p.duplicates, p.noVin], [2, [vin(1)], 1]);
});

test('a held import still adds and updates cars, removes nothing, logs the run with the list, and emails the alert address', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    calls.push({ url, method: opts.method || 'GET', body });
    if (url.includes('rpc/vp_feed_preview')) return Response.json(preview(200, 190));
    if (url.includes('rpc/vp_feed_sync')) return Response.json({ inserted: 0, updated: 10, marked_sold: 0, rows: 10 });
    if (url.includes('/rest/v1/feed_runs')) return Response.json([{ id: 'run9' }]);
    if (url.includes('platform_settings')) return Response.json([{ email_cost: 0.0004 }]);
    if (url.includes('/rest/v1/messages')) return Response.json([{ id: 'm1' }]);
    if (url.includes('api.resend.com')) return Response.json({ id: 're1' });
    return new Response(null, { status: 204 });
  };
  try {
    const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', RESEND_API_KEY: 're_x', EMAIL_FROM_DOMAIN: 'aiautoengine.com' };
    const r = await runFeedSync(env, { id: 'd1', slug: 'nsbchevy', name: 'NSB Chevrolet' }, { ...S, feed_alert_email: 'gm@nsb.test' }, csv(10), 'sftp: inventory.csv');
    assert.equal(r.held, true);
    assert.equal(r.held_removals, 190);
    assert.equal(r.run_id, 'run9');
    const sync = calls.find((c) => c.url.includes('vp_feed_sync'));
    assert.equal(sync.body.p_mark_missing_sold, false, 'nothing removed');
    assert.equal(sync.body.p_rows.length, 10, 'the 10 listed cars are still updated');
    const run = calls.find((c) => c.url.includes('/rest/v1/feed_runs')).body;
    assert.equal(run.status, 'held');
    assert.equal(run.remove_ids.length, 190);
    assert.equal(run.active_before, 200);
    assert.ok(calls.some((c) => c.url.includes('api.resend.com')), 'alert emailed');
  } finally { globalThis.fetch = real; }
});
