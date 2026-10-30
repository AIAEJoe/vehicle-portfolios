// Window sticker logic shared by the sticker tab, the printed sticker and the tests. No browser or database imports.
import { computeChomes, VS_AVERAGE_LABEL } from './chomes.js';

export const STACK_KINDS = [['discount', 'Discount'], ['rebate', 'Rebate'], ['addon', 'Add-on']];
const cents = (n) => Math.round(Number(n) * 100);

/**
 * The pricing stack as it may be printed. It prints only when the starting price plus every line equals the
 * vehicle's current price, so a stale stack (after a price change) can never reach the window.
 */
export function priceStack(v) {
  const lines = Array.isArray(v.price_stack) ? v.price_stack : [];
  if (!lines.length) return { has: false, valid: false, lines: [], base: null, final: null };
  const base = v.price_stack_base === null || v.price_stack_base === undefined ? null : Number(v.price_stack_base);
  const final = base === null ? null : (cents(base) + lines.reduce((a, l) => a + cents(l.amount), 0)) / 100;
  const price = v.price === null || v.price === undefined || v.price === '' ? null : Number(v.price);
  const valid = base !== null && price !== null && cents(final) === cents(price);
  return {
    has: true, valid, base, final, price,
    baseLabel: v.price_stack_base_label || (v.condition === 'new' ? 'MSRP' : 'Retail price'),
    lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })),
    savings: lines.filter((l) => l.kind !== 'addon').reduce((a, l) => a - Number(l.amount), 0),
    reason: valid ? null : base === null ? 'No starting price' : price === null ? 'The vehicle has no price'
      : `Adds up to ${fmt(final)}, but the vehicle's price is ${fmt(price)}`,
  };
}
const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

/**
 * What the CHOMES record may contribute to the window. Equipment highlights always may. The vehicle story
 * (age, miles, history) prints only when no FTC review is pending, the same gate the future VDP panel uses.
 * Internal fields (recon cost, notes, demand note) are never read here.
 */
export function stickerStory(v, rec, today = new Date()) {
  const used = v.condition !== 'new';
  const r = rec && !rec.error ? rec : null;
  const highlights = (r && r.highlight_features && r.highlight_features.length ? r.highlight_features : (v.features || [])).slice(0, 8);
  const options = r ? (r.options_packages || []).slice(0, 14) : [];
  if (!used || !r) return { highlights, options, story: null, held: false };
  const held = !!r.review_required && !r.review_cleared_at;
  if (held) return { highlights, options, story: null, held: true };
  const c = computeChomes(v, r, today).values;
  const provider = { carfax: 'CARFAX', autocheck: 'AutoCheck' }[r.report_provider];
  const per = provider ? ` (${provider} report)` : '';
  const story = [];
  if (c.model_year) story.push(['Age', c.vehicle_age_years === 0 ? `${c.model_year} model year` : `${c.model_year} · ${c.vehicle_age_years} year${c.vehicle_age_years === 1 ? '' : 's'} old`]);
  if (c.miles_per_year !== null) story.push(['Miles', `${c.miles_per_year.toLocaleString('en-US')} a year · ${VS_AVERAGE_LABEL[c.vs_average].toLowerCase()} for its age`]);
  if (r.generation_note) story.push(['Generation', r.generation_note]);
  if (provider && r.prior_owners !== null && r.prior_owners !== undefined) story.push(['Owners', `${r.prior_owners} prior owner${r.prior_owners === 1 ? '' : 's'}${per}`]);
  if (provider && r.accidents_count !== null && r.accidents_count !== undefined) {
    story.push(['Accidents', r.accidents_count === 0 ? `No accidents reported${per}` : `${r.accidents_count} reported: ${r.accidents_summary}${per}`]);
  }
  if (provider && r.service_records) story.push(['Service', `${r.service_records} service record${r.service_records === 1 ? '' : 's'}${per}`]);
  if (provider && r.title_issues === false) story.push(['Title', `No title issues reported${per}`]);
  if (r.title_issues === true) story.push(['Title', `${r.title_issue_detail}${per}`]);
  return { highlights, options, story: story.length ? story : null, held: false };
}

// ---------- reading option packages off a factory (Monroney) sticker ----------
const START = /OPTIONAL\s+EQUIPMENT|OPTIONS?\s*(?:&|AND)\s*PACKAGES|FACTORY\s+INSTALLED\s+OPTIONS|OPTION\s+PACKAGES/i;
const STOP = /TOTAL\s+(?:VEHICLE\s+)?PRICE|TOTAL\s+MSRP|TOTAL\s+OPTIONS|DESTINATION|GAS(?:OLINE)?\s+MILEAGE|FUEL\s+ECONOMY|GOVERNMENT\s+5-STAR|PARTS\s+CONTENT/i;
const ITEM = /^(.*[A-Za-z].*?)\s*[.\s]*\s(\$\s?[\d,]+(?:\.\d{2})?|N\/?C|NO\s+CHARGE|INCLUDED|STD)\s*$/i;
const NOT_OPTION = /^(BASE\s+PRICE|TOTAL|SUB-?TOTAL|MSRP|DESTINATION|PRICE|OPTIONAL\s+EQUIPMENT)\b/i;

