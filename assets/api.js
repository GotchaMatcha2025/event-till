/* Gotcha Matcha event till — which server, one fetch with a timeout, and the error words (gotcha-hq API contract, 12 Nov 2026).
   Live by default; ?api=staging (remembered on this phone, red "TEST · staging" stripe on every screen); ?api=live switches back.
   ?api=http://localhost:PORT only from a copy opened on this computer (file: or localhost): the test stub. Plain ES5; puts TillApi on window. */
(function (root) {
  'use strict';
  var C = root.TillCore, KEY = 'gm-till-api';
  function ls(op, k, v) { try { return op === 'get' ? root.localStorage.getItem(k) : op === 'set' ? root.localStorage.setItem(k, v) : root.localStorage.removeItem(k); } catch (e) { return null; } }
  var P = C.pickApi(root.location.search, root.location.protocol, root.location.hostname, ls('get', KEY));
  if (P.save === null) ls('del', KEY); else if (P.save) ls('set', KEY, P.save);

  // the words people see (≤ 6 where possible); a server message wins for the price and cap refusals
  var WORDS = {
    'bad-pin': 'Wrong PIN.', busy: 'Too many wrong PINs. Wait 15 minutes.', login: 'Log in again.',
    clash: 'Number clash — tell an owner.', 'below-zero': 'That day would go below S$0.', closed: 'Till server not set up.',
    adjusted: 'Undo its adjustment first.', voided: 'Already voided.', undone: 'Undone at the till.', 'too-late': 'Too late to undo — tell an owner.',
    full: 'No till letters left — tell an owner.', 'not-found': 'No such order.'
  };
  function words(res) {
    if (!res || res.ok) return '';
    if (res.net) return 'No signal. Try again.';
    if ((res.error === 'price' || res.error === 'cap') && res.message) return res.message;
    if (WORDS[res.error]) return WORDS[res.error];
    if (res.status === 503) return WORDS.closed;
    if (res.status === 404) return WORDS['not-found'];
    return res.message || 'Something went wrong (' + (res.error || res.status) + ').';
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

  // one key space per server: a staging test never mixes with live sales on the same phone
  function key(k) { return 'gm-till/' + P.ns + '/' + k; }
  // the red stripe on every screen when this is not the live server
  function stripe() {
    if (P.mode === 'live') return;
    var s = document.createElement('div');
    s.className = 'stripe'; s.setAttribute('role', 'note');
    s.textContent = P.mode === 'staging' ? 'TEST · staging' : 'TEST · local stub';
    document.body.insertBefore(s, document.body.firstChild);
    document.body.className += ' test';
  }
  // the app shell for a reload with no signal (https or this computer only; file: has no service worker)
  function offlineShell(swPath) {
    if (!('serviceWorker' in root.navigator)) return;
    if (root.location.protocol !== 'https:' && root.location.hostname !== 'localhost' && root.location.hostname !== '127.0.0.1') return;
    root.navigator.serviceWorker.register(swPath).then(null, function () { /* no shell: the page still works online */ });
  }

  root.TillApi = { base: P.base, mode: P.mode, ns: P.ns, call: call, words: words, key: key, stripe: stripe, offlineShell: offlineShell, ls: ls };
})(window);
