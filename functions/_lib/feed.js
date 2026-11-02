// Shared inventory-feed pipeline: CSV text → rows → safety check → vp_feed_sync → logged in feed_runs.
//
// The safety check (decideHold) protects live inventory from a damaged, partial or wrong file: vehicles are only
// marked sold for being missing from a file when the file looks like a complete inventory. Otherwise the import adds
// and updates vehicles but removes nothing, and an admin reviews the would-be removals (Settings → Inventory feed).
import { sb, HttpError, requireEnv, escapeHtml } from './util.js';
import { feedToRows } from './inventory.js';
import { sendEmail } from './messaging.js';

const IMPORTANT = { price: 'price', stock_number: 'stock number' };

/** Pure: should this import be allowed to remove vehicles? */
export function decideHold({ parsed, preview, settings }) {
  const missing = preview.missing_ids.length;
  const active = preview.active;
  if ((settings.feed_mode || 'snapshot') === 'incremental') return { remove: false, reasons: [], note: 'Incremental file: missing vehicles are never removed.' };
  if (settings.feed_mark_missing_sold === false) return { remove: false, reasons: [], note: 'Removing missing vehicles is turned off in Settings.' };
  if (!missing) return { remove: false, reasons: [] };
  const reasons = [];
  const pct = Number(settings.feed_max_removal_pct) || 15;
  const allowed = Math.max(3, Math.ceil((active * pct) / 100));
  if (parsed.rows.length < 3) reasons.push(`The file lists only ${parsed.rows.length} vehicle${parsed.rows.length === 1 ? '' : 's'}.`);
  if (active >= 6 && parsed.rows.length < active * 0.5) reasons.push(`The file lists ${parsed.rows.length} vehicles but ${active} are in stock: less than half.`);
  if (missing > allowed) reasons.push(`It would remove ${missing} of ${active} vehicles (${Math.round((missing / Math.max(1, active)) * 100)}%), more than the ${pct}% allowed in one import.`);
  for (const [col, label] of Object.entries(IMPORTANT)) if (!parsed.columns.includes(col)) reasons.push(`The file has no ${label} column.`);
  if (parsed.noVin > Math.max(2, parsed.totalLines * 0.1)) reasons.push(`${parsed.noVin} of ${parsed.totalLines} lines have no VIN.`);
  return reasons.length ? { remove: false, reasons, held: true } : { remove: true, reasons: [] };
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function keepFile(env, dealership, text, hash) {
  try {
    requireEnv(env, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
    const path = `${dealership.id}/feeds/${new Date().toISOString().slice(0, 10)}-${hash.slice(0, 12)}.csv`;
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/internal/${path}`, {
      method: 'POST', headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }), 'content-type': 'text/csv', 'x-upsert': 'true' }, body: text });
    return res.ok ? path : null;
  } catch { return null; }
}

async function logRun(env, row) {
  try {
    const r = await sb(env, '/rest/v1/feed_runs', { method: 'POST', body: row, prefer: 'return=representation' });
    return Array.isArray(r) ? r[0] : r;
  } catch (e) { console.error('feed_runs insert failed', e); return null; } // the import itself must not fail over its log
}

async function alertHeld(env, dealership, settings, run, origin) {
  if (!settings.feed_alert_email) return;
  const list = run.remove_sample.slice(0, 25).map((v) => `<li>${escapeHtml(v.title || '')} · Stock ${escapeHtml(v.stock_number || '–')} · ${escapeHtml(v.vin)}</li>`).join('');
  try {
    await sendEmail(env, { dealership, to: settings.feed_alert_email, audience: 'staff', purpose: 'feed_alert',
      subject: `Inventory import held: ${run.would_remove} vehicles were NOT removed`,
      html: `<p>Today's inventory file for ${escapeHtml(dealership.name)} looked incomplete, so nothing was removed from your website.</p>
        <ul>${run.hold_reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <p>Vehicles that would have been marked sold:</p><ul>${list}</ul>
        <p>Review it in Settings → Inventory feed${origin ? `: <a href="${escapeHtml(origin)}/admin/settings#feed-history">open</a>` : ''}.</p>`,
      text: `Inventory import held for ${dealership.name}. ${run.hold_reasons.join(' ')} Review it in Settings → Inventory feed.` });
  } catch (e) { console.error('feed alert failed', e); }
}

export async function runFeedSync(env, dealership, settings, csvText, source, { origin } = {}) {
  const parsed = feedToRows(csvText, { dealerId: settings.feed_dealer_id });
  if (!parsed.totalLines) throw new HttpError(422, 'The feed file is empty or not a CSV');
  if (!parsed.columns.includes('vin')) throw new HttpError(422, 'The feed file has no VIN column, so nothing was imported. Check the file\'s header row.');
  if (!parsed.rows.length) throw new HttpError(422, `The feed had ${parsed.totalLines} lines but no usable VINs. Check the DealerId filter and column headers.`);

  const hash = await sha256Hex(csvText);
  const preview = await sb(env, '/rest/v1/rpc/vp_feed_preview', { method: 'POST', body: { p_dealership_id: dealership.id, p_vins: parsed.rows.map((r) => r.vin) } });
  const decision = decideHold({ parsed, preview, settings });
  const filePath = await keepFile(env, dealership, csvText, hash);

  const result = await sb(env, '/rest/v1/rpc/vp_feed_sync', {
    method: 'POST',
    body: { p_dealership_id: dealership.id, p_rows: parsed.rows, p_auto_publish: settings.feed_auto_publish !== false, p_mark_missing_sold: decision.remove },
  });

  const run = {
    dealership_id: dealership.id, source, status: decision.held ? 'held' : 'applied', hold_reasons: decision.reasons,
    file_lines: parsed.totalLines, usable_rows: parsed.rows.length, columns: parsed.columns, no_vin_rows: parsed.noVin,
    duplicate_vins: parsed.duplicates.slice(0, 200), other_dealer_rows: parsed.otherDealer, active_before: preview.active,
    would_remove: preview.missing_ids.length, remove_ids: decision.held ? preview.missing_ids : [],
    remove_sample: decision.held ? preview.missing_sample : [], result: { ...result, new_vins: preview.new, note: decision.note || null },
    file_sha256: hash, file_path: filePath,
  };
  const saved = await logRun(env, run);
  const summary = { ...result, source, at: new Date().toISOString(), lines: parsed.totalLines, held: !!decision.held,
    held_removals: decision.held ? preview.missing_ids.length : 0, hold_reasons: decision.reasons, run_id: saved ? saved.id : null };
  await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealership.id}`, {
    method: 'PATCH',
    body: { feed_last_sync_at: summary.at, feed_last_result: summary },
  });
  if (decision.held) await alertHeld(env, dealership, settings, run, origin);
  return summary;
}

export async function recordFeedError(env, dealership, message, source) {
  try {
    await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealership.id}`, {
      method: 'PATCH',
      body: { feed_last_result: { error: message, source, at: new Date().toISOString() } },
    });
  } catch (e) { console.error(e); }
  await logRun(env, { dealership_id: dealership.id, source, status: 'failed', error: String(message).slice(0, 1000) });
}
