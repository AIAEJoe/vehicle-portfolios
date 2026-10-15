// Add a vehicle: import from a listing URL, decode a VIN, or start blank.
import { sb, html, mount, must, api, $, errMsg, esc, toast } from '../core.js';
import { adminPage } from './layout.js';
import { navigate } from '../router.js';

const FIELDS = ['vin', 'stock_number', 'condition', 'year', 'make', 'model', 'trim', 'body_style', 'exterior_color',
  'interior_color', 'engine', 'transmission', 'drivetrain', 'fuel_type', 'mileage', 'price', 'description', 'listing_url'];

export default async function vehicleNew(el) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;

  mount(main, html`<div class="page-head"><h1>Add a vehicle</h1><a class="btn ghost" href="/admin/vehicles">Cancel</a></div>
    <div class="card"><h2>Import from your website</h2>
      <p class="sub">Paste the vehicle's page from ${ctx.dealership.website ? new URL(ctx.dealership.website).host : 'your website'}. We'll copy the details and photos.</p>
      <form id="f-import" class="copy-field">
        <input id="url" type="url" placeholder="https://www.newsmyrnachevy.com/inventory/..." required aria-label="Listing URL">
        <button class="btn">Import</button>
      </form><div id="m-import"></div></div>
    <div class="card"><h2>Start from a VIN</h2>
      <p class="sub">We'll decode year, make, model, engine and more from NHTSA.</p>
      <form id="f-vin" class="copy-field">
        <input id="vin" maxlength="17" placeholder="17-character VIN" required style="text-transform:uppercase" aria-label="VIN" autocapitalize="characters">
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
      m.innerHTML = `<div class="notice bad">${esc(errMsg(err))}</div>`;
    } finally { busy(e.target, false); }
  });

  $('#f-vin', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#m-vin', main);
    const vin = $('#vin', main).value.trim().toUpperCase();
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

  $('#blank', main).addEventListener('click', async () => {
    try { const v = await create({}); navigate(`/admin/vehicles/${v.id}`); }
    catch (err) { toast(errMsg(err), 'bad'); }
  });
}
