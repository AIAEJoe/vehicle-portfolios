// Vehicle editor: details, photos, documents, sharing & activity, recalls.
import {
  sb, html, raw, mount, must, api, $, $$, on, errMsg, toast, money, vTitle, timeAgo, dateTime,
  portfolioUrl, copyText, smsHref, telHref, config,
} from '../core.js';
import { adminPage, STATUS_LABEL } from './layout.js';
import { navigate } from '../router.js';
import { resizeImage, uploadFile, removeFile } from './media.js';
import { renderBuyersGuide, resolveGuide, needsBuyersGuide, isShorthand } from '../buyers-guide.js';

const DOC_KINDS = [
  ['window_sticker', 'Window sticker'], ['history_report', 'Vehicle history report (Carfax / AutoCheck)'],
  ['inspection', 'Inspection / reconditioning'], ['warranty', 'Warranty information'],
  ['brochure', 'Brochure'], ['other', 'Other'],
];

const TABS = [['details', 'Details'], ['photos', 'Photos'], ['documents', 'Documents'], ['guide', 'Buyers Guide'], ['shares', 'Share & activity'], ['recalls', 'Recalls']];

const FULL_CONDITIONS = [
  'Warranty service is provided to anyone who owns the vehicle during the warranty period',
  'Warranty service is free of charge, including removing and reinstalling the system when necessary',
  'The buyer can choose a replacement or a full refund if the vehicle or a part can\'t be repaired after a reasonable number of tries',
  'The buyer only has to tell the dealer that warranty service is needed (no other duties, unless the dealer shows they are reasonable)',
  'The dealer does not limit how long implied warranties last',
];

