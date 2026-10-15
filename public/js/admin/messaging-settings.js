// Sender identity settings shared by the dealership Settings page and the platform console:
// registration details for 10DLC, consent wording, email sender/reply-to and sending domain.
import { sb, html, mount, must, api, $, errMsg, toast } from '../core.js';

export const A2P_LABEL = {
  not_started: 'Not started', in_progress: 'Registering', brand_pending: 'Brand under review', brand_approved: 'Brand approved',
  campaign_pending: 'Campaign under review', approved: 'Approved', action_needed: 'Action needed', suspended: 'Suspended',
};

const BIZ_FIELDS = [
  ['legal_name', 'Legal business name (exactly as on IRS records)'], ['ein', 'EIN'], ['business_type', 'Business type'],
  ['website_url', 'Website'], ['street', 'Street'], ['city', 'City'], ['region', 'State (2 letters)'], ['postal_code', 'ZIP'],
  ['rep_first_name', 'Authorized rep first name'], ['rep_last_name', 'Last name'], ['rep_title', 'Title'], ['rep_email', 'Email'], ['rep_phone', 'Phone'],
];

export async function renderMessagingSettings(box, { dealership, onChange }) {
  const D = dealership.id;
  let p;
  async function load() { p = must(await sb.from('messaging_profiles').select('*').eq('dealership_id', D).single()); }
  try { await load(); } catch (e) { mount(box, html`<div class="notice bad">${errMsg(e)}</div>`); return; }

  function draw() {
    const domainRecords = Array.isArray(p.email_dns_records) ? p.email_dns_records : [];
    mount(box, html`
    <div class="card"><h2>Texting</h2>
      <table class="specs">
        <tr><td>Dealership number</td><td><strong>${p.twilio_phone_number || 'Not assigned yet'}</strong></td></tr>
        <tr><td>10DLC registration</td><td><span class="pill ${p.a2p_status === 'approved' ? 'published' : p.a2p_status === 'action_needed' ? 'sold' : 'draft'}">${A2P_LABEL[p.a2p_status] || p.a2p_status}</span>
          ${p.a2p_last_error ? html`<div class="small" style="color:var(--bad)">${p.a2p_last_error}</div>` : ''}</td></tr>
        <tr><td>Texting customers</td><td>${p.sms_enabled ? '✅ On' : 'Off until registration is approved'}</td></tr>
      </table>
    </div>

    <form class="card" id="biz"><h2>Business details for carrier registration</h2>
      <p class="sub small" style="margin-top:0">US carriers require every business that texts customers to register (10DLC). These details must match IRS records exactly.</p>
      <div class="grid2 stack-sm">${BIZ_FIELDS.map(([k, label]) => html`<div><label for="b-${k}">${label}</label>
        ${k === 'business_type' ? html`<select id="b-${k}" name="${k}">${['Corporation', 'Limited Liability Corporation', 'Partnership', 'Sole Proprietorship', 'Non-profit Corporation'].map((t) => html`<option ${p[k] === t ? 'selected' : ''}>${t}</option>`)}</select>`
          : html`<input id="b-${k}" name="${k}" value="${p[k] || ''}">`}</div>`)}
        <div><label for="b-company_type">Company type</label><select id="b-company_type" name="company_type">${['private', 'public', 'non-profit', 'government'].map((t) => html`<option ${p.company_type === t ? 'selected' : ''}>${t}</option>`)}</select></div>
      </div>
      <label for="b-campaign_description">What you text customers about</label>
      <textarea id="b-campaign_description" name="campaign_description" rows="3">${p.campaign_description || ''}</textarea>
      <label for="b-message_flow">How customers agree to receive texts</label>
      <textarea id="b-message_flow" name="message_flow" rows="4">${p.message_flow || ''}</textarea>
      <label for="b-samples">Sample messages (one per line, at least two)</label>
      <textarea id="b-samples" name="sample_messages" rows="4">${(p.sample_messages || []).join('\n')}</textarea>
      <label for="b-consent">Consent wording shown on the test-drive form</label>
      <textarea id="b-consent" name="consent_language" rows="3" placeholder="By checking this box, I agree to receive text messages from…">${p.consent_language || ''}</textarea>
      <label for="b-help">HELP reply</label>
      <input id="b-help" name="help_message" value="${p.help_message || ''}" placeholder="${dealership.name}: for help call ${dealership.phone || ''}. Msg & data rates may apply. Reply STOP to opt out.">
      <div class="btn-row" style="margin-top:12px"><button class="btn">Save registration details</button>
        <button type="button" class="btn ghost" id="fill">Fill in suggested wording</button></div>
    </form>

    <form class="card" id="mail"><h2>Email sender</h2>
      <div class="grid2 stack-sm">
        <div><label for="m-name">From name</label><input id="m-name" name="email_from_name" value="${p.email_from_name || dealership.name}"></div>
        <div><label for="m-local">From address (before the @)</label><input id="m-local" name="email_from_local" value="${p.email_from_local || 'sales'}"></div>
        <div><label for="m-reply">Customer replies go to</label><input id="m-reply" name="email_reply_to" type="email" value="${p.email_reply_to || ''}" placeholder="sales@yourdealership.com">
          <div class="hint">Used when a reply can't be routed to the salesperson.</div></div>
      </div>
      <p class="small sub">Currently sending as <strong>${p.email_domain_status === 'verified' ? `${p.email_from_name || dealership.name} <${p.email_from_local || 'sales'}@${p.email_domain}>` : `${p.email_from_name || dealership.name} via Vehicle Portfolios`}</strong></p>
      <button class="btn">Save email sender</button>
    </form>

    <div class="card"><h2>Your sending domain</h2>
      <p class="sub small" style="margin-top:0">Send from your own domain (for example <code>mail.yourdealership.com</code>) so customers see your name and replies land with you. Add the DNS records below at your domain host, then press Verify.</p>
      ${p.email_domain ? html`<p><strong>${p.email_domain}</strong> <span class="pill ${p.email_domain_status === 'verified' ? 'published' : p.email_domain_status === 'failed' ? 'sold' : 'draft'}">${p.email_domain_status}</span></p>
        ${domainRecords.length && p.email_domain_status !== 'verified' ? html`<div class="table-wrap" style="box-shadow:none"><table class="data"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th></tr></thead><tbody>
          ${domainRecords.map((r) => html`<tr><td>${r.type}</td><td><code>${r.name}</code></td><td style="word-break:break-all"><code>${r.value}</code></td><td>${r.priority ?? ''}</td></tr>`)}</tbody></table></div>` : ''}
        <div class="btn-row" style="margin-top:10px"><button class="btn alt" id="verify">Verify</button><button class="btn danger" id="remove">Remove</button></div>`
        : html`<form id="domform" class="copy-field"><input name="domain" placeholder="mail.yourdealership.com" aria-label="Domain" required><button class="btn alt">Add domain</button></form>`}
    </div>`);

    $('#biz', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const patch = {};
      for (const [k] of BIZ_FIELDS) patch[k] = String(fd.get(k) ?? '').trim() || null;
      for (const k of ['company_type', 'campaign_description', 'message_flow', 'consent_language', 'help_message']) patch[k] = String(fd.get(k) ?? '').trim() || null;
      patch.sample_messages = String(fd.get('sample_messages') || '').split('\n').map((x) => x.trim()).filter(Boolean);
      try { p = must(await sb.from('messaging_profiles').update(patch).eq('dealership_id', D).select().single()); toast('Saved'); draw(); onChange && onChange(p); }
      catch (err) { toast(errMsg(err), 'bad'); }
    });
    $('#fill', box).addEventListener('click', () => {
      const f = $('#biz', box);
      const origin = location.origin;
      const name = dealership.name;
      if (!f.campaign_description.value) f.campaign_description.value = `${name} sends one-to-one text messages to customers who asked about a vehicle: links to the vehicle's photos and details, test-drive confirmations, and replies to their questions from their salesperson.`;
      if (!f.message_flow.value) f.message_flow.value = `Customers opt in on ${name}'s vehicle pages (${origin}/v/...) by checking an unchecked SMS consent box on the test-drive form, which shows the consent language and links to ${origin}/sms-terms, or by texting the dealership's number first. Salespeople may also text customers who give verbal consent in person or by phone; the salesperson records that consent in the dashboard before the first text, with date, time and wording.`;
      if (!f.sample_messages.value) f.sample_messages.value = `Hi Mike, it's Kyleigh at ${name}. Here are the photos, details and history for the 2018 Jeep Wrangler Sport S: ${origin}/v/2018-jeep-wrangler?s=Ab3dEf7h Reply STOP to opt out.\nHi Mike, your test drive of the 2018 Jeep Wrangler is confirmed for Saturday at 10am. See you at ${name}! Reply STOP to opt out.`;
      if (!f.consent_language.value) f.consent_language.value = `By checking this box, I agree to receive text messages from ${name} about my vehicle inquiry at the number provided. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.`;
      if (!f.help_message.value) f.help_message.value = `${name}: for help call ${dealership.phone || 'the dealership'}. Msg & data rates may apply. Reply STOP to opt out.`;
      toast('Suggested wording added. Review it, then save.');
    });
    $('#mail', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const local = String(fd.get('email_from_local') || 'sales').trim().toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(local)) { toast('The from address can only use letters, numbers, dots and dashes', 'bad'); return; }
      try {
        p = must(await sb.from('messaging_profiles').update({ email_from_name: String(fd.get('email_from_name')).trim() || null, email_from_local: local,
          email_reply_to: String(fd.get('email_reply_to') || '').trim() || null }).eq('dealership_id', D).select().single());
        toast('Saved'); draw();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
    const domAction = async (action, extra = {}) => {
      try {
        const r = await api('/api/platform/email-domain', { method: 'POST', auth: true, body: { dealership_id: D, action, ...extra } });
        p = r.profile; draw();
        toast(action === 'verify' ? (p.email_domain_status === 'verified' ? 'Domain verified' : 'Not verified yet. DNS changes can take up to a few hours.') : 'Saved');
      } catch (err) { toast(errMsg(err), 'bad'); }
    };
    const df = $('#domform', box);
    df && df.addEventListener('submit', (e) => { e.preventDefault(); domAction('create', { domain: e.target.domain.value }); });
    const v = $('#verify', box); v && v.addEventListener('click', () => domAction('verify'));
    const rm = $('#remove', box); rm && rm.addEventListener('click', () => confirm('Stop sending from this domain?') && domAction('remove'));
  }
  draw();
  return { reload: async () => { await load(); draw(); } };
}
