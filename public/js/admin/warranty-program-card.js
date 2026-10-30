// Settings → Dealer warranty program: set the program's terms once, then review which cars mention it and apply
// it to their Buyers Guides in one click. Nothing is applied without an admin confirming the list.
import { sb, html, mount, must, $, on, errMsg, toast, vTitle, clearDealerCache } from '../core.js';
import { resetAdminContext } from './layout.js';
import { isShorthand } from '../buyers-guide.js';
import { DEFAULT_PROGRAM, programStatus } from '../warranty-program.js';

export async function warrantyProgramCard(box, { dealership, onSaved }) {
  const D = dealership.id;
  let p = dealership.bg_program;
  let draft = JSON.parse(JSON.stringify(p || DEFAULT_PROGRAM));
  let cars = [];
  async function loadCars() {
    cars = must(await sb.from('vehicles')
      .select('id,year,make,model,trim,stock_number,condition,status,description,bg_warranty,bg_warranty_type,bg_labor_pct,bg_parts_pct,bg_deductible,bg_systems,bg_program')
      .eq('dealership_id', D).in('status', ['published', 'draft']).in('condition', ['used', 'certified']).limit(2000));
  }
  try { await loadCars(); } catch (e) { mount(box, html`<div class="card"><h2>Dealer warranty program</h2><div class="notice bad">${errMsg(e)}</div></div>`); return; }

  function draw() {
    const groups = { missing: [], outdated: [], applied: [] };
    if (p) for (const v of cars) { const s = programStatus(v, p); if (groups[s]) groups[s].push(v); }
    const todo = [...groups.missing, ...groups.outdated];
    mount(box, html`<form class="card" id="wp-form"><h2>Dealer warranty program</h2>
      <p class="sub small" style="margin-top:0">A warranty you include with cars, such as a lifetime powertrain warranty. Set the terms once, then apply them to the cars that qualify. Applying fills each car's FTC Buyers Guide: <b>Dealer warranty, Limited</b>, with the % of labor and parts, the deductible and each covered system.</p>
      ${p ? '' : html`<div class="notice">Pre-filled from your Lifetime Limited Powertrain Warranty form (TWS-LW-AMSI F 06/24). <strong>Have Total Warranty Services or your compliance contact confirm the covered-systems wording before applying it.</strong></div>`}
      <div class="grid2 stack-sm">
        <div><label for="wp-name">Program name</label><input id="wp-name" data-k="name" value="${draft.name}"></div>
        <div><label for="wp-match">Look for these words in vehicle descriptions</label><input id="wp-match" data-k="match" value="${draft.match}">
          <div class="hint">Any order, any case; "limited" is ignored.</div></div>
      </div>
      <div class="grid3">
        <div><label for="wp-labor">Dealer pays % of labor</label><input id="wp-labor" data-k="labor_pct" type="number" min="0" max="100" value="${draft.labor_pct}"></div>
        <div><label for="wp-parts">Dealer pays % of parts</label><input id="wp-parts" data-k="parts_pct" type="number" min="0" max="100" value="${draft.parts_pct}"></div>
      </div>
      <label for="wp-ded">Deductible (as it should read on the Buyers Guide)</label><input id="wp-ded" data-k="deductible" value="${draft.deductible || ''}">
      <label>Covered systems and durations</label>
      <p class="hint" style="margin-top:0">Name each system's parts. The FTC doesn't allow "powertrain" or "drive train" on its own.</p>
      <div id="wp-sys"></div>
      <button type="button" class="btn alt sm" id="wp-sys-add">+ Add system</button>
      <label for="wp-line">Line on the dealer window sticker</label><input id="wp-line" data-k="sticker_line" value="${draft.sticker_line || ''}">
      <div class="grid2 stack-sm">
        <div><label for="wp-banner">Banner on the first photo</label><input id="wp-banner" data-k="banner_text" value="${draft.banner_text ?? DEFAULT_PROGRAM.banner_text}">
          <div class="hint">Shown on the customer page and inventory grid for cars that have the program. Leave blank for no banner.</div></div>
        <div><label for="wp-banner-note">Small print under the banner</label><input id="wp-banner-note" data-k="banner_note" value="${draft.banner_note ?? DEFAULT_PROGRAM.banner_note}"></div>
      </div>
      <button class="btn" style="margin-top:12px">${p ? 'Save program' : 'Save program terms'}</button>
      ${p ? html`<p class="hint">Changing the terms doesn't change cars already done; they show below as "older terms" until you apply again.</p>` : ''}
    </form>
    ${p ? html`<div class="card" id="wp-cars"><h2>Cars and the ${p.name}</h2>
      <p class="sub small" style="margin-top:0">${groups.applied.length} used car${groups.applied.length === 1 ? ' has' : 's have'} it on their Buyers Guide.
        ${todo.length ? `${todo.length} need${todo.length === 1 ? 's' : ''} it:` : 'Nothing to do.'}</p>
      ${todo.length ? html`<div class="wp-list">${todo.map((v) => html`<label class="check wp-car"><input type="checkbox" data-car="${v.id}" checked>
          <span><a href="/admin/vehicles/${v.id}#guide">${vTitle(v)}</a>${v.stock_number ? ` · Stock ${v.stock_number}` : ''}<br>
          <span class="small ${groups.missing.includes(v) ? 'wp-warn' : 'sub'}">${groups.missing.includes(v)
            ? `Description mentions it; Buyers Guide shows ${{ as_is: 'As Is', implied_only: 'Implied warranties only', dealer_warranty: 'a different dealer warranty' }[v.bg_warranty] || 'As Is (pending)'}`
            : 'Has the program with older terms'}</span></span></label>`)}</div>
        <button type="button" class="btn" id="wp-apply" style="margin-top:12px">Apply to selected cars</button>
        <p class="hint">Only cars you tick change. Reprint each one's Buyers Guide afterwards.</p>` : ''}
    </div>` : ''}`);
    drawSystems();
  }
  function drawSystems() {
    $('#wp-sys', box).innerHTML = String(html`${draft.systems.map((s, i) => html`<div class="wp-sys">
      <div><input data-sys="${i}" data-f="system" value="${s.system}" placeholder="System and parts" aria-label="Covered system ${i + 1}">
        ${isShorthand(s.system) ? html`<div class="hint" style="color:var(--bad)">Name the parts. "Powertrain" / "drive train" alone isn't allowed.</div>` : ''}</div>
      <textarea data-sys="${i}" data-f="duration" rows="2" placeholder="Duration" aria-label="Duration ${i + 1}">${s.duration}</textarea>
      ${draft.systems.length > 1 ? html`<button type="button" class="btn ghost sm" data-sys-del="${i}" aria-label="Remove system ${i + 1}">✕</button>` : html`<span></span>`}</div>`)}`);
  }
  draw();

  on(box, 'input', '[data-k]', (e, el) => { draft[el.dataset.k] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value; });
  on(box, 'input', '[data-sys]', (e, el) => { draft.systems[Number(el.dataset.sys)][el.dataset.f] = el.value; });
  on(box, 'change', '[data-f=system]', () => drawSystems());
  on(box, 'click', '#wp-sys-add', () => { draft.systems.push({ system: '', duration: draft.systems[0] ? draft.systems[0].duration : '' }); drawSystems(); });
  on(box, 'click', '[data-sys-del]', (e, b) => { draft.systems.splice(Number(b.dataset.sysDel), 1); drawSystems(); });
  on(box, 'submit', '#wp-form', async (e) => {
    e.preventDefault();
    const clean = { ...draft, name: draft.name.trim(), match: draft.match.trim(), deductible: (draft.deductible || '').trim() || null, sticker_line: (draft.sticker_line || '').trim() || null, banner_text: (draft.banner_text ?? DEFAULT_PROGRAM.banner_text).trim(), banner_note: (draft.banner_note ?? DEFAULT_PROGRAM.banner_note).trim(),
      systems: draft.systems.map((s) => ({ system: s.system.trim(), duration: s.duration.trim() })).filter((s) => s.system || s.duration) };
    if (clean.systems.some((s) => isShorthand(s.system))) { toast('Name each covered system\'s parts; "powertrain" on its own isn\'t allowed', 'bad'); return; }
    try {
      const saved = must(await sb.from('dealerships').update({ bg_program: clean }).eq('id', D).select('bg_program').single());
      p = saved.bg_program; draft = JSON.parse(JSON.stringify(p));
      clearDealerCache(); resetAdminContext();
      toast('Warranty program saved');
      onSaved && onSaved(p);
      draw();
    } catch (err) { toast(errMsg(err), 'bad'); }
  });
  on(box, 'click', '#wp-apply', async (e, b) => {
    const ids = [...box.querySelectorAll('[data-car]:checked')].map((x) => x.dataset.car);
    if (!ids.length) { toast('Tick at least one car', 'bad'); return; }
    if (!confirm(`Put the ${p.name} on the Buyers Guide of ${ids.length} car${ids.length === 1 ? '' : 's'}?`)) return;
    b.disabled = true;
    try {
      const n = must(await sb.rpc('vp_apply_bg_program', { p_vehicle_ids: ids }));
      toast(`Applied to ${n} car${n === 1 ? '' : 's'}. Reprint their Buyers Guides.`);
      await loadCars();
      draw();
    } catch (err) { toast(errMsg(err), 'bad'); b.disabled = false; }
  });
}
