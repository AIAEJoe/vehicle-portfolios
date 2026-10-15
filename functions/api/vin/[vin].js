// GET /api/vin/<VIN> — decode a VIN with NHTSA vPIC.
import { json, handle, HttpError } from '../../_lib/util.js';
import { decodeVin } from '../../_lib/nhtsa.js';

export const onRequestGet = handle(async ({ params }) => {
  const vin = String(params.vin || '').toUpperCase().trim();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new HttpError(400, 'A VIN is 17 letters and numbers (no I, O or Q)');
  const data = await decodeVin(vin);
  if (!data.ok) throw new HttpError(422, data.message || 'NHTSA could not decode that VIN');
  return json(data, 200, { 'cache-control': 'public, max-age=86400' });
});
