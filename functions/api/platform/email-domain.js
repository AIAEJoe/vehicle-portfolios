// POST /api/platform/email-domain {dealership_id, action: 'create'|'verify'|'remove', domain?}
// Dealership admins (for their own store) or platform operators. Uses Resend's Domains API.
import { json, handle, HttpError, sb, enc, requireDealerAccess } from '../../_lib/util.js';

async function resend(env, method, path, body) {
  if (!env.RESEND_API_KEY) throw new HttpError(500, 'RESEND_API_KEY is not set');
  const res = await fetch(`https://api.resend.com${path}`, {
    method, headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, data.message || `Resend error ${res.status}`);
  return data;
}

const STATUS = { not_started: 'pending', pending: 'pending', verified: 'verified', failed: 'failed', temporary_failure: 'temporary_failure' };

export const onRequestPost = handle(async ({ request, env }) => {
  const b = await request.json().catch(() => ({}));
  await requireDealerAccess(request, env, b.dealership_id, ['owner', 'admin']);
  const [profile] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${enc(b.dealership_id)}&select=*`);
  if (!profile) throw new HttpError(404, 'Dealership not found');
  const patch = (body) => sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${profile.dealership_id}`, { method: 'PATCH', prefer: 'return=representation', body }).then((r) => r[0]);

  if (b.action === 'create') {
    const domain = String(b.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) throw new HttpError(400, 'Enter a domain like mail.yourdealership.com');
    if (profile.resend_domain_id) await resend(env, 'DELETE', `/domains/${profile.resend_domain_id}`).catch(() => {});
    const d = await resend(env, 'POST', '/domains', { name: domain });
    const row = await patch({ email_domain: domain, resend_domain_id: d.id, email_domain_status: STATUS[d.status] || 'pending', email_dns_records: d.records || [] });
    return json({ ok: true, profile: row });
  }
  if (!profile.resend_domain_id) throw new HttpError(400, 'Add a sending domain first');
  if (b.action === 'verify') {
    await resend(env, 'POST', `/domains/${profile.resend_domain_id}/verify`).catch(() => {});
    const d = await resend(env, 'GET', `/domains/${profile.resend_domain_id}`);
    const row = await patch({ email_domain_status: STATUS[d.status] || 'pending', email_dns_records: d.records || profile.email_dns_records });
    return json({ ok: true, profile: row });
  }
  if (b.action === 'remove') {
    await resend(env, 'DELETE', `/domains/${profile.resend_domain_id}`).catch(() => {});
    const row = await patch({ email_domain: null, resend_domain_id: null, email_domain_status: 'none', email_dns_records: null });
    return json({ ok: true, profile: row });
  }
  throw new HttpError(400, 'Unknown action');
});
