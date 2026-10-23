// CHOMES shared logic (public/js/chomes.js): the numbers the team tab and the future VDP panel show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeChomes, vehicleAge, milesPerYear, vsAverage, reviewReasons, customerSafe, SECTIONS, INTERNAL_FIELDS,
} from '../../public/js/chomes.js';

const OCT_2026 = new Date('2026-10-23T12:00:00');
const jeep = { year: 2018, mileage: 81273, trim: 'Sport S', drivetrain: 'Four Wheel Drive', engine: '3.6L V6' };

test('Old: age is computed from the model year', () => {
  assert.equal(vehicleAge(2018, OCT_2026), 8);
  assert.equal(vehicleAge(2026, OCT_2026), 0);
  assert.equal(vehicleAge(2027, OCT_2026), 0, 'next model year is not negative');
  assert.equal(vehicleAge(null, OCT_2026), null);
});

test('Miles: miles per year and the average band', () => {
  assert.equal(milesPerYear(81273, 8), 10159);
  assert.equal(milesPerYear(9000, 0), 9000, 'current model year counts as one year');
  assert.equal(milesPerYear(null, 8), null);
  assert.equal(milesPerYear(0, 3), 0);
  assert.equal(vsAverage(9999), 'below_average');
  assert.equal(vsAverage(10000), 'average');
  assert.equal(vsAverage(15000), 'average');
  assert.equal(vsAverage(15001), 'above_average');
  assert.equal(vsAverage(null), null);
});

test('O/M/E come from the vehicle record, not the CHOMES row', () => {
  const c = computeChomes(jeep, { trim: 'stale copy', odometer: 1 }, OCT_2026);
  assert.equal(c.values.odometer, 81273);
  assert.equal(c.values.trim, 'Sport S');
  assert.equal(c.values.vs_average, 'average');
});

test('an empty record lists exactly the required manual fields as missing', () => {
  const c = computeChomes(jeep, {}, OCT_2026);
  const missing = Object.values(c.sections).flatMap((s) => s.missing.map((f) => f.k)).sort();
  assert.deepEqual(missing, ['accidents_count', 'inspected_by', 'inspection_date', 'overall_grade', 'report_provider', 'title_issues']);
  assert.ok(c.sections.O.done && c.sections.M.done && c.sections.E.done);
  assert.equal(c.marketDataPending, true, 'Supply & demand is pending, not missing');
  assert.equal(c.sections.S.done, true);
});

test('missing vehicle basics count against O, M and E', () => {
  const c = computeChomes({ year: 2020 }, {}, OCT_2026);
  assert.deepEqual(c.sections.M.missing.map((f) => f.k), ['odometer', 'miles_per_year', 'vs_average']);
  assert.deepEqual(c.sections.E.missing.map((f) => f.k), ['trim', 'drivetrain', 'engine']);
});

test('title_issues = false and zero accidents count as answered', () => {
  const c = computeChomes(jeep, { overall_grade: 'good', inspected_by: 'Dana', inspection_date: '2026-10-22', report_provider: 'carfax',
    accidents_count: 0, title_issues: false, price_to_market_pct: 98.2, market_days_supply: 41, comparable_units_nearby: 7 }, OCT_2026);
  assert.equal(c.missingCount, 0);
  assert.equal(c.marketDataPending, false);
});

test('FTC review: Fair grade, needed work or a title issue (mirrors the database rule)', () => {
  assert.deepEqual(reviewReasons({ overall_grade: 'good', needed_work: '  ', title_issues: false }), []);
  assert.deepEqual(reviewReasons({ overall_grade: 'fair' }), ['Condition is graded Fair']);
  assert.deepEqual(reviewReasons({ needed_work: 'Brakes' }), ['Needed work is listed']);
  assert.deepEqual(reviewReasons({ title_issues: true }), ['The history report shows a title issue']);
  assert.equal(computeChomes(jeep, { overall_grade: 'fair', review_cleared_at: '2026-10-23' }).review.cleared, true);
});

test('customer-safe view drops every internal field', () => {
  const rec = { overall_grade: 'good', recon_cost: 450, acquisition_notes: 'auction', demand_note: 'hot', history_report_path: 'x/y.pdf',
    provenance: {}, strengths: 'New tires' };
  const safe = customerSafe(rec);
  for (const k of INTERNAL_FIELDS) assert.ok(!(k in safe), `${k} removed`);
  assert.equal(safe.strengths, 'New tires');
  assert.equal(rec.recon_cost, 450, 'original untouched');
});

test('spec field list: every field the build spec names is modeled', () => {
  const keys = SECTIONS.flatMap((s) => s.fields.map((f) => f.k));
  for (const k of ['overall_grade', 'strengths', 'wear_items', 'needed_work', 'inspected_by', 'inspection_date', 'report_provider',
    'accidents_count', 'service_records', 'prior_owners', 'title_issues', 'open_recalls', 'model_year', 'vehicle_age_years',
    'generation_note', 'odometer', 'miles_per_year', 'vs_average', 'trim', 'drivetrain', 'engine', 'options_packages',
    'highlight_features', 'price_to_market_pct', 'market_days_supply', 'comparable_units_nearby', 'demand_note']) {
    assert.ok(keys.includes(k), k);
  }
  assert.deepEqual(SECTIONS.map((s) => s.key).join(''), 'CHOMES');
});
