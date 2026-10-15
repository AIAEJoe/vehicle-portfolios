// POST /api/messages/send — staff send a portfolio link or a reply from the dealership's own number/email.
// Body: { channel: 'sms'|'email', customer_id? , customer?: {name, phone, email}, vehicle_id?, kind: 'portfolio_share'|'conversation',
//         body?, subject?, staff_id?, consent?: { attested: true, text } }
import { json, handle, HttpError, sb, enc, getDealership, dealerSlugFromRequest, requireUser, siteOrigin, vehicleTitle, escapeHtml } from '../../_lib/util.js';
import { dealerTwilio } from '../../_lib/twilio.js';
import { findOrCreateCustomer, recordConsent, canTextCustomer, sendSms, sendEmail } from '../../_lib/messaging.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const { user } = await requireUser(request, env, dealership.id);
  const b = await request.json().catch(() => ({}));
  const channel = b.channel === 'email' ? 'email' : 'sms';
  const kind = b.kind === 'portfolio_share' ? 'portfolio_share' : 'conversation';
  const origin = siteOrigin(request);

  // staff sending (defaults to the signed-in user's salesperson profile)
  let staff = null;
  if (b.staff_id) [staff] = await sb(env, `/rest/v1/staff?id=eq.${enc(b.staff_id)}&dealership_id=eq.${dealership.id}&select=*`);
  if (!staff) [staff] = await sb(env, `/rest/v1/staff?user_id=eq.${user.id}&dealership_id=eq.${dealership.id}&select=*`);

  let customer;
  if (b.customer_id) {
    [customer] = await sb(env, `/rest/v1/customers?id=eq.${enc(b.customer_id)}&dealership_id=eq.${dealership.id}&select=*`);
    if (!customer) throw new HttpError(404, 'Customer not found');
  } else {
    const c = b.customer || {};
    if (!c.name || !String(c.name).trim()) throw new HttpError(400, 'Enter the customer\'s name');
    customer = await findOrCreateCustomer(env, dealership.id, { name: String(c.name).trim(), phone: c.phone, email: c.email, staffId: staff && staff.id });
  }

  const { profile, creds } = await dealerTwilio(env, dealership.id);
  const [billing] = await sb(env, `/rest/v1/dealership_billing?dealership_id=eq.${dealership.id}&select=*`);

  // Staff attests the customer agreed to texts (logged with who/when/wording)
  if (channel === 'sms' && b.consent && b.consent.attested && customer.sms_consent_status !== 'opted_in') {
    try {
      await recordConsent(env, {
        dealership_id: dealership.id, customer_id: customer.id, channel: 'sms', action: 'opt_in', method: 'verbal_attested',
        consent_text: String(b.consent.text || (profile && profile.consent_language) || '').slice(0, 2000),
        staff_id: staff && staff.id, recorded_by: user.id,
        ip_address: request.headers.get('cf-connecting-ip'), user_agent: (request.headers.get('user-agent') || '').slice(0, 300),
      });
      customer.sms_consent_status = 'opted_in';
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  }

  // Vehicle + personal tracked link
  let vehicle = null;
  let share = null;
  if (b.vehicle_id) {
    [vehicle] = await sb(env, `/rest/v1/vehicles?id=eq.${enc(b.vehicle_id)}&dealership_id=eq.${dealership.id}&select=*`);
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');
  }
  if (kind === 'portfolio_share') {
    if (!vehicle) throw new HttpError(400, 'Choose a vehicle to share');
    if (vehicle.status !== 'published') throw new HttpError(400, 'Publish this vehicle before sending it');
  }

  // Gate before creating anything customer-visible
  if (channel === 'sms') {
    const gate = await canTextCustomer(env, { profile, customer, billing, purpose: kind });
    if (!gate.ok) throw Object.assign(new HttpError(409, gate.reason), { code: gate.code });
  } else {
    if (!customer.email) throw new HttpError(400, 'This customer has no email address');
    if (customer.email_opted_out) throw new HttpError(409, 'This customer unsubscribed from your emails.');
  }

  if (kind === 'portfolio_share') {
    [share] = await sb(env, '/rest/v1/shares', {
      method: 'POST', prefer: 'return=representation',
      body: { vehicle_id: vehicle.id, dealership_id: dealership.id, staff_id: staff && staff.id, channel,
              customer_id: customer.id, customer_name: customer.full_name, customer_phone: customer.phone, customer_email: customer.email, created_by: user.id },
    });
  }
  if (staff && !customer.assigned_staff_id) {
    await sb(env, `/rest/v1/customers?id=eq.${customer.id}`, { method: 'PATCH', body: { assigned_staff_id: staff.id } });
  }

  const first = String(customer.full_name || '').split(/\s+/)[0] || 'there';
  const from = staff ? staff.full_name.split(' ')[0] : 'the team';
  const link = share ? `${origin}/v/${vehicle.slug}?s=${share.code}` : null;
  const title = vehicle ? vehicleTitle(vehicle) : '';
  let text = String(b.body || '').trim();
  if (!text && kind === 'portfolio_share') {
    text = `Hi ${first}, it's ${from} at ${dealership.name}. Here are the photos, details and history for the ${title}: ${link}`;
  } else if (link && !text.includes(link)) {
    text = `${text} ${link}`.trim();
  }
  if (!text) throw new HttpError(400, 'Type a message');

  let result;
  if (channel === 'sms') {
    // First text from this dealership to this customer carries the opt-out notice
    const prior = await sb(env, `/rest/v1/messages?customer_id=eq.${customer.id}&channel=eq.sms&direction=eq.outbound&status=neq.failed&select=id&limit=1`);
    if (!prior.length && !/STOP/i.test(text)) text += ' Reply STOP to opt out.';
    result = await sendSms(env, {
      dealershipId: dealership.id, sender: 'dealership', dealer: { profile, creds }, to: customer.phone, body: text, origin,
      customerId: customer.id, staffId: staff && staff.id, vehicleId: vehicle && vehicle.id, shareId: share && share.id,
      purpose: kind, audience: 'customer', sentBy: user.id,
    });
  } else {
    const subject = String(b.subject || '').trim() || (title ? `${title} at ${dealership.name}` : `Message from ${dealership.name}`);
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#222">
${escapeHtml(text.replace(link || '\u0000', '')).replace(/\n/g, '<br>')}
${link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:${escapeHtml(dealership.brand_primary || '#013C9E')};color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">View the ${escapeHtml(title)}</a></p>` : ''}
${staff ? `<p>${escapeHtml(staff.full_name)}<br>${escapeHtml(dealership.name)}${staff.phone ? `<br>${escapeHtml(staff.phone)}` : ''}</p>` : ''}</div>`;
    result = await sendEmail(env, {
      dealership, profile, to: customer.email, subject, html, text, origin, customer, staff,
      vehicleId: vehicle && vehicle.id, shareId: share && share.id, purpose: kind, audience: 'customer', sentBy: user.id,
    });
  }
  if (result.skipped) throw new HttpError(503, `Not sent: ${result.skipped}`);
  await sb(env, '/rest/v1/rpc/vp_customer_touch', { method: 'POST', body: { p_customer_id: customer.id, p_inbound: false } });
  if (result.error) return json({ ok: false, error: result.error, message: result.message, share, customer }, 502);
  return json({ ok: true, message: result.message, share, customer });
});
