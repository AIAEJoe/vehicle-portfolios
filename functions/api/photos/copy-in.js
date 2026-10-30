// POST /api/photos/copy-in  { include_new?: boolean, skip?: number }  (dealership admins)
// Copies one batch of a dealership's hosted-elsewhere photos (feed, listing import, pasted URL) into our media bucket
// and turns each into our own photo (source 'upload', copied_from = the old URL), keeping its place in the order.
// Settings calls it repeatedly until done: each call handles a small batch so it stays well inside Cloudflare's
// limits (about 3 requests per photo). Photos that can't be downloaded are skipped and reported; `skip` tells the next
// call how many failures to step over.
//
// Used and certified cars only by default: a new car's feed photos are usually the manufacturer's stock images.

import { json, handle, HttpError, getDealership, dealerSlugFromRequest, requireUser, requireEnv, sb } from '../../_lib/util.js';

export const BATCH = 12;
const MAX_BYTES = 15 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function copyOne(env, p) {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
  const auth = { apikey: key, ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }) };
  let src;
  try { src = new URL(p.url); } catch { throw new Error('not a web address'); }
  if (src.protocol !== 'https:' && src.protocol !== 'http:') throw new Error('not a web address');
  const res = await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0 (VehiclePortfolios photo copy)', accept: 'image/*' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`the photo's server answered ${res.status}`);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw new Error(`not a photo (${type || 'unknown type'})`);
  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength) throw new Error('empty file');
  if (bytes.byteLength > MAX_BYTES) throw new Error('over 15 MB');
  const path = `${p.dealership_id}/vehicles/${p.vehicle_id}/${crypto.randomUUID()}.${ext}`;
  const up = await fetch(`${base}/storage/v1/object/media/${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': type === 'image/jpg' ? 'image/jpeg' : type, 'x-upsert': 'false', 'cache-control': '31536000' }, body: bytes,
  });
  if (!up.ok) throw new Error(`couldn't save it (${up.status})`);
  try {
    await sb(env, `/rest/v1/vehicle_photos?id=eq.${p.id}&storage_path=is.null`, {
      method: 'PATCH', body: { url: `${base}/storage/v1/object/public/media/${path}`, storage_path: path, source: 'upload', copied_from: p.url },
    });
  } catch (e) {
    await fetch(`${base}/storage/v1/object/media/${path}`, { method: 'DELETE', headers: auth }).catch(() => {});
    throw e;
  }
}

export const onRequestPost = handle(async ({ request, env }) => {
  requireEnv(env, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  await requireUser(request, env, dealership.id, ['owner', 'admin']);
  const body = await request.json().catch(() => ({}));
  const conditions = body.include_new ? 'new,used,certified' : 'used,certified';
  const skip = Math.max(0, Math.min(100000, Number(body.skip) || 0));
  const rows = await sb(env, `/rest/v1/vehicle_photos?dealership_id=eq.${dealership.id}&storage_path=is.null&source=in.(feed,url,import)`
    + `&vehicles.condition=in.(${conditions})&vehicles.status=in.(draft,published)`
    + `&select=id,vehicle_id,dealership_id,url,position,vehicles!inner(condition,status,stock_number)`
    + `&order=vehicle_id.asc,position.asc,id.asc&limit=${BATCH}&offset=${skip}`) || [];
  if (!Array.isArray(rows)) throw new HttpError(502, 'Unexpected answer from the database');
  const results = await Promise.all(rows.map((p) => copyOne(env, p).then(() => null, (e) => ({
    id: p.id, vehicle_id: p.vehicle_id, stock_number: p.vehicles && p.vehicles.stock_number, url: p.url, error: e.name === 'TimeoutError' ? 'timed out' : e.message,
  }))));
  const failed = results.filter(Boolean);
  return json({ ok: true, copied: rows.length - failed.length, failed, done: rows.length < BATCH });
});
