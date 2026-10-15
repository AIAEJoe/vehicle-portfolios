// GET /api/recalls?year=2018&make=Jeep&model=Wrangler — NHTSA safety recalls for that model year.
import { json, handle, HttpError } from '../_lib/util.js';
import { fetchRecalls } from '../_lib/nhtsa.js';

export const onRequestGet = handle(async ({ request }) => {
  const u = new URL(request.url);
  const year = u.searchParams.get('year');
  const make = u.searchParams.get('make');
  const model = u.searchParams.get('model');
  if (!year || !make || !model) throw new HttpError(400, 'Year, make and model are required');
  const recalls = await fetchRecalls({ year, make, model });
  return json({ recalls, checked_at: new Date().toISOString() }, 200, { 'cache-control': 'public, max-age=3600' });
});
