// Cloudflare Email Worker for reply.aiautoengine.com
// Customer email replies arrive at <dealer-alias>[+<customer>]@reply.aiautoengine.com.
// The worker logs each reply in that dealership's message history and forwards the
// original email to the salesperson (or the dealership's reply inbox).
export default {
  async email(message, env) {
    let text = '';
    try {
      const raw = await new Response(message.raw).text();
      text = plainText(raw).slice(0, 5000);
    } catch { /* body is optional */ }
    const res = await fetch(`${env.APP_URL}/api/email/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inbound-secret': env.INBOUND_EMAIL_SECRET },
      body: JSON.stringify({
        to: message.to,
        from: message.from,
        subject: message.headers.get('subject') || '',
        message_id: message.headers.get('message-id') || '',
        text,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.forward_to) {
      message.setReject('Unknown recipient');
      return;
    }
    await message.forward(data.forward_to);
  },
};

// Very small text extractor: first text/plain part, quoted-printable decoded, quoted history removed.
export function plainText(raw) {
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/);
  let body = null;
  for (const p of parts) {
    if (/content-type:\s*text\/plain/i.test(p)) { body = p; break; }
  }
  if (body === null) body = raw;
  const idx = body.search(/\r?\n\r?\n/);
  const headers = idx >= 0 ? body.slice(0, idx) : '';
  let content = idx >= 0 ? body.slice(idx).trim() : body;
  if (/quoted-printable/i.test(headers)) {
    content = content.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  } else if (/base64/i.test(headers)) {
    try { content = atob(content.replace(/\s+/g, '')); } catch { /* leave as is */ }
  }
  const lines = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^On .+wrote:$/.test(line.trim()) || /^-+\s*Original Message/i.test(line)) break;
    if (line.startsWith('>')) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}