function niceCase(s) {
  if (/[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Ii|Iii|Iv|Awd|4wd|2wd|Fwd|Rwd|Led|Hd|Usb|Gps|Lt|Ls|Ltz|Rs|Ss|Zr2|Z71|At4|Slt|Sle|Rst|Trd|Xlt|Bose|Wifi|V6|V8|Dvd|Abs)\b/g, (m) => m.toUpperCase());
}

/** Lines of text from a factory window sticker → suggested option / package names (people confirm them). */
export function parseFactoryOptions(lines) {
  const all = (lines || []).map((l) => String(l).replace(/[ \u00a0]+/g, ' ').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  let on = false;
  for (const line of all) {
    if (START.test(line)) { on = true; continue; }
    if (!on) continue;
    if (STOP.test(line)) { on = false; continue; }
    for (const cell of cells(line)) {
    const m = cell.match(ITEM);
    if (!m) continue;
    const name = niceCase(m[1].replace(/[.\s]+$/, '').replace(/^[-•*\s]+/, '').trim());
    if (!name || name.length < 3 || NOT_OPTION.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 30) return out;
    }
  }
  return out;
}

// Sticker lines can hold two columns (standard equipment | options), and prices are often right-aligned far
// from their names. textItemsToLines marks wide gaps with a tab; split there and re-attach lone prices.
const PRICE_ONLY = /^(\$\s?[\d,]+(?:\.\d{2})?|N\/?C|NO\s+CHARGE|INCLUDED|STD)$/i;
function cells(line) {
  const out = [];
  for (const raw of line.split('\t').map((x) => x.trim()).filter(Boolean)) {
    if (PRICE_ONLY.test(raw) && out.length) out[out.length - 1] += ' ' + raw; else out.push(raw);
  }
  return out;
}

/** pdf.js text items → reading-order lines (items on the same baseline joined left to right). */
export function textItemsToLines(items) {
  const rows = [];
  for (const it of items || []) {
    if (!it || !it.str || !it.str.trim()) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, w: Number(it.width) || it.str.length * 5, str: it.str });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    const parts = r.parts.sort((a, b) => a.x - b.x);
    let out = '';
    parts.forEach((p, i) => {
      if (i) { const prev = parts[i - 1]; out += p.x - (prev.x + prev.w) > COLUMN_GAP ? '\t' : ' '; }
      out += p.str.replace(/[ \u00a0]+/g, ' ').trim();
    });
    return out.trim();
  });
}
const COLUMN_GAP = 24; // PDF points (1/3 inch): wider than a word space, narrower than a column gutter


// ---------- equipment lists for the sticker (from the VIN decoder's factory data) ----------
// The decoder's groups are folded into the four lists dealers print: Standard, Exterior, Interior, Safety.
const EQUIP_BUCKETS = [
  ['Safety', /safety|brak|traction|anti-?theft|lock|airbag|security|stability|collision|assist/i],
  ['Exterior', /exterior|lighting|mirror|window|wiper|wheel|tire|roof|glass|paint|body/i],
  ['Interior', /interior|seat|climate|entertain|audio|communication|navigation|remote|instrument|comfort|convenience|storage|cargo/i],
];
/** factory equipment ({ features: [{group, items}], chassis: [{name, value}], optional }) → [[title, items[]] x4] */
export function equipmentLists(eq) {
  const out = { Standard: [], Exterior: [], Interior: [], Safety: [] };
  if (!eq) return [];
  for (const g of eq.features || []) {
    const hit = EQUIP_BUCKETS.find(([, re]) => re.test(g.group));
    out[hit ? hit[0] : 'Standard'].push(...(g.items || []));
  }
  for (const c of eq.chassis || []) {
    const line = `${c.name}: ${c.value}`;
    (/tire|wheel/i.test(c.name) ? out.Exterior : out.Standard).push(line);
  }
  out.Standard.unshift(...(eq.optional || []).map((o) => `${o.name} (option)`)); // options first, in factory order
  const seen = new Set();
  return Object.entries(out).map(([k, items]) => [k, items.filter((x) => { const key = `${k}|${x.toLowerCase()}`; if (seen.has(key)) return false; seen.add(key); return true; })])
    .filter(([, items]) => items.length);
}
