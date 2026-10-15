// Runs in front of every page (static assets are excluded in public/_routes.json).
// 1. Injects the public runtime config (Supabase URL + anon key + dealer slug).
// 2. For /v/<slug> portfolio pages, adds title + Open Graph tags so texted links
//    show a photo, title and price preview.

import { dealerSlugFromHost, escapeHtml, absoluteUrl, vehicleTitle, formatMoney, enc } from './_lib/util.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return next();

  const res = await next();
  const type = res.headers.get('content-type') || '';
  if (request.method !== 'GET' || !type.includes('text/html')) return res;

  const dealer = dealerSlugFromHost(url.host, env);
  let html = await res.text();
  const config = {
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    dealer,
    rootDomain: env.ROOT_DOMAIN || 'aiautoengine.com',
  };
  let head = `<script>window.VP_CONFIG=${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`;

  const m = url.pathname.match(/^\/v\/([a-z0-9-]+)\/?$/);
  if (m && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      head += await portfolioMeta(env, dealer, m[1], url);
      html = html.replace(/<title>[\s\S]*?<\/title>/i, '');
    } catch (err) {
      console.error('og meta failed', err);
    }
  }

  html = html.replace('</head>', head + '</head>');
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-cache');
  return new Response(html, { status: res.status, headers });
}

export async function portfolioMeta(env, dealer, slug, url) {
  const q = `/rest/v1/vehicles?select=slug,year,make,model,trim,price,mileage,exterior_color,status,` +
    `dealerships!inner(slug,name,logo_url),vehicle_photos(url,position)` +
    `&slug=eq.${enc(slug)}&dealerships.slug=eq.${enc(dealer)}` +
    `&vehicle_photos.order=position.asc&vehicle_photos.limit=1&limit=1`;
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + q, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
  });
  if (!r.ok) return '';
  const rows = await r.json();
  const v = rows && rows[0];
  if (!v) return '';
  const title = `${v.status === 'sold' ? 'SOLD: ' : ''}${vehicleTitle(v)} | ${v.dealerships.name}`;
  const desc = [
    v.price ? formatMoney(v.price) : null,
    v.mileage != null ? `${Number(v.mileage).toLocaleString('en-US')} miles` : null,
    v.exterior_color,
    'Photos, specs, documents and test drive scheduling.',
  ].filter(Boolean).join(' · ');
  const img = absoluteUrl((v.vehicle_photos[0] && v.vehicle_photos[0].url) || v.dealerships.logo_url, url.origin);
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  return `<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeHtml(url.origin + url.pathname)}">
${img ? `<meta property="og:image" content="${escapeHtml(img)}">\n<meta name="twitter:image" content="${escapeHtml(img)}">` : ''}
<meta name="twitter:card" content="summary_large_image">`;
}
