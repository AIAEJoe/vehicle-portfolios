// POST /api/inventory/sync — download the HomeNet/vAuto feed from its HTTPS URL and sync it.
// Called hourly by Supabase pg_cron (Authorization: Bearer <CRON_SECRET>) or by an
// admin pressing "Sync now" in Settings (their Supabase session token).

import { json, handle, HttpError, getDealership, getSettings, dealerSlugFromRequest, requireUser } from '../../_lib/util.js';
import { runFeedSync, recordFeedError } from '../../_lib/feed.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const auth = request.headers.get('authorization') || '';
  const isCron = env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`;
  if (!isCron) await requireUser(request, env, dealership.id, ['owner', 'admin']);

  const settings = await getSettings(env, dealership.id);
  if (!settings.feed_url) throw new HttpError(400, 'No feed URL is set. Add it in Settings → Inventory feed.');

  const source = isCron ? 'scheduled' : 'manual';
  try {
    const res = await fetch(settings.feed_url, {
      headers: settings.feed_auth_header ? { authorization: settings.feed_auth_header } : {},
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) throw new HttpError(502, `The feed URL returned an error (${res.status})`);
    const text = await res.text();
    return json({ ok: true, result: await runFeedSync(env, dealership, settings, text, `${source}: url`) });
  } catch (err) {
    await recordFeedError(env, dealership, err.message, source);
    throw err;
  }
});
