// Printable factory equipment sheet (US Letter), built from the VIN decoder's data for the vehicle's trim.
// It is honest about what that data is: standard equipment for the trim, not this car's installed options,
// and not the manufacturer's window sticker. No prices (the decoder's are inconsistent and include invoice),
// no dimensions (the decoder contradicts itself on them).
import { sb, html, mount, must, vTitle, conditionLabel, errMsg } from '../core.js';
import { adminPage } from './layout.js';

export default async function factorySheet(el, { id }) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;
  const d = ctx.dealership;
  let v, fd;
  try {
    v = must(await sb.from('vehicles').select('*').eq('id', id).eq('dealership_id', d.id).single());
    fd = must(await sb.from('vehicle_factory_data').select('vin,data,fetched_at').eq('vehicle_id', v.id).maybeSingle());
  } catch (e) {
    mount(main, html`<div class="card">${errMsg(e)} <a href="/admin/vehicles/${id}">Back</a></div>`);
    return;
  }
  if (!fd) {
    mount(main, html`<div class="card"><h2>No factory data yet</h2><p>Get factory data on the vehicle's Window sticker tab first.</p>
      <a class="btn" href="/admin/vehicles/${v.id}#sticker">Back to vehicle</a></div>`);
    return;
  }
  const x = fd.data.vehicle || {};
  const facts = [['Engine', x.engine], ['Transmission', x.transmission], ['Drivetrain', x.drivetrain],
    ['Fuel economy', x.mpg_city && x.mpg_hwy ? `${x.mpg_city} city / ${x.mpg_hwy} hwy MPG` : null],
    ['EV range', x.ev_range_miles ? `${x.ev_range_miles} miles` : null], ['Fuel', x.fuel_type], ['Seating', x.seating ? `${x.seating} passengers` : null],
    ['Fuel tank', x.fuel_capacity], ['Built in', x.made_in]].filter(([, y]) => y);
  const groups = [...(fd.data.features || [])];
  if ((fd.data.chassis || []).length) groups.push({ group: 'Chassis', items: fd.data.chassis.map((c) => `${c.name}: ${c.value}`) });
  const optional = fd.data.optional || [];
  const vinMismatch = fd.vin !== v.vin;
  const name = vTitle({ year: v.year || x.year, make: v.make || x.make, model: v.model || x.model, trim: v.trim || x.trim });

  mount(main, html`
    <div class="page-head no-print"><a href="/admin/vehicles/${v.id}#sticker">← Back to vehicle</a>
      <span class="btn-row"><a class="btn alt" href="/admin/vehicles/${v.id}/sticker">Dealer window sticker</a><button class="btn" onclick="window.print()" ${vinMismatch ? 'disabled' : ''}>Print</button></span></div>
    ${vinMismatch ? html`<div class="notice bad no-print">This factory data is for VIN ${fd.vin}, but the vehicle's VIN is now ${v.vin}. Look it up again on the Window sticker tab before printing.</div>` : ''}
    <p class="small sub no-print">Print on US Letter, portrait, at 100%.</p>
    <article class="fs">
      <header class="fs-head">
        <div><div class="fs-kicker">Factory equipment · ${conditionLabel(v.condition)}</div><h1>${name}</h1>
          <div>${[x.style, v.vin ? `VIN ${v.vin}` : null, v.stock_number ? `Stock ${v.stock_number}` : null].filter(Boolean).join('  ·  ')}</div></div>
        ${d.logo_url ? html`<img src="${d.logo_url}" alt="${d.name}">` : html`<strong>${d.name}</strong>`}
      </header>
      <p class="fs-note">Built from VIN data (VinAudit) for this model and trim. It lists the equipment this trim comes with as standard${optional.length ? ', plus options listed for this VIN' : '; options and packages added to this particular vehicle are not included'}. Equipment can vary by build, so confirm features on the vehicle. This is not the manufacturer's window sticker.</p>
      <div class="fs-facts">${facts.map(([k, y]) => html`<div><b>${k}</b>${y}</div>`)}</div>
      ${optional.length ? html`<div class="fs-group"><h2>Options listed for this vehicle</h2><ul>${optional.map((o) => html`<li>${o.name}</li>`)}</ul></div>` : ''}
      <div class="fs-groups">${groups.map((g) => html`<section class="fs-group"><h2>${g.group}</h2><ul>${g.items.map((it) => html`<li>${it}</li>`)}</ul></section>`)}</div>
      <footer class="fs-foot">${d.name}${d.phone ? ` · ${d.phone}` : ''}. Specifications from VIN data provided by VinAudit; not a guarantee of equipment on this vehicle.</footer>
    </article>`);
}
