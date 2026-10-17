// Minimal S3 GET with AWS Signature V4 (no SDK). Used to read feed files that land in
// SFTP To Go, whose storage is an S3 bucket reachable with the account's root access keys.

const te = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(data) { return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? te.encode(data) : data)); }
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? te.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, te.encode(msg));
}
// S3 object keys: encode each path segment, keep the slashes.
export const encodeKey = (key) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

export async function signedS3Request({ method = 'GET', bucket, key, region, accessKeyId, secretAccessKey, now = new Date() }) {
  const host = region === 'us-east-1' ? `${bucket}.s3.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`;
  const path = '/' + encodeKey(key.replace(/^\/+/, ''));
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let k = await hmac('AWS4' + secretAccessKey, date);
  k = await hmac(k, region); k = await hmac(k, 's3'); k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, toSign));
  return {
    url: `https://${host}${path}`,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** GET an object; follows S3's "wrong region" answer once. Returns the Response. */
export async function s3Get(opts, fetchImpl = fetch) {
  let region = opts.region || 'us-east-1';
  for (let attempt = 0; attempt < 2; attempt++) {
    const { url, headers } = await signedS3Request({ ...opts, region });
    const res = await fetchImpl(url, { headers });
    const actual = res.headers.get('x-amz-bucket-region');
    if ((res.status === 301 || res.status === 400) && actual && actual !== region) { region = actual; continue; }
    return res;
  }
  throw new Error('Could not reach the SFTP storage bucket');
}
