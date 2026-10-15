// POST /api/lead  — test-drive / question form on a portfolio page.
// Saves the lead, emails the dealership + salesperson, texts the salesperson,
// and sends an ADF/XML copy to the CRM (Elead) lead-intake address.

import { json, handle, HttpError, sb, enc, getDealership, getSettings, dealerSlugFromRequest,
  vehicleTitle, escapeHtml, formatMoney, siteOrigin } from '../_lib/util.js';
import { buildAdf } from '../_lib/adf.js';
import { sendEmail, alertStaffSms, findOrCreateCustomer, recordConsent } from '../_lib/messaging.js';

const clip = (s, n) => (s === undefined || s === null ? null : String(s).trim().slice(0, n) || null);

export const onRequestPost = handle(async (ctx) => {
  const { request, env } = ctx;
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid request'); }

  // Honeypot: real people never fill the hidden "website" field
  if (body.website) return json({ ok: true });

  const name = clip(body.name, 120);
  const phone = clip(body.phone, 40);
  const email = clip(body.email, 200);
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (!phone && !email) throw new HttpError(400, 'Please enter a phone number or email');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Please check your email address');
  const kind = ['test_drive', 'question', 'offer'].includes(body.kind) ? body.kind : 'test_drive';
  const preferredDate = /^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date || '') ? body.preferred_date : null;

  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));

  let vehicle = null;
  if (body.vehicle_id) {
    const rows = await sb(env, `/rest/v1/vehicles?id=eq.${enc(body.vehicle_id)}&dealership_id=eq.${dealership.id}` +
      `&status=in.(published,sold)&select=*`);
    vehicle = rows[0] || null;
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');
  }

  let share = null;
  if (body.share_code && vehicle) {
    const rows = await sb(env, `/rest/v1/shares?code=eq.${enc(body.share_code)}&vehicle_id=eq.${vehicle.id}&select=id,staff_id`);
    share = rows[0] || null;
  }
  const staffId = (share && share.staff_id) || (vehicle && vehicle.salesperson_id) || null;

  // Ignore accidental double-submits (same contact, same vehicle, last 2 minutes)
  const since = new Date(Date.now() - 120000).toISOString();
  const contactFilter = phone ? `phone=eq.${enc(phone)}` : `email=eq.${enc(email)}`;
  const dupes = await sb(env, `/rest/v1/leads?dealership_id=eq.${dealership.id}&${contactFilter}` +
    `&created_at=gt.${enc(since)}${vehicle ? `&vehicle_id=eq.${vehicle.id}` : ''}&select=id&limit=1`);
  if (dupes.length) return json({ ok: true, duplicate: true });

  // Customer record (scoped to this dealership) + optional SMS consent from the form checkbox
  let customer = null;
  try {
    customer = await findOrCreateCustomer(env, dealership.id, { name, phone, email, staffId });
  } catch { /* unusual phone formats still create the lead */ }
  const smsConsent = !!(body.sms_consent && customer && customer.phone);
  if (smsConsent) {
    const [profile] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${dealership.id}&select=consent_language`);
    await recordConsent(env, {
      dealership_id: dealership.id, customer_id: customer.id, channel: 'sms', action: 'opt_in', method: 'web_form',
      consent_text: clip(body.consent_text, 2000) || (profile && profile.consent_language) || defaultConsent(dealership),
      phone: customer.phone, source_url: clip(body.page_url, 500), staff_id: staffId,
      ip_address: request.headers.get('cf-connecting-ip'), user_agent: clip(request.headers.get('user-agent'), 300),
    }).catch((e) => console.error('consent', e));
  }

  const [lead] = await sb(env, '/rest/v1/leads', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      dealership_id: dealership.id,
      vehicle_id: vehicle && vehicle.id,
      share_id: share && share.id,
      staff_id: staffId,
      kind, name, phone, email,
      preferred_date: preferredDate,
      preferred_time: clip(body.preferred_time, 40),
      message: clip(body.message, 2000),
      customer_id: customer && customer.id,
      sms_consent: smsConsent,
    },
  });

  const work = notifyLead(env, { lead, vehicle, dealership, staffId, origin: siteOrigin(request) })
    .catch((err) => console.error('lead notify failed', err));
  if (ctx.waitUntil) ctx.waitUntil(work); else await work;

  return json({ ok: true, id: lead.id });
});

export async function notifyLead(env, { lead, vehicle, dealership, staffId, origin }) {
  const settings = await getSettings(env, dealership.id);
  let staff = null;
  if (staffId) {
    const rows = await sb(env, `/rest/v1/staff?id=eq.${staffId}&select=*`);
    staff = rows[0] || null;
  }
  const portfolioUrl = vehicle ? `${origin}/v/${vehicle.slug}` : origin;
  const title = vehicle ? vehicleTitle(vehicle) : 'General inquiry';
  const what = lead.kind === 'test_drive' ? 'Test drive request' : 'New question';
  const when = lead.preferred_date ? `${lead.preferred_date}${lead.preferred_time ? ` (${lead.preferred_time})` : ''}` : '';

  const rows = [
    ['Customer', lead.name], ['Phone', lead.phone], ['Email', lead.email], ['Preferred time', when],
    ['Vehicle', title], ['Stock #', vehicle && vehicle.stock_number], ['VIN', vehicle && vehicle.vin],
    ['Price', vehicle && formatMoney(vehicle.price)], ['Salesperson', staff && staff.full_name], ['Notes', lead.message],
  ].filter(([, v]) => v);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#222">
<h2 style="margin:0 0 12px">${escapeHtml(what)}: ${escapeHtml(title)}</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="color:#666">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`).join('')}</table>
<p><a href="${escapeHtml(portfolioUrl)}">Open the vehicle portfolio</a> · <a href="${escapeHtml(origin)}/admin/leads">View in dashboard</a></p></div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\n${portfolioUrl}`;

  const results = {};
  const [profile] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${dealership.id}&select=*`);
  const to = [settings.lead_email, staff && staff.notify_email ? staff.email : null].filter(Boolean);
  results.email = await sendEmail(env, {
    dealership, profile, to, subject: `${what}: ${title} - ${lead.name}`, html, text, replyTo: lead.email || undefined,
    audience: 'staff', purpose: 'lead_notification', origin, leadId: lead.id, vehicleId: vehicle && vehicle.id,
  });

  if (settings.crm_adf_email) {
    results.crm = await sendEmail(env, {
      dealership, profile, to: settings.crm_adf_email, subject: `Vehicle Portfolio lead - ${lead.name}`,
      text: buildAdf({ lead, vehicle, dealership, staff, portfolioUrl }),
      audience: 'crm', purpose: 'crm_adf', origin, leadId: lead.id, vehicleId: vehicle && vehicle.id,
    });
  }

  if (staff) {
    results.sms = await alertStaffSms(env, {
      dealershipId: dealership.id, staff, purpose: 'lead_alert', origin, vehicleId: vehicle && vehicle.id, customerId: lead.customer_id,
      body: `${what} from ${lead.name}${lead.phone ? ' ' + lead.phone : ''} for the ${title}${when ? ', wants ' + when : ''}. ${origin}/admin/leads`,
    });
  }

  const patch = {};
  if (results.email && results.email.sent) patch.email_sent_at = new Date().toISOString();
  if (results.crm && results.crm.sent) patch.crm_sent_at = new Date().toISOString();
  if (Object.keys(patch).length) {
    await sb(env, `/rest/v1/leads?id=eq.${lead.id}`, { method: 'PATCH', body: patch });
  }
  return results;
}

export function defaultConsent(d) {
  return `By checking this box, I agree to receive text messages from ${d.name} about my vehicle inquiry at the number provided. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.`;
}
