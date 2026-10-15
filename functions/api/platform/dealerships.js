// POST /api/platform/dealerships {name, slug, phone, website, address_line, city, state, zip, owner_email?} — operators only.
import { json, handle, HttpError, sb, requirePlatformAdmin, enc } from '../../_lib/util.js';

export const onRequestPost = handle(async ({ request, env }) => {
  await requirePlatformAdmin(request, env);
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || ['www', 'app', 'api', 'admin', 'platform', 'mail', 'reply'].includes(slug)) {
    throw new HttpError(400, 'Subdomain must be 2-40 lowercase letters, numbers or dashes');
  }
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Dealership name is required');
  const exists = await sb(env, `/rest/v1/dealerships?slug=eq.${enc(slug)}&select=id`);
  if (exists.length) throw new HttpError(409, `${slug}.${env.ROOT_DOMAIN || 'aiautoengine.com'} is already taken`);
  const pick = (k) => (b[k] ? String(b[k]).trim() : null);
  const [d] = await sb(env, '/rest/v1/dealerships', {
    method: 'POST', prefer: 'return=representation',
    body: { slug, name: pick('name'), phone: pick('phone'), sms_phone: pick('phone'), website: pick('website'), address_line: pick('address_line'),
            city: pick('city'), state: pick('state'), zip: pick('zip'), timezone: pick('timezone') || 'America/New_York' },
  });

  let invited = null;
  const email = String(b.owner_email || '').trim().toLowerCase();
  if (email) {
    const host = `https://${slug}.${env.ROOT_DOMAIN || 'aiautoengine.com'}`;
    try {
      const u = await sb(env, `/auth/v1/invite?redirect_to=${enc(host + '/admin/account')}`, { method: 'POST', body: { email, data: { dealership: slug } } });
      await sb(env, '/rest/v1/dealership_members', { method: 'POST', body: { dealership_id: d.id, user_id: u.id, role: 'owner' } });
      invited = email;
    } catch (err) {
      invited = `not sent: ${err.message}`;
    }
  }
  return json({ ok: true, dealership: d, invited });
});
