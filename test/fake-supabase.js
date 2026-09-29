// Tiny in-memory stand-in for Supabase's REST API (PostgREST + auth), enough
// for the queries the Truckle API makes. Installed by replacing global fetch.
export function installFakeSupabase(url) {
  const tables = { workspaces: [], workspace_members: [], docs: [], connect_accounts: [], payments: [], stripe_events: [] };
  const pk = { docs: ['workspace_id', 'coll', 'id'], stripe_events: ['id'], connect_accounts: ['workspace_id', 'party_kind', 'party_id'] };
  const users = {}; // token -> user
  const merge = (a, b) => {
    if (!(a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b))) return b;
    const o = { ...a }; for (const k in b) o[k] = merge(a[k], b[k]); return o;
  };
  const realFetch = globalThis.fetch;
  const res = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (!u.href.startsWith(url)) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (u.pathname === '/auth/v1/user') {
      const t = (headers.get('authorization') || '').replace('Bearer ', '');
      return users[t] ? res(200, users[t]) : res(401, { msg: 'bad jwt' });
    }
    if (u.pathname === '/rest/v1/rpc/doc_patch') {
      const d = tables.docs.find((r) => r.workspace_id === body.p_ws && r.coll === body.p_coll && r.id === body.p_id);
      if (!d) return res(404, { code: 'P0002', message: 'not_found' });
      d.data = merge(d.data, body.p_patch); return res(200, d.data);
    }
    const t = u.pathname.replace('/rest/v1/', '');
    const rows = tables[t]; if (!rows) return res(404, { message: 'no table ' + t });
    const filters = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k));
    const match = (r) => filters.every(([k, v]) => v.startsWith('eq.') ? String(r[k]) === v.slice(3) : true);
    const prefer = headers.get('prefer') || '', single = /vnd\.pgrst\.object/.test(headers.get('accept') || '');
    const out = (list) => {
      if (single) return list.length === 1 ? res(200, list[0]) : res(406, { code: 'PGRST116', message: 'rows: ' + list.length, details: `The result contains ${list.length} rows` });
      return res(200, list);
    };
    if (method === 'GET') {
      let list = rows.filter(match);
      if (u.searchParams.get('select')?.includes('workspaces(')) list = list.map((r) => ({ ...r, workspaces: tables.workspaces.find((w) => w.id === r.workspace_id) }));
      return out(list);
    }
    if (method === 'POST') {
      const items = Array.isArray(body) ? body : [body], added = [];
      for (const it of items) {
        const keys = pk[t];
        const dupe = keys && rows.find((r) => keys.every((k) => r[k] === it[k]));
        if (dupe && /merge-duplicates/.test(prefer)) { Object.assign(dupe, it); added.push(dupe); continue; }
        if (dupe) return res(409, { code: '23505', message: 'duplicate key' });
        const row = { ...it };
        if (t === 'workspaces') { row.id = row.id || crypto.randomUUID(); row.join_code = row.join_code || Math.random().toString(16).slice(2, 14); }
        rows.push(row); added.push(row);
      }
      return /return=representation/.test(prefer) ? out(added) : res(201);
    }
    if (method === 'PATCH') { const list = rows.filter(match); list.forEach((r) => Object.assign(r, body)); return /return=representation/.test(prefer) ? out(list) : res(204); }
    if (method === 'DELETE') { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) rows.splice(i, 1); return res(204); }
    return res(405, {});
  };
  return { tables, addUser: (token, user) => { users[token] = user; }, restore: () => { globalThis.fetch = realFetch; } };
}
