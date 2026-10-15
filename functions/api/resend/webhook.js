// POST /api/resend/webhook — email delivery events (Svix-signed).
import { handle, sb, enc, json } from '../../_lib/util.js';
import { validSvixRequest } from '../../_lib/crypto.js';
import { recordConsent } from '../../_lib/messaging.js';

const MAP = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'sending',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await request.text();
  if (!(await validSvixRequest(env.RESEND_WEBHOOK_SECRET, request.headers, body))) return json({ error: 'invalid signature' }, 403);
  const evt = JSON.parse(body);
  const status = MAP[evt.type];
  const emailId = evt.data && evt.data.email_id;
  if (evt.type === 'email.opened' && emailId) {
    // Shown in the Inbox only — never alerts staff (Apple Mail pre-loads the tracking pixel).
    const [o] = await sb(env, `/rest/v1/messages?provider_message_id=eq.${enc(emailId)}&select=id,opened_at,open_count`);
    if (!o) return json({ ok: true, unknown: true });
    await sb(env, `/rest/v1/messages?id=eq.${o.id}`, { method: 'PATCH', body: {
      opened_at: o.opened_at || evt.created_at || new Date().toISOString(), open_count: (o.open_count || 0) + 1,
    } });
    return json({ ok: true });
  }
  if (!status || !emailId) return json({ ok: true, ignored: evt.type });
  const [m] = await sb(env, `/rest/v1/messages?provider_message_id=eq.${enc(emailId)}&select=id,status,dealership_id,customer_id,audience`);
  if (!m) return json({ ok: true, unknown: true });
  const rank = { queued: 0, sending: 1, sent: 2, delivered: 3, bounced: 4, complained: 5, failed: 4 };
  const patch = { status_updated_at: new Date().toISOString() };
  if ((rank[status] ?? 0) >= (rank[m.status] ?? 0)) patch.status = status;
  if (status === 'bounced') {
    patch.error_message = (evt.data.bounce && (evt.data.bounce.message || evt.data.bounce.type)) || 'Bounced';
  }
  await sb(env, `/rest/v1/messages?id=eq.${m.id}`, { method: 'PATCH', body: patch });
  if (status === 'complained' && m.customer_id && m.audience === 'customer') {
    await recordConsent(env, { dealership_id: m.dealership_id, customer_id: m.customer_id, channel: 'email', action: 'opt_out',
      method: 'email_complaint', notes: `Marked as spam (Resend ${emailId})` });
  }
  return json({ ok: true });
});
