import { sb, html, mount, must, $, on, errMsg, toast, vTitle, timeAgo, telHref, smsHref, dateTime } from '../core.js';
import { adminPage } from './layout.js';

export default async function leads(el) {
  const page = await adminPage(el, 'leads');
  if (!page) return;
  const { ctx, main } = page;
  let filter = 'open';
  let rows = [];

  mount(main, html`<div class="page-head"><h1>Leads</h1>
    <select id="flt" style="width:auto" aria-label="Filter">
      <option value="open">New + contacted</option><option value="new">New</option><option value="contacted">Contacted</option>
      <option value="closed">Closed</option><option value="all">All</option></select></div>
    <div id="list"></div>`);

  async function load() {
    try {
      let q = sb.from('leads').select('*, vehicle:vehicles(id,slug,year,make,model,trim,stock_number), staff(full_name)')
        .eq('dealership_id', ctx.dealership.id).order('created_at', { ascending: false }).limit(500);
      if (filter === 'open') q = q.in('status', ['new', 'contacted']);
      else if (filter !== 'all') q = q.eq('status', filter);
      rows = must(await q);
      draw();
    } catch (e) { mount($('#list', main), html`<div class="notice bad">${errMsg(e)}</div>`); }
  }

  function draw() {
    if (!rows.length) { mount($('#list', main), html`<div class="card sub" style="text-align:center">No leads here yet. Test-drive requests from portfolios show up here.</div>`); return; }
    mount($('#list', main), html`${rows.map((l) => html`<div class="lead">
      <div>
        <h3>${l.name} <span class="pill ${l.status}">${l.status}</span></h3>
        <div class="small sub">${l.kind === 'test_drive' ? 'Test drive request' : 'Question'} · ${dateTime(l.created_at)} (${timeAgo(l.created_at)})
          ${l.staff ? ` · for ${l.staff.full_name}` : ''}</div>
        ${l.vehicle ? html`<div style="margin-top:4px"><a href="/admin/vehicles/${l.vehicle.id}">${vTitle(l.vehicle)}</a>${l.vehicle.stock_number ? html` <span class="sub small">Stock ${l.vehicle.stock_number}</span>` : ''}</div>` : ''}
        ${l.preferred_date ? html`<div class="small">Wants: <strong>${new Date(l.preferred_date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}${l.preferred_time ? `, ${l.preferred_time}` : ''}</strong></div>` : ''}
        ${l.message ? html`<p style="margin:6px 0 0">“${l.message}”</p>` : ''}
        <div class="contact" style="margin-top:8px">
          ${l.phone ? html`<a href="${telHref(l.phone)}">Call ${l.phone}</a><a href="${smsHref(l.phone)}">Text</a>` : ''}
          ${l.email ? html`<a href="mailto:${l.email}">${l.email}</a>` : ''}
        </div>
        <div class="small sub" style="margin-top:6px">${l.crm_sent_at ? 'Sent to CRM ✓' : ''}${l.crm_sent_at && l.email_sent_at ? ' · ' : ''}${l.email_sent_at ? 'Emailed ✓' : ''}</div>
      </div>
      <div><label class="sr-only" for="st-${l.id}">Status</label>
        <select id="st-${l.id}" data-lead="${l.id}" style="width:auto">
          ${['new', 'contacted', 'closed'].map((s) => html`<option value="${s}" ${l.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`)}
        </select></div>
    </div>`)}`);
  }

  on(main, 'change', '[data-lead]', async (e, sel) => {
    try {
      must(await sb.from('leads').update({ status: sel.value }).eq('id', sel.dataset.lead));
      rows.find((r) => r.id === sel.dataset.lead).status = sel.value;
      toast('Lead updated');
      draw();
    } catch (err) { toast(errMsg(err), 'bad'); }
  });
  $('#flt', main).addEventListener('change', (e) => { filter = e.target.value; load(); });
  load();
}
