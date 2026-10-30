// Printable dealer window sticker (US Letter, portrait). Built only from customer-safe data: the vehicle record,
// the pricing stack (only while it adds up) and the CHOMES facts stickerStory() allows. It never states warranty
// terms (those live on the FTC Buyers Guide) and never imitates the manufacturer's Monroney label.
import { sb, html, raw, mount, must, money, miles, vTitle, conditionLabel, portfolioUrl, errMsg, $, store } from '../core.js';
import { adminPage } from './layout.js';
import { priceStack, stickerStory, equipmentLists } from '../sticker.js';
import { needsBuyersGuide } from '../buyers-guide.js';
import { programStickerLine, programStatus } from '../warranty-program.js';

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
  const page = await adminPage(el, 'vehicles', { photographer: true });
  if (!page) return;
  const { ctx, main } = page;
  const d = ctx.dealership;
  let v, chomes, share, svg, equipment = null;
  try {
    v = must(await sb.from('vehicles').select('*').eq('id', id).eq('dealership_id', d.id).single());
    // Only the customer-safe CHOMES facts, and the car's tracked QR link: both work for photographers too.
    if (v.condition !== 'new') chomes = must(await sb.rpc('vp_sticker_chomes', { p_vehicle_id: v.id }));
    share = { code: must(await sb.rpc('vp_qr_share', { p_vehicle_id: v.id })) };
    // Equipment lists from the VIN decoder's factory data (never its pricing). Optional: older installs lack it.
    equipment = await sb.rpc('vp_sticker_equipment', { p_vehicle_id: v.id }).then(({ data }) => data).catch(() => null);
    svg = await qrSvg(portfolioUrl(v, share.code));
  } catch (e) {
    mount(main, html`<div class="card">${errMsg(e)} <a href="/admin/vehicles/${id}">Back</a></div>`);
    return;
  }
  const used = v.condition !== 'new';
  const stack = priceStack(v);
  const st = stickerStory(v, chomes);
  // The same detail block as the SlipStream sticker it replaces: Mileage, Engine, Stock #, Color, VIN, Transmission.
  const details = [['Mileage', v.mileage != null ? miles(v.mileage) : null], ['Color', v.exterior_color], ['Engine', v.engine], ['VIN', v.vin],
    ['Stock #', v.stock_number], ['Transmission', v.transmission]].filter(([, x]) => x);
  const specs = [['Drivetrain', v.drivetrain], ['Fuel', v.fuel_type], ['MPG', v.mpg_city && v.mpg_hwy ? `${v.mpg_city} city / ${v.mpg_hwy} hwy` : null],
    ['Interior', v.interior_color], ['Body', v.body_style]].filter(([, x]) => x);
  const website = d.website ? String(d.website).replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const lists = equipmentLists(equipment);
  let bw = false;
  bw = store('sticker-bw') === '1';
  const fees = v.fees_note || d.default_fees_note;
  const programLine = used ? programStickerLine(v, d.bg_program) : null;
  const notes = [
    used && programStatus(v, d.bg_program) === 'missing' && `The description mentions the ${d.bg_program.name}, but this car's Buyers Guide doesn't include it, so the sticker doesn't mention it. Apply it on the Buyers Guide tab.`,
    !v.price && 'This vehicle has no price, so the sticker says "Call for price".',
    stack.has && !stack.valid && `The pricing stack isn't printed: ${stack.reason}. Fix it on the vehicle's Window sticker tab.`,
    st.held && 'The CHOMES vehicle story isn\'t printed until the FTC consistency review is cleared on the CHOMES tab.',
    v.status !== 'published' && 'This vehicle isn\'t published yet, so the QR code won\'t open until you publish it.',
    !lists.length && 'Full equipment lists print once the car has factory data: tap "Get factory data" on the vehicle\'s Window sticker tab.',
  ].filter(Boolean);

  mount(main, html`
    <div class="page-head no-print">${ctx.isPhotographer ? html`<a href="/admin/shoot">← Photos</a>` : html`<a href="/admin/vehicles/${v.id}#sticker">← Back to vehicle</a>`}
      <span class="btn-row">${used && needsBuyersGuide(v) ? html`<a class="btn alt" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>Buyers Guide</a>` : ''}
      <span class="ws-mode" role="group" aria-label="Print in"><button type="button" class="btn alt sm" data-bw="0" aria-pressed="${!bw}">Color</button><button type="button" class="btn alt sm" data-bw="1" aria-pressed="${bw}">Black &amp; white</button></span>
      <button class="btn" onclick="window.print()">Print</button></span></div>
    ${notes.map((n) => html`<div class="notice warn no-print">${n}</div>`)}
    <p class="small sub no-print">Print on US Letter, portrait, at 100% (turn off "fit to page" and headers/footers).</p>
    <article class="ws ${bw ? 'ws-bw' : ''} ${lists.length ? 'ws-has-equip' : ''}" style="--ws-brand:${d.brand_primary || '#013C9E'};--ws-accent:${d.brand_accent || '#F4BC00'}">
      <header class="ws-head">
        ${d.logo_url ? html`<img src="${d.logo_url}" alt="${d.name}">` : html`<strong class="ws-dealer">${d.name}</strong>`}
        <div class="ws-contact">${d.name}<br>${[d.address_line, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' ')}<br>${d.phone || ''}</div>
      </header>
      <div class="ws-title">
        <div class="ws-kicker">${conditionLabel(v.condition)}</div>
        <h1>${vTitle(v)}</h1>
        <dl class="ws-details">${details.map(([k, x]) => html`<div><dt>${k}:</dt><dd>${x}</dd></div>`)}</dl>
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
          ${programLine ? html`<div class="ws-warranty"><strong>${programLine}</strong><span>Coverage, deductible and conditions are on the Buyers Guide.</span></div>` : ''}
          ${st.highlights.length ? html`<h2>Highlights</h2><ul class="ws-hl">${st.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : ''}
          ${st.options.length ? html`<h2>Options and packages</h2><ul class="ws-opts">${st.options.map((o) => html`<li>${o}</li>`)}</ul>` : ''}
          ${st.story ? html`<h2>Vehicle story</h2><dl class="ws-story">${st.story.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}</dl>` : ''}
        </section>
      </div>
      ${lists.length ? html`<section class="ws-equip"><h2>Equipment${equipment && equipment.as_built ? '' : html` <span class="ws-equip-note">standard for this model and trim</span>`}</h2>
        <div class="ws-equip-cols">${lists.map(([title, items]) => html`<div class="ws-equip-col"><h3>${title}</h3><ul>${items.map((x) => html`<li>${x}</li>`)}</ul></div>`)}</div></section>` : ''}
      <footer class="ws-foot">
        ${website ? html`<div class="ws-web">${website}</div>` : ''}
        ${used ? html`<p><strong>Warranty:</strong> see the FTC Buyers Guide displayed on this vehicle.</p>`
          : html`<p><strong>Dealer sticker.</strong> The manufacturer's window sticker (Monroney label) is displayed separately on this vehicle.</p>`}
        ${d.sticker_disclaimer ? html`<p>${d.sticker_disclaimer}</p>` : ''}
        ${st.credit ? html`<p class="ws-credit">${st.credit}</p>` : ''}
      </footer>
    </article>`);
  main.querySelectorAll('[data-bw]').forEach((b) => b.addEventListener('click', () => {
    const on = b.dataset.bw === '1';
    $('.ws', main).classList.toggle('ws-bw', on);
    main.querySelectorAll('[data-bw]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    store('sticker-bw', on ? '1' : '0');
  }));
}
