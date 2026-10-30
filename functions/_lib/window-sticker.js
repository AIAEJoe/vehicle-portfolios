// Original factory window stickers (Monroney labels) by VIN.
// GM, Ford/Lincoln and Stellantis publish the original sticker PDF at public URLs that take a VIN. Other brands
// (Toyota, Honda, Kia…) don't; for those a paid sticker service can be plugged in (VinAudit is supported when
// VINAUDIT_API_KEY is set). Nothing here invents or redraws a sticker: we store the manufacturer's own PDF.

const GM = ['chevrolet', 'chevy', 'gmc', 'buick', 'cadillac'];
const FORD = ['ford', 'lincoln'];
const STELLANTIS = { jeep: 'www.jeep.com', ram: 'www.ramtrucks.com', dodge: 'www.dodge.com', chrysler: 'www.chrysler.com',
  fiat: 'www.fiatusa.com', 'alfa romeo': 'www.alfaromeousa.com' };
// World manufacturer identifiers, for vehicles saved without a make.
const WMI = [[/^(1G[1-9A-Z]|2G[1-9A-Z]|3G[1-9A-Z]|KL[1-9A-Z])/, 'gm'], [/^(1F|2F|3F|5LM|1LN|NM0)/, 'ford'],
  [/^(1C4|1C6|2C4|2C3|3C4|3C6|1C3|2C7|3C7|ZAC|ZFB|1J4|1J8|1D7|3D7)/, 'stellantis']];

export function oemSource(vin, make) {
  const m = String(make || '').trim().toLowerCase();
  let group = GM.includes(m) ? 'gm' : FORD.includes(m) ? 'ford' : m in STELLANTIS ? 'stellantis' : null;
  if (!group) { const hit = WMI.find(([re]) => re.test(vin)); group = hit ? hit[1] : null; }
  const v = encodeURIComponent(vin);
  if (group === 'gm') return { brand: 'GM', url: `https://cws.gm.com/vs-cws/vehshop/v2/vehicle/windowsticker?vin=${v}` };
  if (group === 'ford') return { brand: 'Ford', url: `https://www.windowsticker.forddirect.com/windowsticker.pdf?vin=${v}` };
  if (group === 'stellantis') return { brand: 'Stellantis', url: `https://${STELLANTIS[m] || 'www.chrysler.com'}/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}` };
  return null;
}

export function providerSource(vin, env) {
  if (!env.VINAUDIT_API_KEY) return null;
  return { brand: 'VinAudit', url: `https://windowstickers.vinaudit.com/v1/windowsticker?vin=${encodeURIComponent(vin)}&key=${encodeURIComponent(env.VINAUDIT_API_KEY)}&format=pdf+json`, provider: true };
}

const MAX_BYTES = 15 * 1024 * 1024;

/** Downloads a sticker PDF. Returns { ok, bytes } or { ok: false, message }. Only real PDFs are accepted. */
export async function downloadSticker(src, { timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(src.url, {
      headers: { accept: 'application/pdf,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, message: `${src.brand} didn't answer (${e.name === 'TimeoutError' ? 'timed out' : 'network error'})` };
  }
  if (!res.ok) return { ok: false, message: `${src.brand} has no sticker for this VIN (${res.status})` };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { ok: false, message: 'The sticker file is too large' };
  const head = new TextDecoder().decode(buf.slice(0, 1024));
  if (!head.startsWith('%PDF')) {
    let message = `${src.brand} has no sticker on file for this VIN`;
    try { const j = JSON.parse(new TextDecoder().decode(buf)); if (j && j.message) message = `${src.brand}: ${j.message}`; } catch { /* not JSON */ }
    return { ok: false, message };
  }
  if (buf.length < 2048) return { ok: false, message: `${src.brand} returned an empty sticker for this VIN` };
  return { ok: true, bytes: buf };
}
