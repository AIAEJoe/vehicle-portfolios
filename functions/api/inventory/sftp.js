// POST /api/inventory/sftp — SFTP To Go webhook ("file.created").
// Each dealership has its own SFTP login named after its slug (e.g. "nsbchevy") whose home folder
// is /<slug>. When its feed provider (Dealer Inspire, HomeNet, …) uploads a CSV, SFTP To Go calls this
// endpoint; we verify the signature, download the file from SFTP To Go's S3 storage with the platform's
// keys (Cloudflare secrets, never sent to the browser) and run the normal inventory import.
//
// Secrets: SFTPTOGO_WEBHOOK_SECRET, SFTPTOGO_ACCESS_KEY_ID, SFTPTOGO_SECRET_ACCESS_KEY, SFTPTOGO_BUCKET
// Optional var: SFTPTOGO_REGION (default us-east-1; S3 tells us if it's different).

import { handle, sb, enc, getSettings } from '../../_lib/util.js';
import { timingSafeEqual } from '../../_lib/crypto.js';
import { runFeedSync, recordFeedError } from '../../_lib/feed.js';
import { s3Get } from '../../_lib/s3.js';

const te = new TextEncoder();
async function hmacSha256(secret, body) {
  const k = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(body)));
}

/** X-Hub-Signature: "sha256=<hex>" (documented); also accept bare hex or base64 (seen in their samples). */
export async function validSftpToGoSignature(secret, body, header) {
  if (!secret || !header) return false;
  const mac = await hmacSha256(secret, body);
  const hexSig = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(String.fromCharCode(...mac));
  const got = String(header).trim().replace(/^sha256=/i, '');
  return timingSafeEqual(got.toLowerCase(), hexSig) || timingSafeEqual(got, b64);
}

const isFeedFile = (path) => /\.(csv|txt|tsv|dat)$/i.test(path);
const noContent = () => new Response(null, { status: 204 });

async function dealershipFor(env, username, path) {
  const candidates = [username, path.split('/').filter(Boolean)[0]].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const slug of candidates) {
    if (!/^[a-z0-9-]+$/.test(slug)) continue;
    const rows = await sb(env, `/rest/v1/dealerships?slug=eq.${enc(slug)}&select=*`);
    if (rows && rows[0]) return rows[0];
  }
  return null;
}

async function download(env, path, username) {
  const opts = {
    bucket: env.SFTPTOGO_BUCKET, region: env.SFTPTOGO_REGION,
    accessKeyId: env.SFTPTOGO_ACCESS_KEY_ID, secretAccessKey: env.SFTPTOGO_SECRET_ACCESS_KEY,
  };
  // The path may be relative to the bucket or to the SFTP user's home folder.
  const keys = [path, username && !path.startsWith(username + '/') ? `${username}/${path}` : null].filter(Boolean);
  let last;
  for (const key of keys) {
    const res = await s3Get({ ...opts, key });
    if (res.ok) return { text: await res.text(), key };
    last = res.status;
  }
  throw new Error(`Could not download ${path} from SFTP storage (${last})`);
}

export async function processSftpEvent(env, evt) {
  const path = decodeURIComponent(String((evt.Data && evt.Data.Path) || '')).replace(/^\/+/, '');
  const username = evt.Actor && evt.Actor.Type === 'User' ? String(evt.Actor.Id || '') : '';
  if (!path || path.endsWith('/') || !isFeedFile(path)) return { skipped: 'not a feed file', path };
  const dealership = await dealershipFor(env, username, path);
  if (!dealership) return { skipped: 'no dealership matches this SFTP user or folder', path, username };
  const source = `sftp: ${path.split('/').pop()}`;
  try {
    const settings = await getSettings(env, dealership.id);
    const { text } = await download(env, path, username);
    return { dealership: dealership.slug, result: await runFeedSync(env, dealership, settings, text, source) };
  } catch (err) {
    await recordFeedError(env, dealership, err.message, source);
    return { dealership: dealership.slug, error: err.message };
  }
}

export const onRequestPost = handle(async ({ request, env, waitUntil }) => {
  const body = await request.text();
  if (!(await validSftpToGoSignature(env.SFTPTOGO_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature')))) {
    return new Response('invalid signature', { status: 401 });
  }
  let evt;
  try { evt = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
  if (evt.Topic !== 'file.created') return noContent(); // pings, downloads, deletes
  const missing = ['SFTPTOGO_ACCESS_KEY_ID', 'SFTPTOGO_SECRET_ACCESS_KEY', 'SFTPTOGO_BUCKET'].filter((k) => !env[k]);
  if (missing.length) return new Response(`Server is missing ${missing.join(', ')}`, { status: 500 });
  // Answer SFTP To Go right away; the import can take a few seconds for a large inventory.
  const work = processSftpEvent(env, evt).then((r) => console.log('sftp import', JSON.stringify(r))).catch((e) => console.error(e));
  if (typeof waitUntil === 'function') waitUntil(work); else await work;
  return noContent();
});
