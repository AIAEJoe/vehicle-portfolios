// Twilio REST helpers. Every dealership sends through its own subaccount;
// staff alerts go through the platform's own sender. Credentials never leave the server.
import { HttpError, sb, enc } from './util.js';
import { decryptSecret } from './crypto.js';

export const API = 'https://api.twilio.com/2010-04-01';
export const MESSAGING = 'https://messaging.twilio.com/v1';
export const TRUSTHUB = 'https://trusthub.twilio.com/v1';

export class TwilioError extends HttpError {
  constructor(status, message, code, moreInfo) {
    super(status >= 500 ? 502 : status, message);
    this.code = code;
    this.moreInfo = moreInfo;
  }
}

/** creds: { sid, token } */
export async function twilio(creds, method, url, params = null, headers = {}) {
  let body;
  if (params && method !== 'GET') {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => form.append(k, String(x)));
      else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    body = form.toString();
  } else if (params && method === 'GET') {
    const q = new URLSearchParams(params).toString();
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: 'Basic ' + btoa(`${creds.sid}:${creds.token}`),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    throw new TwilioError(res.status, (data && data.message) || `Twilio error ${res.status}`, data && data.code, data && data.more_info);
  }
  return data;
}

export function platformCreds(env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
}

/** Loads a dealership's messaging profile and its decrypted subaccount credentials. */
export async function dealerTwilio(env, dealershipId) {
  const [profile] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${enc(dealershipId)}&select=*`);
  const [cred] = await sb(env, `/rest/v1/provider_credentials?dealership_id=eq.${enc(dealershipId)}&provider=eq.twilio&select=*`);
  const creds = cred ? { sid: cred.account_sid, token: await decryptSecret(env, cred.secret_encrypted) } : null;
  return { profile: profile || null, creds };
}

// ---------- segments ----------
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';

/** How many billable SMS segments a body will use (GSM-7 vs UCS-2). */
export function smsSegments(body) {
  const s = String(body || '');
  let gsm = true;
  let len = 0;
  for (const ch of s) {
    if (GSM.includes(ch)) len += 1;
    else if (GSM_EXT.includes(ch)) len += 2;
    else { gsm = false; break; }
  }
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  const units = s.length; // UTF-16 code units
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT-OUT', 'OPT OUT'];
export const START_WORDS = ['START', 'UNSTOP', 'YES'];
export const HELP_WORDS = ['HELP', 'INFO'];

/** Classifies an inbound text. Prefers Twilio's OptOutType when Advanced Opt-Out is on. */
export function keywordOf(body, optOutType) {
  const t = String(optOutType || '').toUpperCase();
  if (t === 'STOP' || t === 'START' || t === 'HELP') return t;
  const w = String(body || '').trim().toUpperCase().replace(/[.!\s]+$/g, '');
  if (STOP_WORDS.includes(w)) return 'STOP';
  if (START_WORDS.includes(w)) return 'START';
  if (HELP_WORDS.includes(w)) return 'HELP';
  return null;
}

export const FINAL_STATUSES = ['delivered', 'undelivered', 'failed', 'received', 'canceled'];
const ORDER = { queued: 1, accepted: 1, sending: 2, sent: 3, delivered: 4, undelivered: 4, failed: 4, canceled: 4, received: 4 };
export function laterStatus(current, next) {
  return (ORDER[next] || 0) >= (ORDER[current] || 0);
}
