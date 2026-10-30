// "Window sticker" tab on the vehicle page: the dealer sticker's status, the pricing stack, and the original
// factory sticker. Printing happens on /admin/vehicles/:id/sticker.
import { sb, html, raw, mount, must, api, $, on, errMsg, toast, money } from '../core.js';
import { priceStack, stickerStory, STACK_KINDS } from '../sticker.js';

const BASE_LABELS = ['MSRP', 'Retail price', 'Market value', 'Internet price'];

export function stickerBadge(v) {
  const s = priceStack(v);
  return s.has && !s.valid ? '!' : null;
}

/** @param opts { v, chomes, ctx, onChange(vehiclePatch | null, docs?) } */
export function stickerTab(box, { v, chomes, ctx, onChange }) {
  const s = priceStack(v);
  const story = stickerStory(v, chomes);
  const factory = (v.vehicle_documents || []).find((d) => d.kind === 'window_sticker' && (d.source === 'oem' || d.source === 'provider'));
  const otherSticker = (v.vehicle_documents || []).find((d) => d.kind === 'window_sticker' && d !== factory);
  const used = v.condition !== 'new';
  let lines = (s.lines.length ? s.lines : []).map((l) => ({ ...l, amount: Math.abs(l.amount) }));
  const check = (ok, text, warn) => html`<li class="${ok ? 'ok' : warn ? 'warn' : 'muted'}">${ok ? '✓' : warn ? '!' : '–'} ${text}</li>`;

  mount(box, html`
    <div class="card">
      <h2>Dealer window sticker</h2>
      <p class="sub" style="margin-top:0">Letter-size sticker for the window: price${s.has ? ' with the pricing stack' : ''}, equipment${used ? ', the CHOMES vehicle story' : ''} and a QR code to this vehicle's page.
        ${used ? 'It sits next to the FTC Buyers Guide and never replaces it.' : 'It is a dealer addendum: the manufacturer\'s label stays on the window.'}</p>
      <ul class="st-checks">
        ${check(v.price, v.price ? `Price ${money(v.price)}` : 'No price yet. The sticker will say "Call for price".', true)}
        ${s.has ? check(s.valid, s.valid ? 'Pricing stack adds up' : `Pricing stack won't print: ${s.reason}`, true) : check(false, 'No pricing stack (optional)')}
        ${check(story.highlights.length, story.highlights.length ? `${story.highlights.length} highlight${story.highlights.length > 1 ? 's' : ''}` : 'No highlights. Add them on the CHOMES or Details tab.', false)}
        ${used ? (story.held ? check(false, 'CHOMES story held until the FTC review is cleared (CHOMES tab)', true)
          : story.story ? check(true, `CHOMES story: ${story.story.length} facts`) : check(false, 'No CHOMES story yet (CHOMES tab)')) : ''}
      </ul>
      <div class="btn-row"><a class="btn" href="/admin/vehicles/${v.id}/sticker">Print window sticker</a>
        ${used ? html`<a class="btn alt" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>Print Buyers Guide</a>` : ''}</div>
    </div>

    <form class="card" id="stack-form">
      <h2>Pricing stack</h2>
      <p class="sub" style="margin-top:0">Shows customers how you get from the starting price to your price. It prints only while it adds up to the vehicle's price${v.source === 'feed' && !v.feed_locked ? ', so if the inventory feed changes the price, update it here' : ''}.</p>
      <div class="grid3">
        <div><label for="st-base-label">Starting price is</label>
          <input id="st-base-label" name="base_label" list="st-base-labels" value="${v.price_stack_base_label || (used ? 'Retail price' : 'MSRP')}">
          <datalist id="st-base-labels">${BASE_LABELS.map((l) => html`<option value="${l}">`)}</datalist></div>
        <div><label for="st-base">Amount ($)</label><input id="st-base" name="base" type="number" min="0" step="0.01" inputmode="decimal" value="${v.price_stack_base ?? (used ? '' : v.msrp ?? '')}"></div>
      </div>
      <div id="st-lines"></div>
      <button type="button" class="btn alt sm" id="st-add">+ Add a line</button>
      <div id="st-total" class="st-total"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn" type="submit">Save pricing stack</button>
        ${s.has ? html`<button type="button" class="btn ghost" id="st-clear">Remove stack</button>` : ''}</div>
      <p class="hint">Rebates must say who qualifies, for example "Must finance with GM Financial" or "Active duty and veterans". Fees in your disclaimer still apply.</p>
    </form>

    <div class="card" id="factory">
      <h2>Original factory window sticker</h2>
      ${factory ? html`<div class="doc-row"><span><strong>${factory.title}</strong><br><span class="small sub">From the ${factory.source === 'oem' ? 'manufacturer' : 'sticker service'} · shown to customers on the Documents list</span></span>
          <span class="btn-row"><a class="btn ghost sm" href="${factory.url}" target="_blank" data-external>Open</a></span></div>`
        : html`<p class="sub" style="margin-top:0">${otherSticker ? `"${otherSticker.title}" is already on the Documents tab. ` : ''}Find the original sticker by VIN for Ford, Lincoln and Stellantis (Jeep, Ram, Dodge, Chrysler). For GM vehicles, download it from GlobalConnect and upload it on the Documents tab.</p>`}
      <div class="btn-row"><button type="button" class="btn ${factory ? 'alt' : ''}" id="st-find" ${v.vin ? '' : 'disabled'}>${factory ? 'Fetch again' : 'Find factory sticker'}</button>
        ${used && factory ? html`<button type="button" class="btn alt" data-goto="chomes">Pull option packages into CHOMES</button>` : ''}</div>
      ${v.vin ? '' : html`<p class="notice warn">Add the VIN on the Details tab first.</p>`}
      <div id="st-find-msg"></div>
    </div>`);

  const form = $('#stack-form', box);
  const draw = () => {
    $('#st-lines', box).innerHTML = String(html`${lines.map((l, i) => html`<div class="st-line">
      <select data-i="${i}" data-k="kind" aria-label="Line ${i + 1} type">${STACK_KINDS.map(([k, t]) => html`<option value="${k}" ${l.kind === k ? 'selected' : ''}>${t}</option>`)}</select>
      <input data-i="${i}" data-k="label" value="${l.label || ''}" placeholder="${l.kind === 'addon' ? 'Ceramic tint' : l.kind === 'rebate' ? 'GM Financial bonus cash' : 'Dealer discount'}" aria-label="Line ${i + 1} name">
      <span class="st-amt"><span>${l.kind === 'addon' ? '+$' : '−$'}</span><input data-i="${i}" data-k="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${l.amount || ''}" aria-label="Line ${i + 1} amount"></span>
      <button type="button" class="btn ghost sm" data-del="${i}" aria-label="Remove line ${i + 1}">✕</button>
      ${l.kind !== 'addon' ? html`<input class="st-note" data-i="${i}" data-k="note" value="${l.note || ''}" placeholder="${l.kind === 'rebate' ? 'Who qualifies (required)' : 'Conditions, if any'}" aria-label="Line ${i + 1} conditions">` : ''}
    </div>`)}`);
    total();
  };
  const collect = () => {
    const base = form.base.value === '' ? null : Number(form.base.value);
    return {
      price_stack_base_label: form.base_label.value.trim() || null,
      price_stack_base: lines.length ? base : null,
      price_stack: lines.map((l) => ({ kind: l.kind, label: String(l.label || '').trim(), amount: (l.kind === 'addon' ? 1 : -1) * Number(l.amount || 0),
        ...(l.kind !== 'addon' && String(l.note || '').trim() ? { note: String(l.note).trim() } : {}) })),
    };
  };
  const total = () => {
    const c = collect();
    const p = priceStack({ ...v, ...c, price_stack_base: c.price_stack_base ?? (form.base.value === '' ? null : Number(form.base.value)) });
    const el = $('#st-total', box);
    if (!lines.length) { el.innerHTML = ''; return; }
    el.innerHTML = String(html`<span>Adds up to <strong>${p.final === null ? '…' : money(p.final)}</strong></span>
      ${p.valid ? html`<span class="ok">✓ matches the vehicle's price</span>`
        : p.final !== null ? html`<span class="warn">Vehicle price is ${v.price ? money(v.price) : 'not set'}${p.final !== null && p.final >= 0 ? raw(` <button type="button" class="btn ghost sm" id="st-setprice">Make ${money(p.final)} the price</button>`) : ''}</span>` : ''}`);
  };
  draw();
  form.addEventListener('input', (e) => {
    const i = e.target.dataset.i;
    if (i !== undefined) {
      lines[Number(i)][e.target.dataset.k] = e.target.value;
      if (e.target.dataset.k === 'kind') { draw(); return; }
    }
    total();
  });
  on(box, 'click', '#st-add', () => { lines.push({ kind: 'discount', label: '', amount: '' }); draw(); $(`[data-i="${lines.length - 1}"][data-k=label]`, box).focus(); });
  on(box, 'click', '[data-del]', (e, b) => { lines.splice(Number(b.dataset.del), 1); draw(); });

  const save = async (patch, msg) => {
    try {
      const saved = must(await sb.from('vehicles').update(patch).eq('id', v.id).select('*').single());
      toast(msg);
      onChange(saved);
    } catch (err) { toast(errMsg(err), 'bad'); }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = collect();
    if (lines.length && c.price_stack_base === null) { toast('Enter the starting price', 'bad'); form.base.focus(); return; }
    const bad = c.price_stack.findIndex((l) => !l.label || !l.amount);
    if (bad >= 0) { toast('Each line needs a name and an amount', 'bad'); return; }
    const reb = c.price_stack.find((l) => l.kind === 'rebate' && !l.note);
    if (reb) { toast(`Say who qualifies for the "${reb.label}" rebate`, 'bad'); return; }
    save(c, priceStack({ ...v, ...c }).valid || !lines.length ? 'Pricing stack saved' : 'Saved, but it doesn\'t match the price yet, so it won\'t print');
  });
  on(box, 'click', '#st-setprice', () => {
    const c = collect();
    const p = priceStack({ ...v, ...c, price: 0 });
    if (!confirm(`Change this vehicle's price from ${money(v.price) || 'blank'} to ${money(p.final)}? Customers see the new price everywhere.`)) return;
    save({ ...c, price: p.final }, 'Price updated');
  });
  on(box, 'click', '#st-clear', () => { if (confirm('Remove the pricing stack?')) save({ price_stack: [], price_stack_base: null }, 'Pricing stack removed'); });

  on(box, 'click', '#st-find', async (e, b) => {
    b.disabled = true;
    const msg = $('#st-find-msg', box);
    msg.innerHTML = String(html`<p class="small sub">Asking the manufacturer…</p>`);
    try {
      const r = await api('/api/window-sticker', { method: 'POST', auth: true, body: { vehicle_id: v.id } });
      toast(`Found the original sticker (${r.from})`);
      onChange(null, [...(v.vehicle_documents || []).filter((d) => !(d.kind === 'window_sticker' && (d.source === 'oem' || d.source === 'provider'))), r.document]);
    } catch (err) {
      msg.innerHTML = String(html`<div class="notice warn">${errMsg(err)}</div>`);
      b.disabled = false;
    }
  });
}
