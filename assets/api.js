/* Gotcha Matcha event till — which server, one fetch with a timeout, and the error words (gotcha-hq API contract, 12 Nov 2026).
   Live by default; ?api=staging is remembered on this phone for that SGT day only, with a red "TEST · staging · tap for live" stripe on
   every screen; ?api=live switches back. ?api=http://localhost:PORT only from a copy opened on this computer (file: or localhost): the
   test stub. Plain ES5; puts TillApi on window. */
(function (root) {
  'use strict';
  var C = root.TillCore, R = root.TillRules, KEY = 'gm-till-api';
  // → the value for 'get'; true / false for 'set' and 'del' (a full or blocked storage says false, never throws)
  function ls(op, k, v) {
    try {
      if (op === 'get') return root.localStorage.getItem(k);
      if (op === 'set') root.localStorage.setItem(k, v); else root.localStorage.removeItem(k);
      return true;
    } catch (e) { return op === 'get' ? null : false; }
  }
  // can this browser keep sales? write, read back, remove (private modes and blocked storage fail here)
  function storageOk() {
    var k = 'gm-till-probe', v = String(Math.random());
    return ls('set', k, v) === true && ls('get', k) === v && ls('del', k) === true;
  }
  var raw = ls('get', KEY), day = R.sgtDate(Date.now());
  var P = C.pickApi(root.location.search, root.location.protocol, root.location.hostname, C.storedApi(raw, day));
  if (P.save === null || (raw && P.save === undefined && C.storedApi(raw, day) === null)) ls('del', KEY);   // ?api=live, or yesterday's choice
  else if (P.save) ls('set', KEY, JSON.stringify({ v: P.save, day: day }));

  // the words people see (≤ 6 where possible); a server message wins for the price and cap refusals
  var WORDS = {
    'bad-pin': 'Wrong PIN.', busy: 'Too many wrong PINs. Wait 15 minutes.', login: 'Log in again.',
    clash: 'Number clash — tell an owner.', 'below-zero': 'That day would go below S$0.', closed: 'Till server not set up.',
    adjusted: 'Undo its adjustment first.', voided: 'Already voided.', undone: 'Already undone.', 'too-late': 'Too late to undo — tell an owner.',
    full: 'No till letters left — tell an owner.', 'not-found': 'Not found.', test: 'A test sale: never counted.', 'not-voided': 'Not voided.',
    number: 'Order number too high — tell an owner.', 'req-reused': 'Something went wrong. Try again.', slow: 'Too many tries. Wait a few minutes.'
  };
  var OWN_WORDS = { price: 1, cap: 1, busy: 1, slow: 1, number: 1, 'req-reused': 1 };   // the server's message says it best (e.g. the minutes left)
  function words(res) {
    if (!res || res.ok) return '';
    if (res.net) return 'No signal. Try again.';
    if (OWN_WORDS[res.error] && res.message) return res.message;
    if (WORDS[res.error]) return WORDS[res.error];
    if (res.message) return res.message;   // e.g. 503 try-again: "Something went wrong. Try again."
    if (res.status === 503) return WORDS.closed;
    return 'Something went wrong (' + (res.error || res.status) + ').';
  }

  // → always resolves {ok, status, error, message, data, net}; never throws. A timeout aborts and counts as no signal.
  function call(method, path, body, token, ms) {
    return new Promise(function (resolve) {
      var ctl = root.AbortController ? new root.AbortController() : null, done = false, timer;
      function fin(r) { if (done) return; done = true; clearTimeout(timer); resolve(r); }
      var opts = { method: method, headers: {}, cache: 'no-store', credentials: 'omit' };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      if (token) opts.headers.Authorization = 'Bearer ' + token;
      if (ctl) opts.signal = ctl.signal;
      timer = setTimeout(function () { if (ctl) ctl.abort(); fin({ ok: false, net: true, status: 0, error: 'timeout', message: '' }); }, ms || 15000);
      var f;
      try { f = root.fetch(P.base + path, opts); } catch (e) { fin({ ok: false, net: true, status: 0, error: 'net', message: '' }); return; }
      f.then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
          if (!j || typeof j !== 'object') return fin({ ok: false, status: r.status, error: r.status >= 500 ? 'server' : 'bad-reply', message: '', data: null });
          fin({ ok: j.ok === true && r.ok, status: r.status, error: j.error || (r.ok ? null : 'http-' + r.status), message: j.message || '', data: j });
        });
      }).then(null, function () { fin({ ok: false, net: true, status: 0, error: 'net', message: '' }); });
    });
  }

  // one key space per server: a staging (or stub) token or sale never reaches live on the same phone
  function key(k) { return 'gm-till/' + P.ns + '/' + k; }
  // the red stripe on every screen when this is not the live server; a tap asks, then switches this phone to live
  function stripe() {
    if (P.mode === 'live') return;
    var s = document.createElement('button');
    s.className = 'stripe'; s.type = 'button';
    s.textContent = 'TEST · ' + (P.mode === 'staging' ? 'staging' : 'local stub') + ' · tap for live';
    s.onclick = function () {
      var box = document.getElementById('sheet'); if (!box) return;
      box.innerHTML = '<div class="sheetwrap" id="apiSw"><div class="sheet" role="dialog" aria-modal="true"><h3>Switch to live?</h3>' +
        '<div class="preview">This phone leaves the test server.<br><span style="color:var(--muted)">Test sales stay there.</span></div>' +
        '<div class="row"><button class="btn second" id="apiKeep">Keep test</button><button class="btn paynow" id="apiLive">Switch to live</button></div></div></div>';
      document.getElementById('apiKeep').onclick = function () { box.innerHTML = ''; };
      document.getElementById('apiSw').onclick = function (e) { if (e.target.id === 'apiSw') box.innerHTML = ''; };
      document.getElementById('apiLive').onclick = function () { ls('del', KEY); root.location.replace(root.location.pathname + '?api=live'); };
    };
    document.body.insertBefore(s, document.body.firstChild);
    document.body.className += ' test';
  }
  // the app shell for a reload with no signal (https or this computer only; file: has no service worker). onNew: a newer shell took over
  function offlineShell(swPath, onNew) {
    if (!('serviceWorker' in root.navigator)) return null;
    if (root.location.protocol !== 'https:' && root.location.hostname !== 'localhost' && root.location.hostname !== '127.0.0.1') return null;
    var sw = root.navigator.serviceWorker, had = !!sw.controller, reg = null;
    sw.register(swPath).then(function (r) { reg = r; }, function () { /* no shell: the page still works online */ });
    if (had && onNew) sw.addEventListener('controllerchange', onNew);   // not on the first install
    return { check: function () { if (reg) reg.update().then(null, function () { /* offline */ }); } };
  }

  root.TillApi = { base: P.base, mode: P.mode, ns: P.ns, call: call, words: words, key: key, stripe: stripe, offlineShell: offlineShell, ls: ls, storageOk: storageOk };
})(window);
