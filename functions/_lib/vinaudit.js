// VinAudit Specifications (VIN decoder) API → our factory data shape.
// What this data is: the decoder describes the vehicle's model and trim. Its equipment list is what the trim
// comes with ("Standard"), not a record of the options built into this particular car, and some of its
// figures contradict each other (prices, dimensions). normalizeSpecs keeps only what agrees with itself and
// records every conflict, so nothing contradictory reaches a customer.

export function specsUrl(vin, key) {
  return `https://specifications.vinaudit.com/v3/specifications?vin=${encodeURIComponent(vin)}&include=attributes,equipment,colors,recalls,warranties&format=json&key=${encodeURIComponent(key)}`;
}

export const VINAUDIT_ERRORS = {
  api_not_enabled: "VinAudit says this API key isn't enabled for VIN decoding. Check the key in Cloudflare and that the VIN Decoder API is active in VinAudit.",
  invalid_key: "VinAudit didn't accept the API key. Check VINAUDIT_API_KEY in Cloudflare.",
  invalid_vin: "VinAudit says that VIN isn't valid.",
  no_data: 'VinAudit has no data for this VIN.',
  limit_exceeded: "VinAudit's query limit is used up. Check your plan in VinAudit.",
};

const s = (x) => (x === undefined || x === null ? '' : String(x).trim());
const num = (x) => { const m = s(x).replace(/,/g, '').match(/\d+(?:\.\d+)?/); const n = m ? Number(m[0]) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
const int = (x) => { const n = num(x); return n === null ? null : Math.round(n); };
const title = (x) => s(x).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const CODES = { IND: 'Independent', 'R&P': 'Rack and pinion', SLA: 'Short/long arm' };

export function normalizeSpecs(r, now = new Date()) {
  const a = (r && r.attributes) || {};
  const eq = Array.isArray(r && r.equipments) ? r.equipments : Array.isArray(r && r.equipment) ? r.equipment : [];

  // Standard / optional equipment by group, de-duplicated, in the decoder's order.
  const groups = new Map();
  const optional = [];
  const chassis = [];
  const seen = new Set();
  for (const e of eq) {
    const group = s(e.group) || 'Other';
    const name = s(e.name);
    if (!name) continue;
    const avail = s(e.availability).toLowerCase();
    const key = `${group}|${name}|${avail}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (avail === 'standard') {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(name);
    } else if (avail === 'optional') {
      optional.push({ group, name });
    } else if (group === 'Chassis' && s(e.value)) {
      chassis.push({ name, value: CODES[s(e.value)] || (/tires/i.test(name) ? s(e.value).toUpperCase() : s(e.value)) });
    }
    // Other unlabelled rows (dimensions, capacities) are deliberately dropped: they contradict the attributes.
  }

  // Dimension conflicts between the attributes block and the equipment block.
  const conflicts = [];
  const eqVal = (g, n) => { const e = eq.find((x) => s(x.group) === g && s(x.name) === n); return e ? num(e.value) : null; };
  for (const [attr, g, n, label] of [['overall_length', 'Exterior Dimensions & Weight', 'Overall Length', 'Overall length'],
    ['wheelbase_length', 'Exterior Dimensions & Weight', 'Wheelbase', 'Wheelbase']]) {
    const x = num(a[attr]); const y = eqVal(g, n);
    if (x && y && Math.abs(x - y) > 0.5) conflicts.push(`${label}: ${x} in. vs ${y} in.`);
  }

  // Prices: staff only, and only called consistent when the factory figures add up.
  const p = {
    msrp: num(a.manufacturer_suggested_retail_price), invoice: num(a.invoice_price), delivery: num(a.delivery_charges),
    oem_base: num(a.vehicle_oem_base_msrp), oem_options: num(a.vehicle_oem_total_options),
    oem_destination: num(a.vehicle_oem_destination_charges), oem_total: num(a.vehicle_oem_total_msrp),
  };
  const priceNotes = [];
  if (p.oem_base !== null && p.oem_total !== null) {
    const sum = p.oem_base + (p.oem_options || 0) + (p.oem_destination || 0);
    if (Math.abs(sum - p.oem_total) > 1) priceNotes.push(`Factory base + options + destination is $${sum.toLocaleString('en-US')}, but the factory total says $${p.oem_total.toLocaleString('en-US')}.`);
  }
  if (p.delivery !== null && p.oem_destination !== null && p.delivery !== p.oem_destination) priceNotes.push(`Destination is listed as both $${p.delivery.toLocaleString('en-US')} and $${p.oem_destination.toLocaleString('en-US')}.`);
  if (p.invoice !== null && p.oem_base !== null && p.invoice === p.oem_base) priceNotes.push('The invoice price equals the factory base MSRP, which is unusual.');

  const madeIn = [title(a.made_in_city), s(a.made_in)].filter(Boolean).join(', ');
  const mpgCity = int(a.city_mileage);
  const mpgHwy = int(a.highway_mileage);
  return {
    source: 'vinaudit',
    vin: s(r && r.vin) || s(r && r.input && r.input.vin),
    fetched_at: now.toISOString(),
    vehicle: {
      year: int(a.year), make: s(a.make) || null, model: s(a.model) || null, trim: s(a.trim) || null, style: s(a.style) || null,
      body_style: s(a.type) || null, engine: s(a.engine) || null, transmission: s(a.transmission) || null,
      drivetrain: s(a.drivetrain) || null, fuel_type: s(a.fuel_type) || null,
      mpg_city: mpgCity, mpg_hwy: mpgHwy, mpg_combined: null,
      fuel_capacity: s(a.fuel_capacity) || null, seating: int(a.standard_seating), doors: s(a.doors) || null, made_in: madeIn || null,
      ev_range_miles: int(a.vehicle_ev_battery_range_miles), ev_battery_kwh: num(a.vehicle_ev_battery_capacity_kwh),
    },
    features: [...groups.entries()].map(([group, items]) => ({ group, items })),
    optional,
    chassis,
    colors: (Array.isArray(r && r.colors) ? r.colors : []).map((c) => (typeof c === 'string' ? c : s(c.name || c.color))).filter(Boolean),
    warranties: (Array.isArray(r && r.warranties) ? r.warranties : [])
      .filter((w) => Number(w.miles) > 0 || Number(w.months) > 0)
      .map((w) => ({ type: s(w.type), miles: Number(w.miles) || null, months: Number(w.months) || null })),
    pricing: { ...p, consistent: priceNotes.length === 0 && p.oem_total !== null, notes: priceNotes },
    conflicts,
    as_built: optional.length > 0, // the decoder only says what's on this car when it lists optional equipment
  };
}

/** Fields to fill on the vehicle when they're empty (sent to vp_vehicle_apply_decode). */
export function decodeFill(d) {
  const v = d.vehicle;
  return { year: v.year, make: v.make, model: v.model, trim: v.trim, body_style: v.body_style, drivetrain: v.drivetrain,
    engine: v.engine, transmission: v.transmission, fuel_type: v.fuel_type, mpg_city: v.mpg_city, mpg_hwy: v.mpg_hwy };
}
