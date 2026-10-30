// POST /api/invite {email, role, staff_id?} — admins invite a teammate to the dashboard.
import { json, handle, HttpError, sb, getDealership, dealerSlugFromRequest, requireUser, siteOrigin, enc } from '../_lib/util.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const { user } = await requireUser(request, env, dealership.id, ['owner', 'admin']);
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const role = ['admin', 'sales', 'photographer'].includes(body.role) ? body.role : 'sales';
  if (role === 'admin' && user.vp_role !== 'owner' && user.vp_role !== 'admin') throw new HttpError(403, 'Only admins can add admins');

  let userId = null;
  let invited = false;
  try {
    const redirect = enc(`${siteOrigin(request)}/admin/account`);
    const created = await sb(env, `/auth/v1/invite?redirect_to=${redirect}`, {
      method: 'POST',
      body: { email, data: { dealership: dealership.slug } },
    });
    userId = created && (created.id || (created.user && created.user.id));
    invited = true;
  } catch (err) {
    if (!/already|registered|exists/i.test(err.message)) throw err;
    // Existing user: look them up and just add the membership
    for (let page = 1; page <= 20 && !userId; page++) {
      const list = await sb(env, `/auth/v1/admin/users?page=${page}&per_page=200`);
      const users = (list && list.users) || [];
      const found = users.find((u) => String(u.email || '').toLowerCase() === email);
      if (found) userId = found.id;
      if (users.length < 200) break;
    }
  }
  if (!userId) throw new HttpError(500, 'Could not create the user');

  await sb(env, '/rest/v1/dealership_members?on_conflict=dealership_id,user_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: { dealership_id: dealership.id, user_id: userId, role },
  });
  if (body.staff_id) {
    await sb(env, `/rest/v1/staff?id=eq.${enc(body.staff_id)}&dealership_id=eq.${dealership.id}`, {
      method: 'PATCH', body: { user_id: userId },
    });
  }
  return json({ ok: true, invited, user_id: userId });
});
