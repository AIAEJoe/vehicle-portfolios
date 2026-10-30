// Dealer warranty program: description matching, per-car status, sticker line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROGRAM as P, mentionsProgram, programStatus, programStickerLine, programBanner } from '../../public/js/warranty-program.js';

test('descriptions that mention the program', () => {
  for (const d of ['Lifetime Warranty - Unlimited Time & Miles', 'Includes our LIFETIME LIMITED POWERTRAIN WARRANTY!', 'lifetime power-train warranty included',
    'Comes with NSB Chevy lifetime powertrain warranties.', 'Warranty: Lifetime (powertrain)']) assert.ok(mentionsProgram(d, P.match), d);
  for (const d of ['Balance of factory powertrain warranty', 'Lifetime oil changes', 'Sold as is', '', null, 'lifetimewarranty'])
    assert.ok(!mentionsProgram(d, P.match), String(d));
  assert.ok(mentionsProgram('Includes our Lifetime Limited Powertrain Warranty', 'lifetime powertrain warranty'), 'a stricter match still works');
  assert.ok(!mentionsProgram('Lifetime Warranty - Unlimited Time & Miles', 'lifetime powertrain warranty'), 'which is why the default is now "lifetime warranty"');
  assert.ok(!mentionsProgram('anything', ''), 'empty match never matches');
});

const base = { condition: 'used', description: 'Clean CARFAX. Includes our Lifetime Limited Powertrain Warranty.' };
const applied = { ...base, bg_warranty: 'dealer_warranty', bg_warranty_type: 'limited', bg_labor_pct: 100, bg_parts_pct: 100,
  bg_deductible: P.deductible, bg_systems: P.systems.map((s) => ({ ...s })), bg_program: P.name };

test('program status per car', () => {
  assert.equal(programStatus(base, P), 'missing', 'mentioned but not on the Buyers Guide');
  assert.equal(programStatus({ ...base, bg_warranty: 'as_is' }, P), 'missing');
  assert.equal(programStatus(applied, P), 'applied');
  assert.equal(programStatus({ ...applied, bg_deductible: 'A $50 deductible' }, P), 'outdated', 'terms changed since');
  assert.equal(programStatus({ ...applied, bg_systems: applied.bg_systems.slice(0, 2) }, P), 'outdated');
  assert.equal(programStatus({ ...base, description: 'Nice car' }, P), 'none');
  assert.equal(programStatus({ ...base, condition: 'new' }, P), 'none', 'new cars have no Buyers Guide');
  assert.equal(programStatus(base, null), 'none', 'no program set up');
  assert.equal(programStatus({ ...applied, description: '' }, P), 'applied', 'applied without a mention still counts');
});

test('sticker line only when the Buyers Guide really has it', () => {
  assert.equal(programStickerLine(applied, P), 'Lifetime Limited Powertrain Warranty – unlimited time & miles while you own it');
  assert.equal(programStickerLine(base, P), null);
  assert.equal(programStickerLine({ ...applied, bg_warranty: 'as_is' }, P), null);
  assert.equal(programStickerLine(applied, { ...P, sticker_line: '' }), P.name);
  assert.equal(programStickerLine(applied, null), null);
});

test('default program wording passes the FTC shorthand rule', () => {
  for (const s of P.systems) assert.ok(!/(drive|power)[\s-]*train/i.test(s.system), s.system);
  assert.equal(P.labor_pct, 100);
  assert.equal(P.parts_pct, 100);
  assert.match(P.deductible, /\$100/);
  assert.ok(P.systems.every((s) => /not transferable/.test(s.duration) && /no mileage limit/.test(s.duration)));
});

test('first-photo banner: only when the Buyers Guide carries the program; text editable; blank turns it off', () => {
  assert.deepEqual(programBanner(applied, P), { text: 'LIFETIME WARRANTY', note: 'Limited powertrain · see Buyers Guide' });
  assert.equal(programBanner(base, P), null, 'mentioned in the ad but not on the Buyers Guide: no banner');
  assert.equal(programBanner({ ...applied, bg_warranty: 'as_is' }, P), null);
  const saved = { ...P }; delete saved.banner_text; delete saved.banner_note;
  assert.equal(programBanner(applied, saved).text, 'LIFETIME WARRANTY', 'programs saved before banners existed get the default');
  assert.equal(programBanner(applied, { ...P, banner_text: '' }), null, 'blank banner text turns it off');
  assert.deepEqual(programBanner(applied, { ...P, banner_note: '' }), { text: 'LIFETIME WARRANTY', note: null });
});
