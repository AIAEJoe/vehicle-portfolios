import test from 'node:test';
import assert from 'node:assert/strict';

// banners.js imports core.js (which needs a browser), so test the pure logic through a tiny shim.
const src = (await import('node:fs')).readFileSync(new URL('../../public/js/banners.js', import.meta.url), 'utf8')
  .replace(/^import .*core\.js';$/m, 'const sb = null;');
const { bannerMatches, vehicleBanner, describeRule } = await import('data:text/javascript,' + encodeURIComponent(src));

const silverado = { year: 2024, make: 'Chevrolet', model: 'Silverado 1500', condition: 'new' };
const used = { year: 2019, make: 'Jeep', model: 'Wrangler', condition: 'certified' };

test('blank fields mean any; make and model ignore case and spaces', () => {
  assert.ok(bannerMatches({ text: 'X', condition: 'any' }, silverado));
  assert.ok(bannerMatches({ text: 'X', make: ' chevrolet ', model: 'silverado  1500', condition: 'any' }, silverado));
  assert.ok(!bannerMatches({ text: 'X', model: 'Silverado', condition: 'any' }, silverado), 'model is exact, not a prefix');
});

test('year range, open ended either side', () => {
  assert.ok(bannerMatches({ year_from: 2024, year_to: 2024 }, silverado));
  assert.ok(!bannerMatches({ year_from: 2025 }, silverado));
  assert.ok(bannerMatches({ year_to: 2024 }, silverado));
  assert.ok(!bannerMatches({ year_from: 2020 }, { ...silverado, year: null }), 'unknown year never matches a range');
});

test('new / used; certified counts as used; switched-off rules never match', () => {
  assert.ok(!bannerMatches({ condition: 'new' }, used));
  assert.ok(bannerMatches({ condition: 'used' }, used));
  assert.ok(!bannerMatches({ condition: 'used' }, silverado));
  assert.ok(!bannerMatches({ active: false }, silverado));
});

test('oldest matching rule wins', () => {
  const b = vehicleBanner(silverado, [
    { text: 'Newer', created_at: '2026-10-30T10:00:00Z' }, { text: ' Older ', note: ' ', created_at: '2026-10-01T10:00:00Z' }, { text: 'Jeep only', make: 'Jeep', created_at: '2026-09-01T00:00:00Z' }]);
  assert.deepEqual(b, { text: 'Older', note: null });
  assert.equal(vehicleBanner(silverado, []), null);
});

test('rule descriptions', () => {
  assert.equal(describeRule({ year_from: 2024, year_to: 2026, make: 'Chevrolet', model: 'Silverado 1500', condition: 'new' }), 'new 2024 to 2026 Chevrolet Silverado 1500');
  assert.equal(describeRule({ year_from: 2022, make: 'Chevrolet', condition: 'any' }), '2022 and newer Chevrolet');
  assert.equal(describeRule({ condition: 'any' }), 'every car');
  assert.equal(describeRule({ condition: 'used' }), 'every pre-owned car');
});
