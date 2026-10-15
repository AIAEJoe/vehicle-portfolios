// POST /api/platform/a2p {dealership_id, action, area_code?} — platform operators only.
// actions: provision | run | refresh | buy_number
import { json, handle, HttpError, sb, enc, requirePlatformAdmin, siteOrigin } from '../../_lib/util.js';
import { provision, runSteps, buyNumber, missingFields } from '../../_lib/a2p.js';
import { webhookBase } from '../../_lib/messaging.js';

export const onRequestPost = handle(async ({ request, env }) => {
  await requirePlatformAdmin(request, env);
  const b = await request.json().catch(() => ({}));
  const [dealership] = await sb(env, `/rest/v1/dealerships?id=eq.${enc(b.dealership_id)}&select=*`);
  if (!dealership) throw new HttpError(404, 'Dealership not found');
  let [profile] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${dealership.id}&select=*`);
  // Registration URLs (privacy/terms) must be the dealership's public site
  const origin = `https://${dealership.slug}.${env.ROOT_DOMAIN || 'aiautoengine.com'}`;
  const hooks = webhookBase(env, siteOrigin(request));

  switch (b.action) {
    case 'provision':
      profile = await provision(env, { dealership, profile, webhookBase: hooks });
      return json({ ok: true, profile: strip(profile) });
    case 'run':
    case 'refresh': {
      if (b.action === 'refresh' && !['wait_brand', 'wait_campaign'].includes(profile.a2p_step)) {
        return json({ ok: true, profile: strip(profile), note: 'Nothing waiting on Twilio review' });
      }
      const out = await runSteps(env, { dealership, profile, webhookBase: hooks, origin, maxSteps: b.action === 'refresh' ? 1 : 25 });
      return json({ ok: true, profile: strip(out.profile), ran: out.ran });
    }
    case 'buy_number':
      profile = await buyNumber(env, { dealership, profile, areaCode: String(b.area_code || '').replace(/\D/g, '').slice(0, 3) });
      return json({ ok: true, profile: strip(profile) });
    case 'check':
      return json({ ok: true, missing: missingFields(profile) });
    default:
      throw new HttpError(400, 'Unknown action');
  }
});

const strip = (p) => p; // profiles hold SIDs only; secrets live in provider_credentials
