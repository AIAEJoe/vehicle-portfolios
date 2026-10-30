// Dealer warranty program (e.g. Lifetime Limited Powertrain Warranty): which cars mention it, which already have
// it on their Buyers Guide, and which carry older terms. Pure functions, shared by Settings, the vehicle page,
// the vehicles list, the dealer sticker and the tests.

// Starting point for New Smyrna Beach Chevrolet's program (form TWS-LW-AMSI F 06/24). The covered-systems wording
// is a proposed plain-language summary of typical manufacturer powertrain coverage; the dealership confirms it
// with its administrator (Total Warranty Services) or compliance before applying it to cars.
const DURATION = 'For as long as the original purchaser owns the vehicle (not transferable), subject to the maintenance and inspection requirements in the warranty';
export const DEFAULT_PROGRAM = {
  name: 'Lifetime Limited Powertrain Warranty',
  match: 'lifetime powertrain warranty',
  labor_pct: 100,
  parts_pct: 100,
  deductible: 'A $100 deductible applies to each covered repair',
  systems: [
    { system: 'Engine: cylinder block, cylinder heads and internal lubricated parts', duration: DURATION },
    { system: 'Transmission or transaxle: case and internal parts, torque converter', duration: DURATION },
    { system: 'Drive axles: axle housings and internal parts, axle shafts, constant-velocity joints', duration: DURATION },
  ],
  sticker_line: 'Lifetime Limited Powertrain Warranty included',
};

// "Lifetime Limited Power-Train Warranty", "lifetime powertrain warranties" and "LIFETIME WARRANTY (powertrain)" all
// count; words are matched in any order, ignoring "limited", punctuation and case.
const norm = (t) => ` ${String(t || '').toLowerCase().replace(/power[\s-]*train/g, 'powertrain').replace(/warranties/g, 'warranty').replace(/[^a-z0-9]+/g, ' ')} `;
export function mentionsProgram(description, match) {
  const words = norm(match).trim().split(' ').filter((w) => w && w !== 'limited');
  if (!words.length) return false;
  const d = norm(description);
  return words.every((w) => d.includes(` ${w} `));
}

const used = (v) => v.condition === 'used' || v.condition === 'certified';
const sameTerms = (v, p) => v.bg_warranty === 'dealer_warranty' && v.bg_warranty_type === 'limited'
  && Number(v.bg_labor_pct) === Number(p.labor_pct) && Number(v.bg_parts_pct) === Number(p.parts_pct)
  && (v.bg_deductible || '') === (p.deductible || '')
  && JSON.stringify((v.bg_systems || []).map((s) => [s.system, s.duration])) === JSON.stringify((p.systems || []).map((s) => [s.system, s.duration]));

/**
 * Where a vehicle stands with the program:
 *  'applied'  – its Buyers Guide carries the program's current terms
 *  'outdated' – it carries the program, but the terms have changed since
 *  'missing'  – its description mentions the program, but its Buyers Guide doesn't have it  ← a real FTC risk
 *  'none'     – not mentioned and not applied (or not a used vehicle)
 */
export function programStatus(v, p) {
  if (!p || !used(v)) return 'none';
  if (v.bg_program === p.name) return sameTerms(v, p) ? 'applied' : 'outdated';
  return mentionsProgram(v.description, p.match) ? 'missing' : 'none';
}

/** The line for the dealer window sticker, only when the car's Buyers Guide really has the program. */
export function programStickerLine(v, p) {
  if (!p || v.bg_warranty !== 'dealer_warranty' || v.bg_program !== p.name) return null;
  return p.sticker_line || p.name;
}
