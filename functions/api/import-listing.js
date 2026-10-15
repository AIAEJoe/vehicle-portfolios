// POST /api/import-listing {url} — staff only. Reads a vehicle listing page and
// returns the vehicle details + photo URLs for the dashboard to save.
import { json, handle, HttpError, getDealership, dealerSlugFromRequest, requireUser } from '../_lib/util.js';
import { parseListing } from '../_lib/listing.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  await requireUser(request, env, dealership.id);
  const { url } = await request.json().catch(() => ({}));
  let target;
  try { target = new URL(url); } catch { throw new HttpError(400, 'Paste the full listing URL, starting with https://'); }
  if (!/^https?:$/.test(target.protocol)) throw new HttpError(400, 'Only web addresses can be imported');

  const res = await fetch(target.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpError(502, `The listing page returned an error (${res.status})`);
  const html = await res.text();
  const vehicle = parseListing(html, res.url || target.toString());
  if (!vehicle.vin && !vehicle.make) throw new HttpError(422, 'Could not find vehicle details on that page');
  return json({ vehicle });
});
