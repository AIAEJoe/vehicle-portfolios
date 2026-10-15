// Dealership-scoped messaging: every SMS/email is sent from that dealership's identity,
// gated by consent/opt-out/registration/allowance, recorded in `messages`, and costed.
import { sb, enc, HttpError, escapeHtml } from './util.js';
import { twilio, dealerTwilio, platformCreds, smsSegments, API } from './twilio.js';
import { normalizeUsPhone, splitEmails } from './notify.js';
import { signToken } from './crypto.js';

export const REPLY_WINDOW_HOURS = 72;

const rateCache = { at: 0, v: null };
export async function rates(env) {
  if (rateCache.v && Date.now() - rateCache.at < 60000) return rateCache.v;
  const [r] = await sb(env, '/rest/v1/platform_settings?id=eq.1&select=*');
  rateCache.v = r || { sms_out_segment_cost: 0.0083, sms_in_segment_cost: 0.0083, sms_carrier_fee_out: 0.0045, sms_carrier_fee_in: 0.003, email_cost: 0.0004, mms_out_cost: 0.022 };
  rateCache.at = Date.now();
  return rateCache.v;
}

export function webhookBase(env, origin) {
  return String(env.WEBHOOK_BASE_URL || origin || '').replace(/\/$/, '');
}

// ---------------------------------------------------------------- customers
export async function findOrCreateCustomer(env, dealershipId, { name, phone, email, staffId } = {}) {
  const e164 = phone ? normalizeUsPhone(phone) : null;
  if (phone && !e164) throw new HttpError(400, 'That mobile number doesn\'t look right');
  const mail = email ? String(email).trim().toLowerCase() : null;
  let row = null;
  if (e164) [row] = await sb(env, `/rest/v1/customers?dealership_id=eq.${dealershipId}&phone=eq.${enc(e164)}&select=*`);
  if (!row && mail) [row] = await sb(env, `/rest/v1/customers?dealership_id=eq.${dealershipId}&email=eq.${enc(mail)}&select=*&order=created_at.asc&limit=1`);
  if (!row) {
    [row] = await sb(env, '/rest/v1/customers', {
      method: 'POST', prefer: 'return=representation',
      body: { dealership_id: dealershipId, full_name: name || null, phone: e164, email: mail, assigned_staff_id: staffId || null },
    });
    return row;
  }
  const patch = {};
  if (name && !row.full_name) patch.full_name = name;
  if (mail && !row.email) patch.email = mail;
  if (e164 && !row.phone) patch.phone = e164;
  if (staffId && !row.assigned_staff_id) patch.assigned_staff_id = staffId;
  if (Object.keys(patch).length) {
    [row] = await sb(env, `/rest/v1/customers?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
  }
  return row;
}

export async function recordConsent(env, rec) {
  const [row] = await sb(env, '/rest/v1/consent_records', { method: 'POST', prefer: 'return=representation', body: { recorded_by: null, ...rec } });
  return row;
}

// ---------------------------------------------------------------- gating
export async function usage(env, dealershipId) {
  return sb(env, '/rest/v1/rpc/vp_usage_summary', { method: 'POST', body: { p_dealership_id: dealershipId } });
}

/** Can this dealership text this customer right now? Returns { ok, reason }. */
export async function canTextCustomer(env, { profile, customer, billing, purpose }) {
  if (!profile || !profile.sms_enabled || !profile.twilio_messaging_service_sid) {
    return { ok: false, code: 'not_registered', reason: 'Texting from the dealership number turns on after 10DLC registration is approved.' };
  }
  if (!customer.phone) return { ok: false, code: 'no_phone', reason: 'This customer has no mobile number.' };
  if (customer.sms_consent_status === 'opted_out') {
    return { ok: false, code: 'opted_out', reason: 'This customer texted STOP. They have to text START before you can text them again.' };
  }
  const recentInbound = customer.last_inbound_at && Date.now() - new Date(customer.last_inbound_at).getTime() < REPLY_WINDOW_HOURS * 3600e3;
  if (customer.sms_consent_status !== 'opted_in' && !(purpose === 'conversation' && recentInbound)) {
    return { ok: false, code: 'no_consent', reason: 'We need the customer\'s permission to text them first. Confirm they agreed, or have them text the dealership number.' };
  }
  if (billing) {
    if (billing.status === 'paused' || billing.status === 'cancelled') {
      return { ok: false, code: 'billing', reason: 'Messaging is paused for this account. Contact Vehicle Portfolios support.' };
    }
    if (billing.allow_overage === false) {
      const u = await usage(env, profile.dealership_id);
      if (u && u.sms_segments_total >= u.included_sms_segments) {
        return { ok: false, code: 'allowance', reason: 'This month\'s included texts are used up. Ask your account manager to raise the allowance.' };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- SMS
async function insertMessage(env, row) {
  const [m] = await sb(env, '/rest/v1/messages', { method: 'POST', prefer: 'return=representation', body: row });
  return m;
}
async function patchMessage(env, id, patch) {
  await sb(env, `/rest/v1/messages?id=eq.${id}`, { method: 'PATCH', body: { status_updated_at: new Date().toISOString(), ...patch } });
}

/**
 * Low-level send. sender: 'dealership' (subaccount + messaging service) or 'platform' (staff alerts).
 * Never throws for provider errors: the message row records the failure.
 */
export async function sendSms(env, opts) {
  const { dealershipId, sender = 'dealership', to, body, origin } = opts;
  const r = await rates(env);
  const phone = normalizeUsPhone(to);
  if (!phone) return { skipped: 'bad phone' };

  let creds; let from = {}; let fromAddress = null;
  if (sender === 'dealership') {
    const t = opts.dealer || (await dealerTwilio(env, dealershipId));
    if (!t.creds || !t.profile || !t.profile.twilio_messaging_service_sid) return { skipped: 'dealership sender not set up' };
    creds = t.creds;
    from = { MessagingServiceSid: t.profile.twilio_messaging_service_sid };
    fromAddress = t.profile.twilio_phone_number;
  } else {
    creds = platformCreds(env);
    if (!creds || !(env.TWILIO_PLATFORM_MESSAGING_SERVICE_SID || env.TWILIO_FROM)) return { skipped: 'platform sender not configured' };
    from = env.TWILIO_PLATFORM_MESSAGING_SERVICE_SID ? { MessagingServiceSid: env.TWILIO_PLATFORM_MESSAGING_SERVICE_SID } : { From: env.TWILIO_FROM };
    fromAddress = env.TWILIO_FROM || 'platform';
  }

  const segments = smsSegments(body);
  const message = await insertMessage(env, {
    dealership_id: dealershipId,
    customer_id: opts.customerId || null,
    staff_id: opts.staffId || null,
    vehicle_id: opts.vehicleId || null,
    share_id: opts.shareId || null,
    lead_id: opts.leadId || null,
    channel: 'sms', direction: 'outbound',
    audience: opts.audience || 'customer',
    purpose: opts.purpose || 'conversation',
    sender, from_address: fromAddress, to_address: phone, body,
    provider: 'twilio', status: 'queued', segments,
    cost_estimate: +(segments * r.sms_out_segment_cost).toFixed(5),
    carrier_fee: +(segments * r.sms_carrier_fee_out).toFixed(5),
    sent_by: opts.sentBy || null,
  });

  try {
    const res = await twilio(creds, 'POST', `${API}/Accounts/${creds.sid}/Messages.json`, {
      To: phone, Body: body, ...from,
      StatusCallback: `${webhookBase(env, origin)}/api/twilio/status?m=${message.id}`,
    });
    const segs = Number(res.num_segments) || segments;
    await patchMessage(env, message.id, {
      provider_message_id: res.sid, status: res.status || 'accepted', segments: segs,
      cost_estimate: +(segs * r.sms_out_segment_cost).toFixed(5), carrier_fee: +(segs * r.sms_carrier_fee_out).toFixed(5),
    });
    return { sent: true, message: { ...message, provider_message_id: res.sid, status: res.status } };
  } catch (err) {
    await patchMessage(env, message.id, { status: 'failed', error_code: String(err.code || ''), error_message: err.message, cost_estimate: 0, carrier_fee: 0 });
    // 21610: the handset previously replied STOP to this sender
    if (String(err.code) === '21610' && opts.customerId) {
      await recordConsent(env, { dealership_id: dealershipId, customer_id: opts.customerId, channel: 'sms', action: 'opt_out',
        method: 'inbound_keyword', keyword: 'STOP', notes: 'Twilio error 21610: recipient has opted out of this sender' }).catch(() => {});
    }
    return { error: err.message, code: err.code, message };
  }
}

/** Staff notifications (open alerts, lead alerts, reply alerts) — platform sender, costed to the dealership. */
export async function alertStaffSms(env, { dealershipId, staff, body, purpose, origin, vehicleId, customerId }) {
  if (!staff || !staff.notify_sms || !staff.phone) return { skipped: 'staff sms off' };
  return sendSms(env, { dealershipId, sender: 'platform', audience: 'staff', purpose, to: staff.phone, body, staffId: staff.id, origin, vehicleId, customerId });
}

// ---------------------------------------------------------------- email
export function senderIdentity(env, dealership, profile) {
  const name = (profile && profile.email_from_name) || dealership.name;
  if (profile && profile.email_domain && profile.email_domain_status === 'verified') {
    return { from: `${name} <${profile.email_from_local || 'sales'}@${profile.email_domain}>`, verified: true };
  }
  const alias = (profile && profile.email_inbound_alias) || dealership.slug;
  const domain = env.PLATFORM_EMAIL_DOMAIN || 'mail.aiautoengine.com';
  return { from: `${name} via Vehicle Portfolios <${alias}@${domain}>`, verified: false };
}

/** Customer replies go back to the dealership: tracked alias when inbound email is set up, else the dealership's inbox. */
export function replyAddress(env, dealership, profile, { customer, staff } = {}) {
  if (env.INBOUND_EMAIL_DOMAIN && profile && profile.email_inbound_alias) {
    return `${profile.email_inbound_alias}${customer ? '+' + customer.id.slice(0, 8) : ''}@${env.INBOUND_EMAIL_DOMAIN}`;
  }
  return (staff && staff.email) || (profile && profile.email_reply_to) || dealership.email || null;
}

export async function sendEmail(env, opts) {
  const { dealership, profile, to, subject, html, text, origin } = opts;
  const recipients = Array.isArray(to) ? to.flatMap(splitEmails) : splitEmails(to);
  if (!recipients.length) return { skipped: 'no recipient' };
  if (!env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY not set' };
  const r = await rates(env);
  const audience = opts.audience || 'customer';
  const id = senderIdentity(env, dealership, profile);
  const replyTo = opts.replyTo || (audience === 'customer' ? replyAddress(env, dealership, profile, opts) : null);

  const message = await insertMessage(env, {
    dealership_id: dealership.id, customer_id: (opts.customer && opts.customer.id) || null, staff_id: (opts.staff && opts.staff.id) || null,
    vehicle_id: opts.vehicleId || null, share_id: opts.shareId || null, lead_id: opts.leadId || null,
    channel: 'email', direction: 'outbound', audience, purpose: opts.purpose || 'conversation',
    sender: id.verified ? 'dealership' : 'platform', from_address: id.from, to_address: recipients.join(', '),
    subject, body: text || null, provider: 'resend', status: 'queued', segments: 0,
    cost_estimate: +(r.email_cost * recipients.length).toFixed(5), sent_by: opts.sentBy || null,
  });

  let finalHtml = html;
  let finalText = text;
  const headers = { 'X-VP-Message': message.id };
  if (audience === 'customer' && opts.customer) {
    const token = await signToken(env, { c: opts.customer.id, d: dealership.id });
    const unsub = `${webhookBase(env, origin)}/api/unsubscribe?t=${encodeURIComponent(token)}`;
    headers['List-Unsubscribe'] = `<${unsub}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    const addr = [dealership.address_line, dealership.city, dealership.state, dealership.zip].filter(Boolean).join(', ');
    if (finalHtml) finalHtml += `<p style="font-size:12px;color:#777;margin-top:28px">${escapeHtml(dealership.name)}${addr ? ' · ' + escapeHtml(addr) : ''}<br><a href="${escapeHtml(unsub)}" style="color:#777">Unsubscribe from ${escapeHtml(dealership.name)} emails</a></p>`;
    if (finalText) finalText += `\n\n${dealership.name}${addr ? ', ' + addr : ''}\nUnsubscribe: ${unsub}`;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: id.from, to: [...new Set(recipients)], subject, html: finalHtml, text: finalText, headers,
      ...(replyTo ? { reply_to: replyTo } : {}),
      tags: [{ name: 'dealership', value: dealership.slug.replace(/[^a-zA-Z0-9_-]/g, '_') }, { name: 'message_id', value: message.id }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    await patchMessage(env, message.id, { status: 'failed', error_code: String(res.status), error_message: data.message || 'email failed', cost_estimate: 0 });
    return { error: data.message || `email failed (${res.status})`, message };
  }
  await patchMessage(env, message.id, { provider_message_id: data.id, status: 'sent' });
  return { sent: true, message: { ...message, provider_message_id: data.id } };
}
