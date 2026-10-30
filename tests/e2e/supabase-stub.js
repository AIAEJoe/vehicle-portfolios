// In-memory stand-in for @supabase/supabase-js used by the browser tests.
// Validates every column name against the real migration (window.__SCHEMA).

const SCHEMA = window.__SCHEMA || {};
const db = new Proxy({}, { get: (_, k) => window.__DB[k], set: (_, k, v) => { window.__DB[k] = v; return true; } });
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const RELATIONS = {
  vehicles: {
    vehicle_photos: { many: true, fk: 'vehicle_id' },
    vehicle_documents: { many: true, fk: 'vehicle_id' },
    staff: { many: false, local: 'salesperson_id' },
  },
  shares: { staff: { many: false, local: 'staff_id' } },
  leads: { vehicles: { many: false, local: 'vehicle_id' }, staff: { many: false, local: 'staff_id' } },
};

function usageSummary(dealershipId, isOp) {
  const msgs = db.messages.filter((m) => m.dealership_id === dealershipId);
  const b = db.dealership_billing.find((x) => x.dealership_id === dealershipId) || {};
  const seg = (f) => msgs.filter(f).reduce((a, m) => a + (m.segments || 0), 0);
  const total = seg((m) => m.channel === 'sms');
  const emails = msgs.filter((m) => m.channel === 'email' && m.direction === 'outbound').length;
  const over = Math.max(0, total - b.included_sms_segments);
  const overage = +(over * b.overage_sms_rate).toFixed(2);
  const u = { dealership_id: dealershipId, sms_segments_total: total, sms_segments_customer_out: seg((m) => m.channel === 'sms' && m.direction === 'outbound' && m.audience === 'customer'),
    sms_segments_staff_alerts: seg((m) => m.audience === 'staff' && m.channel === 'sms'), sms_segments_in: seg((m) => m.channel === 'sms' && m.direction === 'inbound'),
    texts_sent: 0, texts_received: msgs.filter((m) => m.direction === 'inbound').length, texts_failed: 0, emails_sent: emails, emails_bounced: 0,
    included_sms_segments: b.included_sms_segments, included_emails: b.included_emails, sms_overage_segments: over, email_overage: 0,
    overage_sms_rate: b.overage_sms_rate, overage_email_rate: b.overage_email_rate, overage_amount: overage, monthly_fee: b.monthly_fee,
    invoice_total: b.monthly_fee + overage, allow_overage: b.allow_overage };
  if (isOp) {
    const cost = msgs.reduce((a, m) => a + (m.provider_cost ?? m.cost_estimate ?? 0) + (m.carrier_fee || 0), 0);
    const fixed = db.usage_charges.filter((c) => c.dealership_id === dealershipId).reduce((a, c) => a + c.provider_cost, 0);
    Object.assign(u, { cost_sms: +cost.toFixed(4), cost_email: 0, cost_fixed: fixed, cost_total: +(cost + fixed).toFixed(2), cost_unreconciled_messages: 0,
      margin: +(u.invoice_total - cost - fixed).toFixed(2), pass_through_fixed_fees: b.pass_through_fixed_fees });
  }
  return u;
}
function isOperator() {
  const s = JSON.parse(localStorage.getItem('stub-session') || 'null');
  return !!(s && db.platform_admins.some((p) => p.user_id === s.user.id));
}

function checkCol(table, col) {
  const cols = SCHEMA[table];
  if (cols && !cols.includes(col)) throw new Error(`STUB: column "${col}" does not exist on ${table}`);
}

function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function project(table, row, select) {
  const parts = splitTop(select || '*');
  const out = {};
  for (const p of parts) {
    const m = p.match(/^(?:(\w+):)?(\w+)(?:!\w+)?\((.*)\)$/s);
    if (m) {
      const [, alias, rel, inner] = m;
      const def = (RELATIONS[table] || {})[rel];
      if (!def) throw new Error(`STUB: no relation ${table} -> ${rel}`);
      if (def.many) out[alias || rel] = db[rel].filter((r) => r[def.fk] === row.id).map((r) => project(rel, r, inner));
      else {
        const t = db[rel].find((r) => r.id === row[def.local]);
        out[alias || rel] = t ? project(rel, t, inner) : null;
      }
    } else if (p === '*') Object.assign(out, row);
    else { checkCol(table, p); out[p] = row[p]; }
  }
  return out;
}

function computeStats() {
  return db.vehicles.map((v) => {
    const views = db.portfolio_views.filter((x) => x.vehicle_id === v.id);
    return {
      vehicle_id: v.id, dealership_id: v.dealership_id, views: views.length,
      visitors: new Set(views.map((x) => x.visitor_id)).size,
      last_viewed_at: views.map((x) => x.viewed_at).sort().pop() || null,
      leads: db.leads.filter((l) => l.vehicle_id === v.id).length,
      shares: db.shares.filter((s) => s.vehicle_id === v.id).length,
    };
  });
}

