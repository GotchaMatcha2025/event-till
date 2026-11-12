/* Gotcha Matcha event till — the pure parts both pages share (no screen, no network), tested by test/core.test.mjs in node.
   Plain ES5 script after rules.js: it puts TillCore on the global object. Money is whole cents; every time word is Singapore time. */
(function (root) {
  'use strict';
  var R = root.TillRules;

  // ---------- which server (live by default; a public page can never be pointed at another host) ----------
  var API = { live: 'https://gotcha-till.long-fog-ae60.workers.dev', staging: 'https://gotcha-till-staging.long-fog-ae60.workers.dev' };
  var LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):(\d{2,5})$/;
  // search = location.search, stored = what this phone remembered; save: a value to remember, null = forget, undefined = leave
  function pickApi(search, protocol, hostname, stored) {
    var m = /[?&]api=([^&#]*)/.exec(search || ''), v = null;
    if (m) { try { v = decodeURIComponent(m[1]); } catch (e) { v = 'live'; } }
    var want = v !== null ? v : stored, local = protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1', lm;
    var r = { mode: 'live', base: API.live, ns: 'live' };
    if (want === 'staging') r = { mode: 'staging', base: API.staging, ns: 'staging' };
    else if (want && local && (lm = LOCAL.exec(want))) r = { mode: 'local', base: want, ns: 'local-' + lm[2] };   // the stub, only from a copy on this computer
    if (v !== null) r.save = r.mode === 'live' ? null : v;
    return r;
  }

  // ---------- numbers ----------
  // the next order number on this phone: max(its own counter, the server's lastN, anything of this letter still queued) + 1
  function nextN(localLast, serverLast, queue, letter) {
    var m = Math.max(+localLast || 0, +serverLast || 0);
    for (var i = 0; i < (queue || []).length; i++) if (queue[i].till === letter && queue[i].n > m) m = queue[i].n;
    return m + 1;
  }
  // a sale's own id (the server's safe-to-repeat key): randomUUID, else getRandomValues (iOS 15.0–15.3), else Math.random
  function uid(cr) {
    var c = cr === undefined ? root.crypto : cr, b = [], i, h = '';
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') { b = c.getRandomValues(new Uint8Array(16)); }
    else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;   // version 4, variant 10
    for (i = 0; i < 16; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16) + (i === 3 || i === 5 || i === 7 || i === 9 ? '-' : '');
    return h;
  }
  // "7", "7.5", "S$7.00", "$1,200" → cents; blank → 0; anything else (7x, 1,2,3, -7) → NaN. String maths: no float drift.
  function parseCents(v) {
    var raw = String(v == null ? '' : v).trim(), t = raw.replace(/^s?\$\s*/i, '');
    if (!raw) return 0;
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return NaN;
    var p = t.replace(/,/g, '').split('.');
    return (+p[0]) * 100 + (p[1] ? +(p[1] + '0').slice(0, 2) : 0);
  }

  // ---------- orders ----------
  function parseCode(code) { var m = /^([A-Z])-(\d+)$/.exec(code || ''); return m ? { till: m[1], n: +m[2] } : null; }
  function escRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // find (mock-up rev 3.1): "A-012", "a12", "12", "GMA012": the exact number first, then numbers that start with it; newest first, then till, number
  function findOrders(orders, query, prefix) {
    var q = String(query || '').trim();
    var m = new RegExp('^\\s*(?:' + escRe(prefix || '') + ')?\\s*([a-z])?\\s*-?\\s*(\\d*)\\s*$', 'i').exec(q);
    var qt = m && m[1] ? m[1].toUpperCase() : null, qd = m ? m[2] : '', starts = qd.replace(/^0+/, '');
    var out = [], i, o, c;
    if (q && !m) return out;
    for (i = 0; i < orders.length; i++) {
      o = orders[i]; c = parseCode(o.code) || { till: '', n: -1 };
      var exact = qd !== '' && c.n === +qd && (!qt || c.till === qt);
      if (!q || ((!qt || c.till === qt) && (exact || String(c.n).indexOf(starts) === 0))) out.push({ o: o, c: c, x: exact ? 1 : 0 });
    }
    out.sort(function (a, b) {
      return (b.x - a.x) || ((b.o.at || 0) - (a.o.at || 0)) || (a.c.till > b.c.till ? -1 : a.c.till < b.c.till ? 1 : 0) || (b.c.n - a.c.n);
    });
    return out.map(function (x) { return x.o; });
  }

  // ---------- the offline queue: every sale is kept on the phone first, then sent until the server has it ----------
  // job: {kind:'sale'|'undo', id, till, n, at, q, prize, undone, total, tries, nextAt, err, inflight}
  function find(queue, id, kind) { for (var i = 0; i < queue.length; i++) if (queue[i].id === id && (!kind || queue[i].kind === kind)) return queue[i]; return null; }
  function drop(queue, job) { var i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); }
  var Q = {
    add: function (queue, job) { job.tries = job.tries || 0; job.nextAt = job.nextAt || 0; job.err = job.err || null; job.inflight = false; queue.push(job); return job; },
    waiting: function (queue) { var n = 0; for (var i = 0; i < queue.length; i++) if (!queue[i].err) n++; return n; },
    failed: function (queue) { return queue.filter(function (j) { return !!j.err; }); },
    // jobs of another letter are never sent with this till's token (they show as not saved)
    foreign: function (queue, letter) { return queue.filter(function (j) { return !j.err && j.till !== letter; }); },
    ready: function (queue, now, letter) {
      for (var i = 0; i < queue.length; i++) { var j = queue[i]; if (!j.err && !j.inflight && j.till === letter && (j.nextAt || 0) <= now) return j; }
      return null;
    },
    wake: function (queue, letter) {
      var t = null;
      for (var i = 0; i < queue.length; i++) { var j = queue[i]; if (!j.err && j.till === letter && (t === null || (j.nextAt || 0) < t)) t = j.nextAt || 0; }
      return t;
    },
    path: function (job) { return job.kind === 'undo' ? '/till/undo' : '/till/sale'; },
    body: function (job) {
      if (job.kind === 'undo') return { id: job.id };
      return { id: job.id, till: job.till, n: job.n, at: job.at, q: job.q, prize: job.prize || null, undone: !!job.undone };
    },
    // saved: the job goes; but a sale undone while it was on its way comes back as an undo (the server keeps a sale's first answer)
    settle: function (queue, job, sent) {
      job.inflight = false;
      if (job.kind === 'sale' && job.undone && sent && !sent.undone) { job.kind = 'undo'; job.tries = 0; job.nextAt = 0; return; }
      drop(queue, job);
    },
    backoff: function (tries) { return Math.min(60000, 1000 * Math.pow(2, Math.max(1, tries))); },
    retry: function (queue, job, now) { job.inflight = false; job.tries = (job.tries || 0) + 1; job.nextAt = now + Q.backoff(job.tries); },
    // a refusal (4xx that isn't the login) is final: kept and shown, never sent again
    fail: function (queue, job, res) { job.inflight = false; job.err = { status: res.status || 0, error: res.error || ('http-' + res.status), message: res.message || '' }; },
    classify: function (res) {
      if (res.ok) return 'ok';
      if (res.net) return 'retry';
      if (res.status === 401 || res.status === 403 || res.error === 'login') return 'login';
      if (!res.status || res.status >= 500 || res.status === 429 || res.status === 408) return 'retry';
      return 'fail';
    },
    // Undo on the Paid screen: still queued → sent once as undone; already sent → POST /till/undo, queued like a sale
    undo: function (queue, sale) {
      var j = find(queue, sale.id, 'sale');
      if (j) { j.undone = true; return 'queued'; }
      if (find(queue, sale.id, 'undo')) return 'queued';
      Q.add(queue, { kind: 'undo', id: sale.id, till: sale.till, n: sale.n });
      return 'undo';
    }
  };
  function pill(queue, offline, needPin) {
    var w = Q.waiting(queue);
    if (needPin) return { text: 'PIN needed' + (w ? ' · ' + w + ' waiting' : ''), cls: 'warn' };
    if (!w) return { text: '● All saved', cls: 'ok' };
    return offline ? { text: 'Offline · ' + w + ' waiting', cls: 'warn' } : { text: w + ' waiting to send', cls: 'warn' };
  }
  function failLine(queue) {
    var f = Q.failed(queue);
    if (!f.length) return '';
    return f.length + ' not saved — tell an owner (' + f.map(function (j) { return R.code(j.till, j.n) + ' · ' + j.err.error; }).join(', ') + ')';
  }

  // ---------- time words (Singapore, whatever the phone's zone) ----------
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function hm(ms) { var m = R.sgtMin(ms), h = Math.floor(m / 60); return ((h % 12) || 12) + ':' + R.pad(m % 60, 2) + (h >= 12 ? 'pm' : 'am'); }
  // "2026-11-14" → {short:'Sat 14', label:'Sat 14 Nov', full:'Sat 14 Nov 2026'} (event days from rules.js, other dates worked out)
  function dayWords(date) {
    var p = String(date).split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])), ev = R.day(date);
    var short = ev ? ev.short : WD[d.getUTCDay()] + ' ' + d.getUTCDate(), label = ev ? ev.label : short + ' ' + MO[d.getUTCMonth()];
    return { date: date, short: short, label: label, full: label + ' ' + p[0] };
  }
  function when(ms, today) { var d = R.sgtDate(ms); return d === today ? hm(ms) : dayWords(d).short + ' ' + hm(ms); }
  function ymd(date) { return String(date).replace(/-/g, ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  root.TillCore = {
    API: API, pickApi: pickApi, nextN: nextN, uid: uid, parseCents: parseCents, parseCode: parseCode, findOrders: findOrders,
    Q: Q, pill: pill, failLine: failLine, hm: hm, dayWords: dayWords, when: when, ymd: ymd, esc: esc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
