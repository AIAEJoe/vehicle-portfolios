// POST /api/window-sticker {vehicle_id} — staff only. Finds the vehicle's original factory window sticker by VIN,
// stores the PDF in the media bucket and attaches it to the vehicle as a "Window sticker" document
// (replacing an earlier fetched copy). Customers see it on the portfolio like any other document.
import { json, handle, HttpError, getDealership, dealerSlugFromRequest, requireUser, sb, enc, requireEnv } from '../_lib/util.js';
import { oemSource, providerSource, downloadSticker } from '../_lib/window-sticker.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  await requireUser(request, env, dealership.id);
  const { vehicle_id: id } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new HttpError(400, 'Which vehicle?');
  const rows = await sb(env, `/rest/v1/vehicles?id=eq.${enc(id)}&dealership_id=eq.${dealership.id}&select=id,dealership_id,vin,make,year`);
  const v = rows && rows[0];
  if (!v) throw new HttpError(404, 'Vehicle not found');
  if (!v.vin) throw new HttpError(400, 'Add the VIN first');

  const sources = [oemSource(v.vin, v.make), providerSource(v.vin, env)].filter(Boolean);
  if (!sources.length) {
    throw new HttpError(422, `${v.make || 'This brand'} doesn't publish original window stickers online. GM, Ford, Lincoln and Stellantis brands do. You can upload the sticker on the Documents tab.`);
  }
  const misses = [];
  let got = null;
  for (const src of sources) {
    const r = await downloadSticker(src);
    if (r.ok) { got = { src, bytes: r.bytes }; break; }
    misses.push(r.message);
  }
  if (!got) throw new HttpError(404, `${misses.join('. ')}. Older vehicles (and some built in the last few weeks) often have none online.`);

  requireEnv(env, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
  const path = `${v.dealership_id}/vehicles/${v.id}/docs/factory-window-sticker-${v.vin}.pdf`;
  const up = await fetch(`${base}/storage/v1/object/media/${path}`, {
    method: 'POST',
    headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }), 'content-type': 'application/pdf', 'x-upsert': 'true', 'cache-control': '3600' },
    body: got.bytes,
  });
  if (!up.ok) throw new HttpError(502, `Couldn't save the sticker (${up.status})`);

  await sb(env, `/rest/v1/vehicle_documents?vehicle_id=eq.${v.id}&kind=eq.window_sticker&source=in.(oem,provider)`, { method: 'DELETE' });
  const doc = await sb(env, '/rest/v1/vehicle_documents', {
    method: 'POST', prefer: 'return=representation',
    body: { vehicle_id: v.id, dealership_id: v.dealership_id, kind: 'window_sticker', title: 'Original factory window sticker',
      url: `${base}/storage/v1/object/public/media/${path}?v=${Date.now()}`, storage_path: path, source: got.src.provider ? 'provider' : 'oem' },
  });
  return json({ ok: true, from: got.src.brand, document: Array.isArray(doc) ? doc[0] : doc });
});
