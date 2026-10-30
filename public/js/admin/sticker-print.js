// Printable dealer window sticker (US Letter, portrait). Built only from customer-safe data: the vehicle record,
// the pricing stack (only while it adds up) and the CHOMES facts stickerStory() allows. It never states warranty
// terms (those live on the FTC Buyers Guide) and never imitates the manufacturer's Monroney label.
import { sb, html, raw, mount, must, money, miles, vTitle, conditionLabel, portfolioUrl, errMsg } from '../core.js';
import { adminPage } from './layout.js';
import { priceStack, stickerStory } from '../sticker.js';
import { needsBuyersGuide } from '../buyers-guide.js';

async function qrSvg(text) {
  const mod = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
  const qrcode = mod.default || mod;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

const signed = (n) => (n < 0 ? `−${money(-n)}` : `+${money(n)}`);

export default async function stickerPrint(el, { id }) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;
  const d = ctx.dealership;
  let v, chomes, share, svg;
  try {
    v = must(await sb.from('vehicles').select('*').eq('id', id).eq('dealership_id', d.id).single());
    if (v.condition !== 'new') chomes = must(await sb.from('vehicle_chomes').select('*').eq('vehicle_id', v.id).maybeSingle());
    share = must(await sb.from('shares').select('code').eq('vehicle_id', v.id).eq('channel', 'qr').limit(1).maybeSingle());
    if (!share) share = must(await sb.from('shares').insert({ vehicle_id: v.id, dealership_id: d.id, channel: 'qr', customer_name: 'QR window card' }).select('code').single());
    svg = await qrSvg(portfolioUrl(v, share.code));
  } catch (e) {
    mount(main, html`<div class="card">${errMsg(e)} <a href="/admin/vehicles/${id}">Back</a></div>`);
    return;
  }
  const used = v.condition !== 'new';
  const stack = priceStack(v);
  const st = stickerStory(v, chomes);
  const specs = [['Engine', v.engine], ['Transmission', v.transmission], ['Drivetrain', v.drivetrain], ['Fuel', v.fuel_type],
    ['MPG', v.mpg_city && v.mpg_hwy ? `${v.mpg_city} city / ${v.mpg_hwy} hwy` : null], ['Exterior', v.exterior_color], ['Interior', v.interior_color]].filter(([, x]) => x);
  const fees = v.fees_note || d.default_fees_note;
  const notes = [
    !v.price && 'This vehicle has no price, so the sticker says "Call for price".',
    stack.has && !stack.valid && `The pricing stack isn't printed: ${stack.reason}. Fix it on the vehicle's Window sticker tab.`,
    st.held && 'The CHOMES vehicle story isn\'t printed until the FTC consistency review is cleared on the CHOMES tab.',
    v.status !== 'published' && 'This vehicle isn\'t published yet, so the QR code won\'t open until you publish it.',
  ].filter(Boolean);

  mount(main, html`
    <div class="page-head no-print"><a href="/admin/vehicles/${v.id}#sticker">← Back to vehicle</a>
      <span class="btn-row">${used && needsBuyersGuide(v) ? html`<a class="btn alt" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>Buyers Guide</a>` : ''}
      <button class="btn" onclick="window.print()">Print</button></span></div>
    ${notes.map((n) => html`<div class="notice warn no-print">${n}</div>`)}
    <p class="small sub no-print">Print on US Letter, portrait, at 100% (turn off "fit to page" and headers/footers).</p>
    <article class="ws" style="--ws-brand:${d.brand_primary || '#013C9E'};--ws-accent:${d.brand_accent || '#F4BC00'}">
      <header class="ws-head">
        ${d.logo_url ? html`<img src="${d.logo_url}" alt="${d.name}">` : html`<strong class="ws-dealer">${d.name}</strong>`}
        <div class="ws-contact">${d.name}<br>${[d.address_line, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' ')}<br>${d.phone || ''}</div>
      </header>
      <div class="ws-title">
        <div class="ws-kicker">${conditionLabel(v.condition)}</div>
        <h1>${vTitle(v)}</h1>
        <div class="ws-ids">${[v.mileage != null ? `${miles(v.mileage)} miles` : null, v.stock_number ? `Stock ${v.stock_number}` : null, v.vin ? `VIN ${v.vin}` : null].filter(Boolean).join('   ·   ')}</div>
      </div>
      <div class="ws-body">
        <section class="ws-left">
          <div class="ws-price">
            ${stack.valid ? html`<table class="ws-stack"><tbody>
                <tr><td>${stack.baseLabel}</td><td>${money(stack.base)}</td></tr>
                ${stack.lines.map((l) => html`<tr class="${l.kind}"><td>${l.label}${l.note ? html`<small>${l.note}</small>` : ''}</td><td>${signed(l.amount)}</td></tr>`)}
                <tr class="ws-final"><td>${v.price_label || 'Your price'}</td><td>${money(v.price)}</td></tr>
              </tbody></table>
              ${stack.savings > 0 ? html`<div class="ws-save">You save ${money(stack.savings)}</div>` : ''}`
              : html`<div class="ws-pl">${v.price ? v.price_label || 'Price' : ''}</div><div class="ws-big">${v.price ? money(v.price) : 'Call for price'}</div>`}
            ${fees ? html`<div class="ws-fees">${fees}</div>` : ''}
          </div>
          <div class="ws-qr">${raw(svg)}<div><strong>Scan for photos, history and a test drive</strong><span>Point your phone's camera at the code.</span></div></div>
          ${specs.length ? html`<h2>Specifications</h2><dl class="ws-specs">${specs.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}</dl>` : ''}
        </section>
        <section class="ws-right">
          ${st.highlights.length ? html`<h2>Highlights</h2><ul class="ws-hl">${st.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : ''}
          ${st.options.length ? html`<h2>Options and packages</h2><ul class="ws-opts">${st.options.map((o) => html`<li>${o}</li>`)}</ul>` : ''}
          ${st.story ? html`<h2>Vehicle story</h2><dl class="ws-story">${st.story.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}</dl>` : ''}
        </section>
      </div>
      <footer class="ws-foot">
        ${used ? html`<p><strong>Warranty:</strong> see the FTC Buyers Guide displayed on this vehicle.</p>`
          : html`<p><strong>Dealer sticker.</strong> The manufacturer's window sticker (Monroney label) is displayed separately on this vehicle.</p>`}
        ${d.sticker_disclaimer ? html`<p>${d.sticker_disclaimer}</p>` : ''}
        ${st.credit ? html`<p class="ws-credit">${st.credit}</p>` : ''}
      </footer>
    </article>`);
}
