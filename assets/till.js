/* Gotcha Matcha event till — the staff till (mock-up rev 3.1, owner's yes 12 Nov 2026; API contract in gotcha-hq).
   Sell → PayNow QR → hold Paid → Paid (Undo until Next order). Prices, prizes and the QR come from rules.js on the phone, so a sale needs
   no signal; every sale is kept on the phone first and sent until the server has it (the server re-prices and decides). Plain ES5. */
(function () {
  'use strict';
  var R = window.TillRules, C = window.TillCore, A = window.TillApi, E = R.EVENT;
  var $ = function (id) { return document.getElementById(id); };
  var esc = C.esc, money = R.money;
  var BOOTH = E.booth.replace(/\s*\(.*\)\s*$/, '');   // "Kallang Wave Mall"

  // ---------- this phone's memory (one key space per server) ----------
  function get(k, d) { var v = A.ls('get', A.key(k)); if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { A.ls('set', A.key(k), JSON.stringify(v)); }
  function del(k) { A.ls('del', A.key(k)); }
  var saved = get('order', null) || {};
  var S = {
    auth: get('auth', null),        // {token, letter, date}: the till token is good for that SGT date only
    letter: get('letter', null),    // kept over a new day, so the phone rejoins as the same till
    counter: get('counter', null),  // {letter, n}: the last number this phone used
    queue: get('queue', []),        // sales (and undos) not yet saved on the server
    q: saved.q || {}, prize: saved.prize || null,
    paid: get('paid', null),        // the sale on the Paid screen (Undo until Next order)
    last: get('last', ''),
    offset: +get('offset', 0) || 0, // server clock − phone clock, used only when the phone is > 5 min off
    offline: false, pin: '', busy: false, pinNet: false, qr: null, screen: null
  };
  for (var i = 0; i < S.queue.length; i++) S.queue[i].inflight = false;
  function now() { return Date.now() + S.offset; }
  // every answer carries the server's clock: a phone more than 5 min off uses it (QR expiry, sale times, the day on screen)
  function learnClock(res, t0) {
    var off = C.clockOffset(res && res.data ? res.data.now : null, t0, Date.now());
    if (off === null || off === S.offset) return;
    S.offset = off; put('offset', off);
    if (S.screen === 'sell') renderSell();
  }
  function today() { return R.sgtDate(now()); }
  function tokenOk() { return !!(S.auth && S.auth.token && S.auth.letter === S.letter && S.auth.date === today()); }
  function setAuth(d) {
    S.auth = { token: d.token, letter: d.letter, date: d.date || today() }; put('auth', S.auth);
  }
  function saveOrder() { put('order', { q: S.q, prize: S.prize }); }
  function saveQueue() { put('queue', S.queue.map(function (j) { var c = {}; for (var k in j) if (k !== 'inflight') c[k] = j[k]; return c; })); }
  function nextN() { return C.nextN(S.counter && S.counter.letter === S.letter ? S.counter.n : 0, 0, S.queue, S.letter); }

  // ---------- screens ----------
  var SCREENS = ['pin', 'sell', 'qr', 'paid'];
  function show(name) {
    S.screen = name;
    for (var i = 0; i < SCREENS.length; i++) $('s-' + SCREENS[i]).hidden = SCREENS[i] !== name;
    closeSheet(); untoast();
    if (name === 'sell') renderSell();
    if (name === 'qr') renderQR();
    if (name === 'paid') renderPaid();
    if (name === 'pin') { S.pin = ''; renderPin(); }
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2400); }
  function untoast() { clearTimeout(toast.t); $('toast').hidden = true; }   // a hint never follows to the next screen or sheet (it covered Hold: Paid)
  function closeSheet() { $('sheet').innerHTML = ''; }
  function sheet(html) {
    if (!$('sheet').firstChild) untoast();
    $('sheet').innerHTML = '<div class="sheetwrap" id="sw"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    $('sw').addEventListener('click', function (e) { if (e.target.id === 'sw') closeSheet(); });
  }

  // ---------- the order (prices, prizes and cup cards from rules.js) ----------
  function cur() {
    var p = R.price(S.q, S.prize);
    if (!p.ok && S.prize) { S.prize = null; saveOrder(); p = R.price(S.q, null); }   // a prize that no longer fits comes off (as in the mock-up)
    return p.ok ? p : { ok: false, err: p.err, gross: 0, disc: 0, total: 0, cups: 0 };
  }
  function status() {
    var p = C.pill(S.queue, S.offline || navigator.onLine === false, !(S.auth && S.auth.token));   // an old token renews itself: only no token needs the PIN
    $('pill').className = 'pill ' + p.cls; $('pill').textContent = p.text;
    var f = C.failLine(S.queue); $('failline').hidden = !f; $('failline').textContent = f;
  }
  function renderSell() {
    var c = cur();
    $('t1').textContent = E.name + ' · ' + S.letter;
    $('t2').textContent = C.dayWords(today()).label + ' · ' + BOOTH;
    $('lastline').textContent = S.last ? 'Last: ' + S.last : '';
    status();
    $('tiles').innerHTML = E.menu.map(function (m) {
      var q = S.q[m.id] || 0;
      return '<div class="tile' + (q ? ' has' : '') + '">' +
        '<button class="add" data-add="' + m.id + '" aria-label="Add ' + esc(m.full || m.name) + '">' +
          '<span><div class="nm">' + esc(m.name) + '</div>' + (m.sub ? '<div class="sub">' + esc(m.sub) + '</div>' : '') + '</span>' +
          '<span class="pr tab">' + money(m.p) + '</span></button>' +
        (q ? '<span class="q tab" aria-hidden="true">' + q + '</span><button class="minus" data-minus="' + m.id + '" aria-label="One less ' + esc(m.full || m.name) + '">−</button>' : '') +
        '</div>';
    }).join('');
    $('prizes').innerHTML = E.prizes.map(function (p) {
      var ok = R.prizeFits(S.q, p.id);
      return '<button class="chip' + (ok ? '' : ' off') + '" data-prize="' + p.id + '" aria-pressed="' + (S.prize === p.id) + '">' + esc(p.label) + '</button>';
    }).join('');
    var lines = [];
    E.menu.forEach(function (m) { var q = S.q[m.id]; if (q) lines.push('<li><span>' + q + ' × ' + esc(m.full || m.name) + '</span><span class="a">' + money(m.p * q) + '</span></li>'); });
    if (S.prize) lines.push('<li class="pz"><span>Prize · ' + esc(R.prize(S.prize).label) + '</span><span class="a">' + money(-c.disc) + '</span></li>');
    $('lines').innerHTML = lines.length ? lines.join('') : '<li class="empty">Tap a drink to start</li>';
    $('tot').textContent = money(c.total);
    $('cupsline').textContent = c.gross ? '· ' + c.cups + ' cup card' + (c.cups === 1 ? '' : 's') : '';
    var off = c.total <= 0;
    $('toQR').setAttribute('aria-disabled', String(off));
    $('toQR').textContent = off ? 'PayNow' : 'PayNow ' + money(c.total);
    $('logout').textContent = 'Till ' + S.letter + ' · log out';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-add],[data-minus],[data-prize],[data-k]') : null;
    if (!t) return;
    if (t.hasAttribute('data-add')) {
      var a = t.getAttribute('data-add'), nq = {}, k;
      for (k in S.q) nq[k] = S.q[k];
      nq[a] = (nq[a] || 0) + 1;
      var chk = R.price(nq, null);
      if (!chk.ok && chk.err === 'qty') { toast(E.maxQty + ' at most'); return; }
      if (!chk.ok && chk.err === 'too-big') { toast(money(E.maxOrderCents) + ' most per order'); return; }
      S.q = nq; saveOrder(); renderSell();
    } else if (t.hasAttribute('data-minus')) {
      var m = t.getAttribute('data-minus');
      S.q[m] = (S.q[m] || 0) - 1; if (S.q[m] <= 0) delete S.q[m];
      saveOrder(); renderSell();
    } else if (t.hasAttribute('data-prize')) {
      var p = t.getAttribute('data-prize');
      if (S.prize !== p && !R.prizeFits(S.q, p)) { toast(R.price(S.q, p).miss || 'Add a drink first'); return; }
      S.prize = S.prize === p ? null : p; saveOrder(); renderSell();
    } else if (t.hasAttribute('data-k')) pinKey(t.getAttribute('data-k'));
  });
  $('clear').onclick = function () { S.q = {}; S.prize = null; saveOrder(); renderSell(); };
  $('toQR').onclick = function () { if (cur().total <= 0) { toast('Add a drink first'); return; } show('qr'); };
  $('pill').onclick = function () {
    if (!tokenOk()) { if (S.auth && S.auth.token && !renewing) { renew(); toast('Checking…'); } else show('pin'); return; }
    S.offline = false; for (var i = 0; i < S.queue.length; i++) S.queue[i].nextAt = 0;   // signal back? send now
    flush(); status();
  };

  // ---------- QR: the order number + PayNow reference, made on the phone ----------
  function renderQR() {
    var c = cur(), n = nextN(), code = R.code(S.letter, n), ref = R.ref(S.letter, n);
    var payload = R.paynow(c.total, ref, C.ymd(today()));   // expiry = the sale day
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
  $('qrBack').onclick = function () { show('sell'); };
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

  // ---------- PAID: the sale goes into the phone's queue first, then to the server ----------
  function markPaid() {
    if (S.screen !== 'qr') return;
    var c = cur(); if (c.total <= 0) return;
    var n = S.qr ? S.qr.n : nextN(), q = {}, k;
    for (k in S.q) if (S.q[k]) q[k] = S.q[k];
    var job = C.Q.add(S.queue, { kind: 'sale', id: C.uid(), till: S.letter, n: n, at: now(), q: q, prize: S.prize || null, undone: false, total: c.total });
    S.counter = { letter: S.letter, n: Math.max(n, S.counter && S.counter.letter === S.letter ? S.counter.n : 0) };
    S.paid = { id: job.id, till: S.letter, n: n, total: c.total, cups: c.cups, q: q, prize: S.prize || null };
    saveQueue(); put('counter', S.counter); put('paid', S.paid);
    show('paid');
    flush();
  }
  function renderPaid() {
    var p = S.paid; if (!p) { show('sell'); return; }
    $('pdno').textContent = R.code(p.till, p.n) + ' paid';
    $('pdm').textContent = money(p.total) + ' · PayNow';
    $('pdcups').textContent = p.cups ? 'Give ' + p.cups + ' cup card' + (p.cups === 1 ? '' : 's') : 'No cup cards';
  }
  $('next').onclick = function () {
    if (S.paid) { S.last = R.code(S.paid.till, S.paid.n) + ' · ' + money(S.paid.total) + ' ✓'; put('last', S.last); }
    S.paid = null; del('paid'); S.q = {}; S.prize = null; saveOrder();
    show('sell');
  };
  // Undo (payment failed): kept for the owners as "Undone at till", never a sale; the order comes back to fix or ring again
  $('undo').onclick = function () {
    var p = S.paid; if (!p) return;
    C.Q.undo(S.queue, { id: p.id, till: p.till, n: p.n });
    saveQueue();
    S.q = p.q; S.prize = p.prize; saveOrder();
    S.paid = null; del('paid');
    show('sell'); toast(R.code(p.till, p.n) + ' undone. Order is back.');
    flush();
  };

  // ---------- a new day (SGT midnight) or a 401: today's token from yesterday's, no PIN; the PIN only if that is refused ----------
  var renewing = false, renewT = null;
  function renew() {
    if (renewing || !S.letter || !S.auth || !S.auth.token) return;
    renewing = true; clearTimeout(renewT);
    var t0 = Date.now();
    A.call('POST', '/till/join', { letter: S.letter, renew: S.auth.token }, null, 15000).then(function (res) {
      renewing = false; learnClock(res, t0);
      var d = res.data || {};
      if (res.ok && d.token && d.letter === S.letter) {
        setAuth(d); S.renewedAt = Date.now(); S.offline = false;
        if (S.counter && S.counter.letter === d.letter && +d.lastN > S.counter.n) { S.counter.n = +d.lastN; put('counter', S.counter); }
        status(); flush(); hello(); return;   // the queue goes now: nothing waits for a morning PIN
      }
      if (C.Q.classify(res) === 'retry') { S.offline = !!res.net; status(); renewT = setTimeout(renew, 15000); return; }
      S.auth = null; del('auth'); status();   // refused: this phone needs the booth PIN
      if (S.screen === 'sell' && !S.paid && !Object.keys(S.q).length) show('pin');
    });
  }

  // ---------- sending: one job at a time, retried with backoff until saved; a refusal stays visible ----------
  var flushing = false, wakeT = null, sentSome = false;
  function flush() {
    if (flushing) return;
    clearTimeout(wakeT);
    if (!tokenOk()) { renew(); status(); return; }
    C.Q.foreign(S.queue, S.letter).forEach(function (j) { C.Q.fail(S.queue, j, { status: 0, error: 'other-till' }); });
    var job = C.Q.ready(S.queue, Date.now(), S.letter);
    if (!job) {
      var t = C.Q.wake(S.queue, S.letter);
      if (t !== null) wakeT = setTimeout(flush, Math.max(500, t - Date.now()));
      if (sentSome) { sentSome = false; hello(); }
      saveQueue(); status(); return;
    }
    flushing = true; job.inflight = true;
    var body = C.Q.body(job, now()), t0 = Date.now();
    A.call('POST', C.Q.path(job), body, S.auth.token, 15000).then(function (res) {
      flushing = false; learnClock(res, t0);
      var k = C.Q.classify(res);
      if (k === 'ok') { S.offline = false; sentSome = true; C.Q.settle(S.queue, job, body, res.data); }
      else if (k === 'retry') { S.offline = !!res.net; C.Q.retry(S.queue, job, Date.now()); }
      else if (k === 'login' && job.loginAt && (S.renewedAt || 0) > job.loginAt) C.Q.fail(S.queue, job, res);   // refused again with a newer token: show it, no loop
      else if (k === 'login') { job.inflight = false; job.loginAt = Date.now(); if (S.auth) S.auth.date = ''; renew(); }   // a new day or a new key: renew; sales wait on the phone
      else { S.offline = false; C.Q.fail(S.queue, job, res); }
      saveQueue(); status();
      if (k === 'ok' || k === 'fail') flush();
      else if (k === 'retry') { var t = C.Q.wake(S.queue, S.letter); wakeT = setTimeout(flush, Math.max(500, (t || 0) - Date.now())); }
    });
  }
  // "I'm here, n waiting" every 60 s while open; its clock answer fixes a phone clock that is far off (QR expiry, sale times)
  function hello() {
    if (document.hidden) return;
    if (!tokenOk()) { renew(); return; }   // past SGT midnight: today's token first
    var t0 = Date.now();
    A.call('POST', '/till/hello', { waiting: C.Q.waiting(S.queue) }, S.auth.token, 10000).then(function (res) {
      learnClock(res, t0);
      if (res.ok) S.offline = false;
      else if (C.Q.classify(res) === 'login') { if (S.auth) S.auth.date = ''; renew(); }
      else if (res.net) S.offline = true;
      status();
    });
  }
  setInterval(hello, 60000);
  window.addEventListener('online', function () { S.offline = false; for (var i = 0; i < S.queue.length; i++) S.queue[i].nextAt = 0; flush(); });
  window.addEventListener('offline', function () { S.offline = true; status(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (S.screen === 'sell') renderSell();
    flush(); hello();
  });

  // ---------- booth PIN: first open → a till letter; a new day → the same letter again ----------
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
    renderPin();
    if (S.pin.length === 6) setTimeout(join, 150);
  }
  document.addEventListener('keydown', function (e) {
    if (S.screen !== 'pin' || $('sheet').firstChild) return;
    if (/^[0-9]$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('⌫');
  });
  function join() {
    var pin = S.pin, body = { pin: pin };
    if (S.letter) body.letter = S.letter;
    S.busy = true; renderPin();
    var t0 = Date.now();
    A.call('POST', '/till/join', body, null, 15000).then(function (res) {
      S.busy = false; S.pin = ''; learnClock(res, t0);
      var d = res.data || {};
      if (!res.ok || !d.token || !/^[A-Z]$/.test(d.letter || '')) {
        S.pinNet = !!res.net || res.status === 429;   // no signal, or locked out for a while: sell now, the sales wait on the phone
        $('pinerr').textContent = res.ok ? 'Something went wrong. Try again.' : A.words(res);
        renderPin(); return;
      }
      if (d.letter !== S.letter) S.counter = { letter: d.letter, n: 0 };   // a new till letter starts its own numbers
      S.letter = d.letter; S.pinNet = false;
      S.counter = { letter: d.letter, n: Math.max(S.counter && S.counter.letter === d.letter ? S.counter.n : 0, +d.lastN || 0) };
      setAuth(d); S.renewedAt = Date.now();
      put('letter', S.letter); put('counter', S.counter);
      show(S.paid ? 'paid' : 'sell');
      flush(); hello();
    });
  }
  $('sellnow').onclick = function () { show(S.paid ? 'paid' : 'sell'); };

  // ---------- log out (asks first; never while sales wait to send) ----------
  $('logout').onclick = function () {
    var w = C.Q.waiting(S.queue), L = S.letter;
    sheet('<h3>Log out of Till ' + esc(L) + '?</h3>' +
      '<div class="preview">This phone stops being Till ' + esc(L) + '.<br><span style="color:var(--muted)">The next PIN gives a new letter.</span></div>' +
      (w ? '<div class="err">' + w + ' not sent yet. Wait for ● All saved.</div>' : '') +
      '<div class="row"><button class="btn second" id="loKeep">Keep</button><button class="btn danger" id="loGo"' + (w ? ' disabled' : '') + '>Log out</button></div>');
    $('loKeep').onclick = closeSheet;
    $('loGo').onclick = function () {
      if (C.Q.waiting(S.queue)) return;
      S.auth = null; S.letter = null; S.counter = null; S.paid = null; S.last = ''; S.q = {}; S.prize = null;
      ['auth', 'letter', 'counter', 'paid', 'last', 'order'].forEach(del);
      show('pin');
    };
  };

  // ---------- start ----------
  A.stripe();
  A.offlineShell('sw.js');
  if (!S.letter || !S.auth || !S.auth.token) show('pin');   // first open, or a renewal was refused
  else show(S.paid ? 'paid' : 'sell');                      // an old token renews itself (flush → renew)
  flush(); hello();
})();
