// Minimal in-memory PostgREST/GoTrue stand-in for function tests.
import { randomUUID } from 'node:crypto';

export function fakeSupabase(seed = {}, { rpc = {}, users = {}, triggers = {} } = {}) {
  const db = JSON.parse(JSON.stringify(seed));
  const calls = [];

  function match(row, key, expr) {
    const [op, ...rest] = expr.split('.');
    const val = rest.join('.');
    const v = row[key];
    switch (op) {
      case 'eq': return String(v) === val;
      case 'neq': return String(v) !== val;
      case 'gt': return v > val;
      case 'gte': return String(v) >= val;
      case 'lt': return v < val;
      case 'lte': return String(v) <= val;
      case 'is': return val === 'null' ? v === null || v === undefined : String(v) === val;
      case 'not': return !match(row, key, rest.join('.'));
      case 'in': return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
      default: throw new Error('fake: unsupported op ' + op);
    }
  }

  function query(table, params) {
    let rows = db[table] || [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k) || k.includes('.')) continue;
      rows = rows.filter((r) => match(r, k, v));
    }
    const order = params.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
    }
    const limit = params.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    return rows;
  }

  async function handler(url, opts) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname + u.search, method, body, headers: opts.headers || {} });
    if (u.pathname === '/auth/v1/user') {
      const tok = String((opts.headers || {}).authorization || '').replace('Bearer ', '');
      return users[tok] ? json(users[tok]) : json({ msg: 'bad jwt' }, 401);
    }
    const m = u.pathname.match(/^\/rest\/v1\/(rpc\/)?(\w+)$/);
    if (!m) return json({ message: 'fake: not found ' + u.pathname }, 404);
    if (m[1]) {
      const fn = rpc[m[2]];
      if (!fn) return json({ message: 'fake: no rpc ' + m[2] }, 404);
      return json(await fn(body, db));
    }
    const table = m[2];
    db[table] = db[table] || [];
    const prefer = String((opts.headers || {}).prefer || '');
    if (method === 'GET') return json(query(table, u.searchParams));
    if (method === 'POST') {
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      const conflict = u.searchParams.get('on_conflict');
      const inserted = [];
      for (const r of rows) {
        if (conflict) {
          const keys = conflict.split(',');
          const existing = db[table].find((x) => keys.every((k) => String(x[k]) === String(r[k])));
          if (existing) {
            if (prefer.includes('merge-duplicates')) Object.assign(existing, r);
            continue;
          }
        } else if (table === 'provider_credentials') {
          const existing = db[table].find((x) => x.dealership_id === r.dealership_id && x.provider === r.provider);
          if (existing) { Object.assign(existing, r); continue; }
        }
        if (triggers[table]) triggers[table](r, db);
        db[table].push(r);
        inserted.push(r);
      }
      return json(prefer.includes('return=representation') ? inserted : '', prefer.includes('return=representation') ? 201 : 201);
    }
    if (method === 'PATCH') {
      const rows = query(table, u.searchParams);
      rows.forEach((r) => Object.assign(r, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))));
      return json(prefer.includes('return=representation') ? rows : '');
    }
    if (method === 'DELETE') {
      const rows = query(table, u.searchParams);
      db[table] = db[table].filter((r) => !rows.includes(r));
      return json('');
    }
    return json({ message: 'fake: method' }, 405);
  }
  return { db, calls, handler };
}

function json(data, status = 200) {
  return new Response(data === '' ? '' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
