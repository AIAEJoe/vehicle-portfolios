// CHOMES vehicle story: Condition, History, Old, Miles, Equipment, Supply and demand.
// Framework created by Jonathan Dawson and Sellchology (credit carried on the customer view).
//
// Pure logic, no browser or database imports, so the team tab, the future customer story panel
// and the tests all compute the same numbers. Old / Miles / Equipment basics come from the
// vehicle record; everything else from the `vehicle_chomes` row.

export const CHOMES_CREDIT = 'CHOMES framework created by Jonathan Dawson and Sellchology.';

// Annual-mileage benchmark for "below / average / above". 12,000 a year is the figure most used
// car managers quote; anything between 10,000 and 15,000 counts as average.
export const ANNUAL_MILES = { benchmark: 12000, below: 10000, above: 15000 };

export const GRADES = [['excellent', 'Excellent'], ['good', 'Good'], ['fair', 'Fair']];
export const PROVIDERS = [['carfax', 'CARFAX'], ['autocheck', 'AutoCheck']];

// Never shown on the customer page (spec section 3), plus bookkeeping.
export const INTERNAL_FIELDS = ['recon_cost', 'acquisition_notes', 'demand_note', 'history_report_path', 'history_report_name',
  'provenance', 'review_required', 'review_cleared_at', 'review_cleared_by', 'updated_by', 'dealership_id'];

// `from`: where the value lives. 'rec' = vehicle_chomes, 'vehicle' = vehicles row, 'calc' = computed.
// `required`: true, false, or 'when_available' (Supply & demand, until the vAuto pipeline lands).
export const SECTIONS = [
  { key: 'C', name: 'Condition', fields: [
    { k: 'overall_grade', label: 'Overall grade', required: true },
    { k: 'strengths', label: "What's right with this car" },
    { k: 'wear_items', label: 'Honest wear a buyer will notice' },
    { k: 'needed_work', label: 'Needed work' },
    { k: 'recon_cost', label: 'Estimated recon cost', internal: true },
    { k: 'inspected_by', label: 'Inspected by', required: true },
    { k: 'inspection_date', label: 'Inspection date', required: true },
  ] },
  { key: 'H', name: 'History', fields: [
    { k: 'report_provider', label: 'Report provider', required: true },
    { k: 'accidents_count', label: 'Accidents reported', required: true },
    { k: 'service_records', label: 'Service records' },
    { k: 'prior_owners', label: 'Prior owners' },
    { k: 'title_issues', label: 'Title issues', required: true },
    { k: 'open_recalls', label: 'Open recalls' },
  ] },
  { key: 'O', name: 'Old', fields: [
    { k: 'model_year', label: 'Model year', required: true, from: 'vehicle' },
    { k: 'vehicle_age_years', label: 'Age', required: true, from: 'calc' },
    { k: 'generation_note', label: 'Generation note' },
  ] },
  { key: 'M', name: 'Miles', fields: [
    { k: 'odometer', label: 'Odometer', required: true, from: 'vehicle' },
    { k: 'miles_per_year', label: 'Miles per year', required: true, from: 'calc' },
    { k: 'vs_average', label: 'Versus average', required: true, from: 'calc' },
  ] },
  { key: 'E', name: 'Equipment', fields: [
    { k: 'trim', label: 'Trim', required: true, from: 'vehicle' },
    { k: 'drivetrain', label: 'Drivetrain', required: true, from: 'vehicle' },
    { k: 'engine', label: 'Engine', required: true, from: 'vehicle' },
    { k: 'options_packages', label: 'Options and packages' },
    { k: 'highlight_features', label: 'Highlight features' },
  ] },
  { key: 'S', name: 'Supply & demand', fields: [
    { k: 'price_to_market_pct', label: 'Price to market (%)', required: 'when_available' },
    { k: 'market_days_supply', label: 'Market days supply', required: 'when_available' },
    { k: 'comparable_units_nearby', label: 'Comparable units nearby', required: 'when_available' },
    { k: 'demand_note', label: 'Demand note', internal: true },
  ] },
];

const VEHICLE_FIELD = { model_year: 'year', odometer: 'mileage', trim: 'trim', drivetrain: 'drivetrain', engine: 'engine' };

export const SOURCE_LABEL = {
  staff: 'Entered by staff', inventory_feed: 'Inventory feed', vin_decode: 'VIN decode', listing_import: 'Listing import',
  system: 'System', existing_record: 'Already on the vehicle record', vauto: 'vAuto',
};

const blank = (x) => x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length);

export function vehicleAge(modelYear, today = new Date()) {
  if (!modelYear) return null;
  return Math.max(0, today.getFullYear() - Number(modelYear));
}

// Odometer divided by age. A current-model-year car (age 0) counts as one year so the
// number stays meaningful instead of dividing by zero.
export function milesPerYear(odometer, age) {
  if (odometer === null || odometer === undefined || odometer === '' || age === null) return null;
  return Math.round(Number(odometer) / Math.max(1, age));
}

export function vsAverage(mpy) {
  if (mpy === null || mpy === undefined) return null;
  if (mpy < ANNUAL_MILES.below) return 'below_average';
  if (mpy > ANNUAL_MILES.above) return 'above_average';
  return 'average';
}
export const VS_AVERAGE_LABEL = { below_average: 'Below average', average: 'Average', above_average: 'Above average' };

// FTC consistency (spec section 4): mirrors the database's review_required column.
export function reviewReasons(rec) {
  const r = rec || {};
  const out = [];
  if (r.overall_grade === 'fair') out.push('Condition is graded Fair');
  if (!blank(r.needed_work && String(r.needed_work).trim())) out.push('Needed work is listed');
  if (r.title_issues) out.push('The history report shows a title issue');
  return out;
}

export function computeChomes(vehicle, rec, today = new Date()) {
  const v = vehicle || {};
  const r = rec || {};
  const age = vehicleAge(v.year, today);
  const mpy = milesPerYear(v.mileage, age);
  const values = {
    ...r,
    model_year: v.year ?? null,
    vehicle_age_years: age,
    odometer: v.mileage ?? null,
    miles_per_year: mpy,
    vs_average: vsAverage(mpy),
    trim: v.trim ?? null,
    drivetrain: v.drivetrain ?? null,
    engine: v.engine ?? null,
  };
  const sections = {};
  let missingCount = 0;
  for (const s of SECTIONS) {
    const missing = s.fields.filter((f) => f.required === true && blank(values[f.k])).map((f) => f);
    missingCount += missing.length;
    sections[s.key] = { missing, done: !missing.length };
  }
  const market = SECTIONS.find((s) => s.key === 'S').fields.filter((f) => f.required === 'when_available');
  const marketDataPending = market.some((f) => blank(values[f.k]));
  sections.S.pending = marketDataPending;
  const reasons = reviewReasons(r);
  return {
    values, sections, missingCount, marketDataPending,
    review: { required: reasons.length > 0, reasons, cleared: !!r.review_cleared_at },
  };
}

export function isVehicleField(k) { return k in VEHICLE_FIELD; }
export function vehicleColumn(k) { return VEHICLE_FIELD[k]; }

// What a customer-facing surface may read. Internal fields are removed, not hidden.
export function customerSafe(rec) {
  const out = { ...(rec || {}) };
  for (const k of INTERNAL_FIELDS) delete out[k];
  return out;
}