export default async function vehicleEdit(el, { id }) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;

  let v, staff;
  async function load() {
    v = must(await sb.from('vehicles').select('*, vehicle_photos(*), vehicle_documents(*)').eq('id', id).eq('dealership_id', D).maybeSingle());
    if (!v) throw new Error('Vehicle not found');
    v.vehicle_photos.sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
    staff = must(await sb.from('staff').select('id,full_name,phone,email,active,user_id').eq('dealership_id', D).order('full_name'));
  }
  try { await load(); } catch (e) { mount(main, html`<div class="card">${errMsg(e)} <a href="/admin/vehicles">Back</a></div>`); return; }

  let tab = (location.hash || '#details').slice(1);
  if (!TABS.some(([k]) => k === tab)) tab = 'details';

  function frame() {
    const url = portfolioUrl(v);
    mount(main, html`
      <div class="page-head">
        <div>
          <a href="/admin/vehicles" class="small">← Vehicles</a>
          <h1>${vTitle(v) || 'New vehicle'}</h1>
          <div class="small sub"><span class="pill ${v.status}">${STATUS_LABEL[v.status]}</span>
            ${v.stock_number ? ` Stock ${v.stock_number}` : ''}${v.vin ? ` · ${v.vin}` : ''}${v.price ? ` · ${money(v.price)}` : ''}
            ${v.source === 'feed' ? html` · from feed${v.feed_locked ? ' (locked)' : ''}` : ''}</div>
        </div>
        <div class="btn-row">
          ${v.status === 'published'
            ? html`<button class="btn alt sm" data-status="draft">Unpublish</button>`
            : v.status === 'sold' ? html`<button class="btn alt sm" data-status="published">Mark available</button>`
            : html`<button class="btn accent sm" data-status="published">Publish</button>`}
          <a class="btn alt sm" href="${url}" target="_blank" data-external>Preview</a>
          <button class="btn alt sm" id="copy">Copy link</button>
          <a class="btn alt sm" href="/admin/vehicles/${v.id}/print">QR window card</a>
        </div>
      </div>
      ${v.status !== 'published' && v.status !== 'sold' ? html`<div class="notice warn">This portfolio is a draft. Customers can't open it until you publish.</div>` : ''}
      <div class="tabs" role="tablist">${TABS.map(([k, label]) => html`<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${label}${k === 'photos' ? html`<span class="badge">${v.vehicle_photos.length}</span>` : ''}${k === 'documents' && v.vehicle_documents.length ? html`<span class="badge">${v.vehicle_documents.length}</span>` : ''}${k === 'guide' && needsBuyersGuide(v) && resolveGuide(v, ctx.dealership).pending ? html`<span class="badge" title="Warranty data pending">!</span>` : ''}</button>`)}</div>
      <div id="tab"></div>`);
    drawTab();
  }

  function drawTab() {
    const box = $('#tab', main);
    ({ details, photos, documents, guide, shares, recalls })[tab](box);
  }

  on(main, 'click', '[data-tab]', (e, b) => {
    tab = b.dataset.tab;
    history.replaceState({}, '', `#${tab}`);
    $$('.tabs button', main).forEach((x) => x.classList.toggle('on', x === b));
    drawTab();
  });
  on(main, 'click', '[data-status]', async (e, b) => {
    const status = b.dataset.status;
    if (status === 'published' && !v.vehicle_photos.length && !confirm('This vehicle has no photos yet. Publish anyway?')) return;
    try {
      must(await sb.from('vehicles').update({ status }).eq('id', v.id));
      v.status = status;
      toast(status === 'published' ? 'Published. Customers can open it now.' : 'Moved to drafts');
      frame();
    } catch (err) { toast(errMsg(err), 'bad'); }
  });
  on(main, 'click', '#copy', () => copyText(portfolioUrl(v)));

  // ---------------------------------------------------------------- details
  function details(box) {
    const f = (name, label, attrs = '') => html`<div><label for="d-${name}">${label}</label><input id="d-${name}" name="${name}" value="${v[name] ?? ''}" ${raw(attrs)}></div>`;
    mount(box, html`<form id="details" class="card">
      <div class="grid3">
        ${f('year', 'Year', 'type="number" min="1900" max="2100"')}${f('make', 'Make')}${f('model', 'Model')}
        ${f('trim', 'Trim')}${f('stock_number', 'Stock #')}
        <div><label for="d-vin">VIN</label><div class="copy-field"><input id="d-vin" name="vin" value="${v.vin || ''}" maxlength="17" style="text-transform:uppercase"><button type="button" class="btn alt sm" id="decode" title="Fill empty fields from NHTSA">Decode</button></div></div>
        <div><label for="d-condition">Condition</label><select id="d-condition" name="condition">
          ${[['used', 'Pre-owned'], ['certified', 'Certified pre-owned'], ['new', 'New']].map(([k, l]) => html`<option value="${k}" ${v.condition === k ? 'selected' : ''}>${l}</option>`)}</select></div>
        ${f('mileage', 'Mileage', 'type="number" min="0" inputmode="numeric"')}
        ${f('price', 'Price ($)', 'type="number" min="0" step="1" inputmode="numeric"')}
        ${f('price_label', 'Price label', 'placeholder="Price, Live Market Price, Sale Price…"')}
        ${f('msrp', 'MSRP ($)', 'type="number" min="0" step="1"')}
        <div><label for="d-salesperson_id">Salesperson</label><select id="d-salesperson_id" name="salesperson_id">
          <option value="">None</option>${staff.filter((s) => s.active || s.id === v.salesperson_id).map((s) => html`<option value="${s.id}" ${v.salesperson_id === s.id ? 'selected' : ''}>${s.full_name}</option>`)}</select></div>
        ${f('exterior_color', 'Exterior color')}${f('interior_color', 'Interior')}${f('body_style', 'Body style')}
        ${f('engine', 'Engine')}${f('transmission', 'Transmission')}${f('drivetrain', 'Drivetrain')}
        ${f('fuel_type', 'Fuel')}${f('mpg_city', 'MPG city', 'type="number" min="0"')}${f('mpg_hwy', 'MPG highway', 'type="number" min="0"')}
      </div>
      <label for="d-fees_note">Fees / price disclaimer</label>
      <input id="d-fees_note" name="fees_note" value="${v.fees_note || ''}" placeholder="${ctx.dealership.default_fees_note || 'Plus tax, tag and fees.'}">
      <div class="hint">Leave blank to use the dealership default.</div>
      <label for="d-features">Highlights (one per line)</label>
      <textarea id="d-features" name="features" rows="4" placeholder="Heated seats&#10;Apple CarPlay&#10;One owner">${(v.features || []).join('\n')}</textarea>
      <label for="d-description">Description</label>
      <textarea id="d-description" name="description" rows="5">${v.description || ''}</textarea>
      <label for="d-listing_url">Website listing URL</label>
      <input id="d-listing_url" name="listing_url" type="url" value="${v.listing_url || ''}">
      ${v.source === 'feed' ? html`<label class="check"><input type="checkbox" name="feed_locked" ${v.feed_locked ? 'checked' : ''}> Lock this vehicle so the inventory feed doesn't overwrite my edits</label>` : ''}
      <div class="btn-row" style="margin-top:16px;justify-content:space-between">
        <button class="btn">Save details</button>
        <span class="btn-row">
          ${v.status !== 'sold' ? html`<button type="button" class="btn alt" data-status="sold">Mark sold</button>` : ''}
          ${ctx.isAdmin ? html`<button type="button" class="btn danger" id="delete">Delete</button>` : ''}
        </span>
      </div>
    </form>`);

    const form = $('#details', box);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const num = (k) => { const x = String(fd.get(k) || '').replace(/[$,\s]/g, ''); return x === '' ? null : Number(x); };
      const txt = (k) => { const x = String(fd.get(k) ?? '').trim(); return x === '' ? null : x; };
      const patch = {
        year: num('year'), make: txt('make'), model: txt('model'), trim: txt('trim'), stock_number: txt('stock_number'),
        vin: txt('vin') && txt('vin').toUpperCase(), condition: txt('condition') || 'used', mileage: num('mileage'),
        price: num('price'), price_label: txt('price_label'), msrp: num('msrp'), salesperson_id: txt('salesperson_id'),
        exterior_color: txt('exterior_color'), interior_color: txt('interior_color'), body_style: txt('body_style'),
        engine: txt('engine'), transmission: txt('transmission'), drivetrain: txt('drivetrain'), fuel_type: txt('fuel_type'),
        mpg_city: num('mpg_city'), mpg_hwy: num('mpg_hwy'), fees_note: txt('fees_note'), description: txt('description'),
        listing_url: txt('listing_url'),
        features: String(fd.get('features') || '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
      if (patch.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(patch.vin)) { toast('VIN must be 17 letters/numbers (no I, O, Q)', 'bad'); return; }
      if (v.source === 'feed') patch.feed_locked = fd.get('feed_locked') === 'on';
      const btn = form.querySelector('button.btn:not([type=button])');
      btn.disabled = true;
      try {
        const updated = must(await sb.from('vehicles').update(patch).eq('id', v.id).select().single());
        Object.assign(v, updated);
        toast('Saved');
        frame();
      } catch (err) {
        toast(/vehicles_dealership_id_vin_key/.test(errMsg(err)) ? 'Another vehicle already has that VIN' : errMsg(err), 'bad');
      } finally { btn.disabled = false; }
    });

    $('#decode', box).addEventListener('click', async () => {
      const vin = $('#d-vin', box).value.trim().toUpperCase();
      try {
        const r = await api(`/api/vin/${encodeURIComponent(vin)}`);
        let filled = 0;
        for (const k of ['year', 'make', 'model', 'trim', 'body_style', 'engine', 'transmission', 'drivetrain', 'fuel_type']) {
          const input = form.elements[k];
          if (input && !input.value && r[k]) { input.value = r[k]; filled++; }
        }
        if (r.specs && Object.keys(r.specs).length) {
          must(await sb.from('vehicles').update({ specs: { ...(v.specs || {}), ...r.specs } }).eq('id', v.id));
          v.specs = { ...(v.specs || {}), ...r.specs };
        }
        toast(filled ? `Filled ${filled} field${filled > 1 ? 's' : ''}. Review and save.` : 'Nothing new to fill in');
      } catch (err) { toast(errMsg(err), 'bad'); }
    });

    const del = $('#delete', box);
    del && del.addEventListener('click', async () => {
      if (!confirm(`Delete the ${vTitle(v)} and all its photos, documents and activity? This can't be undone.`)) return;
      try {
        const paths = [...v.vehicle_photos, ...v.vehicle_documents].map((x) => x.storage_path).filter(Boolean);
        must(await sb.from('vehicles').delete().eq('id', v.id));
        if (paths.length) await sb.storage.from('media').remove(paths);
        toast('Vehicle deleted');
        navigate('/admin/vehicles');
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  // ---------------------------------------------------------------- photos
  function photos(box) {
    const list = v.vehicle_photos;
    mount(box, html`
      <div class="dropzone" id="drop">
        <p style="margin:0 0 10px"><strong>Drag photos here</strong> or</p>
        <label class="btn" style="display:inline-flex;margin:0">Choose photos
          <input type="file" id="files" accept="image/*" multiple class="sr-only"></label>
        <p class="hint">Large phone photos are resized automatically. The first photo is the cover.</p>
        <div id="progress" class="small"></div>
      </div>
      <form id="by-url" class="copy-field" style="margin-bottom:14px">
        <input type="url" id="purl" placeholder="…or paste an image URL" aria-label="Image URL"><button class="btn alt">Add</button>
      </form>
      ${list.length ? html`<div class="photo-grid">${list.map((p, i) => html`<div class="photo-tile">
        ${i === 0 ? html`<span class="cover">Cover</span>` : ''}
        <img src="${p.url}" alt="Photo ${i + 1}" loading="lazy">
        <div class="bar">
          <span><button data-move="-1" data-id="${p.id}" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>◀</button><button data-move="1" data-id="${p.id}" aria-label="Move right" ${i === list.length - 1 ? 'disabled' : ''}>▶</button></span>
          <span>${i !== 0 ? html`<button data-cover="${p.id}" title="Make cover">★</button>` : ''}<button data-del="${p.id}" aria-label="Delete photo">🗑</button></span>
        </div></div>`)}</div>
        ${list.length > 1 ? html`<p style="margin-top:14px"><button class="btn danger sm" id="del-all">Delete all ${list.length} photos</button></p>` : ''}`
        : html`<div class="card sub" style="text-align:center">No photos yet.</div>`}`);

    const progress = $('#progress', box);
    async function addFiles(files) {
      files = [...files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      let pos = list.length ? Math.max(...list.map((p) => p.position)) + 1 : 0;
      let done = 0;
      for (const file of files) {
        progress.textContent = `Uploading ${done + 1} of ${files.length}…`;
        try {
          const small = await resizeImage(file);
          const { path, url } = await uploadFile(D, `vehicles/${v.id}`, small);
          const row = must(await sb.from('vehicle_photos').insert({ vehicle_id: v.id, dealership_id: D, url, storage_path: path, position: pos++, source: 'upload' }).select().single());
          list.push(row);
          done++;
        } catch (err) { toast(`${file.name}: ${errMsg(err)}`, 'bad'); }
      }
      toast(`Uploaded ${done} photo${done === 1 ? '' : 's'}`);
      frame();
    }
    $('#files', box).addEventListener('change', (e) => addFiles(e.target.files));
    const drop = $('#drop', box);
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    $('#by-url', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#purl', box).value.trim();
      if (!/^https?:\/\//.test(url)) { toast('Paste a full image URL', 'bad'); return; }
      const pos = list.length ? Math.max(...list.map((p) => p.position)) + 1 : 0;
      try {
        list.push(must(await sb.from('vehicle_photos').insert({ vehicle_id: v.id, dealership_id: D, url, position: pos, source: 'url' }).select().single()));
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });

    async function saveOrder(next) {
      const updates = next.map((p, i) => ({ ...p, position: i }));
      for (const p of updates.filter((p) => list.find((x) => x.id === p.id).position !== p.position)) {
        const { error } = await sb.from('vehicle_photos').update({ position: p.position }).eq('id', p.id);
        if (error) { toast(errMsg(error), 'bad'); break; }
      }
      v.vehicle_photos = updates;
      frame();
    }
    on(box, 'click', '[data-move]', (e, b) => {
      const i = list.findIndex((p) => p.id === b.dataset.id);
      const j = i + Number(b.dataset.move);
      if (j < 0 || j >= list.length) return;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      saveOrder(next);
    });
    on(box, 'click', '[data-cover]', (e, b) => {
      const p = list.find((x) => x.id === b.dataset.cover);
      saveOrder([p, ...list.filter((x) => x !== p)]);
    });
    on(box, 'click', '[data-del]', async (e, b) => {
      const p = list.find((x) => x.id === b.dataset.del);
      try {
        must(await sb.from('vehicle_photos').delete().eq('id', p.id));
        await removeFile(p.storage_path);
        v.vehicle_photos = list.filter((x) => x !== p);
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
    const delAll = $('#del-all', box);
    delAll && delAll.addEventListener('click', async () => {
      if (!confirm(`Delete all ${list.length} photos?`)) return;
      try {
        must(await sb.from('vehicle_photos').delete().eq('vehicle_id', v.id));
        const paths = list.map((p) => p.storage_path).filter(Boolean);
        if (paths.length) await sb.storage.from('media').remove(paths);
        v.vehicle_photos = [];
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  // ---------------------------------------------------------------- documents
  function documents(box) {
    const docs = v.vehicle_documents;
    mount(box, html`<div class="card"><h2>Documents customers can open</h2>
      ${docs.length ? docs.map((d) => html`<div class="doc-row">
        <span><strong>${d.title}</strong><br><span class="sub small">${(DOC_KINDS.find(([k]) => k === d.kind) || [])[1] || d.kind}</span></span>
        <span class="btn-row"><a class="btn ghost sm" href="${d.url}" target="_blank" data-external>Open</a>
        <button class="btn danger sm" data-deldoc="${d.id}">Remove</button></span></div>`)
        : html`<p class="sub">No documents yet. Only real documents should go here: window stickers, history reports, inspections and warranty papers.</p>`}
      </div>
      <form class="card" id="docform"><h2>Add a document</h2>
        <div class="grid2 stack-sm">
          <div><label for="dk">Type</label><select id="dk" name="kind">${DOC_KINDS.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></div>
          <div><label for="dt">Title</label><input id="dt" name="title" placeholder="e.g. CARFAX Vehicle History Report"></div>
        </div>
        <label for="df">File (PDF or image)</label><input id="df" name="file" type="file" accept="application/pdf,image/*">
        <label for="du">…or link to it</label><input id="du" name="url" type="url" placeholder="https://www.carfax.com/vehiclehistory/…">
        <button class="btn" style="margin-top:14px">Add document</button>
      </form>`);

    $('#docform', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const kind = fd.get('kind');
      const title = String(fd.get('title') || '').trim() || DOC_KINDS.find(([k]) => k === kind)[1].replace(/ \(.*\)/, '');
      const file = fd.get('file');
      let url = String(fd.get('url') || '').trim();
      let storage_path = null;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        if (file && file.size) {
          if (file.size > 25 * 1024 * 1024) throw new Error('Files must be under 25 MB');
          const up = await uploadFile(D, `vehicles/${v.id}/docs`, file.type.startsWith('image/') ? await resizeImage(file, 2400, 0.9) : file);
          url = up.url; storage_path = up.path;
        }
        if (!url) throw new Error('Choose a file or paste a link');
        const row = must(await sb.from('vehicle_documents').insert({ vehicle_id: v.id, dealership_id: D, kind, title, url, storage_path }).select().single());
        v.vehicle_documents.push(row);
        toast('Document added');
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
      finally { btn.disabled = false; }
    });
    on(box, 'click', '[data-deldoc]', async (e, b) => {
      const d = docs.find((x) => x.id === b.dataset.deldoc);
      if (!confirm(`Remove "${d.title}"?`)) return;
      try {
        must(await sb.from('vehicle_documents').delete().eq('id', d.id));
        await removeFile(d.storage_path);
        v.vehicle_documents = docs.filter((x) => x !== d);
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  // ---------------------------------------------------------------- sharing & activity
  async function shares(box) {
    mount(box, html`<div class="loading"><div class="spinner"></div></div>`);
    let list, views, stats, leads, smsInfo;
    try {
      [list, views, stats, leads, smsInfo] = await Promise.all([
        sb.from('shares').select('*, staff(full_name)').eq('vehicle_id', v.id).order('created_at', { ascending: false }).then(must),
        sb.from('portfolio_views').select('id,viewed_at,share_id,referrer,user_agent').eq('vehicle_id', v.id).order('viewed_at', { ascending: false }).limit(50).then(must),
        sb.from('vehicle_stats').select('*').eq('vehicle_id', v.id).maybeSingle().then(must),
        sb.from('leads').select('id,name,created_at,status').eq('vehicle_id', v.id).order('created_at', { ascending: false }).then(must),
        sb.rpc('vp_public_sms_info', { p_slug: config.dealer }).then(must),
      ]);
    } catch (err) { mount(box, html`<div class="notice bad">${errMsg(err)}</div>`); return; }
    stats = stats || {};
    const shareById = Object.fromEntries(list.map((s) => [s.id, s]));
    const defaultStaff = (ctx.me && ctx.me.id) || v.salesperson_id || '';
    const live = v.status === 'published';

    mount(box, html`
      <div class="kpis">
        <div class="kpi"><div class="n">${stats.views || 0}</div><div class="l">Total opens</div></div>
        <div class="kpi"><div class="n">${stats.visitors || 0}</div><div class="l">People</div></div>
        <div class="kpi"><div class="n">${list.length}</div><div class="l">Links sent</div></div>
        <div class="kpi"><div class="n">${leads.length}</div><div class="l">Leads</div></div>
      </div>
      <form class="card" id="sendform"><h2>Send to a customer</h2>
        ${!live ? html`<div class="notice warn">Publish this vehicle before sending it. Customers can't open drafts.</div>` : ''}
        <p class="sub" style="margin-top:0">Each customer gets a personal link. You'll get a text and email the moment they open it.</p>
        <div class="grid3">
          <div><label for="cn">Customer name</label><input id="cn" name="customer_name" required autocomplete="off"></div>
          <div><label for="cp">Mobile phone</label><input id="cp" name="customer_phone" type="tel" autocomplete="off"></div>
          <div><label for="ce">Email (optional)</label><input id="ce" name="customer_email" type="email" autocomplete="off"></div>
        </div>
        <label for="cs">From</label>
        <select id="cs" name="staff_id">${staff.filter((s) => s.active).map((s) => html`<option value="${s.id}" ${s.id === defaultStaff ? 'selected' : ''}>${s.full_name}</option>`)}</select>
        <label class="check small"><input type="checkbox" name="attested"> The customer told me it's OK to text them (saved with your name, the time and our consent wording)</label>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" data-channel="dealer-sms" ${live && smsInfo && smsInfo.sms_enabled ? '' : 'disabled'} title="${smsInfo && smsInfo.sms_enabled ? `From ${smsInfo.phone}` : 'Available after 10DLC approval'}">Text from ${smsInfo && smsInfo.phone ? smsInfo.phone : 'dealership number'}</button>
          <button class="btn alt" data-channel="dealer-email" ${live ? '' : 'disabled'}>Email it</button>
          <button class="btn alt" data-channel="sms" ${live ? '' : 'disabled'}>Text from my phone</button>
          <button class="btn alt" data-channel="link" ${live ? '' : 'disabled'}>Copy personal link</button>
        </div>
        <p class="hint">Texts from the dealership number get delivery status, and replies come back to the Inbox.${smsInfo && smsInfo.sms_enabled ? '' : ' Texting from the dealership number turns on after carrier registration is approved.'}</p>
      </form>
      <div class="card"><h2>Sent links</h2>
        ${list.length ? list.map((s) => html`<div class="share-item">
          <div><strong>${s.customer_name || (s.channel === 'qr' ? 'QR window card' : 'Link')}</strong>
            ${s.customer_phone ? html` · <a href="${telHref(s.customer_phone)}">${s.customer_phone}</a>` : ''}
            <div class="small sub">${s.channel === 'qr' ? 'Printed QR code' : `Sent by ${s.staff ? s.staff.full_name : 'staff'} by ${s.channel === 'sms' ? 'text' : s.channel}`} · ${timeAgo(s.created_at)}${s.customer_id ? html` · <a href="/admin/inbox?c=${s.customer_id}">conversation</a>` : ''}</div></div>
          <div style="text-align:right" class="small">${s.open_count
            ? html`<span class="opened">Opened ${s.open_count}×</span><br><span class="sub">last ${timeAgo(s.last_opened_at)}</span>`
            : html`<span class="not-opened">Not opened yet</span>`}<br>
            <button class="btn ghost sm" data-copyshare="${s.code}">Copy link</button></div>
        </div>`) : html`<p class="sub">No links sent yet.</p>`}
      </div>
      <div class="card"><h2>Recent opens</h2>
        ${views.length ? html`<div class="table-wrap" style="box-shadow:none"><table class="data"><thead><tr><th>When</th><th>Who</th><th>Device</th></tr></thead><tbody>
          ${views.map((pv) => { const s = shareById[pv.share_id]; return html`<tr><td class="nowrap">${dateTime(pv.viewed_at)}</td>
            <td>${s ? (s.customer_name || (s.channel === 'qr' ? 'QR code scan' : 'Personal link')) : html`<span class="sub">${pv.referrer ? new URL(pv.referrer, location.href).host : 'Direct / shared link'}</span>`}</td>
            <td class="sub">${device(pv.user_agent)}</td></tr>`; })}
        </tbody></table></div>` : html`<p class="sub">No one has opened this portfolio yet.</p>`}
      </div>
      ${leads.length ? html`<div class="card"><h2>Leads for this vehicle</h2>${leads.map((l) => html`<div class="share-item"><span><strong>${l.name}</strong> <span class="pill ${l.status}">${l.status}</span></span><span class="sub small">${timeAgo(l.created_at)}</span></div>`)}<p><a href="/admin/leads">Open leads</a></p></div>` : ''}`);

    on(box, 'click', '[data-copyshare]', (e, b) => copyText(portfolioUrl(v, b.dataset.copyshare)));
    on(box, 'click', '#sendform [data-channel]', async (e, b) => {
      e.preventDefault();
      const form = $('#sendform', box);
      const fd = Object.fromEntries(new FormData(form).entries());
      const channel = b.dataset.channel;
      if (!fd.customer_name.trim()) { toast('Enter the customer\'s name', 'bad'); form.customer_name.focus(); return; }
      if (/sms/.test(channel) && !fd.customer_phone.trim()) { toast('Enter a mobile number to text', 'bad'); form.customer_phone.focus(); return; }
      if (/email/.test(channel) && !fd.customer_email.trim()) { toast('Enter an email address', 'bad'); form.customer_email.focus(); return; }
      if (channel === 'dealer-sms' || channel === 'dealer-email') {
        b.disabled = true;
        try {
          await api('/api/messages/send', { method: 'POST', auth: true, body: {
            channel: channel === 'dealer-sms' ? 'sms' : 'email', kind: 'portfolio_share', vehicle_id: v.id, staff_id: fd.staff_id || null,
            customer: { name: fd.customer_name.trim(), phone: fd.customer_phone.trim() || null, email: fd.customer_email.trim() || null },
            consent: fd.attested ? { attested: true } : undefined } });
          toast(channel === 'dealer-sms' ? 'Text sent from the dealership number' : 'Email sent');
          form.reset();
          frame();
        } catch (err) { toast(errMsg(err), 'bad'); b.disabled = false; }
        return;
      }
      // Open a window synchronously for iOS/Safari popup rules isn't needed for sms:/mailto:
      try {
        const s = must(await sb.from('shares').insert({
          vehicle_id: v.id, dealership_id: D, channel, staff_id: fd.staff_id || null,
          customer_name: fd.customer_name.trim(), customer_phone: fd.customer_phone.trim() || null, customer_email: fd.customer_email.trim() || null,
        }).select().single());
        const link = portfolioUrl(v, s.code);
        const from = staff.find((x) => x.id === fd.staff_id);
        const first = fd.customer_name.trim().split(/\s+/)[0];
        const msg = `Hi ${first}, it's ${from ? from.full_name.split(' ')[0] : 'us'} at ${ctx.dealership.name}. Here are the photos, details and history for the ${vTitle(v)}: ${link}`;
        if (channel === 'sms') location.href = smsHref(fd.customer_phone, msg);
        else await copyText(link);
        form.reset();
        setTimeout(frame, 600);
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  // ---------------------------------------------------------------- FTC Buyers Guide
  function guide(box) {
    const d = ctx.dealership;
    if (!needsBuyersGuide(v)) {
      mount(box, html`<div class="card"><h2>FTC Buyers Guide</h2><p class="sub">Only used and certified pre-owned vehicles need a Buyers Guide. This vehicle is listed as new.</p></div>`);
      return;
    }
    const g = resolveGuide(v, d);
    const canEdit = ctx.isAdmin;
    const defaultLabel = { as_is: 'As Is', implied_only: 'Implied warranties only' }[d.bg_default_warranty];
    let systems = (Array.isArray(v.bg_systems) && v.bg_systems.length ? v.bg_systems : [{ system: '', duration: '' }]).map((s) => ({ ...s }));
    const radio = (name, value, label, checked, extra = '') => html`<label class="check" style="font-weight:400"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${canEdit ? '' : 'disabled'} ${raw(extra)}> ${label}</label>`;
    const check = (name, label, checked) => html`<label class="check" style="font-weight:400"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> ${label}</label>`;

    mount(box, html`<form id="bg-form" class="card">
      <h2>FTC Buyers Guide</h2>
      ${g.pending ? html`<div class="notice warn"><strong>Warranty data pending.</strong> Customers currently see the <b>AS IS - NO DEALER WARRANTY</b> guide for this vehicle. Enter the warranty terms below, or set a default for all vehicles in <a href="/admin/settings">Settings</a>. Only staff see this message.</div>` : ''}
      ${!v.bg_warranty && d.bg_default_warranty ? html`<div class="notice">Using your dealership default: <strong>${defaultLabel}</strong>. Choose terms below to override it for this vehicle.</div>` : ''}
      ${canEdit ? '' : html`<div class="notice">Only dealership admins can change warranty terms.</div>`}
      <p class="sub small">This drives the Buyers Guide on the customer page and the printed window guide. Enter only the terms you actually offer on this vehicle. If terms change during negotiation, update them here and reprint before closing so both match.</p>

      <label>Warranty for this vehicle</label>
      ${d.bg_default_warranty ? radio('bg_warranty', '', `Use dealership default (${defaultLabel})`, !v.bg_warranty) : ''}
      ${radio('bg_warranty', 'as_is', html`<b>As Is</b> - no dealer warranty`, v.bg_warranty === 'as_is' || (!v.bg_warranty && !d.bg_default_warranty))}
      ${radio('bg_warranty', 'implied_only', html`<b>Implied warranties only</b> (required where state law limits "as is" sales)`, v.bg_warranty === 'implied_only')}
      ${radio('bg_warranty', 'dealer_warranty', html`<b>Dealer warranty</b>`, v.bg_warranty === 'dealer_warranty')}

      <div id="dw" style="margin-left:24px">
        <label>Full or limited?</label>
        ${radio('bg_warranty_type', 'limited', 'Limited warranty', v.bg_warranty_type !== 'full')}
        ${radio('bg_warranty_type', 'full', 'Full warranty', v.bg_warranty_type === 'full')}
        <div id="full-checks" class="notice" style="margin-top:8px">
          <p class="small" style="margin-top:0"><strong>Mark it FULL only if every statement is true</strong> (Magnuson-Moss Act, 15 U.S.C. 2304). Otherwise choose Limited.</p>
          ${FULL_CONDITIONS.map((c, i) => html`<label class="check small" style="font-weight:400;align-items:flex-start"><input type="checkbox" name="full_${i}" ${v.bg_warranty_type === 'full' ? 'checked' : ''} ${canEdit ? '' : 'disabled'} style="margin-top:3px"> ${c}</label>`)}
        </div>
        <div id="pct" class="grid3">
          <div><label for="bg-labor">Dealer pays % of labor</label><input id="bg-labor" name="bg_labor_pct" type="number" min="0" max="100" inputmode="numeric" value="${v.bg_labor_pct ?? ''}" ${canEdit ? '' : 'disabled'}></div>
          <div><label for="bg-parts">Dealer pays % of parts</label><input id="bg-parts" name="bg_parts_pct" type="number" min="0" max="100" inputmode="numeric" value="${v.bg_parts_pct ?? ''}" ${canEdit ? '' : 'disabled'}></div>
        </div>
        <label for="bg-ded">Deductible (optional)</label>
        <input id="bg-ded" name="bg_deductible" placeholder="A $50 deductible applies to each repair visit" value="${v.bg_deductible || ''}" ${canEdit ? '' : 'disabled'}>
        <label>Covered systems and durations</label>
        <p class="hint" style="margin-top:0">Name each system specifically, for example "Engine block, cylinder heads and internal parts" or "Transmission case and internal parts". The FTC does not allow shorthand like "drive train" or "power train".</p>
        <div id="sys"></div>
        ${canEdit ? html`<button type="button" class="btn alt sm" id="sys-add">+ Add system</button>` : ''}
      </div>

      <label style="margin-top:18px">Non-dealer warranties (check only what is actually true for this VIN)</label>
      ${check('bg_mfr_warranty', "Manufacturer's original warranty still applies to some components", v.bg_mfr_warranty)}
      ${check('bg_mfr_used_warranty', "Manufacturer's used vehicle warranty applies (for example, a certified pre-owned warranty)", v.bg_mfr_used_warranty)}
      ${check('bg_other_used_warranty', 'Other used vehicle warranty applies', v.bg_other_used_warranty)}
      <label style="margin-top:14px">Service contract</label>
      ${check('bg_service_contract', 'We offer a service contract on this vehicle for an extra charge', v.bg_warranty ? v.bg_service_contract : (v.bg_service_contract || d.bg_default_service_contract))}

      <div class="btn-row" style="margin-top:16px">
        ${canEdit ? html`<button class="btn" type="submit">Save Buyers Guide</button>` : ''}
        <a class="btn alt" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>Print (English)</a>
        <a class="btn alt" href="/v/${v.slug}/buyers-guide?lang=es" target="_blank" data-external>Print (Español)</a>
      </div>
      ${v.bg_updated_at ? html`<p class="small sub">Warranty terms last changed ${dateTime(v.bg_updated_at)}.</p>` : ''}
    </form>
    <div class="card bg-wrap"><h2>Preview</h2><div id="bg-preview"></div></div>`);

    const form = $('#bg-form', box);
    const val = (n) => { const x = form.querySelector(`[name="${n}"]:checked`); return x ? x.value : null; };
    const drawSystems = () => {
      $('#sys', box).innerHTML = String(html`${systems.map((s, i) => html`<div class="grid2" style="align-items:end;margin-bottom:6px">
        <div><input data-sys="${i}" data-k="system" placeholder="System, e.g. Engine block and cylinder heads" value="${s.system || ''}" aria-label="Covered system ${i + 1}" ${canEdit ? '' : 'disabled'}>
          ${isShorthand(s.system) ? html`<div class="hint" style="color:var(--bad)">Name the parts specifically. "Drive train" / "power train" isn't allowed.</div>` : ''}</div>
        <div class="btn-row"><input data-sys="${i}" data-k="duration" placeholder="30 days or 1,000 miles, whichever occurs first" value="${s.duration || ''}" aria-label="Duration ${i + 1}" style="flex:1" ${canEdit ? '' : 'disabled'}>
          ${canEdit && systems.length > 1 ? html`<button type="button" class="btn ghost sm" data-sys-del="${i}" aria-label="Remove">✕</button>` : ''}</div></div>`)}`);
    };
    const collect = () => {
      const w = val('bg_warranty') || null;
      const type = val('bg_warranty_type');
      const fd = new FormData(form);
      return {
        bg_warranty: w,
        bg_warranty_type: w === 'dealer_warranty' ? type : null,
        bg_labor_pct: w === 'dealer_warranty' && type === 'limited' && fd.get('bg_labor_pct') !== '' ? Number(fd.get('bg_labor_pct')) : null,
        bg_parts_pct: w === 'dealer_warranty' && type === 'limited' && fd.get('bg_parts_pct') !== '' ? Number(fd.get('bg_parts_pct')) : null,
        bg_deductible: w === 'dealer_warranty' ? (String(fd.get('bg_deductible') || '').trim() || null) : null,
        bg_systems: w === 'dealer_warranty' ? systems.map((s) => ({ system: String(s.system || '').trim(), duration: String(s.duration || '').trim() })).filter((s) => s.system || s.duration) : [],
        bg_mfr_warranty: fd.has('bg_mfr_warranty'),
        bg_mfr_used_warranty: fd.has('bg_mfr_used_warranty'),
        bg_other_used_warranty: fd.has('bg_other_used_warranty'),
        bg_service_contract: fd.has('bg_service_contract'),
      };
    };
    const refresh = () => {
      const w = val('bg_warranty');
      const type = val('bg_warranty_type');
      $('#dw', box).hidden = w !== 'dealer_warranty';
      $('#full-checks', box).hidden = type !== 'full';
      $('#pct', box).hidden = type === 'full';
      const draft = { ...v, ...collect() };
      if (draft.bg_warranty_type === 'full') { draft.bg_labor_pct = 100; draft.bg_parts_pct = 100; }
      const { front, back } = renderBuyersGuide(draft, d, 'en');
      $('#bg-preview', box).innerHTML = String(html`${front}${back}`);
    };
    drawSystems();
    refresh();
    form.addEventListener('change', refresh);
    form.addEventListener('input', (e) => {
      const i = e.target.dataset.sys;
      if (i !== undefined) {
        systems[Number(i)][e.target.dataset.k] = e.target.value;
        const warn = e.target.parentElement.querySelector('.hint');
        if (e.target.dataset.k === 'system' && !!warn !== isShorthand(e.target.value)) { const pos = e.target.selectionStart; drawSystems(); const n = $(`[data-sys="${i}"][data-k="system"]`, box); n.focus(); n.setSelectionRange(pos, pos); }
      }
      refresh();
    });
    on(box, 'click', '#sys-add', () => { systems.push({ system: '', duration: '' }); drawSystems(); $(`[data-sys="${systems.length - 1}"][data-k="system"]`, box).focus(); });
    on(box, 'click', '[data-sys-del]', (e, b) => { systems.splice(Number(b.dataset.sysDel), 1); drawSystems(); refresh(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = collect();
      if (body.bg_warranty === 'dealer_warranty') {
        if (!body.bg_warranty_type) { toast('Choose Full or Limited', 'bad'); return; }
        if (body.bg_warranty_type === 'full' && FULL_CONDITIONS.some((_, i) => !form.querySelector(`[name="full_${i}"]`).checked)) {
          toast('A FULL warranty must meet every condition listed. Otherwise choose Limited.', 'bad'); return;
        }
        if (body.bg_warranty_type === 'limited' && (body.bg_labor_pct === null || body.bg_parts_pct === null)) { toast('Enter the % of labor and parts the dealer pays', 'bad'); return; }
        if (!body.bg_systems.length || body.bg_systems.some((s) => !s.system || !s.duration)) { toast('Each covered system needs a name and a duration', 'bad'); return; }
        if (body.bg_systems.some((s) => isShorthand(s.system))) { toast('Name each covered system specifically. "Drive train" / "power train" isn\'t allowed.', 'bad'); return; }
      }
      try {
        const saved = must(await sb.from('vehicles').update(body).eq('id', v.id).select('*').single());
        Object.assign(v, saved);
        toast('Buyers Guide saved. Reprint the window guide so it matches.');
        frame();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  // ---------------------------------------------------------------- recalls
  function recalls(box) {
    const list = Array.isArray(v.recalls) ? v.recalls : null;
    mount(box, html`<div class="card"><h2>NHTSA safety recalls</h2>
      <p class="sub">Checks recalls issued for the ${v.year || ''} ${v.make || ''} ${v.model || ''}. These are model-year recalls, not proof that this VIN still has an open recall. Confirm with your service department or nhtsa.gov.</p>
      <div class="btn-row"><button class="btn" id="check" ${v.year && v.make && v.model ? '' : 'disabled'}>${list ? 'Check again' : 'Check recalls'}</button>
      ${list ? html`<button class="btn alt" id="hide">Hide from portfolio</button>` : ''}</div>
      ${!(v.year && v.make && v.model) ? html`<p class="notice warn">Add year, make and model on the Details tab first.</p>` : ''}
      ${list ? html`<p class="small sub">Last checked ${dateTime(v.recalls_checked_at)}. Shown on the portfolio.</p>
        ${list.length ? list.map((r) => html`<details class="recall"><summary>${r.component} <span class="sub small">${r.campaign}</span></summary><p class="small">${r.summary}</p><p class="small"><strong>Remedy:</strong> ${r.remedy}</p></details>`)
          : html`<div class="notice ok">No recalls listed for this model year.</div>`}` : ''}
    </div>`);
    const check = $('#check', box);
    check && check.addEventListener('click', async () => {
      check.disabled = true;
      try {
        const r = await api(`/api/recalls?year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}`);
        const updated = must(await sb.from('vehicles').update({ recalls: r.recalls, recalls_checked_at: r.checked_at }).eq('id', v.id).select('recalls,recalls_checked_at').single());
        Object.assign(v, updated);
        toast(r.recalls.length ? `${r.recalls.length} recall${r.recalls.length > 1 ? 's' : ''} found` : 'No recalls found');
        recalls(box);
      } catch (err) { toast(errMsg(err), 'bad'); check.disabled = false; }
    });
    const hide = $('#hide', box);
    hide && hide.addEventListener('click', async () => {
      must(await sb.from('vehicles').update({ recalls: null, recalls_checked_at: null }).eq('id', v.id));
      v.recalls = null; v.recalls_checked_at = null;
      recalls(box);
    });
  }

  frame();
}

function device(ua) {
  ua = String(ua || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return ua ? 'Other' : '';
}

