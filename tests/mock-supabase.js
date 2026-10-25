// In-memory stand-in for supabase-js, only for the browser smoke test. It mimics the calls the page
// makes (auth, rpc, select) with simplified booking rules so the interface can be exercised offline.
(function () {
  var seed = window.__seed || {};
  var db = {
    bookings: (seed.bookings || []).slice(),
    allowed: [
      { email: 'boss@t.test', role: 'admin', display_name: 'Boss' },
      { email: 'ann@t.test', role: 'staff', display_name: 'Ann' },
    ],
    n: 100,
  };
  window.__db = db;
  var me = window.__loginAs || null;
  var listener = null;
  function err(m) { return { error: { message: m }, data: null }; }
  function overlap(a, b) { return a.date === b.date && a.start_min < b.end_min && b.start_min < a.end_min; }
  function role() { var u = db.allowed.find(function (x) { return x.email === me; }); return u ? u.role : null; }
  function row(p, status) {
    return { id: 'id' + (db.n++), owner_email: me, name: p.p_name, date: p.p_date, start_min: p.p_start, end_min: p.p_end, status: status,
      created_at: new Date().toISOString(), promoted_at: null, teacher: '', attendance: '', remark: '', internship: false, entered: false };
  }
  var rpcs = {
    whoami: function () { var u = db.allowed.find(function (x) { return x.email === me; }); return { data: u || null, error: null }; },
    book_slot: function (p) {
      if (!role()) return err('not_allowed');
      if (db.bookings.some(function (b) { return b.owner_email === me && overlap(b, { date: p.p_date, start_min: p.p_start, end_min: p.p_end }); })) return err('own_overlap');
      var taken = db.bookings.some(function (b) { return b.status === 'confirmed' && overlap(b, { date: p.p_date, start_min: p.p_start, end_min: p.p_end }); });
      var r = row(p, taken ? 'waitlisted' : 'confirmed'); db.bookings.push(r); return { data: r, error: null };
    },
    cancel_booking: function (p) {
      var i = db.bookings.findIndex(function (b) { return b.id === p.p_id; });
      if (i < 0) return err('not_found');
      if (role() !== 'admin' && db.bookings[i].owner_email !== me) return err('not_allowed');
      db.bookings.splice(i, 1); return { data: null, error: null };
    },
    admin_swap_in: function (p) {
      if (role() !== 'admin') return err('not_allowed');
      var w = db.bookings.find(function (b) { return b.id === p.p_id; });
      db.bookings.forEach(function (b) { if (b.id !== w.id && b.status === 'confirmed' && overlap(b, w)) b.status = 'waitlisted'; });
      w.status = 'confirmed'; return { data: null, error: null };
    },
    admin_save_booking: function (p) {
      if (role() !== 'admin') return err('not_allowed');
      var b = db.bookings.find(function (x) { return x.id === p.p_id; });
      var t = { id: b.id, date: p.p_date, start_min: p.p_start, end_min: p.p_end };
      var clash = db.bookings.filter(function (x) { return x.id !== b.id && x.status === 'confirmed' && overlap(x, t); });
      if (p.p_status === 'confirmed' && clash.length) return { data: { ok: false, conflict: clash.map(function (c) { return { name: c.name, start_min: c.start_min, end_min: c.end_min }; }) }, error: null };
      Object.assign(b, { name: p.p_name, date: p.p_date, start_min: p.p_start, end_min: p.p_end, status: p.p_status });
      return { data: { ok: true }, error: null };
    },
    admin_log_patch: function (p) { var b = db.bookings.find(function (x) { return x.id === p.p_id; }); Object.assign(b, p.p_patch); return { data: null, error: null }; },
    admin_add_staff: function (p) {
      if (role() !== 'admin') return err('not_allowed');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.p_email.trim())) return err('bad_email');
      db.allowed.push({ email: p.p_email.trim().toLowerCase(), role: 'staff', display_name: p.p_name || null }); return { data: null, error: null };
    },
    admin_remove_staff: function (p) { db.allowed = db.allowed.filter(function (u) { return !(u.email === p.p_email && u.role === 'staff'); }); return { data: null, error: null }; },
  };
  function query(table) {
    var q = { _t: table, _from: 0, _to: 999 };
    q.select = function () { return q; };
    q.order = function () { return q; };
    q.range = function (a, b) { q._from = a; q._to = b; return q; };
    q.then = function (res, rej) {
      var rows = table === 'bookings' ? db.bookings : db.allowed;
      return Promise.resolve({ data: rows.slice(q._from, q._to + 1).map(function (r) { return Object.assign({}, r); }), error: null }).then(res, rej);
    };
    return q;
  }
  window.supabase = {
    createClient: function (url, key, opts) {
      var store = opts.auth.storage;
      return {
        auth: {
          getSession: async function () { var s = store.getItem('mock-session'); return { data: { session: s ? JSON.parse(s) : null }, error: null }; },
          onAuthStateChange: function (cb) { listener = cb; return { data: { subscription: { unsubscribe: function () {} } } }; },
          signInWithOAuth: async function () {
            store.setItem('mock-session', JSON.stringify({ user: { email: me, user_metadata: { full_name: 'Google Name' } } }));
            location.reload(); return { error: null };
          },
          signOut: async function () { store.removeItem('mock-session'); if (listener) listener('SIGNED_OUT'); return { error: null }; },
        },
        rpc: async function (fn, args) { return rpcs[fn](args || {}); },
        from: query,
        channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
        removeChannel: function () {},
      };
    },
  };
})();
