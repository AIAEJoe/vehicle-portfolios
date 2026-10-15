// Add a vehicle: import from a listing URL, decode a VIN, or start blank.
import { sb, html, mount, must, api, $, errMsg, esc, toast } from '../core.js';
import { adminPage } from './layout.js';
import { navigate } from '../router.js';
import { bookmarkletHref, decodeImport } from './grab.js';

const FIELDS = ['vin', 'stock_number', 'condition', 'year', 'make', 'model', 'trim', 'body_style', 'exterior_color',
  'interior_color', 'engine', 'transmission', 'drivetrain', 'fuel_type', 'mileage', 'price', 'description', 'listing_url'];

export default async function vehicleNew(el) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;

  mount(main, html`<div class="page-head"><h1>Add a vehicle</h1><a class="btn ghost" href="/admin/vehicles">Cancel</a></div>
    <div class="card"><h2>Import from your website</h2>
      <p class="sub">Paste the vehicle's page from ${ctx.dealership.website ? new URL(ctx.dealership.website).host : 'your website'}. We'll copy the details and photos.</p>
      <div id="incoming"></div>
      <form id="f-import" class="copy-field">
        <input id="url" type="url" placeholder="https://www.newsmyrnachevy.com/inventory/..." required aria-label="Listing URL">
        <button class="btn">Import</button>
      </form><div id="m-import"></div>
      <details id="bm-help" style="margin-top:14px"><summary><strong>Website blocks imports? Use the one-click button</strong></summary>
        <ol class="small" style="padding-left:20px;line-height:1.7">
          <li>Show your browser's bookmarks bar (Chrome: <strong>Cmd+Shift+B</strong> on Mac, <strong>Ctrl+Shift+B</strong> on Windows).</li>
          <li>Drag this button onto the bookmarks bar: <a class="btn sm accent" id="bm" href="#" data-external title="Drag me to your bookmarks bar">+ Send to Vehicle Portfolios</a></li>
          <li>Open any vehicle on ${ctx.dealership.website ? new URL(ctx.dealership.website).host : 'your website'} and click the bookmark. This page opens with the vehicle and photos ready to save.</li>
        </ol></details>
    </div>
    <div class="card"><h2>Start from a VIN</h2>
      <p class="sub">We'll decode year, make, model, engine and more from NHTSA.</p>
      <form id="f-vin" class="copy-field">
        <input id="vin" placeholder="17-character VIN" required aria-label="VIN" autocapitalize="characters" autocomplete="off" spellcheck="false">
        <button class="btn">Decode</button>
      </form><div id="m-vin"></div></div>
    <div class="card"><h2>Enter it yourself</h2>
      <button class="btn alt" id="blank">Start a blank vehicle</button></div>
    <p class="sub small">Vehicles from your HomeNet/vAuto feed are added automatically. See Settings → Inventory feed.</p>`);

  async function existing(vin) {
    if (!vin) return null;
    return must(await sb.from('vehicles').select('id').eq('dealership_id', ctx.dealership.id).eq('vin', vin).maybeSingle());
  }

  async function create(fields, photos = [], source = 'manual') {
    const row = { dealership_id: ctx.dealership.id, status: 'draft', source };
    for (const k of FIELDS) if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') row[k] = fields[k];
    const int = (x) => { const n = parseInt(String(x).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : undefined; };
    if (row.year !== undefined) row.year = int(row.year);
    if (row.mileage !== undefined) row.mileage = int(row.mileage);
    if (row.price !== undefined) { const n = Number(String(row.price).replace(/[^0-9.]/g, '')); row.price = n > 0 ? n : undefined; }
    if (row.vin !== undefined) { row.vin = String(row.vin).toUpperCase().replace(/\s/g, ''); if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(row.vin)) delete row.vin; }
    if (row.condition && !['new', 'used', 'certified'].includes(row.condition)) delete row.condition;
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    if (fields.features && fields.features.length) row.features = fields.features;
    if (fields.specs) row.specs = fields.specs;
    if (ctx.me) row.salesperson_id = ctx.me.id;
    const v = must(await sb.from('vehicles').insert(row).select('id').single());
    if (photos.length) {
      must(await sb.from('vehicle_photos').insert(photos.map((url, i) => ({
        vehicle_id: v.id, dealership_id: ctx.dealership.id, url, position: i, source: source === 'import' ? 'import' : 'url',
      }))));
    }
    return v;
  }

  const busy = (form, on) => { const b = form.querySelector('button'); b.disabled = on; b.textContent = on ? 'Working…' : b.dataset.label || b.textContent; };
  main.querySelectorAll('form button').forEach((b) => { b.dataset.label = b.textContent; });

  $('#f-import', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#m-import', main);
    busy(e.target, true);
    try {
      const { vehicle } = await api('/api/import-listing', { method: 'POST', auth: true, body: { url: $('#url', main).value.trim() } });
      const dup = await existing(vehicle.vin);
      if (dup) { toast('That VIN is already in your vehicles'); navigate(`/admin/vehicles/${dup.id}`); return; }
      const v = await create(vehicle, vehicle.photos || [], 'import');
      toast(`Imported with ${(vehicle.photos || []).length} photos`);
      navigate(`/admin/vehicles/${v.id}`);
    } catch (err) {
      const blocked = /\b(403|401|429|503)\b/.test(errMsg(err));
      m.innerHTML = blocked
        ? '<div class="notice warn">That website blocks automatic imports. Use the one-click <strong>Send to Vehicle Portfolios</strong> button below instead. It takes 10 seconds to set up.</div>'
        : `<div class="notice bad">${esc(errMsg(err))}</div>`;
      if (blocked) $('#bm-help', main).open = true;
    } finally { busy(e.target, false); }
  });

  $('#f-vin', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#m-vin', main);
    const raw = $('#vin', main).value.trim();
    if (/^https?:\/\//i.test(raw) || /\.(com|net|org)\b/i.test(raw)) {
      $('#url', main).value = raw.replace(/^HTTPS?:\/\//, (x) => x.toLowerCase());
      $('#vin', main).value = '';
      m.innerHTML = '<div class="notice warn">That\'s a web address, so I moved it to the import box above.</div>';
      $('#f-import', main).requestSubmit();
      return;
    }
    const vin = raw.toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) { m.innerHTML = '<div class="notice bad">A VIN is 17 letters and numbers (no I, O or Q).</div>'; return; }
    busy(e.target, true);
    try {
      const dup = await existing(vin);
      if (dup) { toast('That VIN is already in your vehicles'); navigate(`/admin/vehicles/${dup.id}`); return; }
      let decoded = { vin };
      try { decoded = await api(`/api/vin/${encodeURIComponent(vin)}`); }
      catch (err) {
        if (!confirm(`${errMsg(err)}\n\nCreate the vehicle anyway and fill in the details yourself?`)) return;
      }
      const v = await create({ ...decoded, vin });
      navigate(`/admin/vehicles/${v.id}`);
    } catch (err) {
      m.innerHTML = `<div class="notice bad">${esc(errMsg(err))}</div>`;
    } finally { busy(e.target, false); }
  });

  // Bookmarklet: drag-to-install link + incoming vehicle from the dealer site
  const bm = $('#bm', main);
  bm.setAttribute('href', bookmarkletHref(location.origin));
  bm.addEventListener('click', (e) => { e.preventDefault(); toast('Drag this button to your bookmarks bar'); });
  const incoming = decodeImport(location.hash);
  if (incoming) {
    history.replaceState({}, '', location.pathname);
    const title = [incoming.year, incoming.make, incoming.model, incoming.trim].filter(Boolean).join(' ') || incoming.name || 'Vehicle';
    mount($('#incoming', main), html`<div class="notice ok" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <span><strong>${title}</strong>${incoming.vin ? ` · VIN ${incoming.vin}` : ''} · ${(incoming.photos || []).length} photos from ${new URL(incoming.listing_url).host}</span>
      <button class="btn sm" id="save-incoming">Save vehicle</button></div>`);
    $('#save-incoming', main).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const dup = await existing(incoming.vin);
        if (dup) { toast('That VIN is already in your vehicles'); navigate(`/admin/vehicles/${dup.id}`); return; }
        const v = await create(incoming, incoming.photos || [], 'import');
        toast(`Imported with ${(incoming.photos || []).length} photos`);
        navigate(`/admin/vehicles/${v.id}`);
      } catch (err) { toast(errMsg(err), 'bad'); e.target.disabled = false; }
    });
  }

  $('#blank', main).addEventListener('click', async () => {
    try { const v = await create({}); navigate(`/admin/vehicles/${v.id}`); }
    catch (err) { toast(errMsg(err), 'bad'); }
  });
}
