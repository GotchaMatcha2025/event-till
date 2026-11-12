/* Gotcha Matcha event till — the offline app shell (service worker): a reload with no signal still opens the till.
   Pages: network first (3.5 s, the stadium's signal), then the saved copy. Our own files (all ?v= tagged): the saved copy first.
   The till server (another host) and anything else: never touched, straight to the network.
   Every deploy: a new VERSION here + the same ?v= on both pages (test/files.test.mjs checks it), so phones get the new files. Plain ES5. */
var VERSION = '20261112a';
var CACHE = 'gm-till-' + VERSION;
var SHELL = [
  './',
  './index.html',
  './admin/',
  './admin/index.html',
  './assets/till.css?v=20261112a',
  './assets/rules.js?v=20261112a',
  './assets/core.js?v=20261112a',
  './assets/api.js?v=20261112a',
  './assets/till.js?v=20261112a',
  './assets/admin.js?v=20261112a',
  './assets/vendor/qrcode-generator-1.4.4/qrcode.js?v=20261112a',
  './assets/fonts/nunito-latin.woff2',
  './assets/fonts/plexmono-500-latin.woff2',
  './assets/fonts/plexmono-600-latin.woff2'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));   // fresh from the server, not the browser's copy
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('gm-till-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function pageKeys(url) {   // ?api=staging and friends share one saved copy; "/admin" = "/admin/" = "/admin/index.html"
  var p = url.origin + url.pathname, k = [p];
  if (/\/index\.html$/.test(p)) k.push(p.replace(/index\.html$/, ''));
  else if (/\/$/.test(p)) k.push(p + 'index.html');
  else k.push(p + '/', p + '/index.html');
  return k;
}
function fromCache(keys) {
  var i = 0;
  function next() { if (i >= keys.length) return Promise.resolve(null); return caches.match(keys[i++]).then(function (r) { return r || next(); }); }
  return next();
}
function page(req, url) {
  var keys = pageKeys(url);
  return new Promise(function (resolve) {
    var done = false;
    function give(r) { if (!done && r) { done = true; resolve(r); } }
    var slow = setTimeout(function () { fromCache(keys).then(give); }, 3500);   // weak signal: open the saved copy, keep waiting otherwise
    fetch(req).then(function (r) {
      clearTimeout(slow);
      if (r && r.ok && r.type === 'basic') { var copy = r.clone(); caches.open(CACHE).then(function (c) { return c.put(keys[0], copy); }); }
      give(r);
    }, function () {
      clearTimeout(slow);
      fromCache(keys).then(function (r) { give(r || Response.error()); });
    });
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || /(\/|\.html)$/.test(url.pathname)) { e.respondWith(page(req, url)); return; }
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (r) {
      if (r && r.ok && r.type === 'basic') { var copy = r.clone(); caches.open(CACHE).then(function (c) { return c.put(req, copy); }); }
      return r;
    });
  }));
});
