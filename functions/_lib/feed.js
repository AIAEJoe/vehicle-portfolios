// Shared inventory-feed pipeline: CSV text -> rows -> vp_feed_sync RPC -> status saved.
import { sb, HttpError } from './util.js';
import { feedToRows } from './inventory.js';

export async function runFeedSync(env, dealership, settings, csvText, source) {
  const { rows, totalLines } = feedToRows(csvText, { dealerId: settings.feed_dealer_id });
  if (!totalLines) throw new HttpError(422, 'The feed file is empty or not a CSV');
  if (!rows.length) throw new HttpError(422, `The feed had ${totalLines} lines but no usable VINs. Check the DealerId filter and column headers.`);

  const result = await sb(env, '/rest/v1/rpc/vp_feed_sync', {
    method: 'POST',
    body: {
      p_dealership_id: dealership.id,
      p_rows: rows,
      p_auto_publish: settings.feed_auto_publish !== false,
      // Safety: never mass-mark-sold from a suspiciously small file
      p_mark_missing_sold: settings.feed_mark_missing_sold !== false && rows.length >= 3,
    },
  });
  const summary = { ...result, source, at: new Date().toISOString(), lines: totalLines };
  await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealership.id}`, {
    method: 'PATCH',
    body: { feed_last_sync_at: summary.at, feed_last_result: summary },
  });
  return summary;
}

export async function recordFeedError(env, dealership, message, source) {
  try {
    await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealership.id}`, {
      method: 'PATCH',
      body: { feed_last_result: { error: message, source, at: new Date().toISOString() } },
    });
  } catch (e) { console.error(e); }
}
