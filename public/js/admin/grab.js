// "Send to Vehicle Portfolios" bookmarklet.
// Runs on a dealer-website vehicle page in the staff member's own browser (where bot
// protection doesn't block it), reads the vehicle details + photos, and opens the
// dashboard's Add-a-vehicle page with them.

/* eslint-disable no-alert */
export function grabVehicle(target, win) {
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
      description: (() => { const ta = document.createElement('textarea'); ta.innerHTML = tx(car.description) || ''; return ta.value
        .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, 1500) || null; })(),
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
  // Dealer.com / Dealer Inspire galleries lazy-load most photos; every photo of this car has its VIN in the URL.
  const vinPhotos = [];
  if (o.vin) {
    const re = /https?:\/\/[^"'\s()<>\\]+?\.(?:jpe?g|png|webp)/gi;
    for (const m of document.documentElement.innerHTML.matchAll(re)) {
      if (m[0].toUpperCase().includes(o.vin)) vinPhotos.push(m[0].replace(/&amp;/g, '&').replace(/\/thumbnails\/[a-z]+\//i, '/'));
    }
  }
  // Trim: "Used 1993 Chevrolet Corvette 2DR CPE Coupe" -> "2DR CPE"
  if (o.trim && o.make && o.model) {
    let t = o.trim.replace(/^(used|new|certified|pre-owned)\s+/i, '').replace(String(o.year || ''), '');
    t = t.replace(new RegExp('\\b' + o.make.replace(/[^\w ]/g, '') + '\\b', 'i'), '').replace(new RegExp('\\b' + o.model.replace(/[^\w ]/g, '') + '\\b', 'i'), '');
    if (o.body_style) t = t.replace(new RegExp('\\b' + o.body_style.replace(/[^\w ]/g, '') + '\\s*$', 'i'), '');
    o.trim = t.replace(/\s+/g, ' ').trim() || null;
  }
  // Engine / transmission are often only in the description's first line ("4-Speed Automatic 5.7L V8 16V")
  const first = String(o.description || '').split(/\.\s|\n/)[0];
  if (!o.transmission) { const m = first.match(/\b(\d{1,2}-Speed [A-Za-z/ -]+?|CVT|Automatic|Manual)(?=\s+\d\.\dL|\s*$|,)/i); if (m) o.transmission = m[1].trim(); }
  if (!o.engine) { const m = first.match(/\b(\d\.\dL[^,]*)$/i) || first.match(/\b(\d\.\dL [A-Z0-9 -]+)/i); if (m) o.engine = m[1].trim(); }
  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) o.photos.push(og.content);
  const cdn = /carscommerce|pictures\.dealer\.com|dealerinspire|homenetiol|dealeron|vehicle-photos|inventory-photos|dealerphotos|images\.dealer|di-uploads|cloudfront\.net/i;
  document.querySelectorAll('img').forEach((i) => {
    const u = i.currentSrc || i.src || i.getAttribute('data-src') || i.getAttribute('data-lazy');
    if (!u || !/\.(jpe?g|png|webp)/i.test(u) || /logo|icon|badge|sprite|carfax|autocheck|placeholder/i.test(u)) return;
    if ((i.naturalWidth || 0) >= 400 || cdn.test(u)) o.photos.push(u);
  });
  // When the site names photos by VIN, use exactly those (skips "similar vehicles" and logos).
  if (vinPhotos.length >= 2) o.photos = vinPhotos;
  const seen = new Set();
  o.photos = o.photos.filter(Boolean).map((u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } })
    .filter((u) => { if (!u) return false; const k = u.replace(/[?#].*$/, '').replace(/\/thumbnails\/[a-z]+\//i, '/'); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 60);
  if (!o.vin && !o.make) { if (win) win.close(); alert('No vehicle found on this page. Open one vehicle\'s page and click the button again.'); return null; }
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const url = `${target}/admin/vehicles/new#import=${encodeURIComponent(payload)}`;
  if (win) win.location.href = url; else window.open(url, '_blank');
  return o;
}

/**
 * The bookmark is a small launcher: it loads the latest grab.js from our site (so fixes apply without
 * re-dragging the bookmark) and falls back to the copy embedded in the bookmark if that can't load.
 * The tab is opened first, while the click still counts as a user action, so popup blockers allow it.
 */
export function bookmarkletHref(origin) {
  const O = JSON.stringify(origin);
  return 'javascript:' + encodeURIComponent(`(function(){var O=${O};var w=window.open('about:blank','_blank');`
    + `var run=function(g){try{g(O,w)}catch(e){if(w)w.close();alert('Could not read this page: '+e.message)}};`
    + `import(O+'/js/admin/grab.js?t='+Date.now()).then(function(m){run(m.grabVehicle)})`
    + `.catch(function(){run(${grabVehicle.toString()})})})()`);
}

export function decodeImport(hash) {
  const m = String(hash || '').match(/^#import=(.+)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); } catch { return null; }
}
