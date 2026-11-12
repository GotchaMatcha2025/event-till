# Gotcha Matcha event till (OCBC Arena, Fri 13 – Sun 15 Nov 2026)

Static page on GitHub Pages: the staff till (`/`) and the owners' Admin (`/admin/`). Look, words and behaviour = the approved mock-up
rev 3.1 (gotcha-hq `systems/guides/EVENT-TILL-MOCKUP.html`, owner's yes 12 Nov 2026 ~12:48). Server: `event-till-server` (Worker
`gotcha-till`, contract in its `API.md`). Plain ES5, no build step, nothing loaded from a CDN.

- `assets/rules.js`: the event (menu, prizes, days, PayNow QR). **Byte-identical to the server's `src/rules.js`**; change both or neither.
- `assets/core.js`: the pure parts (queue, next number, find, amounts, which server), tested in node. `assets/api.js`: server + fetch + words.
- `assets/till.js` + `index.html`: sell → PayNow QR → hold Paid → Paid (Undo until Next order); sales queue on the phone first.
- `assets/admin.js` + `admin/index.html`: everything from `GET /admin/state`; Void / Restore / Adjust / Undo; Save PDF = print, X reading only.
- `sw.js`: the offline shell. **Every deploy: a new `VERSION` in sw.js and the same `?v=` on both pages** (the tests check they match).
- Vendored, unmodified: `assets/vendor/qrcode-generator-1.4.4`, `assets/fonts` (OFL); `SHA256SUMS` in each, checked by the tests.

Server: live by default; `?api=staging` (remembered on that phone, red "TEST · staging" stripe); `?api=live` switches back.

Tests: `node --test test/*.test.mjs`. Browser walk (needs Chrome): `node test/browser-check.mjs [out-dir]` runs the pages against
`test/stub-server.mjs` (made-up data and made-up test PINs, never real ones) and saves screenshots + the printed PDF.