// Mirrors the CHOMES triggers in 0005_chomes.sql closely enough for the UI: provenance stamps and the review flag.
const CHOMES_TRACKED = ['overall_grade', 'strengths', 'wear_items', 'needed_work', 'recon_cost', 'inspected_by', 'inspection_date', 'report_provider',
  'accidents_count', 'accidents_summary', 'service_records', 'prior_owners', 'title_issues', 'title_issue_detail', 'open_recalls', 'history_report_path',
  'generation_note', 'options_packages', 'highlight_features', 'price_to_market_pct', 'market_days_supply', 'comparable_units_nearby', 'demand_note', 'acquisition_notes'];
const VEHICLE_TRACKED = { year: 'model_year', mileage: 'odometer', trim: 'trim', drivetrain: 'drivetrain', engine: 'engine' };
function actor(source) {
  const s = JSON.parse(localStorage.getItem('stub-session') || 'null');
  const st = s && db.staff.find((x) => x.user_id === s.user.id);
  return { source, by: s ? s.user.id : null, by_name: s ? (st ? st.full_name : s.user.email) : null, at: now() };
}
function stampChomes(row, before) {
  if (row.accidents_count === 0 && !row.accidents_summary) row.accidents_summary = 'No accidents reported';
  for (const k of CHOMES_TRACKED) {
    if (k in row && JSON.stringify(row[k] ?? null) !== JSON.stringify((before || {})[k] ?? null)) row.provenance = { ...(row.provenance || {}), [k]: actor('staff') };
  }
  row.review_required = row.overall_grade === 'fair' || !!String(row.needed_work || '').trim() || !!row.title_issues;
}
function stampVehicle(row, before, source) {
  const c = db.vehicle_chomes && db.vehicle_chomes.find((x) => x.vehicle_id === row.id);
  if (!c) return;
  for (const [col, k] of Object.entries(VEHICLE_TRACKED)) {
    if (row[col] != null && row[col] !== before[col]) c.provenance = { ...(c.provenance || {}), [k]: actor(source) };
  }
}

const slugify = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const DEFAULTS = {
  vehicles: (r) => ({ status: 'draft', condition: 'used', features: [], specs: {}, price_stack: [], source: 'manual', feed_locked: false, price_label: 'Price',
    slug: r.slug || slugify([r.year, r.make, r.model, r.trim, r.stock_number].filter(Boolean).join(' ')) || r.id.slice(0, 8) }),
  shares: () => ({ code: Math.random().toString(36).slice(2, 10), open_count: 0, channel: 'sms' }),
  staff: () => ({ active: true, notify_email: true, notify_sms: true, title: 'Sales Consultant' }),
  leads: () => ({ status: 'new', kind: 'test_drive' }),
  vehicle_photos: () => ({ position: 0, source: 'upload' }),
  vehicle_documents: () => ({ kind: 'other', source: 'upload' }),
  vehicle_chomes: () => ({ options_packages: [], highlight_features: [], provenance: {}, review_required: false }),
};

