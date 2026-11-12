// A pretend till server for checking the pages on this computer: answers the shapes in the API contract (gotcha-hq / build shared API.md)
// with seeded, made-up sales, in memory only. Never deployed, never the real rules of the server repo (it only re-prices with rules.js).
//   node test/stub-server.mjs [--port 8788] [--now 2026-11-14T19:41:00+08:00] [--empty]
// Then open index.html or admin/index.html (from disk, or http://localhost:PORT/…) with ?api=http://localhost:PORT
// Made-up test PINs, this stub only (never real ones): booth 482913 · Kai 736204 · Vin 591847.
// Controls: POST /__stub/down {down} (no signal), /__stub/expire (every token is yesterday's), /__stub/busy {on} (PINs locked: 429),
// /__stub/broken {on} (every API call 503), /__stub/page500 {on} (the pages answer 500), /__stub/dump (+ join / renew counts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('--port', process.env.PORT || 8788);
const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/rules.js'), 'utf8'), ctx);
const R = ctx.TillRules, E = R.EVENT;
const PIN = { booth: '482913', Kai: '736204', Vin: '591847' };   // test-only
const START = Date.now(), ANCHOR = arg('--now') ? Date.parse(arg('--now')) : START;
const now = () => ANCHOR + (Date.now() - START);
const today = () => R.sgtDate(now());

// ---------- data (the server's tables, in memory) ----------
const tills = new Map();   // letter → {letter, joinedAt, lastSeen, lastSaleAt, waiting}
const sales = [];          // {id, till, n, day, at, receivedAt, lines, prize, gross, disc, total, cups, undone, test}
const fixes = [];          // {id, req, kind, till, n, day, amt, why, by, madeAt, undoes}
const reqs = new Map();    // req → [status, body]
const tokens = new Map();  // token → {kind, who, date}
let down = false, busy = false, broken = false, page500 = false, wrong = { booth: 0, owner: 0 }, count = { joins: 0, renews: 0, logins: 0 };

