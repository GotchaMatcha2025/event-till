/* Gotcha Matcha event till — Admin, owners only (mock-up rev 3.1, owner's yes 12 Nov 2026; API contract in gotcha-hq).
   Every figure is drawn from GET /admin/state (the server works out the X reading, the owners' card, items and prizes); this page only
   draws it, pre-checks a correction like the mock-up, and lets the server decide. Corrections are add-only server rows (void, restore,
   adjust, undo), each with a fresh request id that is re-sent on a retry. Save PDF prints the X reading receipt only. Plain ES5. */
(function () {
  'use strict';
  var R = window.TillRules, C = window.TillCore, A = window.TillApi, E = R.EVENT;
  var $ = function (id) { return document.getElementById(id); };
  var esc = C.esc, money = R.money;
  var VOID_WHY = ["Didn't pay", 'Refunded in full', 'Test'];

  // the owner token lives for this tab only (Lock clears it); one per server
  var TOK = A.key('owner');
  function ssGet() { try { return JSON.parse(window.sessionStorage.getItem(TOK)); } catch (e) { return null; } }
  function ssSet(v) { try { if (v) window.sessionStorage.setItem(TOK, JSON.stringify(v)); else window.sessionStorage.removeItem(TOK); } catch (e) { /* private mode */ } }
  var S = { auth: ssGet(), st: null, stFor: null, all: null, filter: 'all', shown: 10, find: '', pin: '', busy: false, loading: 0, screen: null, loadErr: null };
  // the state on hand is for the day chip on screen (a slow or failed load never shows another day's figures, or prints them)
  function ready() { return !!S.st && S.stFor === S.filter; }

  // ---------- small helpers ----------
  function signed(c) { return (c > 0 ? '+' : '') + money(c); }
  function hhmm(s) { var p = String(s).split(':'), h = +p[0], m = +p[1]; return ((h % 12) || 12) + ':' + R.pad(m, 2) + (h >= 12 ? 'pm' : 'am'); }
  function mins(s) { var p = String(s).split(':'); return +p[0] * 60 + +p[1]; }
  function stamp(ms) { return C.dayWords(R.sgtDate(ms)).short + ' ' + C.hm(ms); }   // "Fri 13 6:09pm"
  function days() { return (S.st && S.st.days && S.st.days.length) ? S.st.days : E.days; }
  function nowMs() { return S.st && S.st.now ? S.st.now : Date.now(); }
  function today() { return R.sgtDate(nowMs()); }
  // "so far": that day's booth is still open (or not yet an hour past closing)
  function openStill(date) {
    var d = null, ds = days(), i; for (i = 0; i < ds.length; i++) if (ds[i].date === date) d = ds[i];
    return !!d && today() === date && R.sgtMin(nowMs()) <= mins(d.close) + 60;
  }
  function itemName(id, fallback) { var m = R.item(id); return m ? (m.full || m.name) : (fallback || id); }
  function itemsText(o) {
    var a = (o.lines || []).map(function (l) { return l.q + ' ' + itemName(l.id); });
    return a.join(', ') + (o.prize ? ' · ' + (R.prize(o.prize) ? R.prize(o.prize).label : o.prize) : '');
  }
  // a hint sits under the top bar (never over a button)
  function toast(msg) {
    var t = $('toast'), top = document.querySelector('#s-' + S.screen + ' .top'), app = $('app').getBoundingClientRect();
    t.textContent = msg; t.hidden = false;
    t.style.top = Math.max(8, Math.round(top ? top.getBoundingClientRect().bottom - app.top + 8 : 12)) + 'px';
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function untoast() { clearTimeout(toast.t); $('toast').hidden = true; }   // a hint never follows to the next screen or sheet (it covered Hold: Paid)
  function note(text, bad) { var n = $('adnote'); n.textContent = text || ''; n.className = bad ? 'err adnote' : 'count adnote'; }
  function closeSheet() { $('sheet').innerHTML = ''; S.sheet = null; }
  function sheet(html) {
    if (!$('sheet').firstChild) untoast();
    $('sheet').innerHTML = '<div class="sheetwrap" id="sw"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    $('sw').addEventListener('click', function (e) {   // a tap outside = Cancel (and a fresh look if a save was left unsure)
      if (e.target.id !== 'sw' || (S.sheet && S.sheet.busy)) return;
      var unsure = S.sheet && S.sheet.unsure; closeSheet(); if (unsure) load('keep');
    });
  }

  // ---------- screens ----------
  function show(name) {
    S.screen = name;
    $('s-pin').hidden = name !== 'pin'; $('s-admin').hidden = name !== 'admin';
    closeSheet(); untoast();
    if (name === 'pin') { S.pin = ''; renderPin(); }
    if (name === 'admin') { render(); load(); }
  }

  // ---------- owner PIN → token (the server checks it; 5 wrong in 15 min locks it) ----------
  function renderPin() {
    var keys = $('keys');
    if (!keys.firstChild) keys.innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(function (k) {
      return k ? '<button data-k="' + k + '" aria-label="' + (k === '⌫' ? 'Delete' : k) + '">' + k + '</button>' : '<span></span>';
    }).join('');
    var b = keys.querySelectorAll('button'); for (var i = 0; i < b.length; i++) b[i].disabled = S.busy;
    var d = $('dots').children; for (var j = 0; j < d.length; j++) d[j].className = j < S.pin.length ? 'on' : '';
  }
  function pinKey(k) {
    if (S.busy || S.screen !== 'pin') return;
    if (k === '⌫') S.pin = S.pin.slice(0, -1); else if (S.pin.length < 6) S.pin += k;
    $('pinerr').textContent = ''; renderPin();
    if (S.pin.length === 6) { S.busy = true; setTimeout(login, 150); renderPin(); }   // busy at once: a double tap sends one login
  }
  document.addEventListener('keydown', function (e) {
    if (S.screen !== 'pin') return;
    if (/^[0-9]$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('⌫');
  });
  function login() {
    var pin = S.pin; S.busy = true; renderPin();
    A.call('POST', '/admin/login', { pin: pin }, null, 15000).then(function (res) {
      S.busy = false; S.pin = '';
      var d = res.data || {};
      if (!res.ok || !d.token) { $('pinerr').textContent = res.ok ? 'Something went wrong. Try again.' : A.words(res); renderPin(); return; }
      S.auth = { token: d.token, name: d.name || '' }; ssSet(S.auth);
      show('admin');
    });
  }
  // the owner token is good for one SGT day: past midnight (a 401) the open tab renews it with itself, no PIN; refused → the PIN
  var renewing = null;
  function renewAuth(cb) {
    if (!S.auth || !S.auth.token) { cb(false); return; }
    if (renewing) { renewing.push(cb); return; }
    renewing = [cb];
    A.call('POST', '/admin/login', { renew: S.auth.token }, null, 15000).then(function (res) {
      var d = res.data || {}, ok = res.ok && !!d.token, cbs = renewing; renewing = null;
      if (ok) { S.auth = { token: d.token, name: d.name || S.auth.name }; ssSet(S.auth); }
      for (var i = 0; i < cbs.length; i++) cbs[i](ok, res);
    });
  }
  function lock(msg) {
    S.auth = null; ssSet(null); S.st = null; S.stFor = null; S.all = null;
    show('pin'); if (msg) $('pinerr').textContent = msg;
  }
  $('lock').onclick = function () { lock(''); };

  // ---------- state: everything Admin draws, from the server ----------
  function load(keep, then, again) {
    if (!S.auth) return;
    var f = S.filter, mine = ++S.loading;
    A.call('GET', '/admin/state?day=' + encodeURIComponent(f), null, S.auth.token, 20000).then(function (res) {
      if (mine !== S.loading) return;   // a later tap wins
      if (!res.ok) {
        if (C.Q.classify(res) === 'login') {
          if (again) { lock('Log in again.'); return; }
          renewAuth(function (ok) { if (ok) load(keep, then, true); else lock('Log in again.'); }); return;
        }
        if (ready()) note('Not up to date. ' + A.words(res), true);
        else { S.loadErr = { f: f, text: A.words(res) }; render(); }
        return;
      }
      S.st = res.data; S.stFor = f; S.loadErr = null; if (f === 'all') S.all = res.data;
      note(''); render();
      if (then) then();
    });
  }
  // the whole event, for the Adjust sheet's order look-up and day totals when a single day is on screen
  function loadAll(then) {
    if (!S.auth) return;
    A.call('GET', '/admin/state?day=all', null, S.auth.token, 20000).then(function (res) { if (res.ok) { S.all = res.data; if (then) then(); } });
  }
  function findOrder(code) {
    var t = String(code || '').trim().toUpperCase().replace(new RegExp('^' + E.refPrefix + '(?=[A-Z]\\s*-?\\s*\\d)'), '');   // GMA057 (the bank's ref) = A-057
    var want = C.parseCode(t.replace(/^([A-Z])\s*-?\s*0*(\d+)$/, function (m, a, b) { return R.code(a, +b); }));
    if (!want) return null;
    var srcs = [ready() ? S.st : null, S.all], i, j, os;
    for (i = 0; i < srcs.length; i++) {
      os = srcs[i] && srcs[i].orders || [];
      for (j = 0; j < os.length; j++) if (os[j].code === R.code(want.till, want.n)) return os[j];
    }
    return null;
  }
  // a day's X reading total as the server last said it (null = not known here: the server still checks)
  function dayTotal(date) {
    if (ready() && S.filter === date) return S.st.x.total;
    var src = ready() && S.filter === 'all' ? S.st : S.all, i, b = src && src.x && src.x.byDay || [];
    for (i = 0; i < b.length; i++) if (b[i].date === date) return b[i].total;
    return null;
  }

  // ---------- drawing ----------
  function render() {
    var st = S.st;
    $('adnow').textContent = st ? C.dayWords(today()).label + ' ' + C.hm(st.now) + ' · ' + (st.name || S.auth && S.auth.name || '') : (S.auth && S.auth.name || '');
    $('daychips').innerHTML = [{ date: 'all', short: 'Whole event' }].concat(days()).map(function (d) {
      return '<button data-day="' + esc(d.date) + '" aria-pressed="' + (S.filter === d.date) + '">' + esc(d.short) + '</button>';
    }).join('');
    $('tills').innerHTML = ''; if (st) renderTills(st);
    $('pdf').disabled = !ready();
    if (!ready()) {   // "Loading Sat 14…" (or why not), never the last day's figures
      var lbl = S.filter === 'all' ? 'whole event' : C.dayWords(S.filter).short, err = S.loadErr && S.loadErr.f === S.filter ? S.loadErr.text : '';
      $('receipt').innerHTML = '<div class="rc">' + esc(err ? lbl.charAt(0).toUpperCase() + lbl.slice(1) + ' not loaded. ' + err : 'Loading ' + lbl + '…') + '</div>';
      $('own').hidden = $('mix').hidden = true; $('adjlist').innerHTML = $('ordlist').innerHTML = ''; $('ordcount').textContent = ''; $('more').hidden = true;
      return;
    }
    $('own').hidden = $('mix').hidden = false;
    renderReceipt(st); renderOwn(st); renderLists();
  }
  function renderTills(st) {
    $('tills').innerHTML = (st.tills || []).map(function (t) {
      var w = +t.waiting || 0, seen = t.lastSeen ? C.when(t.lastSeen, today()) : '';
      if (!t.lastSeen) return '<span class="pill warn">Till ' + esc(t.letter) + ' · not seen yet</span>';
      return w ? '<span class="pill warn">Till ' + esc(t.letter) + ' · ' + w + ' waiting · ' + seen + '</span>'
               : '<span class="pill ok">Till ' + esc(t.letter) + ' ● all sent ' + seen + '</span>';
    }).join('');
  }
  function rl(l, rt, cls) { return '<div class="rl' + (cls ? ' ' + cls : '') + '"><span>' + l + '</span><span>' + rt + '</span></div>'; }
  function rl3(a, b, c, cls) { return '<div class="rl three' + (cls ? ' ' + cls : '') + '"><span>' + a + '</span><span>' + b + '</span><span>' + c + '</span></div>'; }
  function renderReceipt(st) {
    var x = st.x || {}, f = S.filter, d = f === 'all' ? null : C.dayWords(f), ds = days(), d0 = ds[0], dn = ds[ds.length - 1], t = today();
    var soFar = f === 'all' ? (t < dn.date || openStill(dn.date)) && t >= d0.date || (t < d0.date && x.orders > 0) : openStill(f);
    var h = '';
    if (A.mode !== 'live') h += '<div class="rc testline">TEST · ' + (A.mode === 'staging' ? 'staging' : 'local stub') + ' · not real sales</div>';
    h += '<div class="rc big">' + esc(E.company.name) + '</div><div class="rc">UEN ' + esc(E.company.uen) + '</div><div class="rc">' + esc(E.booth) + '</div>';
    h += '<div class="rh">X READING</div>';
    var range = d0.short + ' – ' + C.dayWords(dn.date).full;   // "Fri 13 – Sun 15 Nov 2026"
    h += '<div class="rc">' + esc(d ? d.full : range) + (soFar ? ' (so far)' : '') + '</div>';
    if (x.orders > 0 && x.firstAt) {
      h += rl('First sale', esc(C.dayWords(R.sgtDate(x.firstAt)).label + ' ' + C.hm(x.firstAt)), 'rdim');
      h += rl('Last sale', esc(C.dayWords(R.sgtDate(x.lastAt)).label + ' ' + C.hm(x.lastAt)), 'rdim');
      h += rl('Tills', esc((x.tills || []).join(', ')), 'rdim');
    }
    h += rl('Made', esc(C.dayWords(t).full + ' ' + C.hm(st.now)), 'rdim');
    if (!x.orders && !(st.own && st.own.adjustedN)) {
      var opens = d ? hhmm(dayOf(f).open) : d0.label + ' ' + hhmm(d0.open);
      h += '<div class="rs" style="text-align:center">No sales yet' + (d ? ' on ' + esc(d.label) : '') + '.</div><div class="rc rdim">Booth opens ' + esc(opens) + '.</div>';
      $('receipt').innerHTML = h + '<div class="rcut">— end —</div>';
      return;
    }
    h += '<div class="rs">Sales</div>';
    h += rl('TOTAL SALES', money(x.total), 'net');
    h += rl('Orders · all PayNow', String(x.orders));
    if (!E.gstRegistered) h += '<div class="rcut rdim" style="margin-top:4px">Not GST-registered</div>';
    if (f === 'all') {
      h += '<div class="rs">By day <small>' + esc(d0.short.split(' ')[0] + ' → ' + dn.short.split(' ')[0]) + ' · total sales</small></div>';
      (x.byDay || []).forEach(function (b) {
        var any = b.orders || b.adjusted;
        h += rl3(esc(C.dayWords(b.date).short) + (openStill(b.date) ? ' so far' : ''), any ? String(b.orders) : '–', any ? money(b.total) : 'none yet');
      });
      h += rl3('Total', String(x.orders), money(x.total), 'tot');
    }
    h += '<div class="rcut">— end of X reading —</div><div class="rc rdim">Internal · Gotcha Matcha only</div>';
    $('receipt').innerHTML = h;
  }
  function dayOf(date) { var ds = days(); for (var i = 0; i < ds.length; i++) if (ds[i].date === date) return ds[i]; return ds[0]; }
  function ol(l, rt, cls) { return '<div class="ol' + (cls ? ' ' + cls : '') + '"><span>' + l + '</span><span>' + rt + '</span></div>'; }
  function renderOwn(st) {
    var o = st.own || {};
    $('own').innerHTML = '<h4>Owners only · not on the PDF</h4>' +
      ol('Till rung (' + (+o.rungN || 0) + ')', money(+o.rung || 0)) +
      ol('Voided (' + (+o.voidedN || 0) + ')', money(-(+o.voided || 0))) +
      ol('Adjusted (' + (+o.adjustedN || 0) + ')', signed(+o.adjusted || 0)) +
      ol('X reading total', money(+o.total || 0), 'big') +
      ol('Bank check · PayNow in', money(+o.bankIn || 0)) +
      ol('Undone at till (' + (+o.undoneN || 0) + ') · never sales', '', 'dim');
    // items: the server's list (most first); a menu item it didn't send sold 0 (kept, A–Z after, as in the mock-up)
    var its = (st.items || []).map(function (x) { return { id: x.id, name: itemName(x.id, x.name), q: +x.q || 0 }; }), have = {};
    its.forEach(function (x) { have[x.id] = true; });
    var zero = E.menu.filter(function (m) { return !have[m.id]; }).map(function (m) { return { id: m.id, name: m.full || m.name, q: 0 }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var h = '<h4>Items + prizes · not on the PDF</h4>' + ol('Items sold · most first', '', 'dim');
    its.concat(zero).forEach(function (x) { h += ol(esc(x.name), String(x.q)); });
    h += ol('Shootout prizes · incl. voided · highest first', '', 'dim');
    (st.prizes || []).forEach(function (x) { h += ol(esc(x.label || (R.prize(x.id) || {}).label || x.id) + ' × ' + (+x.n || 0), money(-(+x.v || 0))); });
    h += ol('Prizes given (' + (+st.prizesN || 0) + ')', money(-(+st.prizesV || 0)), 'big');
    $('mix').innerHTML = h;
  }
  function renderLists() {
    var st = S.st, f = S.filter, on = f === 'all' ? '' : ' on ' + C.dayWords(f).label;
    var aj = (st.fixes || []).filter(function (x) { return !x.kind || x.kind === 'adjust'; });
    $('adjlist').innerHTML = aj.length ? aj.map(function (x) {
      var code = x.code || (x.till ? R.code(x.till, x.n) : ''), undone = !!x.undoneBy;
      return '<li class="' + (undone ? 'voided' : '') + '"><div class="l"><div class="l1"><span class="tag adj">' + (x.amt < 0 ? 'Take off' : 'Add') + '</span> ' + esc(x.why) + '</div>' +
        '<div class="l2">for ' + esc(C.dayWords(x.day).short) + (code ? ' · ' + esc(code) : '') + ' · made ' + esc(stamp(x.madeAt)) + ' · ' + esc(x.by) +
        (undone ? ' <span class="tag dim">Undone · ' + esc(x.undoneBy) + ' ' + esc(stamp(x.undoneAt)) + '</span>' : '') + '</div></div>' +
        '<div class="r">' + signed(x.amt) + '</div>' +
        (undone ? '' : '<button class="restore" data-adjundo="' + esc(x.id) + '">Undo</button>') + '</li>';
    }).join('') : '<li><div class="l"><div class="l2">None' + esc(on) + '.</div></div></li>';

    var q = S.find.trim(), os = C.findOrders(st.orders || [], q, E.refPrefix), shown = os.slice(0, S.shown);
    $('ordcount').textContent = os.length ? 'Showing ' + shown.length + ' of ' + os.length : '';
    $('ordlist').innerHTML = shown.length ? shown.map(function (o) {
      var v = o.voided, u = o.undone, t = o.test, rs = o.restored, adj = +o.adjusted || 0;
      return '<li class="' + (v || u || t ? 'voided' : '') + '"><div class="l"><div class="l1">' + esc(o.code) + ' · ' + esc(C.dayWords(o.day).short + ' ' + C.hm(o.at)) + '</div>' +
        '<div class="l2">' + esc(itemsText(o)) + ' · ref ' + esc(o.ref) +
        (v ? ' <span class="tag bad">Voided · ' + esc(v.why) + ' · ' + esc(v.by) + ' ' + esc(stamp(v.at)) + '</span>' : '') +
        (!v && rs ? ' <span class="tag dim">Restored · ' + esc(rs.why) + ' · ' + esc(rs.by) + ' ' + esc(stamp(rs.at)) + '</span>' : '') +
        (adj ? ' <span class="tag adj">Adjusted ' + signed(adj) + '</span>' : '') +
        (u ? ' <span class="tag dim">Undone at till</span>' : '') +
        (t ? ' <span class="tag dim">Test sale · not counted</span>' : '') + '</div></div>' +
        '<div class="r">' + money(o.total) + '</div>' +
        (u || t ? '' : v ? '<button class="restore" data-restore="' + esc(o.code) + '">Restore</button>' :
          '<div class="btns"><button class="restore" data-adjord="' + esc(o.code) + '">Adjust</button><button class="void" data-void="' + esc(o.code) + '">Void</button></div>') + '</li>';
    }).join('') : '<li><div class="l"><div class="l2">' + (q ? 'No order ' + esc(q) + '.' : 'No orders yet' + esc(on) + '.') + '</div></div></li>';
    $('more').hidden = shown.length >= os.length;
    $('more').textContent = 'Show more (' + shown.length + ' of ' + os.length + ')';
  }
  $('more').onclick = function () { if (!ready()) return; S.shown += 20; renderLists(); };
  $('find').oninput = function () { S.find = this.value; S.shown = 10; if (ready()) renderLists(); };
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-day],[data-void],[data-restore],[data-adjord],[data-adjundo],[data-k]') : null;
    if (!t) return;
    if (t.hasAttribute('data-day')) {
      S.filter = t.getAttribute('data-day'); S.shown = 10; S.loadErr = null;
      if (S.filter === 'all' && S.all) { S.st = S.all; S.stFor = 'all'; }   // the whole event on hand: shown, then refreshed
      render(); load();
    }
    else if (t.hasAttribute('data-void')) openVoid(t.getAttribute('data-void'));
    else if (t.hasAttribute('data-restore')) openRestore(t.getAttribute('data-restore'));
    else if (t.hasAttribute('data-adjord')) openAdjust(t.getAttribute('data-adjord'));
    else if (t.hasAttribute('data-adjundo')) openAdjUndo(t.getAttribute('data-adjundo'));
    else if (t.hasAttribute('data-k')) pinKey(t.getAttribute('data-k'));
  });

  // ---------- Save PDF = the browser's print, A4, the X reading receipt only (till.css @media print) ----------
  $('pdf').onclick = function () {
    if (!ready()) { toast('Wait for the X reading'); return; }
    var keep = document.title;
    document.title = 'X reading ' + (S.filter === 'all' ? 'OCBC whole event' : 'OCBC ' + C.dayWords(S.filter).label) + (A.mode !== 'live' ? ' TEST' : '');
    window.addEventListener('afterprint', function back() { document.title = keep; window.removeEventListener('afterprint', back); });
    window.print();
  };

  // ---------- writes: a fresh request id per correction, the same id on a retry; the server decides; then fresh state ----------
  // ss = the open sheet's state {req, busy, unsure, err}; redraw = draw the sheet again
  function write(path, body, ss, okMsg, redraw, again) {
    if (!ss.req) ss.req = C.uid();
    body.req = ss.req; ss.busy = true; ss.err = ''; redraw();
    A.call('POST', path, body, S.auth.token, 20000).then(function (res) {
      ss.busy = false;
      if (res.ok) { closeSheet(); toast(okMsg); S.all = S.filter === 'all' ? S.all : null; load('keep'); return; }
      var k = C.Q.classify(res);
      if (k === 'login' && !again) {   // past midnight: renew, then the same request again (same id: it saves once)
        ss.busy = true; redraw();
        renewAuth(function (ok) { ss.busy = false; if (ok) write(path, body, ss, okMsg, redraw, true); else lock('Log in again.'); }); return;
      }
      if (k === 'login') { lock('Log in again.'); return; }
      if (k === 'retry') { ss.unsure = true; ss.err = res.net ? 'No answer. Saved? Try again (it won\'t save twice).' : A.words(res); redraw(); return; }
      ss.req = null; ss.unsure = false;   // the server said no: a new try is a new request
      ss.err = res.status === 409 && res.message ? res.message : A.words(res);
      redraw(); load('keep');
    });
  }
  function buttons(ss, keepId, keepText, goId, goText, goCls, ok) {
    return '<div class="row"><button class="btn second" id="' + keepId + '"' + (ss.busy ? ' disabled' : '') + '>' + (ss.unsure ? 'Cancel' : keepText) + '</button>' +
      '<button class="btn ' + goCls + '" id="' + goId + '"' + (ok && !ss.busy ? '' : ' disabled') + '>' + (ss.busy ? 'Saving…' : ss.unsure ? 'Try again' : goText) + '</button></div>';
  }
  function cancel(ss) { return function () { if (ss.busy) return; closeSheet(); if (ss.unsure) load('keep'); }; }
  function live(id, obj, key, draw) {   // typing redraws the sheet; keep the caret
    var el = $(id); if (!el) return;
    el.oninput = function () { obj[key] = this.value; var pos = this.selectionStart; draw(); var n = $(id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* number fields */ } } };
  }

  // VOID (owners)
  function openVoid(code) {
    var o = findOrder(code); if (!o) return;
    var ss = S.sheet = { req: null, busy: false, unsure: false, err: '' }, why = null;
    var adj = +o.adjusted || 0, dt = dayTotal(o.day), left = dt === null ? 0 : dt - o.total;
    var block = adj ? 'Undo its adjustment first (' + signed(adj) + ').' : left < 0 ? C.dayWords(o.day).label + ' would go below S$0. Undo a take-off first.' : '';
    function draw() {
      sheet('<h3>Void ' + esc(code) + '?</h3>' +
        '<div class="preview">' + money(o.total) + ' · ' + esc(C.dayWords(o.day).short + ' ' + C.hm(o.at)) + '<br><span style="color:var(--muted)">' + esc(itemsText(o)) + '</span></div>' +
        '<div class="lbl">Why</div><div class="seg">' + VOID_WHY.map(function (w) { return '<button data-why="' + esc(w) + '" aria-pressed="' + (w === why) + '"' + (ss.unsure || ss.busy ? ' disabled' : '') + '>' + esc(w) + '</button>'; }).join('') + '</div>' +
        (block ? '<div class="err">' + esc(block) + '</div>' : '') + (ss.err ? '<div class="err" role="alert">' + esc(ss.err) + '</div>' : '') +
        '<div class="hint">Comes off the X reading. The PDF shows no void.</div>' +
        buttons(ss, 'vKeep', 'Keep', 'vGo', 'Void order', 'danger', why && !block));
      var wb = document.querySelectorAll('[data-why]');
      for (var i = 0; i < wb.length; i++) wb[i].onclick = function () { why = this.getAttribute('data-why'); draw(); };
      $('vKeep').onclick = cancel(ss);
      $('vGo').onclick = function () { write('/admin/void', { code: code, why: why }, ss, code + ' voided', draw); };
    }
    draw();
  }

  // RESTORE (owners): needs a reason; the void stays in the trail (a second row, never an edit)
  function openRestore(code) {
    var o = findOrder(code); if (!o || !o.voided) return;
    var ss = S.sheet = { req: null, busy: false, unsure: false, err: '' }, f = { why: '' };
    function draw() {
      sheet('<h3>Restore ' + esc(code) + '?</h3>' +
        '<div class="preview">' + money(o.total) + ' · Voided · ' + esc(o.voided.why) + ' · ' + esc(o.voided.by) + ' ' + esc(stamp(o.voided.at)) + '</div>' +
        '<input class="field" id="rsWhy" placeholder="Why (bank shows paid)" aria-label="Why" maxlength="80" value="' + esc(f.why) + '"' + (ss.unsure || ss.busy ? ' disabled' : '') + '>' +
        (ss.err ? '<div class="err" role="alert">' + esc(ss.err) + '</div>' : '') +
        '<div class="hint">Goes back on the X reading.</div>' +
        buttons(ss, 'rsKeep', 'Keep voided', 'rsGo', 'Restore', 'paynow', f.why.trim()));
      live('rsWhy', f, 'why', draw);
      $('rsKeep').onclick = cancel(ss);
      $('rsGo').onclick = function () { write('/admin/restore', { code: code, why: f.why.trim() }, ss, code + ' restored', draw); };
    }
    draw();
  }

  // ADJUST (owners): take off or add on a sales day, optionally for one order; the PDF shows the new totals, never the adjustment
  function openAdjust(code) {
    var o0 = code ? findOrder(code) : null;
    var ss = S.sheet = { req: null, busy: false, unsure: false, err: '' };
    var F = { dir: 'off', amt: '', order: code || '', day: o0 ? o0.day : (S.filter !== 'all' ? S.filter : null), why: '' };
    if (S.filter !== 'all') loadAll(function () { if (S.sheet === ss && !ss.busy && !ss.unsure) draw(); });   // other days' orders and totals
    function draw() {
      var lo = F.order.trim() ? findOrder(F.order) : null, err = '', lock = ss.unsure || ss.busy;
      if (F.order.trim() && !lo) err = 'No order ' + F.order.trim() + '.';
      else if (lo && lo.voided) err = lo.code + ' is voided.';
      else if (lo && lo.undone) err = lo.code + ' was undone at the till.';
      else if (lo && lo.test) err = lo.code + ' is a test sale.';
      if (lo && !err) F.day = lo.day;
      var cents = C.parseCents(F.amt);
      if (!err && isNaN(cents)) err = 'Numbers only (7.00).';
      var dayT = F.day ? dayTotal(F.day) : null, room = lo && !err ? lo.total + (+lo.adjusted || 0) : null;
      if (!err && cents > 500000) err = 'At most S$5,000 in one go.';
      else if (!err && F.dir === 'off' && room !== null && cents > room) err = 'At most ' + money(room) + ' off ' + lo.code + '.';
      else if (!err && F.dir === 'off' && F.day && dayT !== null && cents > dayT) err = 'At most ' + money(dayT) + ' off on ' + C.dayWords(F.day).label + '.';
      var sg = F.dir === 'off' ? -cents : cents;
      var ok = !err && F.day && cents > 0 && F.why.trim();
      var t = today(), byDay = (((ready() && S.filter === 'all' ? S.st : S.all) || (ready() ? S.st : null) || {}).x || {}).byDay || [];
      var ds = lo && !err ? [dayOf(lo.day)] : days().filter(function (d) {   // days so far (all three after Sun 15 Nov), and any day that has sales
        if (d.date <= t) return true;
        for (var i = 0; i < byDay.length; i++) if (byDay[i].date === d.date && (byDay[i].orders || byDay[i].adjusted)) return true;
        return false;
      });
      var dis = lock ? ' disabled' : '';
      sheet('<h3>' + (lo && !err ? 'Adjust ' + esc(lo.code) : '+ Adjust') + '</h3>' +
        '<div class="seg"><button data-ad="off" aria-pressed="' + (F.dir === 'off') + '"' + dis + '>Take off</button><button data-ad="add" aria-pressed="' + (F.dir === 'add') + '"' + dis + '>Add</button></div>' +
        '<input class="field tab" id="aAmt" inputmode="decimal" placeholder="Amount S$" aria-label="Amount in dollars" value="' + esc(F.amt) + '"' + dis + '>' +
        '<input class="field" id="aOrd" placeholder="Order (optional, A-057)" aria-label="Order number, optional" autocapitalize="characters" autocomplete="off" value="' + esc(F.order) + '"' + dis + '>' +
        (lo && !err ? '<div class="preview">' + money(lo.total) + (+lo.adjusted ? ' · adjusted ' + signed(+lo.adjusted) : '') + '<br><span style="color:var(--muted)">' + esc(itemsText(lo)) + '</span></div>' : '') +
        '<div class="lbl">Day' + (lo && !err ? ' · the order\'s day' : '') + '</div><div class="seg">' + ds.map(function (d) { return '<button data-adday="' + esc(d.date) + '" aria-pressed="' + (F.day === d.date) + '"' + dis + '>' + esc(d.short) + '</button>'; }).join('') + '</div>' +
        '<input class="field" id="aWhy" placeholder="Why (keyed 2, made 1)" aria-label="Why" maxlength="80" value="' + esc(F.why) + '"' + dis + '>' +
        (err ? '<div class="err">' + esc(err) + '</div>' : '') + (ss.err ? '<div class="err" role="alert">' + esc(ss.err) + '</div>' : '') +
        (ok && dayT !== null ? '<div class="preview tab">X reading ' + esc(C.dayWords(F.day).label) + ': ' + money(dayT) + ' → <b>' + money(dayT + sg) + '</b></div>' : '') +
        '<div class="hint">The PDF shows the new total. No adjustment line.</div>' +
        buttons(ss, 'aCancel', 'Cancel', 'aSave', 'Save', 'paynow', ok));
      function seg(attr, key) { var b = document.querySelectorAll('[' + attr + ']'); for (var i = 0; i < b.length; i++) b[i].onclick = function () { F[key] = this.getAttribute(attr); ss.err = ''; draw(); }; }
      seg('data-ad', 'dir'); seg('data-adday', 'day');
      live('aAmt', F, 'amt', draw); live('aOrd', F, 'order', draw); live('aWhy', F, 'why', draw);
      $('aCancel').onclick = cancel(ss);
      $('aSave').onclick = function () {
        var body = { dir: F.dir, cents: C.parseCents(F.amt), why: F.why.trim() };
        if (lo) body.code = lo.code; else body.day = F.day;   // with an order the server takes the order's day
        write('/admin/adjust', body, ss, 'Adjustment saved', draw);
      };
    }
    draw();
  }
  $('toAdjust').onclick = function () { if (!ready()) { toast('Wait for the X reading'); return; } openAdjust(null); };

  // UNDO an adjustment: kept in the list as "Undone · who when" (a linked undo row on the server)
  function openAdjUndo(id) {
    var a = null; if (!ready()) return; (S.st.fixes || []).forEach(function (x) { if (String(x.id) === String(id)) a = x; });
    if (!a) return;
    var ss = S.sheet = { req: null, busy: false, unsure: false, err: '' }, dt = dayTotal(a.day);
    var block = a.amt > 0 && dt !== null && dt - a.amt < 0 ? C.dayWords(a.day).label + ' would go below S$0.' : '';
    var code = a.code || (a.till ? R.code(a.till, a.n) : '');
    function draw() {
      sheet('<h3>Undo this adjustment?</h3>' +
        '<div class="preview">' + signed(a.amt) + ' · for ' + esc(C.dayWords(a.day).short) + (code ? ' · ' + esc(code) : '') + '<br><span style="color:var(--muted)">' + esc(a.why) + '</span></div>' +
        (block ? '<div class="err">' + esc(block) + '</div>' : '') + (ss.err ? '<div class="err" role="alert">' + esc(ss.err) + '</div>' : '') +
        '<div class="hint">Stays in the list as undone.</div>' +
        buttons(ss, 'uKeep', 'Keep', 'uGo', 'Undo', 'danger', !block));
      $('uKeep').onclick = cancel(ss);
      $('uGo').onclick = function () { write('/admin/undo', { id: a.id }, ss, 'Adjustment undone', draw); };
    }
    draw();
  }

  // a fresh look every minute while open (till pills, new sales); never under an open sheet
  setInterval(function () { if (S.screen === 'admin' && !S.sheet && !document.hidden) load('keep'); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.screen === 'admin' && !S.sheet) load('keep'); });

  // ---------- start ----------
  A.stripe();
  var shell = A.offlineShell('../sw.js');
  document.addEventListener('visibilitychange', function () { if (!document.hidden && shell) shell.check(); });
  show(S.auth ? 'admin' : 'pin');
})();
