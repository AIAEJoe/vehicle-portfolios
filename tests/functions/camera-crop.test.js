// 4:3 crop for photos (listing sites and LotSync want 4:3). camera.js imports core.js (browser), so load it with a shim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../public/js/admin/camera.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function crop43'), src.indexOf('async function cropBlobTo43'));
const { crop43 } = await import('data:text/javascript,' + encodeURIComponent(body));

test('16:9 landscape is cropped to the centre 4:3', () => {
  assert.deepEqual(crop43(1920, 1080), { sx: 240, sy: 0, sw: 1440, sh: 1080 });
  assert.deepEqual(crop43(3840, 2160), { sx: 480, sy: 0, sw: 2880, sh: 2160 });
});
test('upright phone: 9:16 is cropped to 3:4', () => {
  assert.deepEqual(crop43(1080, 1920), { sx: 0, sy: 240, sw: 1080, sh: 1440 });
});
test('already 4:3 (or 3:4) is left alone; a squarer frame is trimmed top and bottom', () => {
  assert.deepEqual(crop43(4032, 3024), { sx: 0, sy: 0, sw: 4032, sh: 3024 });
  assert.deepEqual(crop43(3024, 4032), { sx: 0, sy: 0, sw: 3024, sh: 4032 });
  assert.deepEqual(crop43(1000, 1000), { sx: 0, sy: 125, sw: 1000, sh: 750 });
});
