import { sb, html, mount, must, $, errMsg } from '../core.js';
import { platformPage, usd } from './layout.js';
import { monthOptions } from '../admin/usage.js';
import { A2P_LABEL } from '../admin/messaging-settings.js';

export default async function overview(el) {
  const page = await platformPage(el, 'overview');
  if (!page) return;
  const { main } = page;
  const months = monthOptions();
  mount(main, html`<div class="page-head"><h1>Dealerships</h1>
    <div class="btn-row"><select id="month" style="width:auto" aria-label="Month">${months.map((m) => html`<option value="${m.value}">${m.label}</option>`)}</select>
    <a class="btn" href="/platform/dealerships/new">+ New dealership</a></div></div><div id="body"></div>`);

  async function load(month) {
    const box = $('#body', main);
    try {
      const rows = must(await sb.rpc('vp_platform_overview', { p_month: month }));
      const t = rows.reduce((a, r) => ({ fee: a.fee + Number(r.usage.invoice_total || 0), cost: a.cost + Number(r.usage.cost_total || 0), margin: a.margin + Number(r.usage.margin || 0), seg: a.seg + r.usage.sms_segments_total }), { fee: 0, cost: 0, margin: 0, seg: 0 });
      mount(box, html`
        <div class="kpis">
          <div class="kpi"><div class="n">${rows.filter((r) => r.billing_status === 'active').length}</div><div class="l">Active dealerships</div></div>
          <div class="kpi"><div class="n">${usd(t.fee, 0)}</div><div class="l">Billed this month</div></div>
          <div class="kpi"><div class="n">${usd(t.cost)}</div><div class="l">Messaging cost (Twilio + email + fees)</div></div>
          <div class="kpi"><div class="n">${usd(t.margin, 0)}</div><div class="l">Margin</div></div>
          <div class="kpi"><div class="n">${t.seg.toLocaleString()}</div><div class="l">Text segments</div></div>
        </div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Dealership</th><th>Texting</th><th>Email domain</th>
          <th class="num">Segments / included</th><th class="num">Emails</th><th class="num">Messaging cost</th><th class="num">Invoice</th><th class="num">Margin</th></tr></thead><tbody>
          ${rows.map((r) => { const u = r.usage; const over = u.sms_segments_total > u.included_sms_segments; return html`<tr>
            <td><a href="/platform/dealerships/${r.id}"><strong>${r.name}</strong></a><br><span class="small sub">${r.slug} · ${r.billing_status}</span></td>
            <td><span class="pill ${r.sms_enabled ? 'published' : r.a2p_status === 'action_needed' ? 'sold' : 'draft'}">${A2P_LABEL[r.a2p_status] || r.a2p_status}</span><br><span class="small sub">${r.phone || 'no number'}</span></td>
            <td>${r.email_domain ? html`${r.email_domain}<br><span class="small sub">${r.email_domain_status}</span>` : html`<span class="sub">platform domain</span>`}</td>
            <td class="num" style="${over ? 'color:var(--bad);font-weight:700' : ''}">${u.sms_segments_total.toLocaleString()} / ${Number(u.included_sms_segments).toLocaleString()}</td>
            <td class="num">${u.emails_sent.toLocaleString()}</td>
            <td class="num">${usd(u.cost_total)}${u.cost_unreconciled_messages ? html`<br><span class="small sub">${u.cost_unreconciled_messages} est.</span>` : ''}</td>
            <td class="num">${usd(u.invoice_total)}${Number(u.overage_amount) ? html`<br><span class="small sub">incl. ${usd(u.overage_amount)} overage</span>` : ''}</td>
            <td class="num">${usd(u.margin)}</td></tr>`; })}
        </tbody></table></div>
        <p class="hint">Messaging cost = Twilio per-segment price (actual when reconciled, estimated until then) + estimated carrier fees + email + phone number and 10DLC fees booked this month.</p>`);
    } catch (e) { mount(box, html`<div class="notice bad">${errMsg(e)}</div>`); }
  }
  $('#month', main).addEventListener('change', (e) => load(e.target.value));
  load(months[0].value);
}
