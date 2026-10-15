// Dealership usage vs. included allowance (dealer admins). Provider costs/margin are not shown here.
import { sb, html, mount, must, $, errMsg, dateTime } from '../core.js';
import { adminPage } from './layout.js';

export const PURPOSE = {
  portfolio_share: 'Portfolio link', conversation: 'Conversation', lead_alert: 'Lead alert to staff', open_alert: 'Open alert to staff',
  reply_alert: 'Reply alert to staff', lead_notification: 'Lead email', crm_adf: 'Elead (ADF)', help_reply: 'HELP reply', system: 'System',
};

export function monthOptions(n = 12) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push({ value: d.toISOString().slice(0, 7) + '-01', label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export function meter(label, used, included, unit) {
  const pct = included ? Math.min(100, (100 * used) / included) : 0;
  const over = included && used > included;
  return html`<div class="kpi"><div class="l">${label}</div>
    <div class="n">${used.toLocaleString()} <span class="small sub">of ${included ? included.toLocaleString() : '—'} ${unit}</span></div>
    <div class="meter ${over ? 'over' : ''}" role="meter" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
    <div class="small sub">${over ? `${(used - included).toLocaleString()} over the allowance` : `${Math.round(pct)}% used`}</div></div>`;
}

export default async function usage(el) {
  const page = await adminPage(el, 'usage', { adminOnly: true });
  if (!page) return;
  const { ctx, main } = page;
  const months = monthOptions();
  mount(main, html`<div class="page-head"><h1>Messaging usage</h1>
    <select id="month" style="width:auto" aria-label="Month">${months.map((m) => html`<option value="${m.value}">${m.label}</option>`)}</select></div>
    <div id="body"></div>`);

  async function load(month) {
    const box = $('#body', main);
    box.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const u = must(await sb.rpc('vp_usage_summary', { p_dealership_id: ctx.dealership.id, p_month: month }));
      const start = new Date(month + 'T00:00:00');
      const end = new Date(start); end.setMonth(end.getMonth() + 1);
      const log = must(await sb.from('messages').select('created_at,channel,direction,audience,purpose,to_address,from_address,status,segments,error_message')
        .eq('dealership_id', ctx.dealership.id).gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
        .order('created_at', { ascending: false }).limit(200));
      mount(box, html`
        <div class="kpis">
          ${meter('Text segments', u.sms_segments_total, u.included_sms_segments, 'included')}
          ${meter('Emails', u.emails_sent, u.included_emails, 'included')}
        </div>
        <div class="card"><h2>This month</h2>
          <table class="specs">
            <tr><td>Texts to customers</td><td>${u.sms_segments_customer_out} segments</td></tr>
            <tr><td>Replies from customers</td><td>${u.sms_segments_in} segments (${u.texts_received} texts)</td></tr>
            <tr><td>Alerts to your staff</td><td>${u.sms_segments_staff_alerts} segments</td></tr>
            <tr><td>Texts not delivered</td><td>${u.texts_failed}</td></tr>
            <tr><td>Emails sent / bounced</td><td>${u.emails_sent} / ${u.emails_bounced}</td></tr>
            <tr><td>Plan</td><td>$${Number(u.monthly_fee).toLocaleString()}/month includes ${Number(u.included_sms_segments).toLocaleString()} text segments and ${Number(u.included_emails).toLocaleString()} emails</td></tr>
            <tr><td>Overage this month</td><td><strong>$${Number(u.overage_amount).toFixed(2)}</strong>${u.sms_overage_segments ? ` (${u.sms_overage_segments} extra segments at $${u.overage_sms_rate})` : ''}</td></tr>
          </table>
          <p class="hint">A text segment is up to 160 characters (70 with emoji). Longer texts use more segments. Incoming replies count too.
          ${u.allow_overage === false ? ' Texting pauses when the allowance is used up.' : ''}</p>
        </div>
        <div class="card"><h2>Message log</h2>
          ${log.length ? html`<div class="table-wrap" style="box-shadow:none"><table class="data"><thead><tr><th>When</th><th>Type</th><th>To / from</th><th>Status</th><th class="num">Segments</th></tr></thead><tbody>
            ${log.map((m) => html`<tr><td class="nowrap">${dateTime(m.created_at)}</td>
              <td>${m.channel === 'email' ? 'Email' : 'Text'} ${m.direction === 'inbound' ? 'in' : 'out'} · ${PURPOSE[m.purpose] || m.purpose}</td>
              <td>${m.direction === 'inbound' ? m.from_address : m.to_address}</td>
              <td>${m.status}${m.error_message ? html`<br><span class="small sub">${m.error_message}</span>` : ''}</td>
              <td class="num">${m.channel === 'email' ? '' : m.segments}</td></tr>`)}
          </tbody></table></div>` : html`<p class="sub">No messages this month.</p>`}
        </div>`);
    } catch (e) { mount(box, html`<div class="notice bad">${errMsg(e)}</div>`); }
  }
  $('#month', main).addEventListener('change', (e) => load(e.target.value));
  load(months[0].value);
}
