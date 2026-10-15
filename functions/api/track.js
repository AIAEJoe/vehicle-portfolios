// POST /api/track — called by the portfolio page after it loads in a real browser.
// Records the view and, for personal share links, alerts the salesperson by
// email + text that their customer just opened it.

import { json, handle, sb, BOT_UA, siteOrigin, vehicleTitle, escapeHtml } from '../_lib/util.js';
import { sendEmail, alertStaffSms } from '../_lib/messaging.js';

export const onRequestPost = handle(async (ctx) => {
  const { request, env } = ctx;
  const ua = request.headers.get('user-agent') || '';
  if (BOT_UA.test(ua)) return json({ recorded: false, reason: 'bot' });
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  if (!body.vehicle_id || !/^[0-9a-f-]{36}$/i.test(body.vehicle_id)) return json({ recorded: false }, 400);

  const result = await sb(env, '/rest/v1/rpc/vp_record_view', {
    method: 'POST',
    body: {
      p_vehicle_id: body.vehicle_id,
      p_share_code: body.share_code ? String(body.share_code).slice(0, 32) : null,
      p_visitor_id: body.visitor_id ? String(body.visitor_id).slice(0, 64) : null,
      p_referrer: String(body.referrer || '').slice(0, 500) || null,
      p_user_agent: ua.slice(0, 500),
    },
  });

  if (result && result.notify) {
    const [dealership] = await sb(env, `/rest/v1/dealerships?id=eq.${result.vehicle.dealership_id}&select=*`);
    const work = sendOpenAlert(env, { ...result, dealership }, siteOrigin(request)).catch((e) => console.error('open alert failed', e));
    if (ctx.waitUntil) ctx.waitUntil(work); else await work;
  }
  return json({ recorded: !!(result && result.recorded) });
});

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export async function sendOpenAlert(env, r, origin) {
  const staff = r.staff;
  const who = (r.share && r.share.customer_name) || 'Your customer';
  const title = vehicleTitle(r.vehicle);
  const nth = r.open_count > 1 ? ` (${ordinal(r.open_count)} view)` : '';
  const phone = r.share && r.share.customer_phone;
  const link = `${origin}/admin/vehicles/${r.vehicle.id}#shares`;
  const out = {};
  out.sms = await alertStaffSms(env, {
    dealershipId: r.dealership.id, staff, purpose: 'open_alert', origin, vehicleId: r.vehicle.id,
    body: `${who} just opened the ${title} portfolio${nth}.${phone ? ` Call or text them now: ${phone}.` : ''} ${link}`,
  });
  if (staff.notify_email && staff.email) {
    out.email = await sendEmail(env, {
      dealership: r.dealership, profile: null, to: staff.email, audience: 'staff', purpose: 'open_alert', origin, vehicleId: r.vehicle.id,
      subject: `${who} just opened the ${title}${nth}`,
      text: `${who} just opened the ${title} portfolio${nth}.\n${phone ? `Phone: ${phone}\n` : ''}\n${link}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px"><p><strong>${escapeHtml(who)}</strong> just opened the
<strong>${escapeHtml(title)}</strong> portfolio${escapeHtml(nth)}.</p>${phone ? `<p>Phone: <a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></p>` : ''}
<p><a href="${escapeHtml(link)}">See activity in the dashboard</a></p></div>`,
    });
  }
  return out;
}
