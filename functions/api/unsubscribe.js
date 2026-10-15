// GET/POST /api/unsubscribe?t=<signed token> — one-click email unsubscribe (RFC 8058).
import { sb, escapeHtml } from '../_lib/util.js';
import { verifyToken } from '../_lib/crypto.js';
import { recordConsent } from '../_lib/messaging.js';

async function unsubscribe(request, env) {
  const t = new URL(request.url).searchParams.get('t');
  const p = await verifyToken(env, t);
  if (!p || !p.c || !p.d) return page('This unsubscribe link is not valid.', 400);
  const [c] = await sb(env, `/rest/v1/customers?id=eq.${p.c}&dealership_id=eq.${p.d}&select=id,email_opted_out`);
  const [d] = await sb(env, `/rest/v1/dealerships?id=eq.${p.d}&select=name`);
  if (!c || !d) return page('This unsubscribe link has expired.', 404);
  if (!c.email_opted_out) {
    await recordConsent(env, { dealership_id: p.d, customer_id: c.id, channel: 'email', action: 'opt_out', method: 'email_unsubscribe',
      ip_address: request.headers.get('cf-connecting-ip'), user_agent: (request.headers.get('user-agent') || '').slice(0, 300) });
  }
  return page(`You're unsubscribed. ${d.name} won't email you again from Vehicle Portfolios.`);
}

function page(msg, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center">
<h1 style="font-size:22px">${escapeHtml(msg)}</h1></body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export const onRequestGet = ({ request, env }) => unsubscribe(request, env);
export const onRequestPost = ({ request, env }) => unsubscribe(request, env);
