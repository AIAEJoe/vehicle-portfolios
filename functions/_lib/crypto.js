// Web Crypto helpers: secret encryption at rest, signed tokens, webhook signature checks.
import { HttpError } from './util.js';

const te = new TextEncoder();
const td = new TextDecoder();

export function b64encode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const b64url = (bytes) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export function timingSafeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function aesKey(env) {
  if (!env.ENCRYPTION_KEY) throw new HttpError(500, 'Server is missing configuration: ENCRYPTION_KEY');
  const raw = b64decode(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new HttpError(500, 'ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypts a provider secret for storage. Format: v1:<base64(iv|ciphertext)> */
export async function encryptSecret(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), te.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return 'v1:' + b64encode(out);
}

export async function decryptSecret(env, stored) {
  if (!String(stored).startsWith('v1:')) throw new HttpError(500, 'Unknown secret format');
  const data = b64decode(stored.slice(3));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await aesKey(env), data.slice(12));
  return td.decode(pt);
}

async function hmac(alg, keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: alg }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof message === 'string' ? te.encode(message) : message));
}

/** Small signed token (for unsubscribe links). */
export async function signToken(env, payload) {
  const body = b64url(te.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac('SHA-256', te.encode('tok:' + (env.ENCRYPTION_KEY || '')), body));
  return `${body}.${sig}`;
}
export async function verifyToken(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = b64url(await hmac('SHA-256', te.encode('tok:' + (env.ENCRYPTION_KEY || '')), body));
  if (!timingSafeEqual(sig, expect)) return null;
  try { return JSON.parse(td.decode(fromB64url(body))); } catch { return null; }
}

/**
 * Twilio request validation: HMAC-SHA1(authToken, url + sorted(key+value)) in base64.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return b64encode(await hmac('SHA-1', te.encode(authToken), data));
}
export async function validTwilioRequest(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  return timingSafeEqual(await twilioSignature(authToken, url, params), signature);
}

/**
 * Resend webhooks are signed with Svix: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)).
 */
export async function validSvixRequest(secret, headers, body, now = Date.now()) {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature') || '';
  if (!secret || !id || !ts || !sigHeader) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = b64decode(String(secret).replace(/^whsec_/, ''));
  const expected = b64encode(await hmac('SHA-256', key, `${id}.${ts}.${body}`));
  return sigHeader.split(' ').some((part) => timingSafeEqual(part.split(',')[1], expected));
}
