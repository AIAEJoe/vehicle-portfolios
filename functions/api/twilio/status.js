// POST /api/twilio/status?m=<message id> — Twilio delivery status callbacks.
import { handle, sb, enc, formParams, json } from '../../_lib/util.js';
import { validTwilioRequest } from '../../_lib/crypto.js';
import { dealerTwilio, platformCreds, laterStatus, FINAL_STATUSES, twilio, API } from '../../_lib/twilio.js';
import { recordConsent } from '../../_lib/messaging.js';

export const onRequestPost = handle(async (ctx) => {
  const { request, env } = ctx;
  const params = await formParams(request);
  const id = new URL(request.url).searchParams.get('m');
  const filter = id && /^[0-9a-f-]{36}$/i.test(id) ? `id=eq.${id}` : `provider_message_id=eq.${enc(params.MessageSid)}`;
  const [m] = await sb(env, `/rest/v1/messages?${filter}&select=*`);
  if (!m) return json({ ok: true, unknown: true });

  const creds = m.sender === 'platform' ? platformCreds(env) : (await dealerTwilio(env, m.dealership_id)).creds;
  if (!creds || !(await validTwilioRequest(creds.token, request.url, params, request.headers.get('x-twilio-signature')))) {
    return json({ error: 'invalid signature' }, 403);
  }

  const status = String(params.MessageStatus || params.SmsStatus || '').toLowerCase();
  const patch = { status_updated_at: new Date().toISOString() };
  if (!m.provider_message_id && params.MessageSid) patch.provider_message_id = params.MessageSid;
  if (status && laterStatus(m.status, status)) patch.status = status;
  if (params.ErrorCode) {
    patch.error_code = String(params.ErrorCode);
    patch.error_message = ERRORS[params.ErrorCode] || null;
  }
  if (status === 'failed' || status === 'undelivered') {
    // failed sends are generally not billed by Twilio; carrier fees may still apply on undelivered
    if (status === 'failed') { patch.cost_estimate = 0; patch.carrier_fee = 0; }
  }
  await sb(env, `/rest/v1/messages?id=eq.${m.id}`, { method: 'PATCH', body: patch });

  if (String(params.ErrorCode) === '21610' && m.customer_id) {
    await recordConsent(env, { dealership_id: m.dealership_id, customer_id: m.customer_id, channel: 'sms', action: 'opt_out',
      method: 'inbound_keyword', keyword: 'STOP', notes: 'Twilio 21610: recipient opted out of this sender' }).catch(() => {});
  }

  if (FINAL_STATUSES.includes(status) && m.provider_cost == null) {
    const work = fetchPrice(env, creds, params.MessageSid || m.provider_message_id, m.id).catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(work); else await work;
  }
  return json({ ok: true });
});

/** Twilio reports the real price shortly after delivery (as a negative string, e.g. "-0.00830"). */
export async function fetchPrice(env, creds, sid, messageId) {
  const res = await twilio(creds, 'GET', `${API}/Accounts/${creds.sid}/Messages/${sid}.json`);
  if (res && res.price !== null && res.price !== undefined && res.price !== '') {
    await sb(env, `/rest/v1/messages?id=eq.${messageId}`, {
      method: 'PATCH', body: { provider_cost: Math.abs(Number(res.price)), segments: Number(res.num_segments) || undefined },
    });
    return true;
  }
  return false;
}

const ERRORS = {
  30003: 'Unreachable handset',
  30004: 'Message blocked by recipient or carrier',
  30005: 'Unknown or inactive number',
  30006: 'Landline or unreachable carrier',
  30007: 'Filtered by carrier (spam)',
  30008: 'Unknown delivery error',
  30034: 'Blocked: number not registered for 10DLC',
  21610: 'Recipient has opted out (STOP)',
  21211: 'Invalid phone number',
};