const sgt = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00+08:00');
function addSale(till, n, at, q, prize, extra = {}) {
  const p = R.price(q, prize); if (!p.ok) throw new Error('seed price ' + JSON.stringify(q) + ' ' + prize + ' ' + p.err);
  const s = { id: crypto.randomUUID(), till, n, day: R.sgtDate(at), at, receivedAt: at + 4000, lines: JSON.parse(JSON.stringify(p.lines)), prize: p.prize,
    gross: p.gross, disc: p.disc, total: p.total, cups: p.cups, undone: false, test: false, ...extra };
  sales.push(s); return s;
}
function seed() {
  let x = 14112026; const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const W = [['ml', .22], ['sml', .18], ['mpm', .12], ['yom', .10], ['sy', .13], ['ss', .09], ['t3y', .10], ['t3s', .06]];
  const pick = () => { let r = rnd(), a = 0; for (const [id, w] of W) { a += w; if (r < a) return id; } return 'ml'; };
  const count = { A: 0, B: 0 };
  const plan = [['2026-11-13', '15:00', '21:55', 46, ['A']], ['2026-11-14', '10:00', '19:38', 58, ['A', 'B']]];
  for (const [date, open, close, n, letters] of plan) {
    const t0 = sgt(date, open), t1 = sgt(date, close);
    for (let i = 0; i < n; i++) {
      const at = Math.round(t0 + (t1 - t0) * (i + rnd() * .8) / n), q = {}, k = rnd() < .55 ? 1 : rnd() < .78 ? 2 : 3;
      for (let j = 0; j < k; j++) { const id = pick(); q[id] = (q[id] || 0) + 1; }
      if ((q.ml || q.sml || q.mpm) && rnd() < .12) q.oat = 1;
      let pz = null;
      if (rnd() < .3) { const r = rnd(), want = r < .25 ? 'fy' : r < .5 ? 'fs' : r < .75 ? 'p10' : 'b149'; pz = R.prizeFits(q, want) ? want : null; }   // the 13 Nov prizes
      const till = letters[Math.floor(rnd() * letters.length)];
      addSale(till, ++count[till], at, q, pz);
    }
  }
  const find = (code) => sales.find((s) => R.code(s.till, s.n) === code);
  const a12 = find('A-012'), a30 = find('A-030'), a40 = find('A-040'), a70 = find('A-070');
  fixes.push({ id: 1, req: 's1', kind: 'void', till: 'A', n: 12, day: a12.day, amt: 0, why: "Didn't pay", by: 'Vin', madeAt: a12.at + 180000, undoes: null });
  fixes.push({ id: 2, req: 's2', kind: 'void', till: 'A', n: 70, day: a70.day, amt: 0, why: 'Refunded in full', by: 'Vin', madeAt: a70.at + 540000, undoes: null });
  fixes.push({ id: 3, req: 's3', kind: 'void', till: 'A', n: 30, day: a30.day, amt: 0, why: 'Test', by: 'Kai', madeAt: a30.at + 60000, undoes: null });
  fixes.push({ id: 4, req: 's4', kind: 'restore', till: 'A', n: 30, day: a30.day, amt: 0, why: 'Bank shows paid', by: 'Vin', madeAt: a30.at + 3600000, undoes: null });
  const take = a40.lines[0];
  fixes.push({ id: 5, req: 's5', kind: 'adjust', till: 'A', n: 40, day: a40.day, amt: -take.p, why: 'Keyed 2 ' + R.item(take.id).name + ', made 1. Refunded.', by: 'Vin', madeAt: a40.at + 720000, undoes: null });
  fixes.push({ id: 6, req: 's6', kind: 'adjust', till: null, n: null, day: '2026-11-14', amt: -7000, why: 'Typed 70 for 7.00', by: 'Kai', madeAt: sgt('2026-11-14', '18:50'), undoes: null });
  fixes.push({ id: 7, req: 's7', kind: 'undo', till: null, n: null, day: '2026-11-14', amt: 0, why: 'undo', by: 'Kai', madeAt: sgt('2026-11-14', '18:51'), undoes: 6 });
  find('A-050').undone = true;
  addSale('B', ++count.B, sgt('2026-11-14', '09:12'), { ml: 1 }, null, { test: true });   // rung before opening: kept, never counted
  tills.set('A', { letter: 'A', joinedAt: sgt('2026-11-13', '14:40'), lastSeen: sgt('2026-11-14', '19:40'), lastSaleAt: sgt('2026-11-14', '19:38'), waiting: 0 });
  tills.set('B', { letter: 'B', joinedAt: sgt('2026-11-14', '09:50'), lastSeen: sgt('2026-11-14', '19:36'), lastSaleAt: sgt('2026-11-14', '19:30'), waiting: 2 });
}
if (!process.argv.includes('--empty')) seed();

