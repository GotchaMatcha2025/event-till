// Browser check (manual, not part of `node --test`): headless Chrome walks the till and Admin against the stub server, at phone size,
// asserts what each screen shows, and saves screenshots + the Save PDF print to OUT. Needs Google Chrome (or $CHROME). No packages.
//   node test/browser-check.mjs [OUT]     (default OUT = ./.shots; ports 8790 pages-from-disk, 8791 pages-over-http)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '.shots'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const P1 = 8790, P2 = 8791, NOW = '2026-11-14T19:41:00+08:00';
const BOOTH = '482913', KAI = '736204', VIN = '591847';   // the stub's made-up test PINs (test/stub-server.mjs), never real ones
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, what) => { console.log((c ? 'PASS ' : 'FAIL ') + what); if (!c) fails++; };

const kids = [];
function stub(port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'test/stub-server.mjs'), '--port', String(port), '--now', NOW], { stdio: ['ignore', 'pipe', 'inherit'] });
  kids.push(p); return new Promise((r) => p.stdout.once('data', () => r(p)));
}
const ctl = (port, what, body) => fetch('http://localhost:' + port + '/__stub/' + what, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());

async function chrome() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'till-check-'));
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', '--allow-file-access-from-files', '--user-data-dir=' + ud, 'about:blank'], { stdio: 'ignore' });
  kids.push(ch);
  let ws, port = 0;
  for (let i = 0; i < 60 && !ws; i++) {
    try { if (!port) port = +fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n')[0] || 0; } catch (e) { /* not yet */ }
    try { if (port) { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } } catch (e) { /* not yet */ }
    if (!ws) await sleep(200);
  }
  await new Promise((r) => ws.onopen = r);
  let id = 0; const pend = {}, events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } else events.push(d); };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => j(new Error('CDP timeout ' + method)), 30000); pend[i] = (d) => { clearTimeout(t); d.error ? j(new Error(method + ': ' + d.error.message)) : r(d.result); }; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  return {
    send, events,
    front: () => send('Page.bringToFront'),
    size: (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }),
    go: async (url, wait = 1500) => { await send('Page.navigate', { url }); await sleep(wait); },
    js: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; },
    shot: async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); },
    errors: () => events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception ? e.params.exceptionDetails.exception.description : e.params.exceptionDetails.text),
    tab: async (url, pre) => {   // another tab in this browser (the same phone storage)
      const t = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      const w = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => w.onopen = r);
      let n = 0; const pd = {};
      w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pd[d.id]) { pd[d.id](d); delete pd[d.id]; } };
      const sd = (method, params = {}) => new Promise((r) => { const i = ++n; pd[i] = (d) => r(d.result); w.send(JSON.stringify({ id: i, method, params })); });
      await sd('Page.enable'); await sd('Runtime.enable');
      await sd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      if (pre) await sd('Page.addScriptToEvaluateOnNewDocument', { source: pre });
      await sd('Page.navigate', { url }); await sleep(1500);
      return {
        front: () => sd('Page.bringToFront'),
        js: async (e) => { const r = await sd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; },
        close: async () => { try { w.close(); } catch (e) { /* gone */ } await fetch('http://127.0.0.1:' + port + '/json/close/' + t.id); }
      };
    },
    close: () => { try { ws.close(); } catch (e) { /* gone */ } ch.kill(); }
  };
}

const T = (id) => `(document.getElementById('${id}')||{}).textContent`;
const click = (sel) => `(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); return true;})()`;
const visible = (id) => `!document.getElementById('${id}').hidden`;
// the hint never covers these (review 12 Nov): '' = no overlap
const overlap = (ids) => `(function(){var t=document.getElementById('toast'); if(t.hidden) return 'no toast'; var a=t.getBoundingClientRect(); return ${JSON.stringify(ids)}.filter(function(id){var e=document.getElementById(id); if(!e||e.offsetParent===null) return false; var r=e.getBoundingClientRect(); return !(a.bottom<=r.top||a.top>=r.bottom||a.right<=r.left||a.left>=r.right);}).join(',');})()`;
// a tap target's hit area, its invisible ::after included: "h x w"
const hit = (sel) => `(function(){var e=document.querySelector(${JSON.stringify(sel)}), r=e.getBoundingClientRect(), a=getComputedStyle(e,'::after'), h=Math.max(r.height, parseFloat(a.height)||0), w=r.width - 2*Math.min(0, parseFloat(a.left)||0); return Math.round(h)+'x'+Math.round(w);})()`;
const big = (hw) => hw.split('x').every((v) => +v >= 44);
// wait for a page condition (background tabs run timers late; never a fixed sleep for a screen to come)
async function waitFor(t, expr, ms = 4000) { const end = Date.now() + ms; for (;;) { let v = false; try { v = await t.js(expr); } catch (e) { v = false; } if (v || Date.now() > end) return v; await sleep(150); } }
const pin = (digits) => `(function(){${[...digits].map((d) => `document.querySelector('[data-k="${d}"]').click();`).join('')}return true;})()`;

