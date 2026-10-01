// Talks to the Apps Script backend, or to a localStorage fake when API_URL is empty (demo mode).
(function () {
  var CFG = window.RAFFLE_CONFIG || {};
  var DEMO = !CFG.API_URL;

  async function remote(action, payload) {
    var res, ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000);
    try {
      if (action === 'board' || action === 'order') {
        var q = new URLSearchParams({ action: action, orderId: (payload || {}).orderId || '' });
        res = await fetch(CFG.API_URL + '?' + q, { signal: ctl.signal });
      } else {
        // text/plain avoids a CORS preflight, which Apps Script can't answer.
        res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal,
          body: JSON.stringify(Object.assign({ action: action }, payload)) });
      }
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // ---------------- demo backend ----------------
  var KEY = 'raffle-demo-v1';
  function load() {
    var s = null; try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (s) return s;
    s = { cfg: { clubName: CFG.CLUB_NAME || 'Club', name: 'Demo Paddle Raffle', price: 150, total: 100, status: 'OPEN',
      holdMinutes: 30, maxSlotsPerOrder: 20,
      prizes: ['1st Prize: Demo Paddle', '2nd Prize: Free Open Play + grip tape', '3rd Prize: Free Open Play'],
      pay: 'GCash: 09XX XXX XXXX (Account Name)\nMaya: 09XX XXX XXXX (Account Name)' },
      slots: {}, orders: [], entries: null, winners: [] };
    return s;
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function pub(name) { var p = name.trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1][0].toUpperCase() + '.' : p[0]; }
  function sweep(s) {
    s.orders.forEach(function (o) {
      if (o.status === 'PENDING' && Date.parse(o.expiresAt) < Date.now()) { o.status = 'EXPIRED'; o.slots.forEach(function (n) { delete s.slots[n]; }); }
    });
  }
  function find(s, id) { var o = s.orders.filter(function (x) { return x.orderId === id; })[0]; if (!o) throw new Error('Order not found.'); return o; }
  function mobileOk(m) { m = String(m || '').replace(/[\s\-()]/g, ''); if (/^\+639\d{9}$/.test(m)) return '0' + m.slice(3); if (/^639\d{9}$/.test(m)) return '0' + m.slice(2); return /^09\d{9}$/.test(m) ? m : null; }

  var demo = {
    board: function (s) {
      var c = s.cfg, slots = [];
      for (var n = 1; n <= c.total; n++) {
        var h = s.slots[n], o = h && s.orders.filter(function (x) { return x.orderId === h.orderId; })[0];
        slots.push({ n: n, status: h ? h.status : 'AVAILABLE', label: o ? pub(o.name) : '' });
      }
      return { ok: true, raffle: { clubName: c.clubName, name: c.name, price: c.price, total: c.total, status: c.status,
        prizes: c.prizes, holdMinutes: c.holdMinutes, maxSlotsPerOrder: c.maxSlotsPerOrder }, slots: slots,
        winners: s.winners.map(function (w) { return { prize: w.prize, slot: w.slot, name: pub(w.name) }; }) };
    },
    reserve: function (s, p) {
      var c = s.cfg; if (c.status !== 'OPEN') throw new Error('Registration is closed.');
      var name = (p.name || '').trim(), fb = (p.facebook || '').trim(), mob = mobileOk(p.mobile);
      if (name.length < 2) throw new Error('Please enter your name.');
      if (!mob) throw new Error('Enter a valid PH mobile number (09XXXXXXXXX).');
      if (fb.length < 2) throw new Error('Please enter your Facebook name.');
      var want = (p.slots || []).map(Number).filter(function (n, i, a) { return a.indexOf(n) === i; });
      if (!want.length) throw new Error('Pick at least one number.');
      if (want.length > c.maxSlotsPerOrder) throw new Error('Maximum ' + c.maxSlotsPerOrder + ' slots per order.');
      var taken = want.filter(function (n) { return s.slots[n]; });
      if (taken.length) return { ok: false, error: 'Sorry, just taken: #' + taken.join(', #') + '. Please pick others.', taken: taken };
      want.sort(function (a, b) { return a - b; });
      var id = Math.random().toString(36).slice(2, 12).toUpperCase();
      s.orders.push({ orderId: id, createdAt: new Date().toISOString(), name: name, mobile: mob, facebook: fb, slots: want,
        amount: want.length * c.price, status: 'PENDING', expiresAt: new Date(Date.now() + c.holdMinutes * 60000).toISOString(), proofUrl: '' });
      want.forEach(function (n) { s.slots[n] = { status: 'PENDING', orderId: id }; });
      var o = s.orders[s.orders.length - 1];
      return { ok: true, orderId: id, slots: want, amount: o.amount, expiresAt: o.expiresAt, paymentInstructions: c.pay };
    },
    resume: function () { return { ok: false, notFound: true, error: 'No reservation found.' }; }, // demo calls never lose a response
    proof: function (s, p) {
      var o = find(s, p.orderId);
      if (o.status === 'EXPIRED') throw new Error('This reservation expired. Please pick your numbers again.');
      if (o.status !== 'PENDING' && o.status !== 'SUBMITTED') throw new Error('This order is already ' + o.status + '.');
      o.status = 'SUBMITTED'; o.proofUrl = 'data:' + p.mime + ';base64,' + p.data; return { ok: true, status: 'SUBMITTED' };
    },
    order: function (s, p) {
      var o = find(s, p.orderId);
      return { ok: true, order: { orderId: o.orderId, name: pub(o.name), slots: o.slots, amount: o.amount, status: o.status,
        expiresAt: o.expiresAt, raffleName: s.cfg.name, paymentInstructions: s.cfg.pay } };
    },
    adminList: function (s) {
      var c = s.cfg, cnt = function (st) { return Object.keys(s.slots).filter(function (n) { return s.slots[n].status === st; }).length; };
      var paid = cnt('PAID'), pend = cnt('PENDING');
      return { ok: true, raffleStatus: c.status, frozen: !!s.entries, prizes: c.prizes,
        stats: { total: c.total, paid: paid, pending: pend, available: c.total - paid - pend, collected: paid * c.price, potential: (c.total - paid) * c.price },
        orders: s.orders.slice().reverse().map(function (o) { return Object.assign({ raffleName: c.name }, o); }),
        winners: s.winners };
    },
    approve: function (s, p) {
      var o = find(s, p.orderId); if (o.status === 'PAID') return { ok: true };
      if (['PENDING', 'SUBMITTED', 'EXPIRED'].indexOf(o.status) < 0) throw new Error('Cannot approve an order that is ' + o.status + '.');
      var gone = o.status === 'EXPIRED' ? o.slots.filter(function (n) { return s.slots[n]; }) : [];
      if (gone.length) throw new Error('Slots #' + gone.join(', #') + ' were taken by someone else after expiry.');
      o.status = 'PAID'; o.slots.forEach(function (n) { s.slots[n] = { status: 'PAID', orderId: o.orderId }; }); return { ok: true };
    },
    reject: function (s, p) { return demo._free(s, p, 'REJECTED', ['PENDING', 'SUBMITTED']); },
    release: function (s, p) { return demo._free(s, p, 'RELEASED', ['PAID']); },
    _free: function (s, p, ns, allowed) {
      var o = find(s, p.orderId); if (allowed.indexOf(o.status) < 0) throw new Error('Cannot do that to an order that is ' + o.status + '.');
      if (s.entries) throw new Error('Entries are frozen.');
      o.slots.forEach(function (n) { delete s.slots[n]; }); o.status = ns; return { ok: true };
    },
    freeze: function (s) {
      if (s.entries) throw new Error('Already frozen.');
      var e = Object.keys(s.slots).filter(function (n) { return s.slots[n].status === 'PAID'; }).map(function (n) {
        return { slot: Number(n), name: find(s, s.slots[n].orderId).name }; });
      if (!e.length) throw new Error('No paid entries to freeze.');
      s.orders.forEach(function (o) { if (o.status === 'PENDING' || o.status === 'SUBMITTED') { o.slots.forEach(function (n) { delete s.slots[n]; }); o.status = 'REJECTED'; } });
      s.entries = e; s.cfg.status = 'CLOSED'; return { ok: true, entries: e.length };
    },
    draw: function (s) {
      if (!s.entries) throw new Error('Freeze the entries first.');
      if (s.winners.length >= s.cfg.prizes.length) throw new Error('All prizes have been drawn.');
      var pool = s.entries.filter(function (e) { return !s.winners.some(function (w) { return w.slot === e.slot; }); });
      var pick = pool[Math.floor(Math.random() * pool.length)];
      var w = { prize: s.cfg.prizes[s.winners.length], slot: pick.slot, name: pick.name }; s.winners.push(w);
      return { ok: true, prize: w.prize, slot: w.slot, name: w.name, remaining: pool.length - 1 };
    },
  };
  var ADMIN = ['adminList', 'approve', 'reject', 'release', 'freeze', 'draw'];

  async function call(action, payload) {
    payload = payload || {};
    try {
      if (!DEMO) return await remote(action, payload);
      var s = load();
      if (ADMIN.indexOf(action) >= 0 && payload.pin !== '1234') return { ok: false, error: 'Wrong PIN' };
      sweep(s);
      var out;
      try { out = demo[action](s, payload); } catch (e) { out = { ok: false, error: e.message }; }
      save(s); return out;
    } catch (e) {
      return { ok: false, network: true, error: 'Network problem. Please try again.' };
    }
  }
  window.RaffleAPI = { call: call, demo: DEMO };
})();
