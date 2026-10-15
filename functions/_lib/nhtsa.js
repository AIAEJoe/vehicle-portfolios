// NHTSA vPIC VIN decoding and model-year recall lookup (free public APIs).

const KEEP_UPPER = new Set(['BMW', 'GMC', 'RAM', 'MINI']);
const titleCase = (s) => (s && !KEEP_UPPER.has(String(s)) ? String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace('Mercedes-benz', 'Mercedes-Benz') : s);
const clean = (s) => {
  const v = s === undefined || s === null ? '' : String(s).trim();
  return v && v !== 'Not Applicable' && v !== '0' ? v : null;
};

export function mapVpic(r) {
  const cyl = clean(r.EngineCylinders);
  const disp = clean(r.DisplacementL);
  const config = clean(r.EngineConfiguration) || '';
  const layout = cyl ? (/^V/i.test(config) ? `V${cyl}` : /in-line/i.test(config) ? `I${cyl}` : `${cyl}-cyl`) : null;
  const engine = [disp && `${Number(disp).toFixed(1)}L`, layout, clean(r.EngineModel)].filter(Boolean).join(' ') || null;
  const speeds = clean(r.TransmissionSpeeds);
  const style = clean(r.TransmissionStyle);
  const transmission = [speeds && `${speeds}-Speed`, style].filter(Boolean).join(' ') || null;
  const errorCode = String(r.ErrorCode || '0').split(',')[0].trim();
  return {
    ok: errorCode === '0' || (!!clean(r.Make) && !!clean(r.ModelYear)),
    message: errorCode === '0' ? null : clean(r.ErrorText),
    vin: clean(r.VIN),
    year: clean(r.ModelYear) ? Number(r.ModelYear) : null,
    make: titleCase(clean(r.Make)),
    model: clean(r.Model),
    trim: clean(r.Trim) || clean(r.Series),
    body_style: clean(r.BodyClass),
    drivetrain: clean(r.DriveType),
    engine,
    transmission,
    fuel_type: clean(r.FuelTypePrimary),
    specs: Object.fromEntries(
      [
        ['Doors', clean(r.Doors)],
        ['Seats', clean(r.Seats)],
        ['Horsepower', clean(r.EngineHP) && `${Math.round(Number(r.EngineHP))} hp`],
        ['Plant', [clean(r.PlantCity), clean(r.PlantState), clean(r.PlantCountry)].filter(Boolean).map(titleCase).join(', ') || null],
        ['GVWR', clean(r.GVWR)],
        ['Wheelbase', clean(r.WheelBaseShort) && `${r.WheelBaseShort} in`],
      ].filter(([, v]) => v)
    ),
  };
}

export async function decodeVin(vin) {
  const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`NHTSA VIN decoder returned ${res.status}`);
  const data = await res.json();
  return mapVpic((data.Results && data.Results[0]) || {});
}

export function mapRecalls(data) {
  return (data.results || data.Results || []).map((r) => ({
    campaign: r.NHTSACampaignNumber,
    date: r.ReportReceivedDate,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
  }));
}

export async function fetchRecalls({ make, model, year }) {
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const res = await fetch(url, { cf: { cacheTtl: 21600, cacheEverything: true } });
  if (res.status === 400 || res.status === 404) return [];
  if (!res.ok) throw new Error(`NHTSA recalls API returned ${res.status}`);
  return mapRecalls(await res.json());
}