// ---------- derived state (API contract: rung − voided + adjusted; bank = rung − "Didn't pay"/"Test" voids) ----------
const code = (s) => R.code(s.till, s.n);
function lastVR(s) { let r = null; for (const f of fixes) if ((f.kind === 'void' || f.kind === 'restore') && f.till === s.till && f.n === s.n) r = f; return r; }
const isVoided = (s) => { const r = lastVR(s); return !!r && r.kind === 'void'; };
const undoOf = (a) => fixes.find((f) => f.kind === 'undo' && f.undoes === a.id) || null;
const liveAdj = () => fixes.filter((f) => f.kind === 'adjust' && !undoOf(f));
const adjOn = (s) => liveAdj().filter((a) => a.till === s.till && a.n === s.n).reduce((t, a) => t + a.amt, 0);
function figures(day) {
  const inD = (d) => day === 'all' || d === day;
  const real = sales.filter((s) => inD(s.day) && !s.test && !s.undone);
  const voided = real.filter(isVoided), kept = real.filter((s) => !isVoided(s)), adj = liveAdj().filter((a) => inD(a.day));
  const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
  const rung = sum(real, (s) => s.total), vv = sum(voided, (s) => s.total), av = sum(adj, (a) => a.amt);
  const noPay = voided.filter((s) => ['Didn\'t pay', 'Test'].includes(lastVR(s).why));
  return { real, voided, kept, adj, rung, vv, av, total: rung - vv + av, bankIn: rung - sum(noPay, (s) => s.total) };
}
function state(day) {
  const F = figures(day), all = figures('all');
  const ats = F.kept.map((s) => s.at).sort((a, b) => a - b);
  const byDay = E.days.filter((d) => day === 'all' || d.date === day)   // the real server: a picked day = that day only
    .map((d) => { const f = figures(d.date); return { date: d.date, orders: f.kept.length, total: f.total, adjusted: f.adj.length > 0 }; });
  const items = {}; for (const m of E.menu) items[m.id] = 0; for (const s of F.kept) for (const l of s.lines) items[l.id] += l.q;
  const pz = {}; for (const s of F.real) if (s.prize) { const p = pz[s.prize] || (pz[s.prize] = { id: s.prize, label: R.prize(s.prize).label, n: 0, v: 0 }); p.n++; p.v += s.disc; }
  const prizes = Object.values(pz).sort((a, b) => b.v - a.v || b.n - a.n);
  const inD = (d) => day === 'all' || d === day;
  return {
    ok: true, now: now(), name: null, days: E.days,
    tills: [...tills.values()].sort((a, b) => a.letter < b.letter ? -1 : 1).map(({ letter, lastSaleAt, lastSeen, waiting }) => ({ letter, lastSaleAt, lastSeen, waiting })),
    x: { from: day === 'all' ? E.days[0].date : day, to: day === 'all' ? E.days[E.days.length - 1].date : day, total: F.total, orders: F.kept.length,
      firstAt: ats[0] || null, lastAt: ats[ats.length - 1] || null, tills: [...new Set(F.kept.map((s) => s.till))].sort(), byDay },
    own: { rung: F.rung, rungN: F.real.length, voided: F.vv, voidedN: F.voided.length, adjusted: F.av, adjustedN: F.adj.length, total: F.total, bankIn: F.bankIn,
      undoneN: sales.filter((s) => inD(s.day) && !s.test && s.undone).length },
    items: Object.entries(items).map(([id, q]) => ({ id, name: R.item(id).full || R.item(id).name, q })).sort((a, b) => b.q - a.q || (a.name < b.name ? -1 : 1)),
    prizes, prizesN: prizes.reduce((t, p) => t + p.n, 0), prizesV: prizes.reduce((t, p) => t + p.v, 0),
    fixes: fixes.filter((f) => f.kind === 'adjust' && inD(f.day)).sort((a, b) => b.madeAt - a.madeAt || b.id - a.id).map((f) => {
      const u = undoOf(f);
      return { id: f.id, kind: f.kind, till: f.till, n: f.n, code: f.till ? R.code(f.till, f.n) : null, day: f.day, amt: f.amt, why: f.why, by: f.by, madeAt: f.madeAt,
        undoes: null, undoneBy: u ? u.by : null, undoneAt: u ? u.madeAt : null };
    }),
    orders: sales.filter((s) => inD(s.day)).map((s) => {
      const r = lastVR(s), v = r && r.kind === 'void' ? r : null, rs = r && r.kind === 'restore' ? r : null;
      return { id: s.id, code: code(s), ref: R.ref(s.till, s.n), day: s.day, at: s.at, lines: s.lines, prize: s.prize, total: s.total, undone: s.undone, test: s.test,
        voided: v && { why: v.why, by: v.by, at: v.madeAt }, restored: rs && { why: rs.why, by: rs.by, at: rs.madeAt }, adjusted: adjOn(s) };
    }),
    _all: all.total
  };
}

