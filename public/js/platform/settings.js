// Rate card (what providers charge you) + default plan for new dealerships.
import { sb, html, mount, must, $, errMsg, toast } from '../core.js';
import { platformPage } from './layout.js';

const COST = [
  ['sms_out_segment_cost', 'Outbound SMS per segment', 5], ['sms_in_segment_cost', 'Inbound SMS per segment', 5],
  ['sms_carrier_fee_out', 'Carrier fee per outbound segment (avg)', 5], ['sms_carrier_fee_in', 'Carrier fee per inbound segment (avg)', 5],
  ['mms_out_cost', 'Outbound MMS', 5], ['email_cost', 'Email (your Resend plan ÷ emails)', 5],
  ['phone_number_monthly', 'Phone number per month', 2], ['campaign_monthly', '10DLC campaign per month', 2],
  ['brand_registration_fee', 'Brand registration (one-time)', 2], ['campaign_vetting_fee', 'Campaign vetting (one-time)', 2],
];
const PLAN = [
  ['default_monthly_fee', 'Monthly subscription', 2], ['default_included_sms_segments', 'Included text segments', 0],
  ['default_included_emails', 'Included emails', 0], ['default_overage_sms_rate', 'Overage per segment', 4], ['default_overage_email_rate', 'Overage per email', 4],
];

export default async function platformSettings(el) {
  const page = await platformPage(el, 'settings');
  if (!page) return;
  const { main } = page;
  let s;
  try { s = must(await sb.from('platform_settings').select('*').eq('id', 1).single()); }
  catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); return; }
  const fields = (list) => list.map(([k, label, dp]) => html`<div><label for="r-${k}">${label}</label><input id="r-${k}" name="${k}" type="number" step="${dp ? 1 / 10 ** dp : 1}" min="0" value="${s[k]}"></div>`);
  const perSeg = Number(s.sms_out_segment_cost) + Number(s.sms_carrier_fee_out);
  mount(main, html`<div class="page-head"><h1>Rates &amp; plans</h1></div>
    <form id="f">
      <div class="card"><h2>Your provider costs</h2>
        <p class="sub small" style="margin-top:0">Defaults are Twilio's published US long-code rates and 10DLC fees as of October 2026. Check your Twilio invoice and adjust.
          Actual per-message prices are pulled from Twilio automatically; these rates are used for estimates and fixed fees.</p>
        <div class="grid3">${fields(COST)}</div></div>
      <div class="card"><h2>Default plan for new dealerships</h2>
        <div class="grid3">${fields(PLAN)}</div>
        <p class="hint">At these rates one outbound text segment costs you about $${perSeg.toFixed(4)}. ${Number(s.default_included_sms_segments).toLocaleString()} included segments ≈ $${(perSeg * s.default_included_sms_segments).toFixed(2)}/month, plus ~$${(Number(s.phone_number_monthly) + Number(s.campaign_monthly)).toFixed(2)} for the number and campaign.</p>
      </div>
      <button class="btn">Save</button>
    </form>`);
  $('#f', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = Object.fromEntries([...COST, ...PLAN].map(([k]) => [k, Number(e.target[k].value)]));
    try { must(await sb.from('platform_settings').update(patch).eq('id', 1)); toast('Saved'); platformSettings(el); }
    catch (err) { toast(errMsg(err), 'bad'); }
  });
}
