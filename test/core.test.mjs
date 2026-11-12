// The till's pure parts (assets/core.js): the next-number rule, the offline queue, order find, amount parsing, the API switch.
// Loaded exactly as the pages load them: rules.js, then core.js, as plain scripts in their own global (node:vm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(extra) {
  const ctx = vm.createContext(Object.assign({ console }, extra || {}));
  for (const f of ['assets/rules.js', 'assets/core.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const G = load({ crypto: globalThis.crypto });
const C = G.TillCore, R = G.TillRules;
const plain = (x) => JSON.parse(JSON.stringify(x));   // vm objects → this realm, for deepEqual

// ---------- the next order number: max(this phone, the server, anything still queued) + 1 ----------
test('nextN: max of the phone counter, the server lastN and the queue, plus 1', () => {
  assert.equal(C.nextN(0, 0, [], 'A'), 1);
  assert.equal(C.nextN(12, 0, [], 'A'), 13);
  assert.equal(C.nextN(12, 40, [], 'A'), 41);             // a reinstalled phone continues after the server's last
  assert.equal(C.nextN(41, 40, [], 'A'), 42);             // the phone is ahead (sales not sent yet)
  assert.equal(C.nextN(null, undefined, [], 'A'), 1);
  const q = [{ kind: 'sale', till: 'A', n: 50 }, { kind: 'sale', till: 'B', n: 90 }];
  assert.equal(C.nextN(12, 40, q, 'A'), 51);              // a queued sale counts; another till's never does
  assert.equal(C.nextN(12, 40, q, 'B'), 91);
});

// ---------- sale ids ----------
test('uid: a UUID from crypto.randomUUID, else getRandomValues, else Math.random; never the same twice', () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(C.uid(), re);
  const noUUID = { getRandomValues: (b) => globalThis.crypto.getRandomValues(b) };   // iOS 15.0–15.3: no randomUUID
  assert.match(C.uid(noUUID), re);
  assert.match(C.uid(null), re);                           // no crypto at all
  const seen = new Set(); for (let i = 0; i < 500; i++) seen.add(C.uid(null));
  assert.equal(seen.size, 500);
});

// ---------- amounts typed by an owner ----------
test('parseCents: "7", "S$7.00", "$1,200" are money; "7x" and friends are NaN; blank is 0', () => {
  assert.equal(C.parseCents('7'), 700);
  assert.equal(C.parseCents('7.5'), 750);
  assert.equal(C.parseCents('7.05'), 705);
  assert.equal(C.parseCents('S$7.00'), 700);
  assert.equal(C.parseCents('s$ 7'), 700);
  assert.equal(C.parseCents('$1,200'), 120000);
  assert.equal(C.parseCents('1,234,567.89'), 123456789);
  assert.equal(C.parseCents('0.29'), 29);                  // no float drift
  assert.equal(C.parseCents(' 12 '), 1200);
  assert.equal(C.parseCents(''), 0);
  assert.equal(C.parseCents(null), 0);
  for (const bad of ['7x', 'x7', '7.', '.5', '7.123', '-7', '1,2,3', '12,00', '7$', 'SGD 7', '7 7', '$', 'S$']) {
    assert.ok(Number.isNaN(C.parseCents(bad)), bad + ' should be NaN');
  }
});

// ---------- order codes and find ----------
const mk = (code, at) => ({ code, at, total: 740 });
const ORD = [mk('A-012', 1000), mk('A-120', 5000), mk('A-121', 6000), mk('B-012', 7000), mk('A-001', 500), mk('B-200', 8000)];
test('parseCode: "A-012" → till A, n 12', () => {
  assert.deepEqual(plain(C.parseCode('A-012')), { till: 'A', n: 12 });
  assert.deepEqual(plain(C.parseCode('Z-1000')), { till: 'Z', n: 1000 });
  assert.equal(C.parseCode('A12'), null);
  assert.equal(C.parseCode(''), null);
});
test('findOrders: blank = all, newest first', () => {
  assert.deepEqual(plain(C.findOrders(ORD, '').map((o) => o.code)), ['B-200', 'B-012', 'A-121', 'A-120', 'A-012', 'A-001']);
});
test('findOrders: the exact number comes first, then numbers that start with it (newest first)', () => {
  assert.deepEqual(plain(C.findOrders(ORD, 'A-012').map((o) => o.code)), ['A-012', 'A-121', 'A-120']);   // the mock-up's rule: exact, then starts-with
  assert.deepEqual(plain(C.findOrders(ORD, 'a12').map((o) => o.code)), ['A-012', 'A-121', 'A-120']);   // rev 2 bug: A-120… came first
  assert.deepEqual(plain(C.findOrders(ORD, '12').map((o) => o.code)), ['B-012', 'A-012', 'A-121', 'A-120']);
  assert.deepEqual(plain(C.findOrders(ORD, '1').map((o) => o.code)), ['A-001', 'B-012', 'A-121', 'A-120', 'A-012']);
  assert.deepEqual(plain(C.findOrders(ORD, 'b').map((o) => o.code)), ['B-200', 'B-012']);
  assert.deepEqual(plain(C.findOrders(ORD, 'A 120').map((o) => o.code)), ['A-120']);
});
test('findOrders: the PayNow reference from the bank app finds its order (GMA120)', () => {
  assert.deepEqual(plain(C.findOrders(ORD, 'GMA120', 'GM').map((o) => o.code)), ['A-120']);
  assert.deepEqual(plain(C.findOrders(ORD, 'gma012', 'GM').map((o) => o.code)), ['A-012', 'A-121', 'A-120']);
});
test('findOrders: nonsense finds nothing; ties break by till then number', () => {
  assert.equal(C.findOrders(ORD, 'xyz').length, 0);
  assert.equal(C.findOrders(ORD, 'A-999').length, 0);
  const tie = [mk('A-002', 100), mk('B-001', 100), mk('A-003', 100)];
  assert.deepEqual(plain(C.findOrders(tie, '').map((o) => o.code)), ['B-001', 'A-003', 'A-002']);
});

// ---------- the offline queue ----------
const sale = (id, n, extra) => Object.assign({ kind: 'sale', id, till: 'A', n, at: 1000 + n, q: { ml: 1 }, prize: null, undone: false, total: 740 }, extra || {});
test('queue: add, ready in order, body and path of each kind', () => {
  const q = [];
  C.Q.add(q, sale('s1', 1)); C.Q.add(q, sale('s2', 2));
  assert.equal(C.Q.waiting(q), 2);
  const j = C.Q.ready(q, 0, 'A');
  assert.equal(j.id, 's1');
  assert.equal(C.Q.path(j), '/till/sale');
  assert.deepEqual(plain(C.Q.body(j)), { id: 's1', till: 'A', n: 1, at: 1001, q: { ml: 1 }, prize: null, undone: false });
  assert.equal(C.Q.body(j, 5000).sentAt, 5000);            // the phone's (corrected) clock when it was sent, beside `at`
  assert.equal(C.Q.path({ kind: 'undo', id: 's1' }), '/till/undo');
  assert.deepEqual(plain(C.Q.body({ kind: 'undo', id: 's1', till: 'A', n: 1 })), { id: 's1' });
});
test('queue: a saved sale leaves the queue', () => {
  const q = [sale('s1', 1), sale('s2', 2)];
  C.Q.settle(q, q[0], C.Q.body(q[0]), { code: 'A-001', saved: true, undone: false });
  assert.deepEqual(q.map((j) => j.id), ['s2']);
});
test('queue: settled on the reply\'s undone — an undo the server refused keeps the sale as sold, in red', () => {
  const q = [sale('s1', 1, { undone: true })];
  C.Q.settle(q, q[0], C.Q.body(q[0]), { code: 'A-001', saved: true, undone: false });   // asked undone, the server said no
  assert.equal(q.length, 1);
  assert.equal(C.failLine(q), 'Too late to undo A-001 — tell an owner');
  assert.equal(C.Q.waiting(q), 0);                         // never sent again
  const q2 = [sale('s2', 2, { undone: true })];
  C.Q.settle(q2, q2[0], C.Q.body(q2[0]), { code: 'A-002', saved: true, undone: true });
  assert.equal(q2.length, 0);                              // the undo stood
  const q3 = [sale('s3', 3, { undone: true })];
  C.Q.settle(q3, q3[0], C.Q.body(q3[0]), { code: 'A-003', saved: true });   // an answer without `undone`: what was sent
  assert.equal(q3.length, 0);
});
test('queue: a network error retries with backoff (2 s, 4 s … at most 60 s); nothing is lost', () => {
  const q = [sale('s1', 1)];
  assert.equal(C.Q.classify({ ok: false, net: true }), 'retry');
  C.Q.retry(q, q[0], 10000);
  assert.equal(q[0].tries, 1); assert.equal(q[0].nextAt, 12000);
  assert.equal(C.Q.ready(q, 11999, 'A'), null);           // not before its time
  assert.equal(C.Q.ready(q, 12000, 'A').id, 's1');
  C.Q.retry(q, q[0], 20000); assert.equal(q[0].nextAt, 24000);
  for (let i = 0; i < 10; i++) C.Q.retry(q, q[0], 0);
  assert.equal(q[0].nextAt, 60000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(C.Q.backoff), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(C.Q.waiting(q), 1);
});
test('queue: classify — 5xx, 429 and timeouts retry; 401 asks for the PIN; other 4xx stop and stay visible', () => {
  assert.equal(C.Q.classify({ ok: true, status: 200 }), 'ok');
  assert.equal(C.Q.classify({ ok: false, status: 503, error: 'closed' }), 'retry');
  assert.equal(C.Q.classify({ ok: false, status: 500, error: 'server' }), 'retry');
  assert.equal(C.Q.classify({ ok: false, status: 429, error: 'busy' }), 'retry');
  assert.equal(C.Q.classify({ ok: false, status: 0, net: true, error: 'timeout' }), 'retry');
  assert.equal(C.Q.classify({ ok: false, status: 401, error: 'login' }), 'login');
  assert.equal(C.Q.classify({ ok: false, status: 403, error: 'login' }), 'login');
  assert.equal(C.Q.classify({ ok: false, status: 403, error: 'origin' }), 'fail');   // a page on a site the server doesn't allow: no PIN fixes that
  assert.equal(C.Q.classify({ ok: false, status: 503, error: 'try-again' }), 'retry');
  assert.equal(C.Q.classify({ ok: false, status: 404, error: 'not-found' }), 'fail');
  assert.equal(C.Q.classify({ ok: false, status: 409, error: 'clash' }), 'fail');
  assert.equal(C.Q.classify({ ok: false, status: 422, error: 'price' }), 'fail');
  assert.equal(C.Q.classify({ ok: false, status: 409, error: 'too-late' }), 'fail');
});
test('queue: a 4xx stays in the queue as "not saved — tell an owner" with its code, and is never sent again', () => {
  const q = [sale('s1', 132), sale('s2', 133)];
  C.Q.fail(q, q[0], { status: 409, error: 'clash', message: 'Number clash' });
  assert.equal(C.Q.waiting(q), 1);
  assert.equal(C.Q.failed(q).length, 1);
  assert.equal(C.Q.ready(q, 0, 'A').id, 's2');             // the stuck one never blocks the rest
  assert.equal(C.failLine(q), '1 not saved — tell an owner (A-132 · clash)');
  C.Q.fail(q, q[1], { status: 422, error: 'price' });
  assert.equal(C.failLine(q), '2 not saved — tell an owner (A-132 · clash, A-133 · price)');
  assert.equal(C.Q.ready(q, 0, 'A'), null);
});
test('queue: undo of a sale still queued marks it undone (sent once, as undone)', () => {
  const q = [sale('s1', 1)];
  assert.equal(C.Q.undo(q, { id: 's1', till: 'A', n: 1 }), 'queued');
  assert.equal(q.length, 1);
  assert.equal(C.Q.body(q[0]).undone, true);
});
test('queue: a refused undo (too late, an owner corrected it) keeps the sale as sold and says so', () => {
  const q = [];
  C.Q.undo(q, { id: 's9', till: 'A', n: 9 });
  C.Q.fail(q, q[0], { status: 409, error: 'too-late', message: 'Too late to undo. Tell an owner.' });
  assert.equal(C.failLine(q), 'Too late to undo A-009 — tell an owner');
  C.Q.add(q, sale('s10', 10)); C.Q.fail(q, q[1], { status: 409, error: 'clash' });
  assert.equal(C.failLine(q), '1 not saved — tell an owner (A-010 · clash) · Too late to undo A-009 — tell an owner');
  const q2 = []; C.Q.undo(q2, { id: 's8', till: 'A', n: 8 }); C.Q.fail(q2, q2[0], { status: 404, error: 'not-found' });
  assert.equal(C.failLine(q2), 'Too late to undo A-008 — tell an owner (not-found)');
});
test('clockOffset: the server\'s clock is used only when the phone is more than 5 minutes off', () => {
  assert.equal(C.clockOffset(1000000, 999000, 999400), 0);                // 0.8 s: the phone is right
  assert.equal(C.clockOffset(1000000 + 3600000, 1000000, 1000200), 3599900);   // the phone is an hour slow
  assert.equal(C.clockOffset(undefined, 1, 2), null);                     // no clock in the answer: keep what we had
});
test('queue: undo of a sale already sent queues POST /till/undo (retried like a sale)', () => {
  const q = [];
  assert.equal(C.Q.undo(q, { id: 's1', till: 'A', n: 7 }), 'undo');
  assert.equal(q.length, 1);
  assert.equal(C.Q.path(q[0]), '/till/undo');
  assert.equal(q[0].n, 7);
  assert.equal(C.Q.undo(q, { id: 's1', till: 'A', n: 7 }), 'queued');   // a second tap adds nothing
  assert.equal(q.length, 1);
});
test('queue: undo while the sale is on its way — the reply turns it into an undo, never a lost undo', () => {
  const q = [sale('s1', 1)];
  const sent = C.Q.body(q[0]);                              // sent with undone:false …
  q[0].inflight = true;
  assert.equal(C.Q.ready(q, 0, 'A'), null);                // never sent twice at once
  C.Q.undo(q, { id: 's1', till: 'A', n: 1 });               // … then Undo is tapped before the answer
  C.Q.settle(q, q[0], sent, { code: 'A-001', saved: true, undone: false });   // the answer: saved (as a sale)
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'undo');
  assert.equal(C.Q.path(q[0]), '/till/undo');
  assert.equal(q[0].inflight, false);
});
test('queue: jobs of another till letter are never sent with this till\'s token', () => {
  const q = [sale('s1', 1, { till: 'B' })];
  assert.equal(C.Q.ready(q, 0, 'A'), null);
  assert.equal(C.Q.foreign(q, 'A').length, 1);
});
test('queue: the earliest wake-up time', () => {
  const q = [sale('s1', 1, { nextAt: 9000 }), sale('s2', 2, { nextAt: 4000 }), sale('s3', 3, { nextAt: 1000, err: { error: 'clash' } })];
  assert.equal(C.Q.wake(q, 'A'), 4000);
  assert.equal(C.Q.wake([], 'A'), null);
});

// ---------- the pill ----------
test('pill: "● All saved" / "2 waiting to send" / "Offline · 2 waiting" / "PIN needed"', () => {
  assert.deepEqual(plain(C.pill([], false, false)), { text: '● All saved', cls: 'ok' });
  const q = [sale('s1', 1), sale('s2', 2)];
  assert.deepEqual(plain(C.pill(q, false, false)), { text: '2 waiting to send', cls: 'warn' });
  assert.deepEqual(plain(C.pill(q, true, false)), { text: 'Offline · 2 waiting', cls: 'warn' });
  assert.deepEqual(plain(C.pill(q, false, true)), { text: 'PIN needed · 2 waiting', cls: 'warn' });
  assert.deepEqual(plain(C.pill([], false, true)), { text: 'PIN needed', cls: 'warn' });
  C.Q.fail(q, q[0], { status: 409, error: 'clash' }); C.Q.fail(q, q[1], { status: 409, error: 'clash' });
  assert.deepEqual(plain(C.pill(q, false, false)), { text: '● All saved', cls: 'ok' });   // the failed ones have their own red line
});

// ---------- time words (SGT, whatever the phone's zone) ----------
test('hm / dayWords / when: "7:41pm", "Sat 14 Nov", "Fri 13 7:41pm"', () => {
  const sat741pm = Date.UTC(2026, 10, 14, 11, 41);         // 19:41 SGT
  assert.equal(C.hm(sat741pm), '7:41pm');
  assert.equal(C.hm(Date.UTC(2026, 10, 14, 2, 0)), '10:00am');
  assert.equal(C.hm(Date.UTC(2026, 10, 14, 4, 5)), '12:05pm');
  assert.equal(C.hm(Date.UTC(2026, 10, 13, 16, 30)), '12:30am');
  assert.deepEqual(plain(C.dayWords('2026-11-14')), { date: '2026-11-14', short: 'Sat 14', label: 'Sat 14 Nov', full: 'Sat 14 Nov 2026' });
  assert.deepEqual(plain(C.dayWords('2026-11-12')), { date: '2026-11-12', short: 'Thu 12', label: 'Thu 12 Nov', full: 'Thu 12 Nov 2026' });
  assert.equal(C.when(sat741pm, '2026-11-14'), '7:41pm');
  assert.equal(C.when(sat741pm, '2026-11-15'), 'Sat 14 7:41pm');
  assert.equal(C.ymd('2026-11-14'), '20261114');
});

// ---------- which server (a public page can never be pointed at another host) ----------
test('pickApi: live by default; ?api=staging is remembered; ?api=live switches back', () => {
  const L = C.API.live, S = C.API.staging;
  assert.equal(L, 'https://gotcha-till.long-fog-ae60.workers.dev');
  assert.equal(S, 'https://gotcha-till-staging.long-fog-ae60.workers.dev');
  let p = C.pickApi('', 'https:', 'gotchamatcha2025.github.io', null);
  assert.deepEqual(plain(p), { mode: 'live', base: L, ns: 'live' });
  p = C.pickApi('?api=staging', 'https:', 'gotchamatcha2025.github.io', null);
  assert.equal(p.mode, 'staging'); assert.equal(p.base, S); assert.equal(p.save, 'staging'); assert.equal(p.ns, 'staging');
  p = C.pickApi('', 'https:', 'gotchamatcha2025.github.io', 'staging');
  assert.equal(p.mode, 'staging'); assert.equal(p.save, undefined);
  p = C.pickApi('?x=1&api=live', 'https:', 'gotchamatcha2025.github.io', 'staging');
  assert.equal(p.mode, 'live'); assert.equal(p.save, null);
});
test('pickApi: ?api=http://localhost:PORT only from a file or localhost copy', () => {
  let p = C.pickApi('?api=http://localhost:8788', 'file:', '', null);
  assert.equal(p.mode, 'local'); assert.equal(p.base, 'http://localhost:8788'); assert.equal(p.ns, 'local-8788');
  p = C.pickApi('?api=http%3A%2F%2F127.0.0.1%3A9000', 'http:', '127.0.0.1', null);
  assert.equal(p.base, 'http://127.0.0.1:9000');
  p = C.pickApi('?api=http://localhost:8788', 'https:', 'gotchamatcha2025.github.io', null);
  assert.equal(p.mode, 'live'); assert.equal(p.save, null);
  p = C.pickApi('', 'https:', 'gotchamatcha2025.github.io', 'http://localhost:8788');     // a stored value from elsewhere: refused
  assert.equal(p.mode, 'live');
  for (const bad of ['https://evil.example', 'http://localhost.evil.example:80', 'http://localhost:80/x', '%E0%A4%A']) {
    p = C.pickApi('?api=' + bad, 'file:', '', null);
    assert.equal(p.mode, 'live', bad);
  }
});
