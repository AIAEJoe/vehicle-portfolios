// Core: config, Supabase client, HTML templating, formatting, toasts.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const config = window.VP_CONFIG || {};
export const configured = !!(config.supabaseUrl && config.supabaseAnonKey);

export const sb = configured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// ---------- templating ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += val(vals[i]); });
  return new Raw(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, view) { el.innerHTML = String(view); return el; }
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}

// ---------- formatting ----------
export const money = (n) => (n === null || n === undefined || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
export const miles = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US'));
export const vTitle = (v) => [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
export const vShort = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ');
export const conditionLabel = (c) => ({ new: 'New', used: 'Pre-Owned', certified: 'Certified Pre-Owned' }[c] || '');
export function telHref(p) { const d = String(p || '').replace(/[^\d+]/g, ''); return d ? `tel:${d}` : ''; }
export function smsHref(p, body) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  return `sms:${d}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;
}
export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}
export const dateTime = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
export const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function setBrand(d) {
  if (!d) return;
  const r = document.documentElement.style;
  if (/^#[0-9a-f]{3,8}$/i.test(d.brand_primary || '')) r.setProperty('--brand', d.brand_primary);
  if (/^#[0-9a-f]{3,8}$/i.test(d.brand_accent || '')) r.setProperty('--accent', d.brand_accent);
}

// ---------- feedback ----------
export function toast(msg, kind = '') {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = kind;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}
export const loadingView = (msg = 'Loading…') => html`<div class="loading"><div class="spinner"></div>${msg}</div>`;

export function errMsg(e) {
  if (!e) return 'Something went wrong';
  if (typeof e === 'string') return e;
  return e.message || e.error_description || e.error || 'Something went wrong';
}

/** Throws on Supabase {error}. */
export function must({ data, error }) {
  if (error) throw error;
  return data;
}

export async function api(path, { method = 'GET', body, auth = false, raw: rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !rawBody) h['content-type'] = 'application/json';
  if (auth && sb) {
    const { data } = await sb.auth.getSession();
    if (data.session) h.authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch(path, { method, headers: h, body: rawBody || (body !== undefined ? JSON.stringify(body) : undefined) });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('Link copied');
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
  return value;
}

export function portfolioUrl(v, code) {
  return `${location.origin}/v/${v.slug}${code ? `?s=${encodeURIComponent(code)}` : ''}`;
}

const dealerCache = {};
export async function loadDealership(slug = config.dealer) {
  if (dealerCache[slug]) return dealerCache[slug];
  const d = must(await sb.from('dealerships').select('*').eq('slug', slug).maybeSingle());
  if (!d) throw new Error(`No dealership is set up for "${slug}" yet.`);
  dealerCache[slug] = d;
  setBrand(d);
  return d;
}
export function clearDealerCache() { for (const k of Object.keys(dealerCache)) delete dealerCache[k]; }