class Query {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.sel = '*'; this.single_ = null; this.orders = []; this.lim = null; this.wantRows = false; }
  select(cols = '*') { if (this.op === 'select') this.sel = cols; else { this.wantRows = true; this.sel = cols; } return this; }
  insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { checkCol(this.table, c); this.filters.push((r) => r[c] === v); return this; }
  in(c, vs) { checkCol(this.table, c); this.filters.push((r) => vs.includes(r[c])); return this; }
  ilike(c, pat) {
    checkCol(this.table, c);
    const re = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    this.filters.push((r) => r[c] != null && re.test(String(r[c]))); return this;
  }
  gt(c, v) { checkCol(this.table, c); this.filters.push((r) => r[c] > v); return this; }
  gte(c, v) { checkCol(this.table, c); this.filters.push((r) => r[c] >= v); return this; }
  lt(c, v) { checkCol(this.table, c); this.filters.push((r) => r[c] < v); return this; }
  order(c, { ascending = true } = {}) { checkCol(this.table, c); this.orders.push([c, ascending]); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.single_ = 'single'; return this; }
  maybeSingle() { this.single_ = 'maybe'; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  run() {
    try {
      window.__CALLS.push({ table: this.table, op: this.op, payload: this.payload });
      const source = this.table === 'vehicle_stats' ? computeStats() : db[this.table];
      if (!source) throw new Error(`STUB: no table ${this.table}`);
      let rows;
      if (this.op === 'insert') {
        rows = this.payload.map((p) => {
          Object.keys(p).forEach((k) => checkCol(this.table, k));
          const base = { id: uid(), created_at: now(), updated_at: now(), ...p };
          const row = { ...(DEFAULTS[this.table] ? DEFAULTS[this.table](base) : {}), ...base };
          if (this.table === 'vehicles' && db.vehicles.some((v) => v.vin && v.vin === row.vin)) throw new Error('duplicate key value violates unique constraint "vehicles_dealership_id_vin_key"');
          if (this.table === 'vehicle_chomes') stampChomes(row, {});
          source.push(row);
          if (this.table === 'consent_records') {
            const c = db.customers.find((x) => x.id === row.customer_id);
            if (row.channel === 'sms') c.sms_consent_status = row.action === 'opt_in' ? 'opted_in' : 'opted_out';
            else c.email_opted_out = row.action === 'opt_out';
          }
          return row;
        });
      } else {
        rows = source.filter((r) => this.filters.every((f) => f(r)));
        if (this.op === 'update') {
          Object.keys(this.payload).forEach((k) => checkCol(this.table, k));
          rows.forEach((r) => {
            const before = { ...r };
            Object.assign(r, this.payload, { updated_at: now() });
            if (this.table === 'vehicle_chomes') stampChomes(r, before);
            if (this.table === 'vehicles') stampVehicle(r, before, 'staff');
          });
        }
        if (this.op === 'delete') {
          db[this.table] = source.filter((r) => !rows.includes(r));
          if (this.table === 'vehicles') for (const t of ['vehicle_photos', 'vehicle_documents', 'shares']) db[t] = db[t].filter((x) => !rows.some((r) => r.id === x.vehicle_id));
        }
      }
      if (this.op !== 'select') window.__SAVE();
      if (this.op === 'select' || this.wantRows) {
        for (const [c, asc] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        if (this.lim) rows = rows.slice(0, this.lim);
        rows = rows.map((r) => project(this.table, r, this.sel));
      } else rows = null;
      if (this.single_) {
        if (this.single_ === 'single' && (!rows || rows.length !== 1)) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: rows ? rows[0] || null : null, error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      if (String(e.message).startsWith('STUB')) { console.error(e.message); window.__STUB_ERRORS.push(e.message); }
      return { data: null, error: { message: e.message } };
    }
  }
}

const listeners = [];
function session() {
  const s = JSON.parse(localStorage.getItem('stub-session') || 'null');
  return s;
}

export function createClient() {
  return {
    from: (t) => new Query(t),
    rpc: async (fn, args) => {
      window.__CALLS.push({ rpc: fn, args });
      if (fn === 'vp_share_public') {
        const s = db.shares.find((x) => x.code === args.p_code);
        return { data: s ? { vehicle_id: s.vehicle_id, staff_id: s.staff_id, customer_first_name: (s.customer_name || '').split(' ')[0] || null } : null, error: null };
      }
      if (fn === 'vp_public_sms_info') {
        const d = db.dealerships.find((x) => x.slug === args.p_slug);
        const p = db.messaging_profiles.find((x) => x.dealership_id === d.id) || {};
        return { data: { dealership: d.name, phone: p.twilio_phone_number || null, sms_enabled: !!p.sms_enabled,
          consent_language: p.consent_language || `By checking this box, I agree to receive text messages from ${d.name}.`, help_message: 'help' }, error: null };
      }
      if (fn === 'vp_usage_summary') return { data: usageSummary(args.p_dealership_id, isOperator()), error: null };
      if (fn === 'vp_platform_overview') {
        if (!isOperator()) return { data: null, error: { message: 'not allowed' } };
        return { data: db.dealerships.map((d) => { const p = db.messaging_profiles.find((x) => x.dealership_id === d.id) || {}; const b = db.dealership_billing.find((x) => x.dealership_id === d.id) || {};
          return { id: d.id, slug: d.slug, name: d.name, a2p_status: p.a2p_status, sms_enabled: p.sms_enabled, phone: p.twilio_phone_number, email_domain: p.email_domain, email_domain_status: p.email_domain_status, billing_status: b.status, usage: usageSummary(d.id, true) }; }), error: null };
      }
      if (fn === 'vp_sticker_equipment') {
        const f = db.vehicle_factory_data.find((x) => x.vehicle_id === args.p_vehicle_id);
        return { data: f ? { features: f.data.features, optional: f.data.optional, chassis: f.data.chassis, as_built: f.data.as_built } : null, error: null };
      }
      if (fn === 'vp_sticker_chomes') {
        const c = db.vehicle_chomes.find((x) => x.vehicle_id === args.p_vehicle_id);
        if (!c) return { data: null, error: null };
        const keep = ['highlight_features', 'options_packages', 'report_provider', 'prior_owners', 'accidents_count', 'accidents_summary', 'service_records',
          'title_issues', 'title_issue_detail', 'generation_note', 'review_required', 'review_cleared_at'];
        return { data: Object.fromEntries(keep.map((k) => [k, c[k] ?? null])), error: null };
      }
      if (fn === 'vp_qr_share') {
        const v = db.vehicles.find((x) => x.id === args.p_vehicle_id);
        if (!v) return { data: null, error: { message: 'Vehicle not found' } };
        let sh = db.shares.find((x) => x.vehicle_id === v.id && x.channel === 'qr');
        if (!sh) { sh = { id: uid(), code: Math.random().toString(36).slice(2, 10), vehicle_id: v.id, dealership_id: v.dealership_id, channel: 'qr', customer_name: 'QR window card', open_count: 0, created_at: now() }; db.shares.push(sh); window.__SAVE(); }
        return { data: sh.code, error: null };
      }
      if (fn === 'vp_apply_bg_program') {
        const vs = db.vehicles.filter((x) => args.p_vehicle_ids.includes(x.id));
        if (!vs.length) return { data: 0, error: null };
        const d = db.dealerships.find((x) => x.id === vs[0].dealership_id);
        const p = d.bg_program;
        if (!p) return { data: null, error: { message: 'Set up the warranty program in Settings first' } };
        let n = 0;
        for (const v of vs.filter((x) => x.condition === 'used' || x.condition === 'certified')) {
          Object.assign(v, { bg_warranty: 'dealer_warranty', bg_warranty_type: 'limited', bg_labor_pct: p.labor_pct, bg_parts_pct: p.parts_pct,
            bg_deductible: p.deductible || null, bg_systems: JSON.parse(JSON.stringify(p.systems)), bg_program: p.name, bg_updated_at: now() });
          n++;
        }
        window.__SAVE();
        return { data: n, error: null };
      }
      if (fn === 'vp_vehicle_apply_decode') {
        const v = db.vehicles.find((x) => x.id === args.p_vehicle_id);
        if (!v) return { data: null, error: { message: 'Vehicle not found' } };
        const before = { ...v };
        for (const k of ['year', 'make', 'model', 'trim', 'body_style', 'drivetrain', 'engine', 'transmission', 'fuel_type']) if (v[k] == null && args.p_fields[k]) v[k] = args.p_fields[k];
        stampVehicle(v, before, 'vin_decode');
        window.__SAVE();
        return { data: { ...v }, error: null };
      }
      if (fn === 'vp_mark_read') { const c = db.customers.find((x) => x.id === args.p_customer_id); c.unread_count = 0; window.__SAVE(); return { data: null, error: null }; }
      if (fn === 'vp_members') return { data: db.dealership_members.map((m) => ({ ...m, email: (db.users.find((u) => u.id === m.user_id) || {}).email })), error: null };
      return { data: null, error: { message: `STUB: unknown rpc ${fn}` } };
    },
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        const u = db.users.find((x) => x.email === email && x.password === password);
        if (!u) return { data: {}, error: { message: 'Invalid login credentials' } };
        const s = { access_token: 'jwt-' + u.id, user: { id: u.id, email: u.email } };
        localStorage.setItem('stub-session', JSON.stringify(s));
        return { data: { session: s }, error: null };
      },
      signInWithOtp: async (args) => { window.__CALLS.push({ otp: args }); return window.__OTP_ERROR ? { data: {}, error: { message: window.__OTP_ERROR } } : { data: {}, error: null }; },
      signOut: async () => { localStorage.removeItem('stub-session'); return { error: null }; },
      updateUser: async (attrs) => { window.__CALLS.push({ updateUser: attrs }); return { data: {}, error: null }; },
      onAuthStateChange: (cb) => { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, file) => {
          if (!/^[0-9a-f-]{36}\//.test(path)) return { error: { message: 'STUB: bad storage path ' + path } };
          if (window.__FAIL_UPLOADS > 0) { window.__FAIL_UPLOADS--; return { error: { message: 'Network connection was lost' } }; }
          window.__UPLOADS.push({ bucket, path, size: file.size, type: file.type });
          return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `/seed/jeep-0${(window.__UPLOADS.length % 9) + 1}.jpg?upload=${encodeURIComponent(path)}` } }),
        remove: async (paths) => { window.__CALLS.push({ removed: paths, bucket }); return { error: null }; },
        createSignedUrl: async (path, secs) => {
          window.__CALLS.push({ signed: path, bucket, secs });
          return bucket === 'internal' ? { data: { signedUrl: `/seed/jeep-01.jpg?signed=${encodeURIComponent(path)}` }, error: null } : { data: null, error: { message: 'STUB: public bucket' } };
        },
      }),
    },
  };
}
