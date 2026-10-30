// CHOMES tab on the vehicle page: the team's entry point for the vehicle story.
// Team only. Nothing on this tab is shown to customers.
import { sb, html, raw, mount, must, api, $, on, errMsg, toast, miles, dateTime } from '../core.js';
import {
  SECTIONS, GRADES, PROVIDERS, SOURCE_LABEL, VS_AVERAGE_LABEL, ANNUAL_MILES, CHOMES_CREDIT, computeChomes, isVehicleField,
} from '../chomes.js';
import { resolveGuide } from '../buyers-guide.js';
import { parseFactoryOptions, textItemsToLines } from '../sticker.js';
import { uploadFile, removeFile } from './media.js';

const BUCKET = 'internal';
const GUIDE_LABEL = { as_is: 'AS IS - NO DEALER WARRANTY', implied_only: 'IMPLIED WARRANTIES ONLY', dealer_warranty: 'DEALER WARRANTY' };

export async function loadChomes(vehicleId) {
  return must(await sb.from('vehicle_chomes').select('*').eq('vehicle_id', vehicleId).maybeSingle());
}

export function chomesBadge(v, rec) {
  if (v.condition === 'new' || (rec && rec.error)) return null;
  const c = computeChomes(v, rec);
  return c.missingCount || null;
}

/**
 * @param box   element to draw into
 * @param opts  { v, rec, ctx, staff, onChange(rec, vehiclePatch) }
 */
