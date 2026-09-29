// Truckle live mode.
// Loaded right after the demo store in index.html. When /api/config says a
// backend is configured, this swaps the in-browser demo store for Supabase
// (with realtime sync), connects sign-in to Supabase Auth, and exposes
// window.TL for Truckle Pay (Stripe). Without config it does nothing and the
// app stays the offline demo.
//   ?demo  -> force the offline demo on this device
//   ?live  -> go back to live mode
(function () {
  var C = window.TRUCKLE_CONFIG, qs = new URLSearchParams(location.search);
  var ls = {
    get: function (k) { try { return localStorage.getItem(k) } catch (_) { return null } },
    set: function (k, v) { try { localStorage.setItem(k, v) } catch (_) {} },
    del: function (k) { try { localStorage.removeItem(k) } catch (_) {} }
  };
  if (qs.has('demo')) ls.set('truckle.mode', 'demo');
  if (qs.has('live')) ls.del('truckle.mode');
  var live = !!(C && C.supabaseUrl && C.supabaseAnonKey) && ls.get('truckle.mode') !== 'demo';
  if (!live) { window.TL = { live: false }; return; }

  var ref = new URL(C.supabaseUrl).hostname.split('.')[0];
  var SB_KEY = 'sb-' + ref + '-auth-token';
  var joinCode = qs.get('join');
  if (joinCode) { try { sessionStorage.setItem('truckle.join', joinCode) } catch (_) {} }
  var returning = qs.has('code') || /access_token=/.test(location.hash);
  // Demo data (view, fake session) must not leak into a real account.
  if (ls.get('truckle.lastMode') !== 'live') { ls.del('crewbill.view'); ls.del('truckle.session'); ls.set('truckle.lastMode', 'live') }
  if (!ls.get(SB_KEY) && !returning) ls.del('truckle.session');

  var origUse = window.claude && window.claude.use;
  var resolveDb, dbPromise = new Promise(function (r) { resolveDb = r });
  window.claude = { use: function (n) { return n === 'db' ? dbPromise : (origUse ? origUse(n) : Promise.resolve(null)) } };

  var sb = null, WS = null;
  var sbReady = new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = function () {
      sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: SB_KEY }
      });
      res(sb);
    };
    s.onerror = function () { rej(new Error('Could not load sign-in. Check your connection.')) };
    document.head.appendChild(s);
  });

  async function token() {
    await sbReady;
    var r = await sb.auth.getSession();
    return r.data.session && r.data.session.access_token;
  }
  async function api(path, body, opts) {
    opts = opts || {};
    var h = { 'content-type': 'application/json' };
    if (opts.auth !== false) { var t = await token(); if (t) h.authorization = 'Bearer ' + t }
    var res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    var out = {}; try { out = await res.json() } catch (_) {}
    if (!res.ok) { var e = new Error(out.error || 'Something went wrong. Try again.'); e.status = res.status; throw e }
    return out;
  }
  function savedSession() { try { return JSON.parse(ls.get('truckle.session') || 'null') } catch (_) { return null } }

  // ---------------------------------------------------------------------------
  // Supabase-backed store with the same interface as the demo store
  // (doc(path).get/set/update/delete/onSnapshot, collection(c).onSnapshot).
  // ---------------------------------------------------------------------------
  function makeDb(ws) {
    var cache = {}, colSubs = {}, docSubs = {}, loaded = false, loading = null, lastLoad = 0, timer = null, dirty = {};
    var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)) };
    var split = function (p) { var s = p.split('/'); return [s.slice(0, -1).join('/'), s[s.length - 1]] };
    function colSnap(c) { var o = cache[c] || {}; return { docs: Object.keys(o).map(function (id) { return { id: id, data: function () { return clone(o[id]) } } }) } }
    function docSnap(c, id) { var d = cache[c] && cache[c][id]; return { exists: !!d, id: id, data: function () { return clone(d) } } }
    function emit(c) { dirty[c] = 1; clearTimeout(timer); timer = setTimeout(flush, 5) }
    function flush() {
      var cs = Object.keys(dirty); dirty = {};
      cs.forEach(function (c) {
        (colSubs[c] || []).forEach(function (f) { f(colSnap(c)) });
        Object.keys(docSubs).forEach(function (p) { var q = split(p); if (q[0] === c) docSubs[p].forEach(function (f) { f(docSnap(c, q[1])) }) });
      });
    }
    function setLocal(c, id, data) { (cache[c] = cache[c] || {})[id] = data; emit(c) }
    function delLocal(c, id) { if (cache[c]) delete cache[c][id]; emit(c) }

    async function loadAll() {
      if (loading) return loading;
      loading = (async function () {
        var next = {}, from = 0, page = 1000;
        for (;;) {
          var r = await sb.from('docs').select('coll,id,data').eq('workspace_id', ws).range(from, from + page - 1);
          if (r.error) throw r.error;
          r.data.forEach(function (row) { (next[row.coll] = next[row.coll] || {})[row.id] = row.data });
          if (r.data.length < page) break;
          from += page;
        }
        var all = {}; Object.keys(cache).concat(Object.keys(next)).forEach(function (c) { all[c] = 1 });
        cache = next; loaded = true; lastLoad = Date.now();
        Object.keys(all).concat(Object.keys(colSubs)).forEach(emit);
      })().finally(function () { loading = null });
      return loading;
    }

    var ch = sb.channel('docs:' + ws)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'docs', filter: 'workspace_id=eq.' + ws }, function (p) { setLocal(p.new.coll, p.new.id, p.new.data) })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'docs', filter: 'workspace_id=eq.' + ws }, function (p) { setLocal(p.new.coll, p.new.id, p.new.data) })
      // Delete events can't be filtered server side; check the workspace here.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'docs' }, function (p) { if (p.old && p.old.workspace_id === ws) delLocal(p.old.coll, p.old.id) })
      .subscribe(function (status) { if (status === 'SUBSCRIBED' && loaded) loadAll().catch(function () {}) });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad > 60000) loadAll().catch(function () {});
    });
    var first = loadAll();

    function fail(e) {
      console.error('[truckle] db', e);
      if (e && (e.code === 'P0002' || /not_found/.test(e.message || ''))) return { code: 'not_found' };
      return { code: 'unavailable', message: (e && e.message) || 'network' };
    }
    function watch(subs, key, f) {
      (subs[key] = subs[key] || []).push(f);
      first.then(function () { f() }, function () { f() });
      return function () { subs[key] = (subs[key] || []).filter(function (x) { return x !== f }) };
    }
    return {
      workspaceId: ws,
      reload: loadAll,
      doc: function (p) {
        var q = split(p), c = q[0], id = q[1];
        return {
          id: id, path: p,
          get: async function () { await first; return docSnap(c, id) },
          set: async function (d) {
            var r = await sb.from('docs').upsert({ workspace_id: ws, coll: c, id: id, data: d, updated_at: new Date().toISOString() });
            if (r.error) throw fail(r.error);
            setLocal(c, id, clone(d));
          },
          update: async function (d) {
            var r = await sb.rpc('doc_patch', { p_ws: ws, p_coll: c, p_id: id, p_patch: d });
            if (r.error) throw fail(r.error);
            setLocal(c, id, r.data);
          },
          delete: async function () {
            var r = await sb.from('docs').delete().eq('workspace_id', ws).eq('coll', c).eq('id', id);
            if (r.error) throw fail(r.error);
            delLocal(c, id);
          },
          onSnapshot: function (cb, onErr) {
            first.catch(function (e) { onErr && onErr(e) });
            return watch(docSubs, p, function (s) { cb(s || docSnap(c, id)) });
          }
        };
      },
      collection: function (c) {
        return {
          onSnapshot: function (cb, onErr) {
            first.catch(function (e) { onErr && onErr(e) });
            return watch(colSubs, c, function (s) { cb(s || colSnap(c)) });
          }
        };
      },
      channel: ch
    };
  }

  // Find/join/create the workspace for the signed-in user, then hand the app its db.
  var attaching = null;
  function attach(role, name) {
    if (attaching) return attaching;
    attaching = (async function () {
      var join = null; try { join = sessionStorage.getItem('truckle.join') } catch (_) {}
      var w = await api('/api/workspace', { role: role, name: name || '', join: join || undefined });
      try { sessionStorage.removeItem('truckle.join') } catch (_) {}
      WS = w; TL.workspace = w;
      resolveDb(makeDb(w.workspaceId));
      return w;
    })();
    attaching.catch(function () { attaching = null });
    return attaching;
  }

  function go(url) { location.href = url }
  function toastMsg(m) { try { toast(m) } catch (_) { alert(m) } }
  function cleanUrl() { history.replaceState(null, '', location.pathname) }

  var TL = window.TL = {
    live: true,
    testMode: C.stripeMode !== 'live',
    payEnabled: !!C.payEnabled,
    workspace: null,
    api: api,

    // Email + password. Signs in, or creates the account if it doesn't exist.
    emailAuth: async function (email, password, name) {
      await sbReady;
      var r = await sb.auth.signInWithPassword({ email: email, password: password });
      if (!r.error) return { ok: true };
      if (!/invalid login credentials/i.test(r.error.message || '')) throw r.error;
      var s = await sb.auth.signUp({ email: email, password: password, options: { data: { name: name || '' }, emailRedirectTo: location.origin + '/' } });
      if (s.error) throw s.error;
      if (s.data.session) return { ok: true, created: true };
      return { confirm: true };
    },
    oauth: async function (provider) {
      await sbReady;
      var r = await sb.auth.signInWithOAuth({ provider: provider, options: { redirectTo: location.origin + '/' } });
      if (r.error) throw r.error;
    },
    resetPassword: async function (email) {
      await sbReady;
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
      if (r.error) throw r.error;
    },
    chooseRole: function (role, name) { return attach(role, name) },
    signOut: async function () {
      try { await sbReady; await sb.auth.signOut() } catch (_) {}
      ls.del('truckle.session'); ls.del('crewbill.view');
      location.replace(location.pathname);
    },
    inviteLink: function () { return WS && WS.joinCode ? location.origin + '/?join=' + WS.joinCode : null },
    payLink: function (cinvId) { return WS ? location.origin + '/pay.html?w=' + WS.workspaceId + '&i=' + encodeURIComponent(cinvId) : null },

    // Truckle Pay
    payInvoice: async function (id, method) {
      var r = await api('/api/pay/checkout', { workspaceId: WS.workspaceId, kind: 'invoice', id: id, method: method });
      if (r.fallback) toastMsg('Bank payments are not switched on yet. Paying by card instead.');
      go(r.url);
    },
    payCinvoice: async function (id, method) {
      var r = await api('/api/pay/checkout', { workspaceId: WS.workspaceId, kind: 'cinvoice', id: id, method: method }, { auth: false });
      go(r.url);
    },
    connect: async function (kind, id) {
      var r = await api('/api/connect/onboard', { workspaceId: WS.workspaceId, kind: kind, id: id });
      go(r.url);
    },
    connectStatus: function (kind, id) { return api('/api/connect/status', { workspaceId: WS.workspaceId, kind: kind, id: id }) }
  };

  // Boot: restore the session, attach the workspace, and handle returns from Stripe.
  (async function () {
    try {
      await sbReady;
      var r = await sb.auth.getSession(), session = r.data.session;
      sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') ls.del('truckle.session') });
      var saved = savedSession();
      if (!session) {
        // Signed out elsewhere or the session expired: start again at sign-in.
        if (saved) { ls.del('truckle.session'); location.reload() }
        return;
      }
      if (saved) { await attach(saved.role, saved.name) }
      else {
        // Back from Google/Apple/Facebook or an email confirmation: ask how they'll use Truckle.
        var md = session.user.user_metadata || {};
        var wait = setInterval(function () {
          if (typeof authStep !== 'function' || typeof AUTH === 'undefined') return;
          clearInterval(wait);
          AUTH.email = session.user.email || ''; AUTH.name = md.name || md.full_name || '';
          AUTH.via = (session.user.app_metadata && session.user.app_metadata.provider) || 'email';
          authStep('role');
        }, 50);
      }
      if (location.hash && /access_token=/.test(location.hash)) cleanUrl();
      if (qs.has('code')) cleanUrl();
      await dbPromise;
      var kind = qs.get('kind'), pid = qs.get('id');
      if (qs.get('connect') === 'return' && kind && pid) {
        cleanUrl();
        var st = await TL.connectStatus(kind, pid).catch(function () { return null });
        var ps = st && st.payouts && st.payouts.status;
        toastMsg(ps === 'active' ? 'Payouts are on. You can be paid in Truckle.' : ps === 'review' ? 'Thanks! Stripe is checking your details.' : 'Payout setup isn\'t finished yet. Tap Set up payouts to carry on.');
      } else if (qs.get('connect') === 'refresh' && kind && pid) {
        cleanUrl(); TL.connect(kind, pid).catch(function (e) { toastMsg(e.message) });
      } else if (qs.get('paid')) {
        cleanUrl(); toastMsg('Payment received. The invoice updates in a moment.');
      } else if (qs.get('paycancel')) {
        cleanUrl(); toastMsg('Payment cancelled. Nothing was charged.');
      }
    } catch (e) {
      console.error('[truckle] live boot', e);
      toastMsg(e.message || 'Could not connect to Truckle. Reload the page.');
    }
  })();
})();