// ---------- HTTP ----------
const no = (status, error, message) => [status, { ok: false, error, message: message || '' }];
function auth(req, kind) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''), t = m && tokens.get(m[1]);
  return t && t.kind === kind && t.date === today() ? t : null;
}
const once = (body, fn) => { if (typeof body.req !== 'string' || !body.req) return no(400, 'req'); if (reqs.has(body.req)) return reqs.get(body.req); const r = fn(); reqs.set(body.req, r); return r; };
const findCode = (c) => sales.find((s) => code(s) === c);
// the till's own undo (real server): < 30 min after it arrived, no owner correction on it, its day stays ≥ S$0
const undoOk = (s) => now() - s.receivedAt <= 30 * 60000 && !fixes.some((f) => f.till === s.till && f.n === s.n) && (s.test || dayTotal(s.day) - s.total >= 0);
const dayTotal = (d) => figures(d).total;

function route(method, url, body, req) {
  const p = url.pathname;
  if (method === 'POST' && p === '/till/join') {
    if (body.renew) count.renews++; else count.joins++;
    const old = body.renew ? tokens.get(body.renew) : null;   // a new day: yesterday's token for the same letter, no PIN
    if (body.renew && !(old && old.kind === 'till' && old.who === body.letter)) return no(401, 'login', 'Log in again.');
    if (!old && (busy || wrong.booth >= 8)) return no(429, 'busy', 'Too many wrong PINs. Wait 12 minutes.');
    if (!old && body.pin !== PIN.booth) { wrong.booth++; return no(401, 'bad-pin', 'Wrong PIN.'); }
    let letter = body.letter && tills.has(body.letter) ? body.letter : null;
    if (!letter) { for (let c = 65; c <= 90 && !letter; c++) if (!tills.has(String.fromCharCode(c))) letter = String.fromCharCode(c); if (!letter) return no(409, 'full'); tills.set(letter, { letter, joinedAt: now(), lastSeen: now(), lastSaleAt: null, waiting: 0 }); }
    const token = letter + '.' + today() + '.' + crypto.randomBytes(12).toString('base64url'); tokens.set(token, { kind: 'till', who: letter, date: today() });
    return [200, { ok: true, token, letter, lastN: sales.filter((s) => s.till === letter).reduce((m, s) => Math.max(m, s.n), 0), date: today() }];
  }
  if (method === 'POST' && p.startsWith('/till/')) {
    const t = auth(req, 'till'); if (!t) return no(401, 'login', 'Log in again.');
    const till = tills.get(t.who); till.lastSeen = now();
    if (p === '/till/hello') { till.waiting = +body.waiting || 0; return [200, { ok: true, now: now() }]; }
    if (p === '/till/sale') {
      if (body.till !== t.who) return no(401, 'login');
      const had = sales.find((s) => s.id === body.id);
      if (had) { if (body.undone === true && !had.undone && undoOk(had)) had.undone = true; return [200, { ok: true, code: code(had), saved: true, undone: had.undone, day: had.day, test: had.test }]; }
      const pr = R.price(body.q, body.prize); if (!pr.ok) return no(422, 'price', pr.miss || 'Price check failed (' + pr.err + ').');
      if (sales.find((s) => s.till === body.till && s.n === body.n)) return no(409, 'clash', 'Number clash — tell an owner.');
      const at = Math.abs(body.at - now()) > 12 * 3600000 ? now() : body.at;
      let day = R.sgtDate(at); const test = !R.day(day) ? false : !R.inHours(at); if (!R.day(day)) day = E.days[0].date;   // like staging TEST_OPEN
      const s = { id: body.id, till: body.till, n: body.n, day, at: body.at, sentAt: body.sentAt, receivedAt: now(), lines: JSON.parse(JSON.stringify(pr.lines)), prize: pr.prize, gross: pr.gross, disc: pr.disc, total: pr.total, cups: pr.cups, undone: !!body.undone, test };
      sales.push(s); till.lastSaleAt = now();
      return [200, { ok: true, code: code(s), saved: true, undone: s.undone, day: s.day, test: s.test }];
    }
    if (p === '/till/undo') {
      const s = sales.find((x) => x.id === body.id); if (!s) return no(404, 'not-found', "That sale isn't on the server.");
      if (s.till === t.who && s.undone) return [200, { ok: true }];
      if (s.till !== t.who || !undoOk(s)) return no(409, 'too-late', 'Too late to undo. Tell an owner.');
      s.undone = true; return [200, { ok: true }];
    }
  }
  if (method === 'POST' && p === '/admin/login') {
    if (!body.renew) count.logins++;
    const old = body.renew ? tokens.get(body.renew) : null;
    if (body.renew && !(old && old.kind === 'owner')) return no(401, 'login', 'Log in again.');
    if (!old && (busy || wrong.owner >= 5)) return no(429, 'busy', 'Too many wrong PINs. Wait 12 minutes.');
    const name = old ? old.who : body.pin === PIN.Kai ? 'Kai' : body.pin === PIN.Vin ? 'Vin' : null;
    if (!name) { wrong.owner++; return no(401, 'bad-pin', 'Wrong PIN.'); }
    const token = name + '.' + today() + '.' + crypto.randomBytes(12).toString('base64url'); tokens.set(token, { kind: 'owner', who: name, date: today() });
    return [200, { ok: true, token, name }];
  }
  if (p.startsWith('/admin/')) {
    const t = auth(req, 'owner'); if (!t) return no(401, 'login', 'Log in again.');
    if (method === 'GET' && p === '/admin/state') { const d = url.searchParams.get('day') || 'all'; if (d !== 'all' && !R.day(d)) return no(400, 'day'); const s = state(d); s.name = t.who; delete s._all; return [200, s]; }
    const why = String(body.why || '').trim();
    const row = (f) => { f.id = fixes.length + 1; f.req = body.req; f.by = t.who; f.madeAt = now(); fixes.push(f); return f; };
    if (method === 'POST' && p === '/admin/void') return once(body, () => {
      if (!["Didn't pay", 'Refunded in full', 'Test'].includes(why)) return no(400, 'why');
      const s = findCode(body.code); if (!s) return no(404, 'not-found', 'No order ' + body.code + '.');
      if (s.undone) return no(409, 'undone', body.code + ' was undone at the till.'); if (s.test) return no(409, 'test', body.code + ' is a test sale.');
      if (isVoided(s)) return no(409, 'voided', body.code + ' is voided.');
      if (adjOn(s)) return no(409, 'adjusted', 'Undo its adjustment first.');
      if (!s.test && dayTotal(s.day) - s.total < 0) return no(409, 'below-zero', 'That day would go below S$0.');
      row({ kind: 'void', till: s.till, n: s.n, day: s.day, amt: 0, why, undoes: null }); return [200, { ok: true }];
    });
    if (method === 'POST' && p === '/admin/restore') return once(body, () => {
      const s = findCode(body.code); if (!s) return no(404, 'not-found'); if (!isVoided(s)) return no(409, 'not-voided', 'Not voided.');
      if (!why || why.length > 80) return no(400, 'why', 'Say why (80 letters at most).');
      row({ kind: 'restore', till: s.till, n: s.n, day: s.day, amt: 0, why, undoes: null }); return [200, { ok: true }];
    });
    if (method === 'POST' && p === '/admin/adjust') return once(body, () => {
      const c = body.cents; if (!Number.isInteger(c) || c < 1 || c > 500000) return no(400, 'cents', 'S$0.01 to S$5,000.');
      if (!why || why.length > 80) return no(400, 'why', 'Say why (80 letters at most).');
      let day = body.day, s = null;
      if (body.code) {
        s = findCode(body.code); if (!s) return no(404, 'not-found', 'No order ' + body.code + '.');
        if (s.undone) return no(409, 'undone', body.code + ' was undone at the till.'); if (s.test) return no(409, 'test', body.code + ' is a test sale.');
        if (isVoided(s)) return no(409, 'voided', body.code + ' is voided.');
        day = s.day;
        if (body.dir === 'off' && c > s.total + adjOn(s)) return no(409, 'cap', 'At most ' + R.money(s.total + adjOn(s)) + ' off ' + body.code + '.');
      } else if (!R.day(day)) return no(400, 'day', 'Pick a day.');
      if (body.dir === 'off' && c > dayTotal(day)) return no(409, 'cap', 'At most ' + R.money(dayTotal(day)) + ' off on ' + R.day(day).label + '.');
      const f = row({ kind: 'adjust', till: s ? s.till : null, n: s ? s.n : null, day, amt: body.dir === 'off' ? -c : c, why, undoes: null });
      return [200, { ok: true, id: f.id }];
    });
    if (method === 'POST' && p === '/admin/undo') return once(body, () => {
      const a = fixes.find((f) => f.id === body.id && f.kind === 'adjust'); if (!a) return no(404, 'not-found', "That adjustment isn't there."); if (undoOf(a)) return no(409, 'undone', 'Already undone.');
      if (a.amt > 0 && dayTotal(a.day) - a.amt < 0) return no(409, 'below-zero', 'That day would go below S$0.');
      row({ kind: 'undo', till: null, n: null, day: a.day, amt: 0, why: 'undo', undoes: a.id }); return [200, { ok: true }];
    });
  }
  return no(404, 'route');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
  if (url.pathname.startsWith('/__stub/')) {
    let raw = ''; req.on('data', (c) => raw += c); req.on('end', () => {
      if (url.pathname === '/__stub/down') { try { down = !!JSON.parse(raw || '{}').down; } catch (e) { down = true; } }
      if (url.pathname === '/__stub/busy') { try { busy = !!JSON.parse(raw || '{}').on; } catch (e) { busy = true; } }
      if (url.pathname === '/__stub/broken') { try { broken = !!JSON.parse(raw || '{}').on; } catch (e) { broken = true; } }
      if (url.pathname === '/__stub/page500') { try { page500 = !!JSON.parse(raw || '{}').on; } catch (e) { page500 = true; } }
      if (url.pathname === '/__stub/expire') for (const t of tokens.values()) t.date = '2000-01-01';
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ ok: true, down, sales: sales.length, fixes, last: sales.slice(-5), all: sales.map((x) => ({ code: code(x), id: x.id, undone: x.undone })), count }));
    }); return;
  }
  const api = /^\/(till|admin)\/[a-z]/.test(url.pathname) && !/\.html$/.test(url.pathname);   // /admin/ and /admin/index.html are the page
  if (api && down) { req.socket.destroy(); return; }   // "no signal"
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (api && broken) { res.writeHead(503, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ ok: false, error: 'try-again', message: 'Something went wrong. Try again.', now: now() })); return; }
  if (!api) {   // the pages themselves, for the offline-shell check over http://localhost
    let f = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!f.startsWith(ROOT) || /(^|\/)\./.test(path.relative(ROOT, f))) { res.writeHead(404); res.end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    if (page500 && /\.html$/.test(f)) { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<h1>500 host error</h1>'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(res); return;
  }
  let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 16384) req.socket.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = null; }
    const [status, out] = body === null ? no(400, 'json') : route(req.method, url, body, req);
    console.log(req.method, url.pathname, status, out.error || '');
    out.now = now();   // every answer carries the server's clock
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(out));
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('event-till stub on http://localhost:' + PORT + ' (now ' + new Date(now()).toISOString() + ', ' + sales.length + ' seeded sales)'));
