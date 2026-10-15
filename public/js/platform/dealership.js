// One dealership in the platform console: billing plan + costs, 10DLC onboarding, sender identity.
import { sb, html, mount, must, api, $, on, errMsg, toast, dateTime, config } from '../core.js';
import { platformPage, usd } from './layout.js';
import { monthOptions, meter } from '../admin/usage.js';
import { renderMessagingSettings, A2P_LABEL } from '../admin/messaging-settings.js';

const STEPS = [
  ['customer_profile', 'Secondary Customer Profile'], ['business_info', 'Business information'], ['assign_business_info', 'Attach business info'],
  ['authorized_rep', 'Authorized representative'], ['assign_authorized_rep', 'Attach representative'], ['address', 'Business address'],
  ['address_document', 'Address document'], ['assign_address_document', 'Attach address'], ['assign_primary_profile', 'Link to your Primary Profile'],
  ['evaluate_profile', 'Twilio check: profile'], ['submit_profile', 'Submit profile'], ['trust_product', 'A2P messaging profile'],
  ['messaging_profile_info', 'Company type'], ['assign_messaging_profile_info', 'Attach company type'], ['assign_customer_profile', 'Attach customer profile'],
  ['evaluate_trust_product', 'Twilio check: A2P profile'], ['submit_trust_product', 'Submit A2P profile'], ['brand', 'Register brand'],
  ['wait_brand', 'Brand review (TCR, usually 1–3 days)'], ['campaign', 'Register campaign'], ['wait_campaign', 'Campaign review (often 1–3 weeks)'], ['done', 'Approved'],
];
const TABS = [['billing', 'Plan & costs'], ['texting', 'Texting setup'], ['identity', 'Business & email identity']];

