// Shared helpers for Cloudflare Pages Functions (no npm dependencies).

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function requireEnv(env, ...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new HttpError(500, `Server is missing configuration: ${missing.join(', ')}`);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handle(fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || 'Server error' }, status);
    }
  };
}

/** Which dealership a request is for, based on the host name. */
export function dealerSlugFromHost(host, env = {}) {
  host = String(host || '').toLowerCase().split(':')[0];
  const root = String(env.ROOT_DOMAIN || 'aiautoengine.com').toLowerCase();
  if (host.endsWith('.' + root)) {
    const sub = host.slice(0, -(root.length + 1)).split('.').pop();
    if (sub && sub !== 'www' && sub !== 'app') return sub;
  }
  return env.DEFAULT_DEALER || 'nsbchevy';
}

export function dealerSlugFromRequest(request, env) {
  const url = new URL(request.url);
  return url.searchParams.get('dealer') || dealerSlugFromHost(url.host, env);
}

/** Minimal PostgREST client. role: 'service' | 'anon' | a user JWT string. */
export async function sb(env, path, { method = 'GET', body, role = 'service', headers = {}, prefer } = {}) {
  requireEnv(env, 'SUPABASE_URL', 'SUPABASE_ANON_KEY');
  let key = env.SUPABASE_ANON_KEY;
  let bearer = env.SUPABASE_ANON_KEY;
  if (role === 'service') {
    requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    key = bearer = env.SUPABASE_SERVICE_ROLE_KEY;
  } else if (role !== 'anon') {
    bearer = role;
  }
  // New-style keys (sb_publishable_…/sb_secret_…) aren't JWTs: send them only as apikey.
  const authHeader = String(bearer).startsWith('sb_') ? {} : { authorization: `Bearer ${bearer}` };
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      apikey: key,
      ...authHeader,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `Supabase error ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : res.status, msg);
  }
  return data;
}

export const enc = encodeURIComponent;

export async function getDealership(env, slug) {
  const rows = await sb(env, `/rest/v1/dealerships?slug=eq.${enc(slug)}&select=*`);
  if (!rows || !rows.length) throw new HttpError(404, `Unknown dealership "${slug}"`);
  return rows[0];
}

export async function getSettings(env, dealershipId) {
  const rows = await sb(env, `/rest/v1/dealership_settings?dealership_id=eq.${dealershipId}&select=*`);
  return (rows && rows[0]) || {};
}

/** Verifies the caller's Supabase session and (optionally) their role at a dealership. */
export async function requireUser(request, env, dealershipId, roles = ['owner', 'admin', 'sales']) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in required');
  const user = await sb(env, '/auth/v1/user', { role: token }).catch(() => null);
  if (!user || !user.id) throw new HttpError(401, 'Your session has expired. Sign in again.');
  if (dealershipId) {
    const rows = await sb(env,
      `/rest/v1/dealership_members?user_id=eq.${user.id}&dealership_id=eq.${dealershipId}&select=role`);
    let role = rows && rows[0] && rows[0].role;
    if (!role) {
      const ops = await sb(env, `/rest/v1/platform_admins?user_id=eq.${user.id}&select=user_id`);
      if (ops && ops.length) role = 'owner'; // platform operator support access
    }
    if (!role || !roles.includes(role)) throw new HttpError(403, 'You do not have access to this dealership');
    user.vp_role = role;
  }
  return { user, token };
}

export function siteOrigin(request) {
  return new URL(request.url).origin;
}

export function absoluteUrl(url, origin) {
  if (!url) return url;
  try { return new URL(url, origin).toString(); } catch { return url; }
}

export function vehicleTitle(v) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|slack|discord|embedly|skype|linkedin|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|go-http/i;

export async function requirePlatformAdmin(request, env) {
  const { user, token } = await requireUser(request, env, null);
  const rows = await sb(env, `/rest/v1/platform_admins?user_id=eq.${user.id}&select=user_id`);
  if (!rows.length) throw new HttpError(403, 'Platform operators only');
  return { user, token };
}

/** Members of the dealership, or platform operators (support access). */
export async function requireDealerAccess(request, env, dealershipId, roles = ['owner', 'admin', 'sales']) {
  const { user, token } = await requireUser(request, env, null);
  const admin = await sb(env, `/rest/v1/platform_admins?user_id=eq.${user.id}&select=user_id`);
  if (admin.length) { user.vp_role = 'platform'; return { user, token }; }
  const rows = await sb(env, `/rest/v1/dealership_members?user_id=eq.${user.id}&dealership_id=eq.${dealershipId}&select=role`);
  const role = rows[0] && rows[0].role;
  if (!role || !roles.includes(role)) throw new HttpError(403, 'You do not have access to this dealership');
  user.vp_role = role;
  return { user, token };
}

export async function formParams(request) {
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}

export function twiml(xml = '') {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, { headers: { 'content-type': 'text/xml' } });
}
