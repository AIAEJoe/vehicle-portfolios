// POST /api/twilio/inbound — a customer texted a dealership number.
// Validates Twilio's signature with that dealership's subaccount token, handles
// STOP/START/HELP, logs the message, and routes it to the right salesperson.
import { handle, sb, enc, formParams, twiml, json, siteOrigin, escapeHtml } from '../../_lib/util.js';
import { validTwilioRequest } from '../../_lib/crypto.js';
import { dealerTwilio, keywordOf } from '../../_lib/twilio.js';
import { findOrCreateCustomer, recordConsent, alertStaffSms, sendEmail, rates } from '../../_lib/messaging.js';

export const onRequestPost = handle(async (ctx) => {
  const { request, env } = ctx;
  const params = await formParams(request);
  const to = params.To;
  const [profile] = await sb(env, `/rest/v1/messaging_profiles?twilio_phone_number=eq.${enc(to)}&select=dealership_id`);
  if (!profile) return json({ error: 'unknown number' }, 404);
  const dealer = await dealerTwilio(env, profile.dealership_id);
  if (!dealer.creds || !(await validTwilioRequest(dealer.creds.token, request.url, params, request.headers.get('x-twilio-signature')))) {
    return json({ error: 'invalid signature' }, 403);
  }
  if (params.AccountSid && params.AccountSid !== dealer.creds.sid) return json({ error: 'account mismatch' }, 403);

  const dealershipId = profile.dealership_id;
  const [dealership] = await sb(env, `/rest/v1/dealerships?id=eq.${dealershipId}&select=*`);
  const r = await rates(env);

  // idempotency: Twilio retries on timeouts
  const dup = await sb(env, `/rest/v1/messages?provider_message_id=eq.${enc(params.MessageSid)}&select=id`);
  if (dup.length) return twiml();

  let customer = await findOrCreateCustomer(env, dealershipId, { phone: params.From });
  const keyword = keywordOf(params.Body, params.OptOutType);
  const segments = Number(params.NumSegments) || 1;
  const numMedia = Number(params.NumMedia) || 0;

  const [message] = await sb(env, '/rest/v1/messages', {
    method: 'POST', prefer: 'return=representation',
    body: {
      dealership_id: dealershipId, customer_id: customer.id, channel: numMedia ? 'mms' : 'sms', direction: 'inbound',
      audience: 'customer', purpose: 'conversation', sender: 'dealership', from_address: params.From, to_address: to,
      body: params.Body || '', provider: 'twilio', provider_message_id: params.MessageSid, status: 'received',
      segments, num_media: numMedia, cost_estimate: +(segments * r.sms_in_segment_cost).toFixed(5),
      carrier_fee: +(segments * r.sms_carrier_fee_in).toFixed(5), status_updated_at: new Date().toISOString(),
    },
  });

  if (keyword === 'STOP') {
    // Twilio's opt-out handling sends the confirmation text and blocks future sends; we keep the evidence.
    await recordConsent(env, { dealership_id: dealershipId, customer_id: customer.id, channel: 'sms', action: 'opt_out',
      method: 'inbound_keyword', keyword: String(params.Body || '').trim().toUpperCase().slice(0, 20), phone: params.From,
      notes: `Inbound message ${params.MessageSid}` });
    await sb(env, '/rest/v1/rpc/vp_customer_touch', { method: 'POST', body: { p_customer_id: customer.id, p_inbound: false } });
    return twiml();
  }
  if (keyword === 'HELP') {
    await sb(env, '/rest/v1/rpc/vp_customer_touch', { method: 'POST', body: { p_customer_id: customer.id, p_inbound: false } });
    return twiml(); // the HELP reply is configured on the Messaging Service (Advanced Opt-Out) to avoid double replies
  }
  if (keyword === 'START' && customer.sms_consent_status === 'opted_out') {
    await recordConsent(env, { dealership_id: dealershipId, customer_id: customer.id, channel: 'sms', action: 'opt_in',
      method: 'inbound_keyword', keyword: String(params.Body || '').trim().toUpperCase().slice(0, 20), phone: params.From,
      notes: `Inbound message ${params.MessageSid}` });
    customer = { ...customer, sms_consent_status: 'opted_in' };
  }

  await sb(env, '/rest/v1/rpc/vp_customer_touch', { method: 'POST', body: { p_customer_id: customer.id, p_inbound: true } });
  const work = routeReply(env, { dealership, customer, message, origin: siteOrigin(request) }).catch((e) => console.error('route reply', e));
  if (ctx.waitUntil) ctx.waitUntil(work); else await work;
  return twiml();
});

/** Assigned salesperson → whoever last sent them a portfolio → whoever handled their lead → the store inbox. */
export async function routeReply(env, { dealership, customer, message, origin }) {
  let staffId = customer.assigned_staff_id;
  if (!staffId) {
    const [s] = await sb(env, `/rest/v1/shares?customer_id=eq.${customer.id}&staff_id=not.is.null&select=staff_id&order=created_at.desc&limit=1`);
    staffId = s && s.staff_id;
  }
  if (!staffId) {
    const [l] = await sb(env, `/rest/v1/leads?customer_id=eq.${customer.id}&staff_id=not.is.null&select=staff_id&order=created_at.desc&limit=1`);
    staffId = l && l.staff_id;
  }
  let staff = null;
  if (staffId) {
    [staff] = await sb(env, `/rest/v1/staff?id=eq.${staffId}&active=eq.true&select=*`);
    if (staff && !customer.assigned_staff_id) {
      await sb(env, `/rest/v1/customers?id=eq.${customer.id}`, { method: 'PATCH', body: { assigned_staff_id: staff.id } });
    }
    if (staff) await sb(env, `/rest/v1/messages?id=eq.${message.id}`, { method: 'PATCH', body: { staff_id: staff.id } });
  }
  const who = customer.full_name || customer.phone;
  const link = `${origin}/admin/inbox?c=${customer.id}`;
  const excerpt = String(message.body || (message.num_media ? '[photo]' : '')).slice(0, 140);
  const out = {};
  if (staff) {
    out.sms = await alertStaffSms(env, { dealershipId: dealership.id, staff, purpose: 'reply_alert', origin, customerId: customer.id,
      body: `${who} replied: "${excerpt}" Reply in your inbox: ${link}` });
  }
  const [settings] = await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealership.id}&select=lead_email`);
  const to = staff && staff.notify_email && staff.email ? staff.email : settings && settings.lead_email;
  if (to) {
    out.email = await sendEmail(env, {
      dealership, profile: null, to, audience: 'staff', purpose: 'reply_alert', origin,
      subject: `New text from ${who}`,
      text: `${who} (${customer.phone}) texted ${dealership.name}:\n\n${message.body}\n\nReply: ${link}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px"><p><strong>${escapeHtml(who)}</strong> (${escapeHtml(customer.phone)}) texted ${escapeHtml(dealership.name)}:</p>
<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px">${escapeHtml(message.body)}</blockquote><p><a href="${escapeHtml(link)}">Reply in the inbox</a></p></div>`,
    });
  }
  return out;
}
