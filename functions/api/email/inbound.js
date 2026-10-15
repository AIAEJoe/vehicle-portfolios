// POST /api/email/inbound — called by the inbound-email Worker (workers/email-inbound) for each
// reply sent to <alias>[+<customer>]@reply.aiautoengine.com. Logs it and tells the Worker where to forward.
import { handle, json, sb, enc, HttpError } from '../../_lib/util.js';
import { timingSafeEqual } from '../../_lib/crypto.js';
import { findOrCreateCustomer } from '../../_lib/messaging.js';

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.INBOUND_EMAIL_SECRET || !timingSafeEqual(request.headers.get('x-inbound-secret'), env.INBOUND_EMAIL_SECRET)) {
    throw new HttpError(403, 'forbidden');
  }
  const b = await request.json();
  const local = String(b.to || '').split('@')[0].toLowerCase();
  const [alias, tag] = local.split('+');
  const [profile] = await sb(env, `/rest/v1/messaging_profiles?email_inbound_alias=eq.${enc(alias)}&select=dealership_id,email_reply_to`);
  if (!profile) return json({ forward_to: null, reason: 'unknown alias' }, 404);
  const [dealership] = await sb(env, `/rest/v1/dealerships?id=eq.${profile.dealership_id}&select=id,email`);
  const fromEmail = String(b.from || '').toLowerCase().match(/[^<\s]+@[^>\s]+/)?.[0];

  let customer = null;
  if (tag && /^[0-9a-f]{8}$/.test(tag)) {
    [customer] = await sb(env, `/rest/v1/customers?dealership_id=eq.${dealership.id}&id=gte.${tag}-0000-0000-0000-000000000000&id=lte.${tag}-ffff-ffff-ffff-ffffffffffff&select=*&limit=1`);
  }
  if (!customer && fromEmail) customer = await findOrCreateCustomer(env, dealership.id, { email: fromEmail });

  let staff = null;
  if (customer && customer.assigned_staff_id) [staff] = await sb(env, `/rest/v1/staff?id=eq.${customer.assigned_staff_id}&select=email`);
  const forwardTo = (staff && staff.email) || profile.email_reply_to || dealership.email || null;

  await sb(env, '/rest/v1/messages', {
    method: 'POST',
    body: {
      dealership_id: dealership.id, customer_id: customer && customer.id, staff_id: customer && customer.assigned_staff_id,
      channel: 'email', direction: 'inbound', audience: 'customer', purpose: 'conversation', from_address: b.from, to_address: b.to,
      subject: String(b.subject || '').slice(0, 300), body: String(b.text || '').slice(0, 5000) || null, provider: 'resend',
      provider_message_id: b.message_id ? `in:${String(b.message_id).slice(0, 200)}` : null, status: 'received', segments: 0, cost_estimate: 0,
    },
  });
  if (customer) await sb(env, '/rest/v1/rpc/vp_customer_touch', { method: 'POST', body: { p_customer_id: customer.id, p_inbound: true } });
  return json({ forward_to: forwardTo });
});