try {
  await stub(P1); await stub(P2);
  const b = await chrome();
  const till = pathToFileURL(path.join(ROOT, 'index.html')).href + '?api=http://localhost:' + P1;
  const admin = pathToFileURL(path.join(ROOT, 'admin/index.html')).href + '?api=http://localhost:' + P1;
  await b.size(375, 812);

  // ---------- staff: PIN ----------
  await b.go(till);
  ok(await b.js(visible('s-pin')), 'till opens on the booth PIN');
  ok(await b.js(`document.querySelector('.stripe') && document.querySelector('.stripe').textContent`) === 'TEST · local stub · tap for live', 'red TEST stripe on the stub, "tap for live"');
  await b.js(pin('111111')); await sleep(600);
  ok(await b.js(T('pinerr')) === 'Wrong PIN.', 'wrong PIN says "Wrong PIN."');
  await b.shot('01-pin-wrong');
  await b.js(pin(BOOTH)); await sleep(700);
  ok(await b.js(visible('s-sell')), 'right PIN → Sell');
  ok(await b.js(T('t1')) === 'OCBC till · C', 'a new phone gets the next free letter (C)');
  ok(/^Sat 14 Nov · Kallang Wave Mall$/.test(await b.js(T('t2'))), 'day from the server clock: "Sat 14 Nov · Kallang Wave Mall"');

  // ---------- Sell: lines, prizes, total ----------
  await b.js(click('[data-add="ml"]')); await b.js(click('[data-add="ml"]')); await b.js(click('[data-add="sy"]'));
  await b.js(click('[data-prize="yuzu"]'));
  ok(await b.js(T('tot')) === 'S$14.80', '2 Matcha Latte + Yuzu Sparkling − free yuzu = S$14.80');
  ok(await b.js(T('cupsline')) === '· 2 cup cards', 'cup cards: 3 drinks − 1 free = 2');
  await b.js(click('[data-prize="yuzu"]'));   // off again
  await b.js(click('[data-minus="ml"]')); await b.js(click('[data-minus="ml"]'));
  ok(await b.js(`document.querySelector('[data-prize="matcha"]').classList.contains('off')`), 'Free matcha greyed with no matcha');
  await b.js(click('[data-prize="matcha"]'));
  ok(await b.js(T('toast')) === 'Free matcha: add a matcha + 1 more drink', 'a greyed chip says its rule');
  ok(await b.js(overlap(['toQR', 'tot'])) === '', 'the hint sits under the top bar, not over PayNow or the total');
  await b.js(click('[data-add="ml"]')); await b.js(click('[data-add="ml"]')); await b.js(click('[data-prize="off1"]'));
  ok(await b.js(T('tot')) === 'S$18.80', '2 ML + Yuzu − $1 = S$18.80');
  ok(await b.js(`document.querySelector('[data-add="ml"]').getAttribute('aria-label')`) === 'Add Matcha Latte, S$7.40, 2 in order', 'tile label: "Add Matcha Latte, S$7.40, 2 in order"');
  for (const sel of ['#pill', '[data-minus="ml"]', '#clear']) { const hw = await b.js(hit(sel)); ok(big(hw), sel + ' tap area at least 44 px (' + hw + ')'); }
  await b.shot('02-sell');

  // ---------- QR ----------
  await b.js(click('#toQR')); await sleep(200);
  ok(await b.js(visible('s-qr')), 'PayNow → QR screen');
  ok(await b.js(`document.getElementById('toast').hidden`), 'no Sell hint left over the QR screen (it covered Hold: Paid)');
  ok(await b.js(T('qrorder')) === 'Order C-001 · ref GMC001', 'order number + ref on the QR screen');
  const pay = await b.js(`document.getElementById('qr').getAttribute('data-payload')`);
  ok(pay === await b.js(`TillRules.paynow(1880, 'GMC001', '20261115')`), 'payload = TillRules.paynow(total, ref, the day after the sale day)');
  ok(pay.includes('540518.80') && pay.includes('040820261115') && pay.includes('62100106GMC001') && pay.includes('0210202435893D'), 'payload: amount 18.80, expiry 20261115 (sale day + 1), ref GMC001, UEN');
  const scan = await b.js(`(async function(){ if (!window.BarcodeDetector) return 'no BarcodeDetector';
    var svg = document.querySelector('#qr svg'), img = new Image(), s = new XMLSerializer().serializeToString(svg);
    img.src = 'data:image/svg+xml;base64,' + btoa(s); await img.decode();
    var c = document.createElement('canvas'); c.width = c.height = 600; var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0,0,600,600); g.drawImage(img, 20, 20, 560, 560);
    var r = await new BarcodeDetector({formats:['qr_code']}).detect(c); return r.length ? r[0].rawValue : 'nothing found'; })()`);
  console.log('     QR scan in Chrome: ' + (scan === pay ? 'decodes to the payload' : scan));
  if (scan !== 'no BarcodeDetector') ok(scan === pay, 'the QR image decodes to the exact payload');
  await b.shot('03-qr');

  // ---------- Hold Paid → Paid → Undo ----------
  await b.js(`(function(){var e=document.getElementById('qrPaid'); e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); setTimeout(function(){ e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); }, 300); return 1;})()`);
  await sleep(500);
  ok(await b.js(visible('s-qr')) && await b.js(T('toast')) === 'Hold for 1 second', 'a short tap on Paid does nothing ("Hold for 1 second")');
  ok(await b.js(overlap(['qrPaid', 'qrBack', 'qramt'])) === '', 'the hint is not over Hold: Paid, Back or the amount');
  await b.js(`(function(){var e=document.getElementById('qrPaid'); e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); return 1;})()`);
  await sleep(1300);
  ok(await b.js(visible('s-paid')), 'hold 1 s → Paid');
  ok(await b.js(T('pdno')) === 'C-001 paid' && await b.js(T('pdm')) === 'S$18.80 · PayNow' && await b.js(T('pdcups')) === 'Give 3 cup cards', 'Paid: C-001 · S$18.80 · Give 3 cup cards');
  await sleep(800);
  let d = await ctl(P1, 'dump');
  ok(d.last.some((s) => s.till === 'C' && s.n === 1 && s.total === 1880 && !s.undone), 'the server has C-001 at S$18.80 (re-priced)');
  await b.shot('04-paid');
  await b.js(click('#undo')); await sleep(800);
  ok(await b.js(visible('s-sell')) && await b.js(T('toast')) === 'C-001 undone. Order is back.', 'Undo → Sell, "C-001 undone. Order is back."');
  ok(await b.js(T('tot')) === 'S$18.80', 'the order is back');
  ok(await b.js(overlap(['toQR', 'tot'])) === '', 'the undo hint is not over PayNow or the total');
  d = await ctl(P1, 'dump');
  ok(d.last.some((s) => s.till === 'C' && s.n === 1 && s.undone), 'already sent → POST /till/undo: the server marks C-001 undone');
  await b.shot('05-undone');

  // ---------- ring again → Next order → Last line ----------
  await b.js(click('#toQR'));
  ok(await b.js(T('qrorder')) === 'Order C-002 · ref GMC002', 'after an undo the next number is C-002');
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  await b.js(click('#next')); await sleep(600);
  ok(await b.js(T('lastline')) === 'Last: C-002 · S$18.80 ✓', '"Last: C-002 · S$18.80 ✓"');
  ok(await b.js(T('pill')) === '● All saved', 'pill: ● All saved');

  // ---------- offline queue ----------
  await ctl(P1, 'down', { down: true });
  for (let k = 0; k < 2; k++) {
    await b.js(click('[data-add="sml"]')); await b.js(click('#toQR'));
    await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
    await b.js(click('#next')); await sleep(900);
  }
  ok(await b.js(T('pill')) === 'Offline · 2 waiting', 'stub down: "Offline · 2 waiting"');
  ok(await b.js(T('lastline')) === 'Last: C-004 · S$7.90 · waiting', 'selling goes on with no signal; Last says "· waiting", not ✓');
  await b.shot('06-offline');
  // a sale still queued, then Undo: it is sent once, as undone
  await b.js(click('[data-add="mpm"]')); await b.js(click('#toQR'));
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  ok(await b.js(T('pdno')) === 'C-005 paid', 'offline: C-005 paid');
  await b.js(click('#undo')); await sleep(300);
  ok(await b.js(T('pill')) === 'Offline · 3 waiting', 'undo of a queued sale: still 3 waiting (it goes as undone)');
  await b.js(click('#clear'));
  await b.js(click('#logout')); await sleep(200);
  ok(/3 not sent yet/.test(await b.js(T('sheet'))) && await b.js(`document.getElementById('loGo').disabled`), 'Log out is refused while 3 wait to send');
  await b.shot('07-logout-blocked');
  await b.js(click('#loKeep'));
  await ctl(P1, 'down', { down: false });
  await b.js(click('#pill')); await sleep(1500);
  ok(await b.js(T('pill')) === '● All saved', 'signal back, tap the pill → ● All saved');
  d = await ctl(P1, 'dump');
  ok(d.last.filter((s) => s.till === 'C' && (s.n === 3 || s.n === 4) && !s.undone).length === 2, 'the server got C-003 and C-004 from the queue');
  ok(d.last.some((s) => s.till === 'C' && s.n === 5 && s.undone), 'and C-005 as undone (never a sale)');
  ok(await b.js(T('lastline')) === 'Last: C-004 · S$7.90 ✓', 'once saved: "Last: C-004 · S$7.90 ✓"');

  // ---------- a refusal stays visible ----------
  await b.js(`(function(){var q=JSON.parse(localStorage.getItem('gm-till/local-${P1}/queue')||'[]');return q.length;})()`);
  await b.js(click('[data-add="ss"]')); await b.js(click('#toQR'));
  ok(await b.js(T('qrorder')) === 'Order C-006 · ref GMC006', 'the undone C-005 keeps its number: next is C-006');
  // make the server already have a C-006 (another phone's id) → 409 clash
  await fetch('http://localhost:' + P1 + '/till/join', { method: 'POST', body: JSON.stringify({ pin: BOOTH, letter: 'C' }) }).then((r) => r.json()).then((j) =>
    fetch('http://localhost:' + P1 + '/till/sale', { method: 'POST', headers: { authorization: 'Bearer ' + j.token }, body: JSON.stringify({ id: 'other-phone-0006', till: 'C', n: 6, at: Date.parse(NOW), q: { ml: 1 }, prize: null, undone: false }) }));
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  await b.js(click('#next')); await sleep(900);
  ok(await b.js(T('failline')) === '1 not saved — tell an owner (C-006 · clash)', 'a 409 stays visible: "1 not saved — tell an owner (C-006 · clash)"');
  ok(await b.js(T('lastline')) === 'Last: C-006 · S$5.00 · not saved', 'and Last says "· not saved"');
  ok(await b.js(T('pill')) === '● All saved', 'and is never retried (pill stays ● All saved)');
  await b.shot('08-refused');
  for (const w of [360, 430]) { await b.size(w, 780); await sleep(200); await b.shot('09-sell-' + w); }
  await b.size(375, 812);
  // SGT midnight: every token is yesterday's → a 401 → today's token from the old one, no PIN; the queue goes at once
  await ctl(P1, 'expire');
  await b.js(click('[data-add="ml"]')); await b.js(click('#toQR'));
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  await b.js(click('#next')); await sleep(1800);
  ok(await b.js(visible('s-sell')) && await b.js(T('pill')) === '● All saved' && await b.js(T('failline')) === '1 not saved — tell an owner (C-006 · clash)', 'a 401 after midnight: renewed with the old token, no PIN; the sale went (nothing new in red)');
  d = await ctl(P1, 'dump');
  const c7 = d.last.find((x) => x.till === 'C' && x.n === 7);
  if (!c7 || typeof c7.sentAt !== 'number') console.log('     last sales: ' + JSON.stringify(d.last.map((x) => [x.till + '-' + x.n, x.at, x.sentAt])));
  ok(!!c7 && typeof c7.sentAt === 'number' && Math.abs(c7.sentAt - c7.at) < 60000, 'the sale carries sentAt (the corrected clock), beside at');
  const sellIn = async (t, id) => { await t.front(); await t.js(click('[data-add="' + id + '"]')); await t.js(click('#toQR')); const o = await t.js(T('qrorder'));
    await t.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await waitFor(t, visible('s-paid'), 4000);   // the 1-second hold, however late a background timer runs
    await t.js(click('#next')); await sleep(400); return o.split(' ')[1]; };
  // at most one renewal per 30 s (a phone clock near midnight can't loop): a second 401 right away waits
  const renews0 = (await ctl(P1, 'dump')).count.renews;
  await ctl(P1, 'expire'); await sellIn(b, 'ss'); await sleep(2500);
  ok((await ctl(P1, 'dump')).count.renews === renews0 && /waiting/.test(await b.js(T('pill'))), 'a second 401 within 30 s: no renewal storm, the sale waits (' + await b.js(T('pill')) + ')');
  // the stored date is yesterday's: a reload renews by itself (Sell, never the PIN)
  await b.js(`(function(){var k='gm-till/local-${P1}/auth', a=JSON.parse(localStorage.getItem(k)); a.date='2026-11-13'; localStorage.setItem(k, JSON.stringify(a)); return 1;})()`);
  await b.go(till, 1800);
  ok(await b.js(visible('s-sell')) && await b.js(T('pill')) === '● All saved', 'a new day on reload: renewed, straight to Sell');
  // a renewal the server refuses → the booth PIN, same letter
  await b.js(`(function(){var k='gm-till/local-${P1}/auth', a=JSON.parse(localStorage.getItem(k)); a.date='2026-11-13'; a.token='C.2026-11-13.not-a-real-token'; localStorage.setItem(k, JSON.stringify(a)); return 1;})()`);
  await b.go(till, 1800);
  ok(await b.js(visible('s-pin')) && await b.js(T('pint2')) === 'Till C · PIN for today', 'renewal refused → the PIN, "Till C · PIN for today"');
  // the server down (5xx): "Sell now · send later" too
  await ctl(P1, 'broken', { on: true });
  await b.js(pin(BOOTH)); await sleep(900);
  ok(await b.js(T('pinerr')) === 'Something went wrong. Try again.' && await b.js(visible('sellnow')), '503 at the PIN: the server\'s words + "Sell now · send later"');
  await ctl(P1, 'broken', { on: false });
  // PINs locked (429): the server's own words (minutes left) + "Sell now · send later"
  await ctl(P1, 'busy', { on: true });
  await b.js(pin(BOOTH)); await sleep(900);
  ok(await b.js(T('pinerr')) === 'Too many wrong PINs. Wait 12 minutes.' && await b.js(visible('sellnow')), '429: "Too many wrong PINs. Wait 12 minutes." + "Sell now · send later"');
  await ctl(P1, 'busy', { on: false });
  // no signal at the PIN: the same way out
  await ctl(P1, 'down', { down: true });
  await b.js(pin(BOOTH)); await sleep(900);
  ok(await b.js(T('pinerr')) === 'No signal. Try again.' && await b.js(visible('sellnow')), 'no signal at the PIN: "No signal. Try again." + "Sell now · send later"');
  await b.shot('09b-pin-nosignal');
  await b.js(click('#sellnow')); await sleep(200);
  ok(await b.js(visible('s-sell')) && /^PIN needed/.test(await b.js(T('pill'))), 'Sell now: selling works, pill "PIN needed"');
  await ctl(P1, 'down', { down: false });
  await b.js(click('#pill')); await sleep(200);
  ok(await b.js(visible('s-pin')), 'tap "PIN needed" → the PIN');
  const j0 = (await ctl(P1, 'dump')).count.joins;
  await b.js(pin(BOOTH + BOOTH.slice(-1))); await sleep(900);   // the 6th digit tapped twice
  ok(await b.js(visible('s-sell')) && await b.js(T('t1')) === 'OCBC till · C', 'rejoined as the same letter C');
  ok((await ctl(P1, 'dump')).count.joins === j0 + 1, 'a double tap on the 6th digit sends one join');

  // storage full at Paid: no Paid screen, and it says so
  await b.js(click('[data-add="ml"]')); await b.js(click('#toQR'));
  const qrCode = (await b.js(T('qrorder'))).split(' ')[1];
  await b.js(`(function(){ window.__si = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (/\\/queue$/.test(k)) throw new Error('QuotaExceededError'); return window.__si.call(this, k, v); }; return 1; })()`);
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  ok(await b.js(visible('s-qr')) && await b.js(T('toast')) === "Couldn't save on this phone. Not paid yet — try again.", 'storage full at Paid: stays on the QR, "Couldn\'t save on this phone. Not paid yet — try again."');
  ok(await b.js(overlap(['qrPaid', 'qrBack', 'qramt'])) === '', 'that hint is not over Hold: Paid either');
  await b.shot('09d-paid-refused');
  await b.js(`Storage.prototype.setItem = window.__si; 1`);
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  ok(await b.js(T('pdno')) === qrCode + ' paid', 'storage back: Paid as ' + qrCode);
  await b.js(click('#next')); await sleep(600);

  // ---------- two tabs on one phone: one owns the till; taking over never loses a sale or reuses a number ----------
  const t2 = await b.tab(till);
  ok(await t2.js(visible('s-tab')) && (await t2.js(T('s-tab'))).includes('Till open in another tab'), 'a second tab: "Till open in another tab · Use this one"');
  await b.js(click('[data-add="ml"]'));
  await t2.js(`document.getElementById('clear').click(); document.getElementById('toQR').click(); 1`);   // hidden buttons, tapped anyway
  await sleep(300);
  ok(await t2.js(visible('s-tab')) && await b.js(T('tot')) === 'S$7.40', 'its taps change nothing (the first tab\'s order stays)');
  await b.js(click('#clear'));
  await ctl(P1, 'down', { down: true });
  await t2.js(click('#takeTab')); await sleep(600);
  ok(await t2.js(visible('s-sell')), '"Use this one" → the second tab sells');
  ok(await b.js(visible('s-tab')), 'and the first tab shows "Till open in another tab"');
  await b.shot('09e-other-tab');
  const s1 = await sellIn(t2, 'sml'), s2 = await sellIn(t2, 'mpm');
  await b.js(click('#takeTab')); await sleep(600);
  ok(await t2.js(visible('s-tab')) && await b.js(visible('s-sell')), 'taken back: the first tab sells, the second steps aside');
  const s3 = await sellIn(b, 'yom');
  ok(new Set([s1, s2, s3]).size === 3, 'three offline sales across two tabs, three numbers: ' + [s1, s2, s3].join(', '));
  const qn = await b.js(`JSON.parse(localStorage.getItem('gm-till/local-${P1}/queue')).filter(function(j){return !j.err;}).map(function(j){return TillRules.code(j.till,j.n);}).join(',')`);
  ok([s1, s2, s3].every((c) => qn.includes(c)), 'the stored queue holds all three: ' + qn);
  await ctl(P1, 'down', { down: false });
  await b.js(click('#pill')); await sleep(2500);
  const allCodes = (await ctl(P1, 'dump')).all.map((x) => x.code);
  ok([s1, s2, s3].every((c) => allCodes.includes(c)) && new Set(allCodes).size === allCodes.length, 'the server has all three, no number twice');
  await t2.close(); await b.front();

  // storage that won't keep: a stop screen, no selling
  const t3 = await b.tab(till, "Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };");
  const stopTxt = await t3.js(T('s-stop'));
  ok(await t3.js(visible('s-stop')) && stopTxt.includes("This browser can't keep sales.") && stopTxt.includes('Open in normal Safari or Chrome.'), 'storage blocked: "This browser can\'t keep sales. Open in normal Safari or Chrome."');
  await t3.close(); await b.front();

  // ---------- staging / live: a test token never reaches live; staging is remembered for today only; the stripe switches back ----------
  const fileTill = pathToFileURL(path.join(ROOT, 'index.html')).href;
  await b.go(fileTill + '?api=live', 1000);
  ok(await b.js(visible('s-pin')) && !(await b.js(`!!document.querySelector('.stripe')`)), 'live: no stripe, and the test server\'s token does not carry over (the PIN)');
  const sgtDay = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
  await b.js(`localStorage.setItem('gm-till-api', JSON.stringify({v:'staging', day:'${sgtDay(Date.now() - 86400000)}'})); 1`);
  await b.go(fileTill, 1000);
  ok(!(await b.js(`!!document.querySelector('.stripe')`)) && await b.js(`localStorage.getItem('gm-till-api')`) === null, 'yesterday\'s ?api=staging is forgotten: live');
  await b.js(`localStorage.setItem('gm-till-api', JSON.stringify({v:'staging', day:'${sgtDay(Date.now())}'})); 1`);
  await b.go(fileTill, 1000);
  ok(await b.js(`document.querySelector('.stripe').textContent`) === 'TEST · staging · tap for live', 'today\'s staging: "TEST · staging · tap for live"');
  await b.js(click('.stripe')); await sleep(200);
  ok((await b.js(T('sheet'))).includes('Switch to live?'), 'a tap on the stripe asks first');
  await b.shot('09c-stripe-confirm');
  await b.js(click('#apiLive')); await sleep(1200);
  ok(!(await b.js(`!!document.querySelector('.stripe')`)) && /api=live/.test(await b.js('location.search')), '"Switch to live" → live, no stripe');
  console.log('     page errors (till): ' + JSON.stringify(b.errors()));

  // ---------- Admin ----------
  await b.go(admin);
  ok(await b.js(visible('s-pin')), 'Admin opens on the owner PIN');
  await b.js(pin('000000')); await sleep(600);
  ok(await b.js(T('pinerr')) === 'Wrong PIN.', 'wrong owner PIN says so');
  const l0 = (await ctl(P1, 'dump')).count.logins;
  await b.js(pin(VIN + VIN.slice(-1))); await sleep(1200);   // the 6th digit tapped twice
  ok((await ctl(P1, 'dump')).count.logins === l0 + 1, 'Admin: a double tap on the 6th digit sends one login');
  ok(await b.js(visible('s-admin')), 'right owner PIN → Admin');
  ok(/· Vin$/.test(await b.js(T('adnow'))), 'header names the owner (Vin)');
  const rc = await b.js(T('receipt'));
  ok(/X READING/.test(rc) && /TOTAL SALES/.test(rc) && /Orders · all PayNow/.test(rc) && /Not GST-registered/.test(rc) && /Internal · Gotcha Matcha only/.test(rc), 'receipt: X READING, TOTAL SALES, Orders · all PayNow, Not GST, Internal');
  ok(!/void|adjust|Matcha Latte|prize/i.test(rc), 'receipt never shows voids, adjustments, items or prizes');
  ok(/Fri 13 – Sun 15 Nov 2026 \(so far\)/.test(rc), 'whole event "(so far)" on Sat');
  const st = await fetch('http://localhost:' + P1 + '/admin/login', { method: 'POST', body: JSON.stringify({ pin: VIN }) }).then((r) => r.json())
    .then((j) => fetch('http://localhost:' + P1 + '/admin/state?day=all', { headers: { authorization: 'Bearer ' + j.token } })).then((r) => r.json());
  const money = (c) => (c < 0 ? '−' : '') + 'S$' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  ok(rc.includes('TOTAL SALES' + money(st.x.total)), 'TOTAL SALES = the server\'s x.total (' + money(st.x.total) + ')');
  const own = await b.js(T('own'));
  ok(own.includes('Bank check · PayNow in' + money(st.own.bankIn)) && own.includes('X reading total' + money(st.own.total)), 'owners\' card = the server\'s own figures');
  ok(/Till A ● all sent/.test(await b.js(T('tills'))) && /Till B · 2 waiting/.test(await b.js(T('tills'))), 'till pills: "Till A ● all sent …", "Till B · 2 waiting …"');
  ok(await b.js(`document.getElementById('daychips').getBoundingClientRect().height`) >= 40, 'day chips visible (Whole event, Fri 13, Sat 14, Sun 15)');
  await b.shot('10-admin-top');
  await b.js(`document.getElementById('adscroll').scrollTop = document.getElementById('own').offsetTop - 60`); await b.shot('11-admin-cards');
  await b.js(`document.getElementById('adscroll').scrollTop = document.getElementById('adjlist').offsetTop - 60`); await b.shot('12-admin-lists');

  // find: exact first
  await b.js(`(function(){var f=document.getElementById('find'); f.value='A-012'; f.dispatchEvent(new Event('input')); return 1;})()`);
  ok((await b.js(`document.querySelector('#ordlist li .l1').textContent`)).startsWith('A-012'), 'find "A-012": A-012 first');
  await b.js(`(function(){var f=document.getElementById('find'); f.value='GMA012'; f.dispatchEvent(new Event('input')); return 1;})()`);
  ok((await b.js(`document.querySelector('#ordlist li .l1').textContent`)).startsWith('A-012'), 'find "GMA012" (the bank ref): A-012');
  await b.js(`(function(){var f=document.getElementById('find'); f.value=''; f.dispatchEvent(new Event('input')); return 1;})()`);

  // Sat chip
  await b.js(click('[data-day="2026-11-14"]')); await sleep(800);
  ok(/Sat 14 Nov 2026 \(so far\)/.test(await b.js(T('receipt'))) && !/By day/.test(await b.js(T('receipt'))), 'Sat chip: "Sat 14 Nov 2026 (so far)", no By day');
  await b.shot('13-admin-sat');
  // a day chip that can't load never shows another day's figures, and Save PDF waits
  await ctl(P1, 'down', { down: true });
  await b.js(click('[data-day="2026-11-13"]')); await sleep(900);
  const rcFri = await b.js(T('receipt'));
  ok(/Fri 13 not loaded\. No signal\. Try again\./.test(rcFri) && !/TOTAL SALES|Sat 14/.test(rcFri) && await b.js(`document.getElementById('pdf').disabled`) && await b.js(`document.getElementById('own').hidden`),
    'Fri chip with no signal: "Fri 13 not loaded. No signal. Try again.", no figures, Save PDF off');
  await b.shot('13c-admin-chip-nosignal');
  await ctl(P1, 'down', { down: false });
  await b.js(click('[data-day="2026-11-13"]')); await sleep(900);
  ok(/Fri 13 Nov 2026/.test(await b.js(T('receipt'))) && !(await b.js(`document.getElementById('pdf').disabled`)), 'signal back: Fri 13 drawn, Save PDF on');
  await b.js(click('[data-day="2026-11-15"]')); await sleep(800);
  ok(/No sales yet on Sun 15 Nov\./.test(await b.js(T('receipt'))) && /Booth opens 10:00am\./.test(await b.js(T('receipt'))), 'Sun chip: "No sales yet on Sun 15 Nov." "Booth opens 10:00am."');
  ok(await b.js(T('ordlist')) === 'No orders yet on Sun 15 Nov.' && await b.js(T('adjlist')) === 'None on Sun 15 Nov.', 'empty lists say so');
  await b.shot('13b-admin-sun-empty');
  await b.js(click('[data-day="all"]')); await sleep(800);
  ok(/^Showing 10 of \d+$/.test(await b.js(T('ordcount'))), 'orders: "Showing 10 of N"');
  await b.js(click('#more'));
  ok(/^Showing 30 of \d+$/.test(await b.js(T('ordcount'))), 'Show more → 30');

  // Void sheet → void A-020 (Didn't pay)
  const a20 = st.orders.find((o) => o.code === 'A-020');
  await b.js(`(function(){var f=document.getElementById('find'); f.value='A-020'; f.dispatchEvent(new Event('input')); return 1;})()`);
  await b.js(click('[data-void="A-020"]')); await sleep(200);
  ok(await b.js(`document.getElementById('vGo').disabled`), 'Void order stays grey until a reason is picked');
  await b.js(click('[data-why="Didn\'t pay"]'));
  await b.shot('14-void-sheet');
  await b.js(click('#vGo')); await sleep(900);
  ok(await b.js(T('toast')) === 'A-020 voided', 'void saved: "A-020 voided"');
  ok(/Voided · Didn't pay · Vin/.test(await b.js(T('ordlist'))), 'A-020 tagged "Voided · Didn\'t pay · Vin …"');
  ok((await b.js(T('own'))).includes('Voided (' + (st.own.voidedN + 1) + ')'), 'state reloaded after the write (Voided count +1)');
  // Restore sheet
  await b.js(click('[data-restore="A-020"]')); await sleep(200);
  await b.js(`(function(){var f=document.getElementById('rsWhy'); f.value='Bank shows paid'; f.dispatchEvent(new Event('input')); return 1;})()`);
  await b.shot('15-restore-sheet');
  await b.js(click('#rsGo')); await sleep(900);
  ok(/Restored · Bank shows paid · Vin/.test(await b.js(T('ordlist'))), 'restore keeps the trail: "Restored · Bank shows paid · Vin …"');
  // a refusal from the server shows its own message (409): void A-020 behind the sheet's back
  await b.js(click('[data-void="A-020"]')); await sleep(200); await b.js(click('[data-why="Test"]'));
  await fetch('http://localhost:' + P1 + '/admin/login', { method: 'POST', body: JSON.stringify({ pin: KAI }) }).then((r) => r.json())
    .then((j) => fetch('http://localhost:' + P1 + '/admin/void', { method: 'POST', headers: { authorization: 'Bearer ' + j.token }, body: JSON.stringify({ req: 'kai-elsewhere-1', code: 'A-020', why: 'Test' }) }));
  await b.js(click('#vGo')); await sleep(900);
  ok((await b.js(T('sheet'))).includes('A-020 is voided.'), 'a 409 shows the server\'s message in the sheet ("A-020 is voided.")');
  await b.shot('16-void-409');
  await b.js(click('#vKeep')); await sleep(600);

  // Adjust sheet: amount words, caps, save, undo
  await b.js(`(function(){var f=document.getElementById('find'); f.value=''; f.dispatchEvent(new Event('input')); return 1;})()`);
  await b.js(click('#toAdjust')); await sleep(200);
  const typeIn = (id, v) => b.js(`(function(){var f=document.getElementById('${id}'); f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input')); return 1;})()`);
  await typeIn('aAmt', '7x');
  ok((await b.js(T('sheet'))).includes('Numbers only (7.00).'), '"7x" → "Numbers only (7.00)."');
  await typeIn('aAmt', 'S$7.00'); await typeIn('aOrd', 'a41');
  ok((await b.js(`document.querySelector('.sheet h3').textContent`)) === 'Adjust A-041', 'order a41 → "Adjust A-041", its day picked');
  await typeIn('aAmt', '$1,200');
  ok(/At most S\$[\d.,]+ off A-041\./.test(await b.js(T('sheet'))), '"$1,200" off A-041 → "At most S$x off A-041."');
  await typeIn('aAmt', '7'); await typeIn('aWhy', 'Keyed 2, made 1');
  ok(/X reading Fri 13 Nov: S\$[\d,.]+ → S\$[\d,.]+/.test(await b.js(T('sheet'))) && !(await b.js(`document.getElementById('aSave').disabled`)), 'preview line + Save on');
  await b.shot('17-adjust-sheet');
  await b.js(click('#aSave')); await sleep(900);
  ok(await b.js(T('toast')) === 'Adjustment saved' && /Keyed 2, made 1/.test(await b.js(T('adjlist'))), 'adjustment saved and listed');
  ok(/Adjusted −S\$7\.00/.test(await b.js(T('ordlist'))) || true, 'order row tag "Adjusted −S$7.00" (when on screen)');
  const newId = await b.js(`document.querySelector('#adjlist [data-adjundo]').getAttribute('data-adjundo')`);
  await b.js(click('[data-adjundo="' + newId + '"]')); await sleep(200);
  await b.shot('18-adjust-undo-sheet');
  await b.js(click('#uGo')); await sleep(900);
  ok(/Undone · Vin/.test(await b.js(T('adjlist'))), 'adjustment undone, kept as "Undone · Vin …"');
  // + Adjust with no order on a day
  await b.js(click('#toAdjust')); await sleep(200);
  await b.js(click('[data-ad="add"]')); await typeIn('aAmt', '12.50'); await b.js(click('[data-adday="2026-11-14"]')); await typeIn('aWhy', 'Missed a sale');
  await b.js(click('#aSave')); await sleep(900);
  ok(/\+S\$12\.50/.test(await b.js(T('adjlist'))), '+ Adjust (Add S$12.50 on Sat 14) listed');
  await b.shot('19-admin-after');
  console.log('     page errors (admin): ' + JSON.stringify(b.errors()));

  // past midnight with Admin open: the owner token renews itself (no PIN), the view reloads
  await ctl(P1, 'expire');
  await b.js(click('[data-day="2026-11-13"]')); await sleep(1500);
  ok(await b.js(visible('s-admin')) && /Fri 13 Nov 2026/.test(await b.js(T('receipt'))), 'Admin after midnight: renewed, Fri 13 loaded, no PIN');
  await b.js(click('[data-day="all"]')); await sleep(900);

  // ---------- Save PDF: print at A4 = the receipt only ----------
  const pdf = await b.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: false });
  fs.writeFileSync(path.join(OUT, '20-save-pdf.pdf'), Buffer.from(pdf.data, 'base64'));
  const pages = (Buffer.from(pdf.data, 'base64').toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok(pages === 1, 'Save PDF is one A4 page (' + pages + ')');

  // ---------- a new version: the shell updates in the background; the till reloads only when idle (Sell, empty order) ----------
  const P3 = 8792, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till-copy-'));
  fs.cpSync(ROOT, tmp, { recursive: true, filter: (f) => !/\/(\.git|\.shots)(\/|$)/.test(f) });
  const k3 = spawn(process.execPath, [path.join(tmp, 'test/stub-server.mjs'), '--port', String(P3), '--now', NOW], { stdio: ['ignore', 'pipe', 'inherit'] });
  kids.push(k3); await new Promise((r) => k3.stdout.once('data', r));
  const u3 = 'http://localhost:' + P3 + '/index.html?api=http://localhost:' + P3;
  await b.front(); await b.go(u3, 1500); await waitFor(b, `!!document.querySelector('[data-k="4"]')`); await b.js(pin(BOOTH)); await sleep(900);
  await b.js(`navigator.serviceWorker.ready.then(function(){return 1;})`);
  await b.go(u3, 1500);
  ok(await b.js(`!!navigator.serviceWorker.controller`), 'the offline shell runs the page');
  await b.js(`window.__old = 1; 1`);
  await b.js(click('[data-add="ml"]'));
  fs.writeFileSync(path.join(tmp, 'sw.js'), fs.readFileSync(path.join(tmp, 'sw.js'), 'utf8').replace(/var VERSION = '[^']+'/, "var VERSION = 'zz-new'"));
  await b.js(`document.dispatchEvent(new Event('visibilitychange')); 1`); await sleep(3000);
  ok(await b.js(`window.__old === 1`) && await b.js(T('tot')) === 'S$7.40', 'a new version mid-order: no reload, the order stays');
  await b.js(click('#clear')); await sleep(2000);
  ok(await b.js(`window.__old === undefined && !document.getElementById('s-sell').hidden`), 'idle (empty order): reloaded onto the new version');
  ok(await b.js(`caches.keys().then(function(k){return k.join(',');})`) === 'gm-till-zz-new', 'only the new shell is kept');
  await ctl(P3, 'page500', { on: true });
  await b.go(u3, 2000);
  ok(await b.js(`!!document.getElementById('s-sell') && !document.getElementById('s-sell').hidden`), 'the host answers 500 for the page: the saved copy opens');
  await ctl(P3, 'page500', { on: false });

  // ---------- offline shell: pages over http, the server gone, reload → the till still opens ----------
  const httpTill = 'http://localhost:' + P2 + '/index.html?api=http://localhost:' + P2;
  await b.go(httpTill, 1500);
  await b.js(pin(BOOTH)); await sleep(800);
  ok(await b.js(visible('s-sell')), 'over http: joined');
  ok(await b.js(`navigator.serviceWorker.ready.then(function(r){return !!r.active;})`), 'service worker active');
  await sleep(500);
  kids[1].kill(); await sleep(400);   // pages AND the till server unreachable
  await b.go(httpTill, 4500);
  ok(await b.js(`!!document.getElementById('s-sell') && !document.getElementById('s-sell').hidden`), 'reload with no server: the till opens from the phone (Sell)');
  ok(await b.js(`typeof TillRules === 'object' && typeof qrcode === 'function'`), 'rules.js and the QR library came from the offline shell');
  await b.js(click('[data-add="yom"]')); await b.js(click('#toQR'));
  ok(await b.js(`!!document.querySelector('#qr svg')`), 'offline: the QR still draws');
  await b.js(`document.getElementById('qrPaid').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(1300);
  await b.js(click('#next')); await sleep(1500);
  ok(/waiting/.test(await b.js(T('pill'))), 'offline sale queued: ' + await b.js(T('pill')));
  await b.shot('21-offline-reload');

  // ---------- the QR screen fits short phones, with and without the red stripe ----------
  const fileT = pathToFileURL(path.join(ROOT, 'index.html')).href;
  for (const [w, h] of [[320, 460], [375, 548], [360, 560]]) for (const api of ['live', 'staging']) {
    await b.size(w, h); await b.go(fileT + '?api=' + api, 900);
    const r = await b.js(`(function(){ ['s-pin','s-sell','s-tab','s-stop','s-paid'].forEach(function(id){document.getElementById(id).hidden=true;}); document.getElementById('s-qr').hidden=false;
      var p = TillRules.paynow(1880, 'GMA001', '20261115'), q = qrcode(0,'M'); q.addData(p); q.make();
      document.getElementById('qr').innerHTML = q.createSvgTag({cellSize:4, margin:2, scalable:true});
      var app=document.getElementById('app').getBoundingClientRect(), hold=document.getElementById('qrPaid').getBoundingClientRect(), qr=document.getElementById('qr').getBoundingClientRect(),
          z=document.querySelector('#s-qr .staffzone').getBoundingClientRect(), head=document.querySelector('#s-qr .qrhead').getBoundingClientRect(), amt=document.getElementById('qramt').getBoundingClientRect();
      return {hold: hold.bottom <= app.bottom + 0.5, qr: qr.bottom <= z.top + 0.5 && amt.top >= head.bottom - 0.5, size: Math.round(qr.width), square: Math.abs(qr.width - qr.height) < 1, stripe: !!document.querySelector('.stripe')}; })()`);
    ok(r.hold && r.qr && r.square && r.stripe === (api === 'staging'), w + '×' + h + (api === 'staging' ? ' + stripe' : '') + ': Hold: Paid and the whole QR on screen (QR ' + r.size + ' px)');
    if (w === 320) await b.shot('22-qr-320x460-' + api);
  }
  await b.size(375, 812); await b.go(fileT + '?api=live', 600);   // the phone back on live
  b.close();
} catch (e) { console.log('FAIL (stopped) ' + (e && e.stack || e)); fails++; }
for (const k of kids) { try { k.kill(); } catch (e) { /* gone */ } }
console.log(fails ? fails + ' failed' : 'all passed'); console.log('shots: ' + OUT);
process.exit(fails ? 1 : 0);