export default async function dealershipPage(el, { id }) {
  const page = await platformPage(el, 'overview');
  if (!page) return;
  const { main } = page;
  let d, b, p;
  async function load() {
    [d, b, p] = await Promise.all([
      sb.from('dealerships').select('*').eq('id', id).single().then(must),
      sb.from('dealership_billing').select('*').eq('dealership_id', id).single().then(must),
      sb.from('messaging_profiles').select('*').eq('dealership_id', id).single().then(must),
    ]);
  }
  try { await load(); } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); return; }
  let tab = (location.hash || '#billing').slice(1);
  const root = config.rootDomain || 'aiautoengine.com';

  function frame() {
    mount(main, html`<div class="page-head"><div><a class="small" href="/platform">← Dealerships</a><h1>${d.name}</h1>
        <div class="small sub">${d.slug}.${root} · ${b.status} · <span class="pill ${p.sms_enabled ? 'published' : 'draft'}">${A2P_LABEL[p.a2p_status]}</span></div></div>
        <a class="btn alt sm" href="https://${d.slug}.${root}/admin" target="_blank" data-external>Open dealer dashboard ↗</a></div>
      <div class="tabs">${TABS.map(([k, l]) => html`<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`)}</div>
      <div id="tab"></div>`);
    const box = $('#tab', main);
    if (tab === 'billing') billing(box);
    else if (tab === 'texting') texting(box);
    else renderMessagingSettings(box, { dealership: d, onChange: (np) => { p = np; } });
  }
  on(main, 'click', '[data-tab]', (e, btn) => { tab = btn.dataset.tab; history.replaceState({}, '', '#' + tab); frame(); });

  // ------------------------------------------------------------ plan & costs
  async function billing(box) {
    const months = monthOptions();
    mount(box, html`
      <form class="card" id="plan"><h2>Plan</h2>
        <div class="grid3">
          <div><label for="b-fee">Monthly subscription ($)</label><input id="b-fee" name="monthly_fee" type="number" step="0.01" value="${b.monthly_fee}"></div>
          <div><label for="b-sms">Included text segments</label><input id="b-sms" name="included_sms_segments" type="number" value="${b.included_sms_segments}"></div>
          <div><label for="b-em">Included emails</label><input id="b-em" name="included_emails" type="number" value="${b.included_emails}"></div>
          <div><label for="b-os">Overage per segment ($)</label><input id="b-os" name="overage_sms_rate" type="number" step="0.0001" value="${b.overage_sms_rate}"></div>
          <div><label for="b-oe">Overage per email ($)</label><input id="b-oe" name="overage_email_rate" type="number" step="0.0001" value="${b.overage_email_rate}"></div>
          <div><label for="b-st">Status</label><select id="b-st" name="status">${['trial', 'active', 'paused', 'cancelled'].map((s) => html`<option ${b.status === s ? 'selected' : ''}>${s}</option>`)}</select></div>
          <div><label for="b-be">Billing email</label><input id="b-be" name="billing_email" type="email" value="${b.billing_email || ''}"></div>
        </div>
        <label class="check"><input type="checkbox" name="allow_overage" ${b.allow_overage ? 'checked' : ''}> Keep texting past the allowance (bill overage). Unchecked = pause texting at the allowance.</label>
        <label class="check"><input type="checkbox" name="pass_through_fixed_fees" ${b.pass_through_fixed_fees ? 'checked' : ''}> Bill phone number and 10DLC fees on top of the subscription</label>
        <label for="b-notes">Notes</label><textarea id="b-notes" name="notes" rows="2">${b.notes || ''}</textarea>
        <button class="btn" style="margin-top:10px">Save plan</button>
      </form>
      <div class="card"><div class="page-head" style="margin:0 0 8px"><h2 style="margin:0">Usage &amp; cost</h2>
        <select id="month" style="width:auto" aria-label="Month">${months.map((m) => html`<option value="${m.value}">${m.label}</option>`)}</select></div>
        <div id="usage"></div></div>`);

    $('#plan', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const patch = {
        monthly_fee: Number(f.monthly_fee.value), included_sms_segments: parseInt(f.included_sms_segments.value, 10) || 0, included_emails: parseInt(f.included_emails.value, 10) || 0,
        overage_sms_rate: Number(f.overage_sms_rate.value), overage_email_rate: Number(f.overage_email_rate.value), status: f.status.value,
        billing_email: f.billing_email.value.trim() || null, allow_overage: f.allow_overage.checked, pass_through_fixed_fees: f.pass_through_fixed_fees.checked, notes: f.notes.value.trim() || null,
      };
      try { b = must(await sb.from('dealership_billing').update(patch).eq('dealership_id', id).select().single()); toast('Plan saved'); loadUsage($('#month', box).value); }
      catch (err) { toast(errMsg(err), 'bad'); }
    });

    async function loadUsage(month) {
      const ub = $('#usage', box);
      try {
        const [u, charges] = await Promise.all([
          sb.rpc('vp_usage_summary', { p_dealership_id: id, p_month: month }).then(must),
          sb.from('usage_charges').select('*').eq('dealership_id', id).eq('month', month).order('created_at').then(must),
        ]);
        mount(ub, html`<div class="kpis">${meter('Text segments', u.sms_segments_total, u.included_sms_segments, 'included')}${meter('Emails', u.emails_sent, u.included_emails, 'included')}</div>
          <table class="data"><tbody>
            <tr><td>Texts to customers</td><td class="num">${u.sms_segments_customer_out} seg</td></tr>
            <tr><td>Customer replies</td><td class="num">${u.sms_segments_in} seg</td></tr>
            <tr><td>Staff alerts</td><td class="num">${u.sms_segments_staff_alerts} seg</td></tr>
            <tr><td>SMS cost (Twilio + carrier fees)</td><td class="num">${usd(u.cost_sms, 4)}</td></tr>
            <tr><td>Email cost</td><td class="num">${usd(u.cost_email, 4)}</td></tr>
            <tr><td>Fixed provider fees this month</td><td class="num">${usd(u.cost_fixed)}</td></tr>
            <tr><td><strong>Total messaging cost</strong>${u.cost_unreconciled_messages ? html`<br><span class="small sub">${u.cost_unreconciled_messages} messages still estimated</span>` : ''}</td><td class="num"><strong>${usd(u.cost_total)}</strong></td></tr>
            <tr><td>Subscription</td><td class="num">${usd(u.monthly_fee)}</td></tr>
            <tr><td>Overage billed${u.pass_through_fixed_fees ? ' (incl. fixed fees)' : ''}</td><td class="num">${usd(u.overage_amount)}</td></tr>
            <tr><td><strong>Invoice</strong></td><td class="num"><strong>${usd(u.invoice_total)}</strong></td></tr>
            <tr><td><strong>Margin</strong></td><td class="num"><strong>${usd(u.margin)}</strong></td></tr>
          </tbody></table>
          <h3 style="font-size:16px;margin-top:18px">Provider charges</h3>
          ${charges.length ? html`<table class="data"><tbody>${charges.map((c) => html`<tr><td>${c.description}<br><span class="small sub">${c.kind}</span></td><td class="num">${usd(c.provider_cost)}</td></tr>`)}</tbody></table>` : html`<p class="sub small">None booked for this month.</p>`}
          <form id="adj" class="copy-field" style="margin-top:10px"><input name="description" placeholder="Adjustment, e.g. Twilio credit" required aria-label="Description">
            <input name="amount" type="number" step="0.01" placeholder="Amount" style="max-width:130px" required aria-label="Amount"><button class="btn alt sm">Add charge</button></form>`);
        $('#adj', ub).addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            must(await sb.from('usage_charges').insert({ dealership_id: id, month, kind: 'adjustment', ref: String(Date.now()), description: e.target.description.value, provider_cost: Number(e.target.amount.value) }));
            loadUsage(month);
          } catch (err) { toast(errMsg(err), 'bad'); }
        });
      } catch (err) { mount(ub, html`<div class="notice bad">${errMsg(err)}</div>`); }
    }
    $('#month', box).addEventListener('change', (e) => loadUsage(e.target.value));
    loadUsage(months[0].value);
  }

  // ------------------------------------------------------------ texting onboarding
  function texting(box) {
    const at = p.a2p_step === 'not_started' ? -1 : STEPS.findIndex(([k]) => k === p.a2p_step);
    const log = [...(p.a2p_log || [])].reverse();
    mount(box, html`
      <div class="card"><h2>10DLC onboarding</h2>
        <p class="sub small" style="margin-top:0">One Twilio subaccount per dealership, with its own Secondary Customer Profile, brand, campaign, Messaging Service and number. Fill in <a href="#identity" data-tab="identity">Business &amp; email identity</a> first.</p>
        <table class="specs">
          <tr><td>Subaccount</td><td>${p.twilio_subaccount_sid || '—'}</td></tr>
          <tr><td>Messaging Service</td><td>${p.twilio_messaging_service_sid || '—'}</td></tr>
          <tr><td>Phone number</td><td>${p.twilio_phone_number || '—'}</td></tr>
          <tr><td>Brand</td><td>${p.a2p_brand_sid || '—'} ${p.a2p_brand_status ? html`<span class="pill">${p.a2p_brand_status}</span>` : ''}</td></tr>
          <tr><td>Campaign</td><td>${p.a2p_campaign_sid || '—'} ${p.a2p_campaign_status ? html`<span class="pill">${p.a2p_campaign_status}</span>` : ''}</td></tr>
          <tr><td>Texting customers</td><td>${p.sms_enabled ? '✅ On' : 'Off'}</td></tr>
          ${p.a2p_last_checked_at ? html`<tr><td>Last checked</td><td>${dateTime(p.a2p_last_checked_at)}</td></tr>` : ''}
        </table>
        ${p.a2p_last_error ? html`<div class="notice bad">${p.a2p_last_error}</div>` : ''}
        <div class="btn-row" style="margin-top:12px">
          ${!p.twilio_subaccount_sid ? html`<button class="btn" data-act="provision">Create subaccount + Messaging Service</button>` : ''}
          ${p.a2p_step !== 'done' ? html`<button class="btn ${p.twilio_subaccount_sid ? '' : 'alt'}" data-act="run">${p.a2p_step === 'not_started' ? 'Start registration' : p.a2p_status === 'action_needed' ? 'Retry from failed step' : 'Continue registration'}</button>` : ''}
          ${['wait_brand', 'wait_campaign'].includes(p.a2p_step) ? html`<button class="btn alt" data-act="refresh">Check review status</button>` : ''}
        </div>
        <ol class="steps" style="margin-top:16px">${STEPS.map(([k, l], i) => html`<li class="${p.a2p_step === 'done' || i < at ? 'done' : i === at ? 'now' : 'todo'}">${l}</li>`)}</ol>
      </div>
      <div class="card"><h2>Phone number</h2>
        ${p.twilio_phone_number ? html`<p><strong>${p.twilio_phone_number}</strong> is attached to the Messaging Service. Texting turns on automatically when the campaign is approved.</p>`
          : html`<form id="buy" class="copy-field"><input name="area" maxlength="3" inputmode="numeric" placeholder="Area code, e.g. 386" value="${(d.phone || '').replace(/\D/g, '').slice(0, 3)}" aria-label="Area code">
            <button class="btn alt" ${p.twilio_messaging_service_sid ? '' : 'disabled'}>Buy local number</button></form>
            <p class="hint">Bills the dealership's subaccount ~$1.15/month. Numbers can be bought before approval but won't send until the campaign is approved.</p>`}
      </div>
      <details class="card"><summary><strong>Registration log</strong> (${log.length})</summary>
        ${log.length ? html`<table class="data" style="margin-top:10px"><tbody>${log.map((l) => html`<tr><td class="nowrap">${dateTime(l.at)}</td><td>${l.step}</td><td>${l.ok ? '✓' : '✗'} ${l.sid || ''} ${l.status || ''} ${l.error || ''}</td></tr>`)}</tbody></table>` : html`<p class="sub">Nothing yet.</p>`}
      </details>
      <details class="card"><summary><strong>Registered in the Twilio Console instead?</strong></summary>
        <p class="small sub">Paste the SIDs from the dealership's subaccount. The daily job then tracks review status and turns texting on when the campaign is approved.</p>
        <form id="sids"><div class="grid2 stack-sm">
          ${['a2p_customer_profile_sid', 'a2p_trust_product_sid', 'a2p_brand_sid', 'a2p_campaign_sid', 'twilio_messaging_service_sid', 'twilio_phone_number', 'twilio_phone_sid'].map((k) => html`<div><label for="x-${k}">${k}</label><input id="x-${k}" name="${k}" value="${p[k] || ''}"></div>`)}
          <div><label for="x-step">Current step</label><select id="x-step" name="a2p_step">${[['not_started', 'Not started'], ...STEPS].map(([k, l]) => html`<option value="${k}" ${p.a2p_step === k ? 'selected' : ''}>${l}</option>`)}</select></div>
        </div><button class="btn alt" style="margin-top:10px">Save SIDs</button></form>
      </details>`);

    on(box, 'click', '[data-act]', async (e, btn) => {
      btn.disabled = true; const label = btn.textContent; btn.textContent = 'Working…';
      try {
        const r = await api('/api/platform/a2p', { method: 'POST', auth: true, body: { dealership_id: id, action: btn.dataset.act } });
        p = r.profile;
        const failed = (r.ran || []).find((x) => !x.ok);
        toast(failed ? `Stopped at ${failed.step}` : r.note || 'Done', failed ? 'bad' : '');
      } catch (err) { toast(errMsg(err), 'bad'); await load(); }
      btn.textContent = label;
      frame();
    });
    const buy = $('#buy', box);
    buy && buy.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api('/api/platform/a2p', { method: 'POST', auth: true, body: { dealership_id: id, action: 'buy_number', area_code: e.target.area.value } }); p = r.profile; toast(`Bought ${p.twilio_phone_number}`); frame(); }
      catch (err) { toast(errMsg(err), 'bad'); }
    });
    $('#sids', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = Object.fromEntries([...new FormData(e.target).entries()].map(([k, v]) => [k, String(v).trim() || null]));
      patch.a2p_step = patch.a2p_step || 'not_started';
      try { p = must(await sb.from('messaging_profiles').update(patch).eq('dealership_id', id).select().single()); toast('Saved'); frame(); }
      catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  frame();
}
