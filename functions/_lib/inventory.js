// HomeNet / vAuto (and most other dealer CSV) inventory feed parsing.
// Columns are matched by normalised header name, so column order and minor
// naming differences between providers don't matter.

export function parseDelimited(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = ['\t', '|', ','].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(normKey);
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, idx) => { if (h && !(h in o)) o[h] = (r[idx] ?? '').trim(); });
    return o;
  });
}

export function normKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ALIASES = {
  vin: ['vin', 'vehiclevin'],
  stock_number: ['stock', 'stocknumber', 'stockno', 'stocknum'],
  type: ['type', 'newused', 'condition', 'vehiclecondition', 'invtype', 'usednew'],
  certified: ['certified', 'cpo', 'iscertified'],
  year: ['year', 'modelyear', 'vehicleyear'],
  make: ['make', 'vehiclemake'],
  model: ['model', 'vehiclemodel'],
  trim: ['trim', 'series', 'trimlevel', 'styledescription'],
  body_style: ['body', 'bodystyle', 'bodytype', 'marketclass'],
  exterior_color: ['exteriorcolor', 'extcolor', 'color', 'colour', 'exteriorcolour'],
  interior_color: ['interiorcolor', 'intcolor', 'interiorcolour', 'intupholstery'],
  engine: ['enginedescription', 'engine'],
  engine_cyl: ['enginecylinders', 'cylinders'],
  engine_disp: ['enginedisplacement', 'displacement'],
  transmission: ['transmissiondescription', 'transmission', 'trans'],
  drivetrain: ['drivetrain', 'drivetype', 'drive', 'drivetraindesc'],
  fuel_type: ['fueltype', 'fuel'],
  mpg_city: ['citympg', 'mpgcity', 'epacity'],
  mpg_hwy: ['highwaympg', 'hwympg', 'mpghighway', 'mpghwy', 'epahighway'],
  mileage: ['miles', 'mileage', 'odometer'],
  price: ['internetprice', 'specialprice', 'saleprice', 'sellingprice', 'price', 'askingprice', 'listprice'],
  msrp: ['msrp', 'retailprice'],
  description: ['description', 'comments', 'sellernotes', 'vehicledescription', 'notes'],
  features: ['options', 'features', 'equipment', 'optionsdescription', 'categorizedoptions'],
  photos: ['imagelist', 'imageurls', 'photourls', 'images', 'photos', 'imageurl', 'photourl', 'pictures'],
  dealer_id: ['dealerid', 'dealercode', 'dealer', 'storeid', 'rooftopid'],
};

function pick(row, field) {
  for (const k of ALIASES[field]) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function firstPrice(row) {
  for (const k of ALIASES.price) {
    const n = num(row[k]);
    if (n) return n;
  }
  return null;
}

function condition(row) {
  const cert = String(pick(row, 'certified') || '').toLowerCase();
  if (['1', 'true', 'yes', 'y', 'certified'].includes(cert)) return 'certified';
  const t = String(pick(row, 'type') || '').toLowerCase();
  if (t.startsWith('n')) return 'new';
  if (t.includes('cert') || t === 'cpo') return 'certified';
  if (t) return 'used';
  return null;
}

function splitList(v, max) {
  if (!v) return [];
  let parts = v.split(/\s*[|;~]\s*/);
  if (parts.length === 1) parts = v.split(/\s*,\s*/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))].slice(0, max);
}

function photos(v) {
  if (!v) return [];
  return [...new Set(v.split(/[\s,|;]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))].slice(0, 100);
}

const KEEP_UPPER = new Set(['BMW', 'GMC', 'RAM', 'MINI', 'AMC']);
const titleCaseIfShouting = (s) =>
  s && s === s.toUpperCase() && /[A-Z]{3}/.test(s) && !KEEP_UPPER.has(s)
    ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bMercedes-benz\b/, 'Mercedes-Benz')
    : s;

export function mapFeedRow(row) {
  const vin = (pick(row, 'vin') || '').toUpperCase().replace(/\s/g, '');
  let engine = pick(row, 'engine');
  if (!engine) {
    const disp = pick(row, 'engine_disp');
    const cyl = pick(row, 'engine_cyl');
    engine = [disp && (/l$/i.test(disp) ? disp : `${disp}L`), cyl && `${cyl}-cyl`].filter(Boolean).join(' ') || null;
  }
  return {
    vin,
    dealer_id: pick(row, 'dealer_id'),
    stock_number: pick(row, 'stock_number'),
    condition: condition(row),
    year: int(pick(row, 'year')),
    make: titleCaseIfShouting(pick(row, 'make')),
    model: pick(row, 'model'),
    trim: pick(row, 'trim'),
    body_style: pick(row, 'body_style'),
    exterior_color: pick(row, 'exterior_color'),
    interior_color: pick(row, 'interior_color'),
    engine,
    transmission: pick(row, 'transmission'),
    drivetrain: pick(row, 'drivetrain'),
    fuel_type: pick(row, 'fuel_type'),
    mpg_city: int(pick(row, 'mpg_city')),
    mpg_hwy: int(pick(row, 'mpg_hwy')),
    mileage: (() => { const m = pick(row, 'mileage'); const n = m === null ? null : Number(String(m).replace(/[,\s]/g, '')); return Number.isFinite(n) ? Math.round(n) : null; })(),
    price: firstPrice(row),
    msrp: num(pick(row, 'msrp')),
    description: pick(row, 'description'),
    features: splitList(pick(row, 'features'), 80),
    photos: photos(pick(row, 'photos')),
  };
}

/** Parse a feed file into rows ready for the vp_feed_sync RPC. */
export function feedToRows(text, { dealerId } = {}) {
  const raw = parseDelimited(text);
  let rows = raw.map(mapFeedRow);
  if (dealerId) rows = rows.filter((r) => !r.dealer_id || String(r.dealer_id) === String(dealerId));
  // drop duplicate VINs (keep first)
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.vin || seen.has(r.vin)) continue;
    seen.add(r.vin);
    delete r.dealer_id;
    out.push(r);
  }
  return { rows: out, totalLines: raw.length };
}
