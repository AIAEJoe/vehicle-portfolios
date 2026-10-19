// Best-effort import of a vehicle from a dealer website listing page.
// Reads schema.org JSON-LD (used by Dealer.com, Dealer Inspire, DealerOn, etc.),
// Open Graph tags, and falls back to pattern matching for VIN/price/mileage.

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function flattenLd(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return out; }
  out.push(node);
  if (node['@graph']) flattenLd(node['@graph'], out);
  if (node.itemOffered) flattenLd(node.itemOffered, out);
  return out;
}

function typeOf(n) {
  const t = n['@type'];
  return (Array.isArray(t) ? t : [t]).map((x) => String(x || '').toLowerCase());
}

function asText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim() || null;
  if (Array.isArray(v)) return asText(v[0]);
  if (typeof v === 'object') return asText(v.name ?? v.value ?? v['@value']);
  return null;
}

function asNumber(v) {
  const t = asText(v);
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function images(v) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.map((i) => (typeof i === 'string' ? i : i && (i.url || i.contentUrl))).filter(Boolean);
}

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]) : null;
}

// Anywhere in the URL ("dealerlogo.png"), plus whole words that would be too broad as substrings.
const NOT_A_VEHICLE_PHOTO = /logo|icon|badge|sprite|placeholder|carfax|autocheck|banner|promo|incentive|coupon|(?:^|[^a-z])(?:specials?|offers?|buttons?|header|footer|staff|employees?|awards?)(?:[^a-z]|$)/i;

/** "Used 2026 Chevrolet Corvette Stingray 2LT Convertible" -> "2LT" (year/make/model/body are shown separately). */
function cleanTrim({ trim, year, make, model, body_style: body }) {
  if (!trim) return trim;
  const word = (s) => new RegExp(`\\b${String(s).replace(/[^\w ]/g, '').replace(/\s+/g, '\\s+')}\\b`, 'i');
  let t = String(trim).replace(/^(used|new|certified|pre-owned)\s+/i, '');
  if (year) t = t.replace(word(year), '');
  if (make) t = t.replace(word(make), '');
  if (model) t = t.replace(word(model), '');
  if (body) t = t.replace(new RegExp(`${word(body).source}\\s*$`, 'i'), '');
  return t.replace(/\s+/g, ' ').trim() || null;
}

export function parseListing(html, pageUrl) {
  const out = { photos: [], features: [], specs: {} };
  const ld = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { flattenLd(JSON.parse(m[1].trim()), ld); } catch { /* ignore malformed blocks */ }
  }
  const car = ld.find((n) => typeOf(n).some((t) => ['car', 'vehicle', 'motorizedbicycle'].includes(t)))
    || ld.find((n) => typeOf(n).includes('product') && (n.vehicleIdentificationNumber || n.mileageFromOdometer || n.brand));

  if (car) {
    out.vin = asText(car.vehicleIdentificationNumber);
    out.year = asNumber(car.vehicleModelDate || car.modelDate || car.productionDate);
    out.make = asText(car.brand || car.manufacturer);
    out.model = asText(car.model);
    out.trim = asText(car.vehicleConfiguration);
    out.body_style = asText(car.bodyType);
    out.exterior_color = asText(car.color);
    out.interior_color = asText(car.vehicleInteriorColor);
    out.engine = asText(car.vehicleEngine && (car.vehicleEngine.name || car.vehicleEngine.engineType || car.vehicleEngine));
    out.transmission = asText(car.vehicleTransmission);
    out.drivetrain = asText(car.driveWheelConfiguration);
    out.fuel_type = asText(car.fuelType);
    out.mileage = asNumber(car.mileageFromOdometer);
    out.stock_number = asText(car.sku || car.productID);
    out.description = asText(car.description) && stripTags(asText(car.description));
    const offers = Array.isArray(car.offers) ? car.offers[0] : car.offers;
    if (offers) out.price = asNumber(offers.price || (offers.priceSpecification && offers.priceSpecification.price));
    const cond = asText(car.itemCondition || (offers && offers.itemCondition)) || '';
    if (/new/i.test(cond)) out.condition = 'new';
    else if (/used/i.test(cond)) out.condition = 'used';
    out.photos.push(...images(car.image));
    if (!out.year && car.name) {
      const y = String(car.name).match(/\b(19|20)\d{2}\b/);
      if (y) out.year = Number(y[0]);
    }
    out.name = asText(car.name);
  }

  const text = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));
  if (!out.vin) { const v = text.match(/VIN[:#\s]*([A-HJ-NPR-Z0-9]{17})/i) || html.match(VIN_RE); if (v) out.vin = v[1]; }
  if (!out.stock_number) { const s = text.match(/Stock\s*(?:#|No\.?|Number)?[:\s]*([A-Z0-9-]{3,15})\b/i); if (s) out.stock_number = s[1]; }
  if (!out.mileage) { const mi = text.match(/([\d,]{1,7})\s*(?:miles|mi\.)\b/i) || text.match(/Mileage[:\s]*([\d,]+)/i); if (mi) out.mileage = asNumber(mi[1]); }
  if (!out.price) { const p = meta(html, 'product:price:amount') || meta(html, 'og:price:amount'); if (p) out.price = asNumber(p); }

  const ogTitle = meta(html, 'og:title');
  out.name = out.name || ogTitle || stripTags((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!out.year || !out.make) {
    const t = String(out.name || '').match(/\b((?:19|20)\d{2})\s+([A-Za-z-]+)\s+([A-Za-z0-9-]+)(?:\s+([^|,\-–]+))?/);
    if (t) {
      out.year = out.year || Number(t[1]);
      out.make = out.make || t[2];
      out.model = out.model || t[3];
      out.trim = out.trim || (t[4] && t[4].trim().split(/\s{2,}/)[0]);
    }
  }

  const og = meta(html, 'og:image');
  if (og) out.photos.push(og);
  // Common dealer-platform photo CDNs, in page order. Dealer sites host their promo banners
  // ("Lower prices start here", specials, staff photos) on the same CDN, so skip obvious ones.
  const vinPhotos = [];
  for (const m of html.matchAll(/https?:\/\/[^"'\s>)]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s>)]*)?/gi)) {
    const u = decodeEntities(m[0]);
    if (out.vin && u.toUpperCase().includes(String(out.vin).toUpperCase())) vinPhotos.push(u);
    if (/pictures\.dealer\.com|dealerinspire|homenetiol|cdn-ds|dealeron|vehicle-photos|inventory-photos|dealerphotos|getedealer|carsforsale|cloudfront\.net\/.*(?:vehicle|inventory)|images\.dealer|di-uploads/i.test(u)
        && !NOT_A_VEHICLE_PHOTO.test(u)) {
      out.photos.push(u);
    }
  }
  // When the site names this car's photos by its VIN, use exactly those (skips banners, logos
  // and "similar vehicles").
  if (vinPhotos.length >= 2) out.photos = vinPhotos;
  const base = pageUrl || undefined;
  const seen = new Set();
  out.photos = out.photos
    .map((u) => { try { return new URL(u, base).toString(); } catch { return null; } })
    .filter((u) => {
      if (!u) return false;
      const key = u.replace(/[?#].*$/, '').replace(/\/(?:thumb|small|medium|large|\d+x\d+)\//i, '/');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 60);

  if (out.vin) out.vin = out.vin.toUpperCase();
  out.trim = cleanTrim(out);
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined || out[k] === '') delete out[k];
  out.listing_url = pageUrl;
  return out;
}
