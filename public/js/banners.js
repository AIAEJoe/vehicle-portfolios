// Photo banners by year, make and model (Settings → Photo banners). Pure functions shared by the vehicle page,
// the inventory grid and Settings. Blank year, make or model means "any"; make and model match without regard
// to case or extra spaces. When several rules match a car, the oldest active rule wins, so adding a new rule never
// silently replaces one that's already showing.
import { sb } from './core.js';

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function bannerMatches(rule, v) {
  if (!rule || !v || rule.active === false) return false;
  const y = Number(v.year);
  if (rule.year_from != null && !(y >= rule.year_from)) return false;
  if (rule.year_to != null && !(y <= rule.year_to)) return false;
  if (norm(rule.make) && norm(rule.make) !== norm(v.make)) return false;
  if (norm(rule.model) && norm(rule.model) !== norm(v.model)) return false;
  if (rule.condition === 'new' && v.condition !== 'new') return false;
  if (rule.condition === 'used' && v.condition === 'new') return false; // "used" includes certified pre-owned
  return true;
}

export function vehicleBanner(v, rules) {
  const hit = (rules || []).filter((r) => bannerMatches(r, v))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0];
  return hit ? { text: hit.text.trim(), note: String(hit.note || '').trim() || null } : null;
}

export function describeRule(r) {
  const years = r.year_from && r.year_to ? (r.year_from === r.year_to ? `${r.year_from}` : `${r.year_from} to ${r.year_to}`)
    : r.year_from ? `${r.year_from} and newer` : r.year_to ? `${r.year_to} and older` : '';
  const car = [years, r.make, r.model].filter(Boolean).join(' ');
  const cond = r.condition === 'new' ? 'new ' : r.condition === 'used' ? 'pre-owned ' : '';
  return car ? `${cond}${car}` : `every ${cond || ''}car`.replace('every  ', 'every ');
}

export async function loadBanners(dealershipId) {
  try {
    const { data, error } = await sb.from('dealership_banners').select('*').eq('dealership_id', dealershipId).eq('active', true);
    return error ? [] : data || []; // a missing table (SQL not run yet) must never break the vehicle page
  } catch { return []; }
}
