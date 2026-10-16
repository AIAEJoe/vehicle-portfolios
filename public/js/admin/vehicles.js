import { sb, html, mount, must, money, miles, vTitle, timeAgo, $, errMsg } from '../core.js';
import { adminPage, STATUS_LABEL } from './layout.js';
import { resolveGuide, needsBuyersGuide } from '../buyers-guide.js';

export default async function vehicles(el) {
  const page = await adminPage(el, 'vehicles');
  if (!page) return;
  const { ctx, main } = page;
  const params = new URLSearchParams(location.search);
  let status = params.get('status') || 'active';

  mount(main, html`<div class="page-head"><h1>Vehicles</h1>
      <a class="btn" href="/admin/vehicles/new">+ Add vehicle</a></div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search stock #, VIN, make, model" aria-label="Search">
      <select id="status" aria-label="Status">
        <option value="active">Live + drafts</option><option value="published">Live</option>
        <option value="draft">Drafts</option><option value="sold">Sold</option><option value="all">All</option>
      </select>
    </div>
    <div id="list"></div>`);
  $('#status', main).value = status;

  let rows = [];
  let stats = {};
  async function load() {
    $('#list', main).innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      let q = sb.from('vehicles')
        .select('id,slug,status,condition,bg_warranty,year,make,model,trim,stock_number,vin,price,mileage,source,updated_at,salesperson:staff!salesperson_id(full_name),vehicle_photos(url,position)')
        .eq('dealership_id', ctx.dealership.id).order('updated_at', { ascending: false }).limit(1000);
      if (status === 'active') q = q.in('status', ['published', 'draft']);
      else if (status !== 'all') q = q.eq('status', status);
      rows = must(await q);
      const s = must(await sb.from('vehicle_stats').select('*').eq('dealership_id', ctx.dealership.id));
      stats = Object.fromEntries(s.map((x) => [x.vehicle_id, x]));
      draw();
    } catch (e) {
      $('#list', main).innerHTML = String(html`<div class="notice bad">${errMsg(e)}</div>`);
    }
  }

  function draw() {
    const term = $('#q', main).value.trim().toLowerCase();
    const list = rows.filter((v) => !term || [vTitle(v), v.stock_number, v.vin].join(' ').toLowerCase().includes(term));
    if (!list.length) {
      mount($('#list', main), html`<div class="card" style="text-align:center">
        ${rows.length ? 'No vehicles match your search.' : html`<p>No vehicles yet.</p><a class="btn" href="/admin/vehicles/new">Add your first vehicle</a>`}</div>`);
      return;
    }
    mount($('#list', main), html`<div class="small sub" style="margin-bottom:8px">${list.length} vehicle${list.length === 1 ? '' : 's'}</div>
      <div class="vlist">${list.map((v) => {
        const p = (v.vehicle_photos || []).sort((a, b) => a.position - b.position)[0];
        const st = stats[v.id] || {};
        return html`<a class="vrow" href="/admin/vehicles/${v.id}">
          ${p ? html`<img src="${p.url}" alt="" loading="lazy">` : html`<div class="noimg"></div>`}
          <div>
            <h3>${vTitle(v) || 'Untitled vehicle'}</h3>
            <div class="meta"><span class="pill ${v.status}">${STATUS_LABEL[v.status]}</span>
              ${v.stock_number ? ` Stock ${v.stock_number}` : ''}${v.price ? ` · ${money(v.price)}` : ''}${v.mileage != null ? ` · ${miles(v.mileage)} mi` : ''}
              ${v.salesperson ? ` · ${v.salesperson.full_name}` : ''}${v.source === 'feed' ? ' · feed' : ''}
              ${needsBuyersGuide(v) && resolveGuide(v, ctx.dealership).pending ? html` <span class="pill contacted" title="No warranty terms entered. Customers see the As Is Buyers Guide.">Warranty data pending</span>` : ''}</div>
          </div>
          <div class="stats"><strong>${st.views || 0}</strong> ${st.views === 1 ? 'open' : 'opens'} · <strong>${st.leads || 0}</strong> ${st.leads === 1 ? 'lead' : 'leads'}
            <br>${st.last_viewed_at ? `Last opened ${timeAgo(st.last_viewed_at)}` : `Updated ${timeAgo(v.updated_at)}`}</div>
        </a>`;
      })}</div>`);
  }

  $('#q', main).addEventListener('input', draw);
  $('#status', main).addEventListener('change', (e) => {
    status = e.target.value;
    history.replaceState({}, '', `/admin/vehicles${status === 'active' ? '' : `?status=${status}`}`);
    load();
  });
  load();
}
