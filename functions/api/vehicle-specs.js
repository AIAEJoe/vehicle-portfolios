// POST /api/vehicle-specs {vehicle_id, refresh?} — staff only. Factory data for a vehicle's VIN from the
// VinAudit VIN decoder. Each VIN is looked up once (VinAudit charges per query) and cached in
// vehicle_factory_data; refresh: true asks again. Empty vehicle basics (engine, MPG…) are filled in,
// labelled "VIN decode". The cached row is staff only: it includes invoice price.
import { json, handle, HttpError, getDealership, dealerSlugFromRequest, requireUser, sb, enc } from '../_lib/util.js';
import { specsUrl, normalizeSpecs, decodeFill, VINAUDIT_ERRORS } from '../_lib/vinaudit.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const dealership = await getDealership(env, dealerSlugFromRequest(request, env));
  const { user, token } = await requireUser(request, env, dealership.id);
  const { vehicle_id: id, refresh = false } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new HttpError(400, 'Which vehicle?');
  const v = (await sb(env, `/rest/v1/vehicles?id=eq.${enc(id)}&dealership_id=eq.${dealership.id}&select=id,dealership_id,vin`))[0];
  if (!v) throw new HttpError(404, 'Vehicle not found');
  if (!v.vin) throw new HttpError(400, 'Add the VIN first');

  const cached = (await sb(env, `/rest/v1/vehicle_factory_data?vehicle_id=eq.${v.id}&select=*`))[0];
  if (cached && cached.vin === v.vin && !refresh) return json({ ok: true, cached: true, factory: cached });

  if (!env.VINAUDIT_API_KEY) throw new HttpError(503, 'Factory data needs a VinAudit API key. Add VINAUDIT_API_KEY in Cloudflare (Settings → Variables and Secrets).');
  let res;
  try {
    res = await fetch(specsUrl(v.vin, String(env.VINAUDIT_API_KEY).trim()), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new HttpError(502, `VinAudit didn't answer (${e.name === 'TimeoutError' ? 'timed out' : 'network error'}). Try again.`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new HttpError(502, `VinAudit returned an error (${res.status})`);
  if (!body.success) throw new HttpError(422, VINAUDIT_ERRORS[body.error] || `VinAudit couldn't decode this VIN (${body.error || 'no reason given'})`);
  if (body.input && body.input.key) body.input.key = '(hidden)';

  const data = normalizeSpecs(body);
  const row = { vehicle_id: v.id, dealership_id: v.dealership_id, vin: v.vin, source: 'vinaudit', data, raw: body,
    fetched_at: data.fetched_at, fetched_by: user.id };
  const saved = await sb(env, '/rest/v1/vehicle_factory_data?on_conflict=vehicle_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: row });

  // Fill empty basics as the signed-in user, so row level security and CHOMES provenance ("VIN decode", by whom) apply.
  const vehicle = await sb(env, '/rest/v1/rpc/vp_vehicle_apply_decode', { method: 'POST', role: token, body: { p_vehicle_id: v.id, p_fields: decodeFill(data) } });
  return json({ ok: true, cached: false, factory: Array.isArray(saved) ? saved[0] : saved, vehicle });
});
