// POST /api/inventory/ingest — receive a feed file directly.
// Used by (a) an FTP/SFTP relay that forwards HomeNet's file, authenticated with the
// dealership's feed token (header "X-Feed-Token" or ?token=), and (b) the manual
// CSV upload in Settings (admin session).
// Body: the raw CSV (text/csv) or multipart/form-data with a "file" field.

import { json, handle, HttpError, getDealership, getSettings, dealerSlugFromRequest, requireUser } from '../../_lib/util.js';
import { runFeedSync, recordFeedError } from '../../_lib/feed.js';

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const settings = await getSettings(env, dealership.id);
  const token = request.headers.get('x-feed-token') || new URL(request.url).searchParams.get('token');
  const viaToken = token && safeEqual(token, settings.feed_ingest_token);
  if (!viaToken) await requireUser(request, env, dealership.id, ['owner', 'admin']);

  let text;
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Attach the CSV as "file"');
    text = await file.text();
  } else {
    text = await request.text();
  }
  if (!text || text.length < 20) throw new HttpError(400, 'The uploaded file is empty');

  const source = viaToken ? 'relay upload' : 'manual upload';
  try {
    return json({ ok: true, result: await runFeedSync(env, dealership, settings, text, source) });
  } catch (err) {
    await recordFeedError(env, dealership, err.message, source);
    throw err;
  }
});
