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
    byId: function (queue, id) { return find(queue, id) || null; },
    // storage is the truth (two tabs, one phone): read the stored queue, change it, write it back; ok = storage took it
    edit: function (read, write, fn) { var q = read() || [], r = fn(q); return { ok: write(q) !== false, q: q, r: r }; },
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
    // sentAt = the phone's (corrected) clock as it sends: with `at`, the server can tell a phone clock that is off
    body: function (job, sentAt) {
      if (job.kind === 'undo') return { id: job.id };
      var b = { id: job.id, till: job.till, n: job.n, at: job.at, q: job.q, prize: job.prize || null, undone: !!job.undone };
      if (typeof sentAt === 'number') b.sentAt = sentAt;
      return b;
    },
    // saved: settled on the server's answer (`undone`), never on what was sent. Undo asked and refused → stays sold, in red;
    // Undo tapped while the sale was on its way → asked now (POST /till/undo).
    settle: function (queue, job, sent, reply) {
      job.inflight = false;
      if (job.kind === 'sale' && job.undone) {
        var got = reply && typeof reply.undone === 'boolean' ? reply.undone : !!(sent && sent.undone);
        if (!got && sent && sent.undone) { job.kind = 'undo'; Q.fail(queue, job, { status: 409, error: 'too-late' }); return; }
        if (!got) { job.kind = 'undo'; job.tries = 0; job.nextAt = 0; return; }
      }
      drop(queue, job);
    },
    backoff: function (tries) { return Math.min(60000, 1000 * Math.pow(2, Math.max(1, tries))); },
    retry: function (queue, job, now) { job.inflight = false; job.tries = (job.tries || 0) + 1; job.nextAt = now + Q.backoff(job.tries); },
    // a refusal (4xx that isn't the login) is final: kept and shown, never sent again
    fail: function (queue, job, res) { job.inflight = false; job.err = { status: res.status || 0, error: res.error || ('http-' + res.status), message: res.message || '' }; },
    classify: function (res) {
      if (res.ok) return 'ok';
      if (res.net) return 'retry';
      if (res.status === 401 || res.error === 'login') return 'login';   // (a 403 "origin" is a wrong site: no PIN fixes it)
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
  // the red line: sales the server refused, and undos it refused (the sale then stays sold: too late, or an owner corrected it)
  function failLine(queue) {
    var f = Q.failed(queue), sold = f.filter(function (j) { return j.kind !== 'undo'; }), und = f.filter(function (j) { return j.kind === 'undo'; }), out = [];
    if (sold.length) out.push(sold.length + ' not saved — tell an owner (' + sold.map(function (j) { return R.code(j.till, j.n) + ' · ' + j.err.error; }).join(', ') + ')');
    if (und.length) {
      var odd = und.filter(function (j) { return j.err.error !== 'too-late'; }).map(function (j) { return j.err.error; });
      out.push('Too late to undo ' + und.map(function (j) { return R.code(j.till, j.n); }).join(', ') + ' — tell an owner' + (odd.length ? ' (' + odd.join(', ') + ')' : ''));
    }
    return out.join(' · ');
  }
  // every server answer carries its clock (ms): server − phone, used only when the phone is more than 5 minutes off; null = no clock
  function clockOffset(serverNow, sentAt, gotAt) {
    if (typeof serverNow !== 'number' || !isFinite(serverNow)) return null;
    var off = serverNow - (sentAt + gotAt) / 2;
    return Math.abs(off) > 300000 ? Math.round(off) : 0;
  }

  // the Last line: ✓ only once the server has the sale
  function lastWords(last, queue) {
    if (!last || !last.till) return '';
    var j = find(queue || [], last.id), base = 'Last: ' + R.code(last.till, last.n) + ' · ' + R.money(last.total);
    return !j ? base + ' ✓' : j.err ? base + ' · not saved' : base + ' · waiting';
  }
  // one tab owns the till (a heartbeat in storage); a heartbeat older than 10 s = that tab was closed or frozen: free to take
  function tabState(owner, me, nowMs) {
    if (!owner || !owner.id) return 'free';
    if (owner.id === me) return 'mine';
    return nowMs - (+owner.at || 0) < 10000 ? 'other' : 'free';
  }
  // ?api=staging is remembered for the SGT day it was set ({v, day}); the next day the phone is back on live
  function storedApi(raw, today) {
    var o = null; try { o = JSON.parse(raw); } catch (e) { return null; }
    return o && typeof o === 'object' && o.day === today && typeof o.v === 'string' ? o.v : null;
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
  // "2026-11-30" → "2026-12-01" (the QR's expiry: the day after the sale day)
  function nextDay(date) { var p = String(date).split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1)); return d.getUTCFullYear() + '-' + R.pad(d.getUTCMonth() + 1, 2) + '-' + R.pad(d.getUTCDate(), 2); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  root.TillCore = {
    API: API, pickApi: pickApi, nextN: nextN, uid: uid, parseCents: parseCents, parseCode: parseCode, findOrders: findOrders,
    Q: Q, pill: pill, failLine: failLine, clockOffset: clockOffset, hm: hm, dayWords: dayWords, when: when, ymd: ymd, nextDay: nextDay, esc: esc,
    lastWords: lastWords, tabState: tabState, storedApi: storedApi
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
