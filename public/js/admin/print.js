// Printable window card with a QR code. Scans are tracked as "QR code scan".
import { sb, html, raw, mount, must, money, miles, vTitle, conditionLabel, portfolioUrl, errMsg } from '../core.js';
import { adminPage } from './layout.js';

async function qrSvg(text) {
  const mod = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
  const qrcode = mod.default || mod;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

export default async function print(el, { id }) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;
  const d = ctx.dealership;
  let v, share, svg;
  try {
    v = must(await sb.from('vehicles').select('*, vehicle_photos(url,position)').eq('id', id).eq('dealership_id', d.id).single());
    share = must(await sb.from('shares').select('code').eq('vehicle_id', v.id).eq('channel', 'qr').limit(1).maybeSingle());
    if (!share) share = must(await sb.from('shares').insert({ vehicle_id: v.id, dealership_id: d.id, channel: 'qr', customer_name: 'QR window card' }).select('code').single());
    svg = await qrSvg(portfolioUrl(v, share.code));
  } catch (e) {
    mount(main, html`<div class="card">${errMsg(e)}</div>`);
    return;
  }
  const photo = (v.vehicle_photos || []).sort((a, b) => a.position - b.position)[0];

  mount(main, html`
    <div class="page-head no-print"><a href="/admin/vehicles/${v.id}">← Back to vehicle</a>
      <button class="btn" onclick="window.print()">Print</button></div>
    ${v.status !== 'published' ? html`<div class="notice warn no-print">This vehicle is not published yet. The QR code won't open until you publish it.</div>` : ''}
    <style>
      .qr-card { background:#fff; max-width: 7.5in; margin: 0 auto; padding: 0.4in; border: 1px solid var(--line); border-radius: 12px; text-align: center; color: #111; }
      .qr-card .logo { height: 60px; }
      .qr-card h1 { font-size: 30px; margin: 14px 0 4px; }
      .qr-card .qr { width: 3.6in; height: 3.6in; margin: 18px auto 10px; }
      .qr-card .qr svg { width: 100%; height: 100%; }
      .qr-card .cta { font-size: 22px; font-weight: 800; margin: 6px 0; }
      .qr-card .price { font-size: 36px; margin: 6px 0; }
      .qr-card .hero { width: 100%; max-height: 2.4in; object-fit: cover; border-radius: 8px; margin-top: 12px; }
      @media print { .admin-top, .admin-main > :not(.qr-card) { display:none !important; } .admin-main { padding: 0; } .qr-card { border: 0; } @page { margin: 0.4in; } }
    </style>
    <div class="qr-card">
      ${d.logo_url ? html`<img class="logo" src="${d.logo_url}" alt="${d.name}">` : html`<h2>${d.name}</h2>`}
      <h1>${conditionLabel(v.condition)} ${vTitle(v)}</h1>
      <div>${[v.exterior_color, v.mileage != null ? `${miles(v.mileage)} miles` : null, v.stock_number ? `Stock ${v.stock_number}` : null].filter(Boolean).join(' · ')}</div>
      ${v.price ? html`<div class="price"><strong>${money(v.price)}</strong></div>` : ''}
      <div class="qr">${raw(svg)}</div>
      <div class="cta">Scan for photos, history &amp; a test drive</div>
      <div class="small">Point your phone's camera at the code. ${d.phone ? `Questions? ${d.phone}` : ''}</div>
      ${photo ? html`<img class="hero" src="${photo.url}" alt="">` : ''}
    </div>`);
}
