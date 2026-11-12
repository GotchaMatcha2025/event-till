/* Gotcha Matcha event till — the staff till (mock-up rev 3.1, owner's yes 12 Nov 2026; API contract in gotcha-hq).
   Sell → PayNow QR → hold Paid → Paid (Undo until Next order). Prices, prizes and the QR come from rules.js on the phone, so a sale needs
   no signal; every sale is kept on the phone first and sent until the server has it (the server re-prices and decides).
   The phone's storage is the truth (code review 12 Nov): every queue change reads it, changes it and writes it back, and one tab at a
   time owns the till (a heartbeat in storage), so two tabs can never lose a sale or reuse a number. Plain ES5. */
(function () {
  'use strict';
  var R = window.TillRules, C = window.TillCore, A = window.TillApi, E = R.EVENT;
  var $ = function (id) { return document.getElementById(id); };
  var esc = C.esc, money = R.money;
  var BOOTH = E.booth.replace(/\s*\(.*\)\s*$/, '');   // "Kallang Wave Mall"
  // this tab, for the one-tab guard: kept per tab (sessionStorage), so a reload is still the same tab, never "another tab"
  var TAB = (function () { var k = 'gm-till-tab', v = null; try { v = window.sessionStorage.getItem(k); if (!v) { v = C.uid(); window.sessionStorage.setItem(k, v); } } catch (e) { v = C.uid(); } return v; })();

  // ---------- this phone's memory (one key space per server); put → false when the browser won't keep it ----------
  function get(k, d) { var v = A.ls('get', A.key(k)); if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { return A.ls('set', A.key(k), JSON.stringify(v)) === true; }
  function del(k) { A.ls('del', A.key(k)); }
  var S = { offline: false, pin: '', busy: false, pinNet: false, qr: null, screen: null, sending: null, lastN: 0, gen: 0 };
  // storage is the truth: read everything again (start, another tab's change, taking the till over)
  function reload() {
    var o = get('order', null) || {};
    S.auth = get('auth', null);       // {token, letter, date}: the till token is good for that SGT date (the server's) only
    S.letter = get('letter', null);   // kept over a new day, so the phone rejoins as the same till
    S.counter = get('counter', null); // {letter, n}: the last number this phone used
    S.q = o.q || {}; S.prize = o.prize || null; S.lost = o.lost || null;   // lost: a prize the order no longer fits (its chip flagged)
    S.paid = get('paid', null);       // the sale on the Paid screen (Undo until Next order)
    S.last = get('last', null);       // {id, till, n, total}
    S.offset = +get('offset', 0) || 0;   // server − phone clock, used for sale times / QR only when the phone is > 5 min off
    S.skew = +get('skew', 0) || 0;       // server − phone clock, always: the token's day is the server's day
    S.queue = readQ();
  }
  function readQ() {
    var q = get('queue', []); if (!Array.isArray(q)) q = [];
    for (var i = 0; i < q.length; i++) q[i].inflight = q[i].id === S.sending;
    return q;
  }
  function writeQ(q) { return put('queue', q.map(function (j) { var c = {}; for (var k in j) if (k !== 'inflight') c[k] = j[k]; return c; })); }
  function editQ(fn) { var r = C.Q.edit(readQ, writeQ, fn); S.queue = r.ok ? r.q : readQ(); return r; }
  function myN(c) { return c && c.letter === S.letter ? +c.n || 0 : 0; }
  // the next number: max(stored counter, this tab's, the server's lastN, anything queued) + 1
  function nextN() { return C.nextN(Math.max(myN(get('counter', null)), myN(S.counter)), S.lastN, readQ(), S.letter); }

  function now() { return Date.now() + S.offset; }
  function today() { return R.sgtDate(now()); }
  function serverDay() { return R.sgtDate(Date.now() + S.skew); }
  // every answer carries the server's clock
  function learnClock(res, t0) {
    var sn = res && res.data ? res.data.now : null;
    if (typeof sn !== 'number' || !isFinite(sn)) return;
    S.skew = Math.round(sn - (t0 + Date.now()) / 2); put('skew', S.skew);
    var off = C.clockOffset(sn, t0, Date.now());
    if (off === null || off === S.offset) return;
    S.offset = off; put('offset', off);
    if (S.screen === 'sell') renderSell();
  }
  function tokenOk() { return !!(S.auth && S.auth.token && S.auth.letter === S.letter && S.auth.date === serverDay()); }
  function setAuth(d) { S.auth = { token: d.token, letter: d.letter, date: d.date || serverDay() }; put('auth', S.auth); }
  function saveOrder() { put('order', { q: S.q, prize: S.prize, lost: S.lost || null }); }

  // ---------- one tab owns the till ----------
  function owner() { return get('tab', null); }
  function claim(gen) { if (gen) S.gen = gen; return put('tab', { id: TAB, at: Date.now(), gen: S.gen }); }
  function state() { return S.screen === 'tab' || S.screen === 'stop' ? 'other' : C.tabState(owner(), TAB, S.gen, Date.now()); }
  // mine: this tab owns the till ('stale' = a late write from a tab that already lost: claim again, it is still ours)
  function mine() { var st = state(); if (st === 'stale') claim(); return st === 'mine' || st === 'stale'; }
  function act() { if (mine()) return true; toTab(); return false; }   // every tap that changes something checks first
  function toTab() { if (S.screen === 'tab' || S.screen === 'stop') return; clearTimeout(wakeT); show('tab'); }
  function beat() {
    if (S.screen === 'tab' || S.screen === 'stop') return;   // stepped aside: only "Use this one" takes the till again
    var st = C.tabState(owner(), TAB, S.gen, Date.now());
    if (st === 'free') take(); else if (st === 'mine' || st === 'stale') claim(); else toTab();
  }
  // taking the till (a tap on "Use this one", or a till left silent > 10 s): a higher generation, then everything from storage
  function take() { claim(C.nextGen(owner())); S.screen = null; reload(); boot(); }
  $('takeTab').onclick = take;

  // ---------- screens ----------
  var SCREENS = ['pin', 'sell', 'qr', 'paid', 'tab', 'stop'];
  function show(name) {
    S.screen = name;
    for (var i = 0; i < SCREENS.length; i++) $('s-' + SCREENS[i]).hidden = SCREENS[i] !== name;
    closeSheet(); untoast();
    if (name === 'sell') renderSell();
    if (name === 'qr') renderQR();
    if (name === 'paid') renderPaid();
    if (name === 'pin') { S.pin = ''; S.busy = false; renderPin(); }
  }
  // a hint sits under the top bar, never over PayNow, the total, Hold: Paid or Undo (on the QR screen: just above the staff's buttons)
  function toast(msg) {
    var t = $('toast'), scr = $('s-' + S.screen), app = $('app').getBoundingClientRect(), y = 12;
    t.textContent = msg; t.hidden = false;
    var top = scr && scr.querySelector('.top'), zone = scr && scr.querySelector('.staffzone');
    if (zone) y = zone.getBoundingClientRect().top - app.top - t.offsetHeight - 8;
    else if (top) y = top.getBoundingClientRect().bottom - app.top + 8;
    t.style.top = Math.max(8, Math.round(y)) + 'px';
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function untoast() { clearTimeout(toast.t); $('toast').hidden = true; }   // a hint never follows to the next screen or sheet
  function closeSheet() { $('sheet').innerHTML = ''; }
  function sheet(html) {
    if (!$('sheet').firstChild) untoast();
    $('sheet').innerHTML = '<div class="sheetwrap" id="sw"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    $('sw').addEventListener('click', function (e) { if (e.target.id === 'sw') closeSheet(); });
  }

  // ---------- the order (prices and prizes from rules.js; no cup cards since 13 Nov: the game is played from the banner QR) ----------
  function cur() {
    var p = R.price(S.q, S.prize);
    if (!p.ok && S.prize) { S.lost = S.prize; S.prize = null; saveOrder(); p = R.price(S.q, null); }   // a prize that no longer fits comes off, flagged
    return p.ok ? p : { ok: false, err: p.err, gross: 0, disc: 0, total: 0 };
  }
  // after a drink is added or taken off: a chosen prize that no longer fits comes off — said out loud and its chip flagged red, so
  // staff see it before PayNow (adversarial pass, rev 3.2); the flag goes when the order fits it again (tap it again) or another prize is chosen
  function checkPrize() {
    if (S.prize && !R.prizeFits(S.q, S.prize)) {
      var miss = (R.prize(S.prize) || {}).miss || 'Add a drink first';
      S.lost = S.prize; S.prize = null;
      return 'Prize came off: ' + miss;
    }
    if (S.lost && R.prizeFits(S.q, S.lost)) S.lost = null;
    return '';
  }
  function status() {
    S.queue = readQ();
    var p = C.pill(S.queue, S.offline || navigator.onLine === false, !(S.auth && S.auth.token));   // an old token renews itself: only no token needs the PIN
    $('pill').className = 'pill ' + p.cls; $('pill').textContent = p.text;
    var f = C.failLine(S.queue); $('failline').hidden = !f; $('failline').textContent = f;
    var lw = typeof S.last === 'string' ? 'Last: ' + S.last : C.lastWords(S.last, S.queue);   // ✓ only once the server has it
    $('lastline').textContent = lw;
    $('lastline').className = 'lastline' + (/not saved$/.test(lw) ? ' bad' : /waiting$/.test(lw) ? ' wait' : '');
  }
  function renderSell() {
    var c = cur();
    $('t1').textContent = E.name + ' · ' + S.letter;
    $('t2').textContent = C.dayWords(today()).label + ' · ' + BOOTH;
    status();
    $('tiles').innerHTML = E.menu.map(function (m) {
      var q = S.q[m.id] || 0, nm = esc(m.full || m.name), inOrder = q ? ', ' + q + ' in order' : '';
      return '<div class="tile' + (q ? ' has' : '') + '">' +
        '<button class="add" data-add="' + m.id + '" aria-label="Add ' + nm + ', ' + money(m.p) + inOrder + '">' +
          '<span><div class="nm">' + esc(m.name) + '</div>' + (m.sub ? '<div class="sub">' + esc(m.sub) + '</div>' : '') + '</span>' +
          '<span class="pr tab">' + money(m.p) + '</span></button>' +
        (q ? '<span class="q tab" aria-hidden="true">' + q + '</span><button class="minus" data-minus="' + m.id + '" aria-label="One less ' + nm + inOrder + '">−</button>' : '') +
        '</div>';
    }).join('');
    $('prizes').innerHTML = E.prizes.map(function (p) {
      var ok = R.prizeFits(S.q, p.id), lost = S.lost === p.id;
      return '<button class="chip' + (ok ? '' : ' off') + (lost ? ' lost' : '') + '" data-prize="' + p.id + '" aria-pressed="' + (S.prize === p.id) + '"' +
        (lost ? ' aria-label="' + esc(p.label) + ', came off"' : '') + '>' + esc(p.label) + '</button>';
    }).join('');
    var lines = [];
    E.menu.forEach(function (m) { var q = S.q[m.id]; if (q) lines.push('<li><span>' + q + ' × ' + esc(m.full || m.name) + '</span><span class="a">' + money(m.p * q) + '</span></li>'); });
    if (S.prize) lines.push('<li class="pz"><span>Prize · ' + esc(R.prize(S.prize).label) + '</span><span class="a">' + money(-c.disc) + '</span></li>');
    $('lines').innerHTML = lines.length ? lines.join('') : '<li class="empty">Tap a drink to start</li>';
    $('tot').textContent = money(c.total);
    var off = c.total <= 0;
    $('toQR').setAttribute('aria-disabled', String(off));
    $('toQR').textContent = off ? 'PayNow' : 'PayNow ' + money(c.total);
    $('logout').textContent = 'Till ' + S.letter + ' · log out';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-add],[data-minus],[data-prize],[data-k]') : null;
    if (!t || !act()) return;
    if (t.hasAttribute('data-add')) {
      var a = t.getAttribute('data-add'), nq = {}, k;
      for (k in S.q) nq[k] = S.q[k];
      nq[a] = (nq[a] || 0) + 1;
      var chk = R.price(nq, null);
      if (!chk.ok && chk.err === 'qty') { toast(E.maxQty + ' at most'); return; }
      if (!chk.ok && chk.err === 'too-big') { toast(money(E.maxOrderCents) + ' most per order'); return; }
      S.q = nq; var said = checkPrize(); saveOrder(); renderSell(); if (said) toast(said);
    } else if (t.hasAttribute('data-minus')) {
      var m = t.getAttribute('data-minus');
      S.q[m] = (S.q[m] || 0) - 1; if (S.q[m] <= 0) delete S.q[m];
      var off = checkPrize(); saveOrder(); renderSell(); if (off) toast(off);
    } else if (t.hasAttribute('data-prize')) {
      var p = t.getAttribute('data-prize');
      if (S.prize !== p && !R.prizeFits(S.q, p)) { toast(R.price(S.q, p).miss || 'Add a drink first'); return; }
      S.prize = S.prize === p ? null : p; if (S.prize) S.lost = null;   // a prize chosen: no flag
      saveOrder(); renderSell();
    } else if (t.hasAttribute('data-k')) pinKey(t.getAttribute('data-k'));
  });
  $('clear').onclick = function () { if (!act()) return; S.q = {}; S.prize = null; S.lost = null; saveOrder(); renderSell(); maybeUpdate(); };
  $('toQR').onclick = function () { if (!act()) return; if (cur().total <= 0) { toast('Add a drink first'); return; } show('qr'); };
  $('pill').onclick = function () {
    if (!act()) return;
    if (!tokenOk()) { if (S.auth && S.auth.token) { renew(); toast('Checking…'); } else show('pin'); return; }
    S.offline = false;
    editQ(function (q) { for (var i = 0; i < q.length; i++) q[i].nextAt = 0; });   // signal back? send now
    flush(); status();
  };

  // ---------- QR: the order number + PayNow reference, made on the phone ----------
  function renderQR() {
    var c = cur(), n = nextN(), code = R.code(S.letter, n), ref = R.ref(S.letter, n);
    var payload = R.paynow(c.total, ref, C.ymd(C.nextDay(today())));   // expiry = the day after the sale day (a same-day expiry isn't proven with bank apps)
    S.qr = { n: n, total: c.total };
    $('qrorder').textContent = 'Order ' + code + ' · ref ' + ref;
    $('qramt').textContent = money(c.total);
    $('chkamt').textContent = money(c.total);
    $('qrto').textContent = E.company.name;
    $('qr').setAttribute('data-payload', payload);
    if (window.qrcode) {
      var q = window.qrcode(0, 'M'); q.addData(payload); q.make();
      $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } else {
      $('qr').innerHTML = '<p style="font-weight:800;text-align:center;padding-top:90px">QR library did not load</p>';
    }
  }
  $('qrBack').onclick = function () { if (act()) show('sell'); };
  // Paid needs a 1-second hold, so a customer's tap on the turned phone doesn't count
  (function () {
    var b = $('qrPaid'), timer = null;
    function start(e) {
      if (e && e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return;
      if (timer) return;
      if (e) e.preventDefault();
      b.classList.add('going');
      timer = setTimeout(function () { timer = null; b.classList.remove('going'); markPaid(); }, 1000);
    }
    function stop() { if (!timer) return; clearTimeout(timer); timer = null; b.classList.remove('going'); toast('Hold for 1 second'); }
    b.addEventListener('pointerdown', start); b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
    b.addEventListener('keydown', start); b.addEventListener('keyup', stop);
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  })();

  // ---------- PAID: the sale goes into the phone's stored queue first (or Paid is refused), then to the server ----------
  function markPaid() {
    if (S.screen !== 'qr' || !act()) return;
    var c = cur(); if (c.total <= 0) return;
    var q = {}, k; for (k in S.q) if (S.q[k]) q[k] = S.q[k];
    var n = Math.max(S.qr ? S.qr.n : 0, nextN());   // never a number another tab has used since the QR was drawn
    var job = { kind: 'sale', id: C.uid(), till: S.letter, n: n, at: now(), q: q, prize: S.prize || null, undone: false, total: c.total };
    if (!editQ(function (qq) { C.Q.add(qq, job); }).ok) { toast("Couldn't save on this phone. Not paid yet — try again."); return; }
    S.counter = { letter: S.letter, n: Math.max(n, myN(get('counter', null)), myN(S.counter)) }; put('counter', S.counter);
    S.paid = { id: job.id, till: S.letter, n: n, total: c.total, q: q, prize: S.prize || null }; put('paid', S.paid);
    show('paid');
    if (S.qr && n !== S.qr.n) toast('Saved as ' + R.code(S.letter, n) + ' (QR said ' + R.code(S.letter, S.qr.n) + ')');
    flush();
  }
  function renderPaid() {
    var p = S.paid; if (!p) { show('sell'); return; }
    $('pdno').textContent = R.code(p.till, p.n) + ' paid';
    $('pdm').textContent = money(p.total) + ' · PayNow';
  }
  $('next').onclick = function () {
    if (!act()) return;
    if (S.paid) { S.last = { id: S.paid.id, till: S.paid.till, n: S.paid.n, total: S.paid.total }; put('last', S.last); }
    S.paid = null; del('paid'); S.q = {}; S.prize = null; S.lost = null; saveOrder();
    show('sell'); maybeUpdate();
  };
  // Undo (payment failed): kept for the owners as "Undone at till", never a sale; the order comes back to fix or ring again
  $('undo').onclick = function () {
    var p = S.paid; if (!p || !act()) return;
    if (!editQ(function (q) { C.Q.undo(q, { id: p.id, till: p.till, n: p.n }); }).ok) { toast("Couldn't save on this phone. Try again."); return; }
    S.q = p.q; S.prize = p.prize; S.lost = null; saveOrder();
    S.paid = null; del('paid');
    show('sell'); toast(R.code(p.till, p.n) + ' undone. Order is back.');
    flush();
  };

  // ---------- a new day or a 401: today's token from the old one, no PIN; the PIN only if refused; at most one try per 30 s ----------
  var renewing = false, renewT = null;
  function renew() {
    if (renewing || !mine() || !S.letter || !S.auth || !S.auth.token) return;
    var wait = 30000 - (Date.now() - (S.renewTry || 0));
    if (wait > 0) { clearTimeout(renewT); renewT = setTimeout(renew, wait); return; }
    renewing = true; S.renewTry = Date.now(); clearTimeout(renewT);
    var t0 = Date.now();
    A.call('POST', '/till/join', { letter: S.letter, renew: S.auth.token }, null, 15000).then(function (res) {
      renewing = false; learnClock(res, t0);
      var d = res.data || {};
      if (res.ok && d.token && d.letter === S.letter) {
        setAuth(d); S.renewedAt = Date.now(); S.offline = false; S.lastN = Math.max(S.lastN, +d.lastN || 0);
        status(); flush(); hello(); return;   // the queue goes now: nothing waits for a morning PIN
      }
      if (C.Q.classify(res) === 'retry') { S.offline = !!res.net; status(); renewT = setTimeout(renew, 30000); return; }
      S.auth = null; del('auth'); status();   // refused: this phone needs the booth PIN
      if (S.screen === 'sell' && !S.paid && !Object.keys(S.q).length) show('pin');
    });
  }

  // ---------- sending: one job at a time, retried with backoff until saved; a refusal stays visible ----------
  var flushing = false, wakeT = null, sentSome = false;
  function flush() {
    if (flushing || !mine()) return;
    clearTimeout(wakeT);
    if (!tokenOk()) { renew(); status(); return; }
    if (C.Q.foreign(readQ(), S.letter).length) editQ(function (q) { C.Q.foreign(q, S.letter).forEach(function (j) { C.Q.fail(q, j, { status: 0, error: 'other-till' }); }); });
    var job = C.Q.ready(readQ(), Date.now(), S.letter);
    if (!job) {
      var t = C.Q.wake(readQ(), S.letter);
      if (t !== null) wakeT = setTimeout(flush, Math.max(500, t - Date.now()));
      if (sentSome) { sentSome = false; hello(); }
      status(); return;
    }
    flushing = true; S.sending = job.id;
    var id = job.id, body = C.Q.body(job, now()), t0 = Date.now();
    A.call('POST', C.Q.path(job), body, S.auth.token, 15000).then(function (res) {
      flushing = false; S.sending = null; learnClock(res, t0);
      var k = C.Q.classify(res), again = false;
      editQ(function (q) {   // settle by id on the stored queue (another tab may have changed it meanwhile)
        var j = C.Q.byId(q, id); if (!j) return;
        if (k === 'ok') C.Q.settle(q, j, body, res.data);
        else if (k === 'retry') C.Q.retry(q, j, Date.now());
        else if (k === 'login' && j.loginAt && (S.renewedAt || 0) > j.loginAt) C.Q.fail(q, j, res);   // refused again with a newer token: show it, no loop
        else if (k === 'login') { j.inflight = false; j.loginAt = Date.now(); again = true; }
        else C.Q.fail(q, j, res);
      });
      if (k === 'ok') { S.offline = false; sentSome = true; } else if (k === 'retry') S.offline = !!res.net; else if (k === 'fail') S.offline = false;
      if (again) { if (S.auth) S.auth.date = ''; renew(); }   // a new day or a new key: renew; sales wait on the phone
      status();
      if (k === 'ok' || k === 'fail') flush();
      else if (k === 'retry') { var w = C.Q.wake(readQ(), S.letter); wakeT = setTimeout(flush, Math.max(500, (w || 0) - Date.now())); }
    });
  }
  // "I'm here, n waiting" every 60 s while open
  function hello() {
    if (document.hidden || !mine()) return;
    if (!tokenOk()) { renew(); return; }   // past SGT midnight (the server's): today's token first
    var t0 = Date.now();
    A.call('POST', '/till/hello', { waiting: C.Q.waiting(readQ()) }, S.auth.token, 10000).then(function (res) {
      learnClock(res, t0);
      if (res.ok) S.offline = false;
      else if (C.Q.classify(res) === 'login') { if (S.auth) S.auth.date = ''; renew(); }
      else if (res.net) S.offline = true;
      status();
    });
  }
  window.addEventListener('online', function () { S.offline = false; editQ(function (q) { for (var i = 0; i < q.length; i++) q[i].nextAt = 0; }); flush(); });
  window.addEventListener('offline', function () { S.offline = true; status(); });
  // another tab changed this phone's storage: take its truth (or step aside if it took the till)
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf(A.key('')) !== 0 || S.screen === 'stop') return;
    if (e.key === A.key('tab')) { if (!mine()) toTab(); return; }
    if (S.screen === 'tab') return;
    // another tab's late write (an answer it was still waiting for): take the queue, the login and the clocks; this tab's own
    // order, Paid and Last are only ever written by the tab that owns the till, so they are never reloaded under it
    S.auth = get('auth', null); S.letter = get('letter', S.letter); S.counter = get('counter', S.counter);
    S.offset = +get('offset', 0) || 0; S.skew = +get('skew', 0) || 0;
    status();
  });

  // ---------- booth PIN: first open → a till letter; refused renewal → the same letter again ----------
  function renderPin() {
    var keys = $('keys');
    if (!keys.firstChild) keys.innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(function (k) {
      return k ? '<button data-k="' + k + '" aria-label="' + (k === '⌫' ? 'Delete' : k) + '">' + k + '</button>' : '<span></span>';
    }).join('');
    var b = keys.querySelectorAll('button');
    for (var i = 0; i < b.length; i++) b[i].disabled = S.busy;
    var d = $('dots').children;
    for (var j = 0; j < d.length; j++) d[j].className = j < S.pin.length ? 'on' : '';
    $('pint2').textContent = S.letter ? 'Till ' + S.letter + ' · PIN for today' : 'Booth phone · first time';
    $('sellnow').hidden = !(S.letter && S.pinNet);
  }
  function pinKey(k) {
    if (S.busy || S.screen !== 'pin') return;
    if (k === '⌫') S.pin = S.pin.slice(0, -1); else if (S.pin.length < 6) S.pin += k;
    $('pinerr').textContent = '';
    if (S.pin.length === 6) { S.busy = true; setTimeout(join, 150); }   // busy at once: a double tap on the 6th digit sends one join
    renderPin();
  }
  document.addEventListener('keydown', function (e) {
    if (S.screen !== 'pin' || $('sheet').firstChild) return;
    if (/^[0-9]$/.test(e.key)) { if (act()) pinKey(e.key); } else if (e.key === 'Backspace') { if (act()) pinKey('⌫'); }
  });
  function join() {
    var body = { pin: S.pin };
    if (S.letter) body.letter = S.letter;
    S.busy = true; renderPin();
    var t0 = Date.now();
    A.call('POST', '/till/join', body, null, 15000).then(function (res) {
      S.busy = false; S.pin = ''; learnClock(res, t0);
      var d = res.data || {};
      if (!res.ok || !d.token || !/^[A-Z]$/.test(d.letter || '')) {
        S.pinNet = !!res.net || res.status === 429 || res.status >= 500;   // no signal, locked out a while, or the server down: sell now, sales wait
        $('pinerr').textContent = res.ok ? 'Something went wrong. Try again.' : A.words(res);
        renderPin(); return;
      }
      if (!mine()) { toTab(); return; }
      var stored = get('counter', null);
      S.letter = d.letter; S.pinNet = false; S.lastN = +d.lastN || 0;
      S.counter = { letter: d.letter, n: Math.max(myN(stored), myN(S.counter), S.lastN) };   // a new letter starts its own numbers
      setAuth(d); S.renewedAt = Date.now();
      put('letter', S.letter); put('counter', S.counter);
      show(S.paid ? 'paid' : 'sell');
      flush(); hello();
    });
  }
  $('sellnow').onclick = function () { if (act()) show(S.paid ? 'paid' : 'sell'); };

  // ---------- log out (asks first; never while sales wait to send) ----------
  $('logout').onclick = function () {
    if (!act()) return;
    var w = C.Q.waiting(readQ()), L = S.letter;
    sheet('<h3>Log out of Till ' + esc(L) + '?</h3>' +
      '<div class="preview">This phone stops being Till ' + esc(L) + '.<br><span style="color:var(--muted)">The next PIN gives a new letter.</span></div>' +
      (w ? '<div class="err">' + w + ' not sent yet. Wait for ● All saved.</div>' : '') +
      '<div class="row"><button class="btn second" id="loKeep">Keep</button><button class="btn danger" id="loGo"' + (w ? ' disabled' : '') + '>Log out</button></div>');
    $('loKeep').onclick = closeSheet;
    $('loGo').onclick = function () {
      if (C.Q.waiting(readQ()) || !act()) return;
      S.auth = null; S.letter = null; S.counter = null; S.paid = null; S.last = null; S.q = {}; S.prize = null; S.lastN = 0;
      ['auth', 'letter', 'counter', 'paid', 'last', 'order'].forEach(del);
      show('pin');
    };
  };

  // ---------- a new version: the shell updates in the background; the page reloads only when idle (Sell, empty order) ----------
  function idle() { return S.screen === 'sell' && !S.paid && !Object.keys(S.q).length && !$('sheet').firstChild; }
  function maybeUpdate() { if (S.updateReady && idle()) window.location.reload(); }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || S.screen === 'stop') return;
    if (shell) shell.check();
    if (S.screen === 'tab') return;   // on the "another tab" screen: only "Use this one" takes the till
    var st = C.tabState(owner(), TAB, S.gen, Date.now());
    if (st === 'other') { toTab(); return; }
    if (st === 'free') { take(); maybeUpdate(); return; }   // another tab had it and went silent: its state is the truth
    claim();
    if (S.screen === 'sell') renderSell();
    flush(); hello(); maybeUpdate();
  });

  // ---------- start ----------
  function boot() {
    if (!S.letter || !S.auth || !S.auth.token) show('pin');   // first open, or a renewal was refused
    else show(S.paid ? 'paid' : 'sell');                      // an old token renews itself (flush → renew)
    flush(); hello();
  }
  A.stripe();
  var shell = null;
  if (!A.storageOk()) { show('stop'); return; }   // private mode / blocked storage: sales could be lost, so no selling here
  shell = A.offlineShell('sw.js', function () { S.updateReady = true; maybeUpdate(); });
  reload();
  var o0 = owner(), st0 = C.tabState(o0, TAB, 0, Date.now());
  if (st0 === 'other') show('tab');
  else { claim(st0 === 'mine' && o0.gen ? o0.gen : C.nextGen(o0)); boot(); }   // a reload is still the same tab (and generation)
  setInterval(beat, 3000);
  setInterval(hello, 60000);
})();
