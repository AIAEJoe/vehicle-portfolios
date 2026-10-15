// "Send to Vehicle Portfolios" bookmarklet.
// Runs on a dealer-website vehicle page in the staff member's own browser (where bot
// protection doesn't block it), reads the vehicle details + photos, and opens the
// dashboard's Add-a-vehicle page with them.

/* eslint-disable no-alert */
export function grabVehicle(target) {
  const ld = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    ld.push(x);
    if (x['@graph']) walk(x['@graph']);
    if (x.itemOffered) walk(x.itemOffered);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { walk(JSON.parse(s.textContent)); } catch (e) { /* skip */ } });
  const types = (n) => [].concat(n['@type'] || []).map((t) => String(t).toLowerCase());
  const car = ld.find((n) => types(n).some((t) => t === 'car' || t === 'vehicle'))
    || ld.find((n) => types(n).includes('product') && (n.vehicleIdentificationNumber || n.mileageFromOdometer));
  const tx = (v) => (v == null ? null : typeof v === 'object' ? tx(Array.isArray(v) ? v[0] : (v.name != null ? v.name : v.value)) : (String(v).trim() || null));
  const num = (v) => { const t = tx(v); if (!t) return null; const n = Number(t.replace(/[^0-9.]/g, '')); return n > 0 ? n : null; };
  const o = { listing_url: location.href, photos: [] };
  if (car) {
    const offer = [].concat(car.offers || [])[0] || {};
    Object.assign(o, {
      vin: tx(car.vehicleIdentificationNumber), year: num(car.vehicleModelDate || car.modelDate || car.productionDate),
      make: tx(car.brand || car.manufacturer), model: tx(car.model), trim: tx(car.vehicleConfiguration), body_style: tx(car.bodyType),
      exterior_color: tx(car.color), interior_color: tx(car.vehicleInteriorColor), engine: tx(car.vehicleEngine),
      transmission: tx(car.vehicleTransmission), drivetrain: tx(car.driveWheelConfiguration), fuel_type: tx(car.fuelType),
      mileage: num(car.mileageFromOdometer), stock_number: tx(car.sku || car.productID),
      price: num(offer.price || (offer.priceSpecification && offer.priceSpecification.price)), name: tx(car.name),
      description: (tx(car.description) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) || null,
    });
    const cond = tx(car.itemCondition || offer.itemCondition) || '';
    if (/new/i.test(cond)) o.condition = 'new'; else if (/used/i.test(cond)) o.condition = 'used';
    [].concat(car.image || []).forEach((i) => o.photos.push(typeof i === 'string' ? i : i && (i.url || i.contentUrl)));
  }
  const body = document.body.innerText;
  if (!o.vin) { const m = body.match(/VIN[:#\s]*([A-HJ-NPR-Z0-9]{17})/i); if (m) o.vin = m[1]; }
  if (!o.stock_number) { const m = body.match(/Stock\s*(?:#|No\.?|Number)?[:\s]*([A-Z0-9-]{3,15})\b/i); if (m) o.stock_number = m[1]; }
  if (!o.mileage) { const m = body.match(/([\d,]{1,7})\s*(?:miles|mi\.)/i); if (m) o.mileage = Number(m[1].replace(/,/g, '')); }
  if (!o.year || !o.make) {
    const t = String(o.name || document.title).match(/\b((?:19|20)\d{2})\s+([A-Za-z-]+)\s+([A-Za-z0-9-]+)/);
    if (t) { o.year = o.year || Number(t[1]); o.make = o.make || t[2]; o.model = o.model || t[3]; }
  }
  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) o.photos.push(og.content);
  const cdn = /pictures\.dealer\.com|dealerinspire|homenetiol|dealeron|vehicle-photos|inventory-photos|dealerphotos|images\.dealer|di-uploads|cloudfront\.net/i;
  document.querySelectorAll('img').forEach((i) => {
    const u = i.currentSrc || i.src || i.getAttribute('data-src') || i.getAttribute('data-lazy');
    if (!u || !/\.(jpe?g|png|webp)/i.test(u) || /logo|icon|badge|sprite|carfax|autocheck|placeholder/i.test(u)) return;
    if ((i.naturalWidth || 0) >= 400 || cdn.test(u)) o.photos.push(u);
  });
  const seen = new Set();
  o.photos = o.photos.filter(Boolean).map((u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } })
    .filter((u) => { if (!u) return false; const k = u.replace(/[?#].*$/, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 60);
  if (!o.vin && !o.make) { alert('No vehicle found on this page. Open one vehicle\'s page and click the button again.'); return null; }
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  window.open(`${target}/admin/vehicles/new#import=${encodeURIComponent(payload)}`, '_blank');
  return o;
}

export function bookmarkletHref(origin) {
  return 'javascript:' + encodeURIComponent(`(${grabVehicle.toString()})(${JSON.stringify(origin)})`);
}

export function decodeImport(hash) {
  const m = String(hash || '').match(/^#import=(.+)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); } catch { return null; }
}
