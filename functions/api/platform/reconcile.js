// POST /api/platform/reconcile — run daily by pg_cron (Bearer CRON_SECRET) or by an operator.
//  1. pulls real Twilio prices for messages that don't have one yet
//  2. books this month's recurring provider charges (phone numbers, 10DLC campaigns) once per month
//  3. refreshes 10DLC review status for dealerships waiting on Twilio
import { json, handle, sb, requirePlatformAdmin, siteOrigin } from '../../_lib/util.js';
import { dealerTwilio, platformCreds } from '../../_lib/twilio.js';
import { fetchPrice } from '../twilio/status.js';
import { runSteps } from '../../_lib/a2p.js';
import { webhookBase } from '../../_lib/messaging.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const auth = request.headers.get('authorization') || '';
  if (!(env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`)) await requirePlatformAdmin(request, env);
  const out = { priced: 0, unpriced: 0, charges: 0, refreshed: 0, errors: [] };

  // 1. prices
  const cutoff = new Date(Date.now() - 10 * 60e3).toISOString();
  const pending = await sb(env, `/rest/v1/messages?provider=eq.twilio&provider_cost=is.null&provider_message_id=not.is.null&status=neq.failed&created_at=lt.${cutoff}&select=id,dealership_id,sender,provider_message_id&order=created_at.asc&limit=300`);
  const credCache = {};
  for (const m of pending) {
    try {
      const key = m.sender === 'platform' ? 'platform' : m.dealership_id;
      if (!(key in credCache)) credCache[key] = m.sender === 'platform' ? platformCreds(env) : (await dealerTwilio(env, m.dealership_id)).creds;
      const creds = credCache[key];
      if (!creds) { out.unpriced++; continue; }
      if (await fetchPrice(env, creds, m.provider_message_id, m.id)) out.priced++; else out.unpriced++;
    } catch (e) { out.errors.push(`${m.id}: ${e.message}`); }
  }

  // 2. monthly recurring charges
  const [rates] = await sb(env, '/rest/v1/platform_settings?id=eq.1&select=phone_number_monthly,campaign_monthly');
  const month = new Date().toISOString().slice(0, 7) + '-01';
  const profiles = await sb(env, '/rest/v1/messaging_profiles?select=dealership_id,twilio_phone_sid,twilio_phone_number,a2p_campaign_sid,a2p_campaign_status,a2p_step');
  for (const p of profiles) {
    const rows = [];
    if (p.twilio_phone_sid) rows.push({ kind: 'phone_number', ref: p.twilio_phone_sid, description: `Phone number ${p.twilio_phone_number}`, provider_cost: rates.phone_number_monthly });
    if (p.a2p_campaign_sid && p.a2p_campaign_status === 'VERIFIED') rows.push({ kind: 'campaign_monthly', ref: p.a2p_campaign_sid, description: '10DLC campaign (monthly)', provider_cost: rates.campaign_monthly });
    for (const r of rows) {
      await sb(env, '/rest/v1/usage_charges?on_conflict=dealership_id,month,kind,ref', {
        method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: { dealership_id: p.dealership_id, month, ...r },
      }).then((x) => { out.charges += (x && x.length) || 0; });
    }
  }

  // 3. registrations waiting on review
  for (const p of profiles.filter((x) => ['wait_brand', 'wait_campaign'].includes(x.a2p_step))) {
    try {
      const [dealership] = await sb(env, `/rest/v1/dealerships?id=eq.${p.dealership_id}&select=*`);
      const [full] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${p.dealership_id}&select=*`);
      await runSteps(env, { dealership, profile: full, webhookBase: webhookBase(env, siteOrigin(request)),
        origin: `https://${dealership.slug}.${env.ROOT_DOMAIN || 'aiautoengine.com'}`, maxSteps: 2 });
      out.refreshed++;
    } catch (e) { out.errors.push(`${p.dealership_id}: ${e.message}`); }
  }
  return json({ ok: true, ...out });
});
