// GET /api/health — configuration check (no secrets returned).
import { json } from '../_lib/util.js';

function jwtRole(k) {
  try {
    const p = JSON.parse(atob(String(k).trim().split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.role || null;
  } catch { return null; }
}

export const onRequestGet = async ({ env }) => {
  const anon = String(env.SUPABASE_ANON_KEY || '');
  const svc = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  let enc = 'missing';
  try { if (env.ENCRYPTION_KEY) enc = atob(String(env.ENCRYPTION_KEY).trim()).length === 32 ? 'ok' : 'wrong length'; } catch { enc = 'not base64'; }
  let db = 'not checked';
  if (env.SUPABASE_URL && svc) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/dealerships?select=slug&limit=1`, { headers: { apikey: svc.trim(), authorization: `Bearer ${svc.trim()}` } });
    db = r.ok ? 'ok' : `error ${r.status}`;
  }
  return json({
    supabase_url: !!env.SUPABASE_URL,
    anon_key: anon ? (jwtRole(anon) === 'anon' ? 'ok' : `unexpected (length ${anon.length})`) : 'missing',
    service_role_key: svc ? (jwtRole(svc) === 'service_role' ? 'ok' : `unexpected (length ${svc.length})`) : 'missing',
    service_role_database_access: db,
    encryption_key: enc,
    cron_secret: env.CRON_SECRET ? (String(env.CRON_SECRET).trim().length >= 32 ? 'ok' : 'too short') : 'missing',
    twilio: !!env.TWILIO_ACCOUNT_SID, resend: !!env.RESEND_API_KEY,
  });
};
