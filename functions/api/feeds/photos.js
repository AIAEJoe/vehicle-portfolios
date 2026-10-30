// GET /api/feeds/photos?token=<photo feed token>[&sep=pipe][&format=json]
// The photo feed for third-party sites. One row per live (published) car that our photographer has shot, with its
// photos in display order (the cover first), as public image URLs. Stock and feed photos are left out, so a vendor
// never gets back its own images. Settings → "Photo feed for third-party sites" shows the URL to give the vendor.
//
// CSV columns: VIN, StockNumber, Year, Make, Model, Trim, Type (New/Used/Certified), PhotoCount, PhotosUpdated, PhotoURLs,
// VideoURL (the walkaround video, MP4 or WebM). JSON also lists the 360° interior photo and the spin's frames.
// PhotoURLs is comma-separated inside one quoted field (like HomeNet's ImageList); &sep=pipe uses "|".

import { HttpError, handle, json, getDealership, getSettings, dealerSlugFromRequest, sb, absoluteUrl, siteOrigin } from '../../_lib/util.js';

const PAGE = 1000; // PostgREST's default row cap

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n|]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const TYPE = { new: 'New', used: 'Used', certified: 'Certified' };

async function allRows(env, path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = (await sb(env, `${path}&limit=${PAGE}&offset=${offset}`)) || [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function buildPhotoFeed(env, dealership, origin) {
  const cars = await allRows(env, `/rest/v1/vehicles?dealership_id=eq.${dealership.id}&status=eq.published&select=id,vin,stock_number,year,make,model,trim,condition&order=stock_number.asc`);
  const photos = await allRows(env, `/rest/v1/vehicle_photos?dealership_id=eq.${dealership.id}&source=eq.upload&select=vehicle_id,url,position,created_at&order=vehicle_id.asc,position.asc,created_at.asc`);
  const media = await allRows(env, `/rest/v1/vehicle_media?dealership_id=eq.${dealership.id}&select=vehicle_id,kind,url,frames,created_at&order=created_at.desc`).catch(() => []);
  const mediaOf = (id, kind) => media.find((m) => m.vehicle_id === id && m.kind === kind);
  const byCar = new Map();
  for (const p of photos) {
    if (!byCar.has(p.vehicle_id)) byCar.set(p.vehicle_id, []);
    byCar.get(p.vehicle_id).push(p);
  }
  return cars.filter((c) => c.vin && byCar.has(c.id)).map((c) => {
    const list = byCar.get(c.id).sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
    return {
      vin: c.vin, stock_number: c.stock_number || '', year: c.year || '', make: c.make || '', model: c.model || '', trim: c.trim || '',
      type: TYPE[c.condition] || '', photo_count: list.length,
      photos_updated: list.reduce((m, p) => (String(p.created_at) > m ? String(p.created_at) : m), ''),
      photos: list.map((p) => absoluteUrl(p.url, origin)),
      video: (mediaOf(c.id, 'video') || {}).url || null,
      interior360: (mediaOf(c.id, 'interior360') || {}).url || null,
      spin: ((mediaOf(c.id, 'spin') || {}).frames || []).map((f) => f.url),
    };
  });
}

export const onRequestGet = handle(async ({ request, env }) => {
  const url = new URL(request.url);
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const settings = await getSettings(env, dealership.id);
  if (!safeEqual(url.searchParams.get('token'), settings.photo_feed_token)) throw new HttpError(401, 'This photo feed link is not valid. Copy it again from Settings.');
  const rows = await buildPhotoFeed(env, dealership, siteOrigin(request));
  const headers = { 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex' };
  if (url.searchParams.get('format') === 'json') return json({ dealership: dealership.slug, generated_at: new Date().toISOString(), vehicles: rows }, 200, headers);
  const sep = url.searchParams.get('sep') === 'pipe' ? '|' : ',';
  const lines = [['VIN', 'StockNumber', 'Year', 'Make', 'Model', 'Trim', 'Type', 'PhotoCount', 'PhotosUpdated', 'PhotoURLs', 'VideoURL'].join(',')];
  for (const r of rows) lines.push([r.vin, r.stock_number, r.year, r.make, r.model, r.trim, r.type, r.photo_count, r.photos_updated, r.photos.join(sep), r.video || ''].map(cell).join(','));
  return new Response(lines.join('\r\n') + '\r\n', { headers: { ...headers, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `inline; filename="${dealership.slug}-photos.csv"` } });
});
