// Public showroom: all published vehicles for this dealership.
import { sb, html, mount, must, money, miles, vTitle, conditionLabel, loadDealership, loadingView, errMsg, $ } from '../core.js';
import { siteHeader, siteFooter } from './site.js';

export default async function home(el) {
  mount(el, loadingView());
  let d, vehicles;
  try {
    d = await loadDealership();
    vehicles = must(await sb.from('vehicles')
      .select('id,slug,year,make,model,trim,price,mileage,condition,exterior_color,stock_number,vehicle_photos(url,position)')
      .eq('dealership_id', d.id).eq('status', 'published')
      .order('updated_at', { ascending: false }).limit(500));
  } catch (e) {
    mount(el, html`<div class="loading">${errMsg(e)}</div>`);
    return;
  }
  document.title = `${d.name} | Vehicle Portfolios`;

  const card = (v) => {
    const photo = (v.vehicle_photos || []).sort((a, b) => a.position - b.position)[0];
    return html`<a class="inv-card" href="/v/${v.slug}" data-q="${[vTitle(v), v.stock_number, v.exterior_color].join(' ').toLowerCase()}">
      ${photo ? html`<img src="${photo.url}" alt="${vTitle(v)}" loading="lazy">` : html`<div class="noimg"></div>`}
      <div class="body">
        <div class="sub small">${conditionLabel(v.condition)}${v.stock_number ? ` · Stock ${v.stock_number}` : ''}</div>
        <h3>${vTitle(v)}</h3>
        <div class="sub small">${[v.exterior_color, v.mileage != null ? `${miles(v.mileage)} mi` : null].filter(Boolean).join(' · ')}</div>
        <div class="p">${v.price ? money(v.price) : 'Call for price'}</div>
      </div></a>`;
  };

  mount(el, html`${siteHeader(d)}
  <main class="site-main" style="max-width:1180px">
    <div class="page-head"><h1 style="margin:0">Our vehicles</h1>
      <input type="search" id="q" placeholder="Search make, model, stock #" style="max-width:320px" aria-label="Search vehicles"></div>
    ${vehicles.length ? html`<div class="inv-grid" id="grid">${vehicles.map(card)}</div>`
      : html`<div class="card">No vehicles are listed right now. Call us at ${d.phone || 'the dealership'}.</div>`}
  </main>${siteFooter(d)}`);

  const q = $('#q', el);
  q && q.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    el.querySelectorAll('.inv-card').forEach((c) => { c.style.display = !term || c.dataset.q.includes(term) ? '' : 'none'; });
  });
}