export function chomesTab(box, { v, rec, ctx, staff, onChange }) {
  if (v.condition === 'new') {
    mount(box, html`<div class="card"><h2>CHOMES vehicle story</h2><p class="sub">Only used and certified pre-owned vehicles get a CHOMES story. This vehicle is listed as new.</p></div>`);
    return;
  }
  if (rec && rec.error) {
    mount(box, html`<div class="card"><h2>CHOMES vehicle story</h2><div class="notice bad">CHOMES couldn't load: ${errMsg(rec.error)}</div>
      <p class="sub">If this is a new install, the database update hasn't been run yet. Run <code>supabase/run-2026-10-23.sql</code> in the Supabase SQL Editor, then reload.</p></div>`);
    return;
  }
  rec = rec || {};
  const c = computeChomes(v, rec);
  const val = c.values;
  const prov = rec.provenance || {};
  const today = new Date().toLocaleDateString('en-CA');
  const fieldsOf = (key) => SECTIONS.find((s) => s.key === key).fields;
  const meta = (k) => SECTIONS.flatMap((s) => s.fields).find((f) => f.k === k) || {};

  const req = (k) => (meta(k).required === true ? html`<span class="req" title="Required">*</span>` : '');
  const internal = html`<span class="tag-internal">Internal</span>`;
  const src = (k) => {
    const p = prov[k];
    if (!p) return '';
    const who = p.source === 'staff' ? (p.by_name || 'staff') : SOURCE_LABEL[p.source] || p.source;
    return html`<div class="src">${who}${p.at ? ` · ${dateTime(p.at)}` : ''}</div>`;
  };
  const label = (k, text = meta(k).label) => html`<label for="ch-${k}">${text}${req(k)}${meta(k).internal ? internal : ''}</label>`;
  const input = (k, attrs = '', value = rec[k]) => html`<div>${label(k)}<input id="ch-${k}" name="${k}" value="${value ?? ''}" ${raw(attrs)}>${src(k)}</div>`;
  const area = (k, attrs = '', value = rec[k]) => html`<div>${label(k)}<textarea id="ch-${k}" name="${k}" rows="2" ${raw(attrs)}>${value ?? ''}</textarea>${src(k)}</div>`;
  const radios = (k, options, current) => html`<div role="radiogroup" aria-label="${meta(k).label}" class="seg">${options.map(([value, text]) => html`<label class="seg-opt"><input type="radio" name="${k}" value="${value}" ${String(current) === String(value) ? 'checked' : ''}><span>${text}</span></label>`)}</div>`;
  const auto = (k, display) => {
    const missing = val[k] === null || val[k] === undefined || val[k] === '';
    return html`<div class="auto-field ${missing ? 'missing' : ''}"><div class="auto-label">${meta(k).label}${req(k)}</div>
      <div class="auto-val">${missing ? html`<span class="sub">Missing</span>` : display ?? val[k]}</div>
      ${isVehicleField(k) ? src(k) : html`<div class="src">Calculated</div>`}</div>`;
  };
  const chip = (s) => {
    const st = c.sections[s.key];
    const state = !st.done ? 'warn' : s.key === 'S' && st.pending ? 'pending' : 'ok';
    const text = !st.done ? `${st.missing.length} missing` : state === 'pending' ? 'Market data pending' : 'Complete';
    return html`<a href="#ch-sec-${s.key}" class="ch-chip ${state}"><b>${s.key}</b><span>${s.name}</span><small>${text}</small></a>`;
  };
  const needsDecode = v.vin && ['year', 'trim', 'drivetrain', 'engine'].some((k) => !v[k]);
  const guide = resolveGuide(v, ctx.dealership);
  const staffNames = staff.filter((s) => s.active).map((s) => s.full_name);

  mount(box, html`
    <div class="card">
      <h2>CHOMES vehicle story</h2>
      <p class="sub" style="margin-top:0">Enter the story once. It feeds pricing and acquisition decisions here and, later, a plain-language story panel on the customer page.
        <strong>This tab is team only.</strong> Recon cost, acquisition notes and the demand note are never shown to customers.</p>
      <div class="ch-chips">${SECTIONS.map(chip)}</div>
      <p class="small sub" style="margin-bottom:0"><span class="req">*</span> required. ${c.missingCount ? `${c.missingCount} required field${c.missingCount > 1 ? 's' : ''} still to fill.` : 'All required fields are filled.'}</p>
    </div>

    ${c.review.required ? html`<div class="notice warn" id="ch-review"><strong>FTC check needed before a customer story can go live.</strong>
      ${c.review.reasons.join('. ')}. The Condition story and the Buyers Guide must tell the same truth about this car.
      The Buyers Guide currently shows <b>${GUIDE_LABEL[guide.status]}</b>${guide.status === 'as_is' ? ', so nothing in Condition may suggest warranty coverage' : ''}.
      ${guide.pending ? ' (Warranty data is still pending on the Buyers Guide tab.)' : ''}
      ${rec.review_cleared_at ? html`<br><span class="small">Reviewed ${dateTime(rec.review_cleared_at)}.</span>` : ''}</div>` : ''}

    <form id="chomes" novalidate>
      <section class="card" id="ch-sec-C"><h2>C · Condition</h2>
        <p class="hint" style="margin-top:0">Entered at the store by the person who looked at the car.</p>
        <label>Overall grade${req('overall_grade')}</label>
        ${radios('overall_grade', GRADES, rec.overall_grade)}${src('overall_grade')}
        <div class="grid2 stack-sm">
          ${area('strengths', 'placeholder="New tires, clean interior, fresh oil change"')}
          ${area('wear_items', 'placeholder="Small scratch on rear bumper, worn driver bolster"')}
        </div>
        <div class="grid2 stack-sm">
          ${area('needed_work', 'placeholder="Rear brake pads at 3 mm"')}
          ${input('recon_cost', 'type="number" min="0" step="1" inputmode="numeric" placeholder="$"')}
        </div>
        <div class="grid2 stack-sm">
          ${input('inspected_by', 'list="ch-staff" autocomplete="off" placeholder="Name of the person who looked at the car"')}
          ${input('inspection_date', `type="date" max="${today}"`)}
        </div>
        <datalist id="ch-staff">${staffNames.map((n) => html`<option value="${n}">`)}</datalist>
      </section>

      <section class="card" id="ch-sec-H"><h2>H · History</h2>
        <label>Report provider${req('report_provider')}</label>
        ${radios('report_provider', PROVIDERS, rec.report_provider)}${src('report_provider')}
        <div class="grid3">
          ${input('accidents_count', 'type="number" min="0" inputmode="numeric"')}
          <div style="grid-column: span 2">${label('accidents_summary', 'One-line accident summary')}<input id="ch-accidents_summary" name="accidents_summary" value="${rec.accidents_summary ?? ''}" placeholder="Minor damage, rear bumper, 2021">${src('accidents_summary')}</div>
          ${input('service_records', 'type="number" min="0" inputmode="numeric"')}
          ${input('prior_owners', 'type="number" min="0" inputmode="numeric"')}
          ${input('open_recalls', 'type="number" min="0" inputmode="numeric"')}
        </div>
        <label>Title issues${req('title_issues')}</label>
        ${radios('title_issues', [['false', 'No'], ['true', 'Yes']], rec.title_issues === null || rec.title_issues === undefined ? '' : rec.title_issues)}${src('title_issues')}
        <div id="ch-title-detail" ${rec.title_issues ? '' : 'hidden'}>${label('title_issue_detail', 'What is the title issue?')}<input id="ch-title_issue_detail" name="title_issue_detail" value="${rec.title_issue_detail ?? ''}" placeholder="Salvage, rebuilt, flood, lemon buyback, prior rental…"></div>
        <div class="ch-report">
          <label>History report (PDF)<span class="tag-internal">Team only</span></label>
          ${rec.history_report_path
            ? html`<div class="doc-row"><span><strong>${rec.history_report_name || 'History report'}</strong>${src('history_report_path')}</span>
                <span class="btn-row"><button type="button" class="btn ghost sm" id="ch-report-open">Open</button><button type="button" class="btn danger sm" id="ch-report-del">Remove</button></span></div>`
            : html`<input type="file" id="ch-report" accept="application/pdf,image/*" aria-label="Upload history report">`}
          <p class="hint">Stored privately for the team. To show a report on the customer page, add it on the Documents tab.</p>
        </div>
      </section>

      <section class="card" id="ch-sec-O"><h2>O · Old</h2>
        <div class="grid3">
          ${auto('model_year')}
          ${auto('vehicle_age_years', val.vehicle_age_years === null ? null : `${val.vehicle_age_years} year${val.vehicle_age_years === 1 ? '' : 's'}`)}
        </div>
        ${needsDecode ? html`<div class="notice">Some basics are missing. <button type="button" class="btn alt sm" id="ch-decode">Decode VIN ${v.vin}</button> fills only the empty ones.</div>` : ''}
        ${input('generation_note', 'placeholder="e.g. Last year of this generation"')}
      </section>

      <section class="card" id="ch-sec-M"><h2>M · Miles</h2>
        <div class="grid3">
          ${auto('odometer', val.odometer === null ? null : `${miles(val.odometer)} mi`)}
          ${auto('miles_per_year', val.miles_per_year === null ? null : `${miles(val.miles_per_year)} / yr`)}
          ${auto('vs_average', val.vs_average ? html`<span class="pill ch-${val.vs_average}">${VS_AVERAGE_LABEL[val.vs_average]}</span>` : null)}
        </div>
        <p class="hint">Average is ${miles(ANNUAL_MILES.below)} to ${miles(ANNUAL_MILES.above)} miles a year. Odometer comes from the inventory feed or the Details tab, so the customer page always shows the same number.</p>
      </section>

      <section class="card" id="ch-sec-E"><h2>E · Equipment</h2>
        <div class="grid3">${auto('trim')}${auto('drivetrain')}${auto('engine')}</div>
        <div class="grid2 stack-sm">
          <div>${label('options_packages', 'Options and packages (one per line)')}
            <textarea id="ch-options_packages" name="options_packages" rows="5" placeholder="Cold Weather Group&#10;Trailer Tow Package">${(rec.options_packages || []).join('\n')}</textarea>${src('options_packages')}
            ${!(rec.options_packages || []).length && (v.features || []).length ? html`<button type="button" class="btn ghost sm" id="ch-from-feed">Start from the ${v.features.length} listed features</button>` : ''}
            ${factorySticker(v) ? html`<button type="button" class="btn alt sm" id="ch-from-sticker">Read options from the factory sticker</button><div id="ch-sticker-opts"></div>` : ''}
            <div class="hint">From the window sticker.</div></div>
          <div>${label('highlight_features', 'Highlight features (one per line, 3 to 5)')}
            <textarea id="ch-highlight_features" name="highlight_features" rows="5" placeholder="Heated seats&#10;Remote start&#10;Apple CarPlay">${(rec.highlight_features || []).join('\n')}</textarea>${src('highlight_features')}
            <div class="hint" id="ch-hl-count">The ones the salesperson would actually mention.</div></div>
        </div>
      </section>

      <section class="card" id="ch-sec-S"><h2>S · Supply and demand</h2>
        ${c.marketDataPending ? html`<div class="notice warn"><strong>Market data pending.</strong> Enter these by hand until the vAuto market feed is connected.</div>` : ''}
        <div class="grid3">
          ${input('price_to_market_pct', 'type="number" min="0" max="300" step="0.1" inputmode="decimal" placeholder="e.g. 97.5"')}
          ${input('market_days_supply', 'type="number" min="0" inputmode="numeric"')}
          ${input('comparable_units_nearby', 'type="number" min="0" inputmode="numeric"')}
        </div>
        ${area('demand_note', 'placeholder="What the pricing manager sees in the market"')}
      </section>

      <section class="card"><h2>Acquisition notes</h2>
        ${area('acquisition_notes', 'rows="3" placeholder="Trade-in from…, auction, what we paid attention to"')}
      </section>

      <div class="ch-save"><button class="btn" type="submit">Save CHOMES</button>
        ${rec.updated_at ? html`<span class="small sub">Last saved ${dateTime(rec.updated_at)}</span>` : ''}</div>
      <p class="small sub">${CHOMES_CREDIT}</p>
    </form>`);

  const form = $('#chomes', box);
  const hlCount = () => {
    const n = form.highlight_features.value.split('\n').map((s) => s.trim()).filter(Boolean).length;
    const hint = $('#ch-hl-count', box);
    hint.textContent = n ? `${n} of 3 to 5${n > 5 ? '. Keep it to five.' : ''}` : 'The ones the salesperson would actually mention.';
    hint.style.color = n > 5 ? 'var(--bad)' : '';
  };
  form.addEventListener('input', (e) => { if (e.target.name === 'highlight_features') hlCount(); });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'title_issues') $('#ch-title-detail', box).hidden = e.target.value !== 'true';
  });
  hlCount();

  on(box, 'click', '#ch-from-sticker', async (e, b) => {
    b.disabled = true;
    const out = $('#ch-sticker-opts', box);
    out.innerHTML = String(html`<p class="small sub">Reading the sticker…</p>`);
    try {
      const found = parseFactoryOptions(await pdfLines(factorySticker(v).url));
      const have = new Set(form.options_packages.value.split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean));
      const fresh = found.filter((o) => !have.has(o.toLowerCase()));
      if (!found.length) { out.innerHTML = String(html`<div class="notice">No optional equipment section found on this sticker. Enter packages by hand.</div>`); b.disabled = false; return; }
      if (!fresh.length) { out.innerHTML = String(html`<div class="notice ok">All ${found.length} options from the sticker are already listed.</div>`); return; }
      out.innerHTML = String(html`<div class="ch-suggest"><p class="small" style="margin:6px 0"><strong>Found on the factory sticker.</strong> Tick the ones to add, then save.</p>
        ${fresh.map((o, i) => html`<label class="check small" style="margin:4px 0;font-weight:500"><input type="checkbox" data-opt="${i}" checked> ${o}</label>`)}
        <button type="button" class="btn sm" id="ch-add-opts">Add selected</button></div>`);
      $('#ch-add-opts', box).addEventListener('click', () => {
        const picked = fresh.filter((_, i) => out.querySelector(`[data-opt="${i}"]`).checked);
        const cur = form.options_packages.value.trim();
        form.options_packages.value = [cur, ...picked].filter(Boolean).join('\n');
        out.innerHTML = String(html`<p class="small" style="color:var(--ok)">Added ${picked.length}. Save CHOMES to keep them.</p>`);
      });
    } catch (err) { out.innerHTML = String(html`<div class="notice warn">Couldn't read the sticker: ${errMsg(err)}</div>`); b.disabled = false; }
  });

  const fromFeed = $('#ch-from-feed', box);
  fromFeed && fromFeed.addEventListener('click', () => { form.options_packages.value = v.features.join('\n'); fromFeed.remove(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const txt = (k) => { const x = String(fd.get(k) ?? '').trim(); return x === '' ? null : x; };
    const num = (k) => { const x = String(fd.get(k) ?? '').replace(/[$,%\s]/g, ''); return x === '' ? null : Number(x); };
    const lines = (k) => String(fd.get(k) || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const title = fd.get('title_issues');
    const patch = {
      overall_grade: txt('overall_grade'), strengths: txt('strengths'), wear_items: txt('wear_items'),
      needed_work: txt('needed_work'), recon_cost: num('recon_cost'), inspected_by: txt('inspected_by'),
      inspection_date: txt('inspection_date'), report_provider: txt('report_provider'), accidents_count: num('accidents_count'),
      accidents_summary: txt('accidents_summary'), service_records: num('service_records'), prior_owners: num('prior_owners'),
      title_issues: title === null ? null : title === 'true', title_issue_detail: title === 'true' ? txt('title_issue_detail') : null,
      open_recalls: num('open_recalls'), generation_note: txt('generation_note'),
      options_packages: lines('options_packages'), highlight_features: lines('highlight_features'),
      price_to_market_pct: num('price_to_market_pct'), market_days_supply: num('market_days_supply'),
      comparable_units_nearby: num('comparable_units_nearby'), demand_note: txt('demand_note'), acquisition_notes: txt('acquisition_notes'),
    };
    const bad = (msg, k) => { toast(msg, 'bad'); const el = form.elements[k]; el && (el.focus ? el.focus() : el[0] && el[0].focus()); };
    if (Object.entries(patch).some(([, x]) => typeof x === 'number' && (Number.isNaN(x) || x < 0))) return bad('Numbers can\'t be negative or contain letters');
    if (patch.highlight_features.length > 5) return bad('Pick at most five highlight features', 'highlight_features');
    if (patch.accidents_count > 0 && !patch.accidents_summary) return bad('Add a one-line summary of the reported accident(s)', 'accidents_summary');
    if (patch.title_issues && !patch.title_issue_detail) return bad('Describe the title issue', 'title_issue_detail');
    if (patch.inspection_date && patch.inspection_date > today) return bad('Inspection date can\'t be in the future', 'inspection_date');
    if (patch.price_to_market_pct !== null && patch.price_to_market_pct > 300) return bad('Price to market is a percent, like 97.5', 'price_to_market_pct');

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const saved = rec.vehicle_id
        ? must(await sb.from('vehicle_chomes').update(patch).eq('vehicle_id', v.id).select('*').single())
        : must(await sb.from('vehicle_chomes').insert({ vehicle_id: v.id, dealership_id: ctx.dealership.id, ...patch }).select('*').single());
      const after = computeChomes(v, saved);
      toast(after.missingCount ? `Saved. ${after.missingCount} required field${after.missingCount > 1 ? 's' : ''} still to fill.` : 'CHOMES saved');
      onChange(saved);
    } catch (err) { toast(errMsg(err), 'bad'); btn.disabled = false; }
  });

  // History report: private bucket, opened with a short-lived signed link.
  const report = $('#ch-report', box);
  report && report.addEventListener('change', async () => {
    const file = report.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('Files must be under 25 MB', 'bad'); return; }
    report.disabled = true;
    try {
      const { path } = await uploadFile(ctx.dealership.id, `vehicles/${v.id}/history`, file, BUCKET);
      const patch = { history_report_path: path, history_report_name: file.name };
      const saved = rec.vehicle_id
        ? must(await sb.from('vehicle_chomes').update(patch).eq('vehicle_id', v.id).select('*').single())
        : must(await sb.from('vehicle_chomes').insert({ vehicle_id: v.id, dealership_id: ctx.dealership.id, ...patch }).select('*').single());
      if (rec.history_report_path) await removeFile(rec.history_report_path, BUCKET);
      toast('History report saved (team only)');
      onChange(saved);
    } catch (err) { toast(errMsg(err), 'bad'); report.disabled = false; }
  });
  on(box, 'click', '#ch-report-open', async () => {
    const w = window.open('', '_blank');
    try {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(rec.history_report_path, 300);
      if (error) throw error;
      if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
    } catch (err) { if (w) w.close(); toast(errMsg(err), 'bad'); }
  });
  on(box, 'click', '#ch-report-del', async () => {
    if (!confirm('Remove the history report?')) return;
    try {
      const saved = must(await sb.from('vehicle_chomes').update({ history_report_path: null, history_report_name: null }).eq('vehicle_id', v.id).select('*').single());
      await removeFile(rec.history_report_path, BUCKET);
      onChange(saved);
    } catch (err) { toast(errMsg(err), 'bad'); }
  });

  // Decode VIN: fill only the vehicle's empty basics, labelled "VIN decode" in provenance.
  on(box, 'click', '#ch-decode', async (e, b) => {
    b.disabled = true;
    try {
      const r = await api(`/api/vin/${encodeURIComponent(v.vin)}`);
      const updated = must(await sb.rpc('vp_vehicle_apply_decode', { p_vehicle_id: v.id, p_fields: r }));
      const fresh = await loadChomes(v.id);
      const filled = ['year', 'trim', 'drivetrain', 'engine'].filter((k) => !v[k] && updated[k]);
      toast(filled.length ? `Filled ${filled.join(', ')} from the VIN` : 'The VIN decode had nothing new to fill');
      onChange(fresh, updated);
    } catch (err) { toast(errMsg(err), 'bad'); b.disabled = false; }
  });
}

function factorySticker(v) {
  return (v.vehicle_documents || []).find((d) => d.kind === 'window_sticker' && /\.pdf(\?|$)/i.test(d.url || ''));
}

// pdf.js loaded on demand. The worker runs from a same-origin blob that imports the CDN build, because browsers
// won't start a worker straight from another origin.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build';
let pdfjs;
async function pdfLines(url) {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
    const boot = URL.createObjectURL(new Blob([`import "${PDFJS}/pdf.worker.min.mjs";`], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(boot, { type: 'module' });
  }
  const task = pdfjs.getDocument({ url, isEvalSupported: false });
  const doc = await task.promise;
  const lines = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n);
    lines.push(...textItemsToLines((await page.getTextContent()).items));
  }
  await task.destroy();
  return lines;
}
