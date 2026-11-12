/* Gotcha Matcha event till — the event's settings and money rules, shared word for word by the page
   (github.com/GotchaMatcha2025/event-till, assets/rules.js) and the server (event-till-server, src/rules.js).
   The two copies must stay identical: the server's tests compare them byte for byte. Change the page copy, then copy it over.
   Plain script: it puts one object, TillRules, on the global object (a <script> tag in the page; `import './rules.js'` in the Worker).
   Money is always whole cents (integers). A new event = a new EVENT block below; the code stays the same. */
(function (root) {
  'use strict';

  // ---------- the event (OCBC Arena pop-up, owner's menu 12 Nov 2026 ~12:45; DECISIONS) ----------
  var EVENT = {
    id: 'ocbc-2026-11',
    name: 'OCBC till',
    company: { name: 'GOTCHA MATCHA PTE LTD', uen: '202435893D', city: 'Singapore' },
    booth: 'Kallang Wave Mall (OCBC Arena)',
    refPrefix: 'GM',                       // PayNow bill reference = GM + till letter + number (GMA132)
    gstRegistered: false,
    // SGT dates and booth hours ("HH:MM", 24 h)
    days: [
      { date: '2026-11-13', short: 'Fri 13', label: 'Fri 13 Nov', open: '15:00', close: '22:00' },
      { date: '2026-11-14', short: 'Sat 14', label: 'Sat 14 Nov', open: '10:00', close: '22:00' },
      { date: '2026-11-15', short: 'Sun 15', label: 'Sun 15 Nov', open: '10:00', close: '18:00' }
    ],
    // p = price in cents; cups = how many drinks it is (cup cards were dropped 13 Nov; the name stays); types: what it counts as
    menu: [
      { id: 'ml',  name: 'Matcha Latte',                    p: 740,  cups: 1, types: ['matcha'] },
      { id: 'sml', name: 'Strawberry Matcha Latte',         p: 790,  cups: 1, types: ['matcha'] },
      { id: 'mpm', name: 'Mango Peach Matcha Latte',        p: 790,  cups: 1, types: ['matcha'] },
      { id: 'yom', name: 'Yuzu Oolong Matcha',              p: 600,  cups: 1, types: ['matcha'] },
      { id: 'sy',  name: 'Yuzu Oolong Sparkling Tea',       p: 500,  cups: 1, types: ['yuzu'] },
      { id: 'ss',  name: 'Strawberry Oolong Sparkling Tea', p: 500,  cups: 1, types: ['sparkling'] },
      // 3 for $16 = Matcha Latte + Strawberry Matcha Latte + a sparkling tea; one tile per sparkling so item counts stay right
      { id: 't3y', name: '3 for $16', sub: 'with Yuzu sparkling',       full: '3 for $16 · Yuzu',       p: 1600, cups: 3, types: ['matcha', 'trio'] },
      { id: 't3s', name: '3 for $16', sub: 'with Strawberry sparkling', full: '3 for $16 · Strawberry', p: 1600, cups: 3, types: ['matcha', 'trio'] },
      { id: 'oat', name: 'Oat milk',  sub: '+ per latte',               p: 100,  cups: 0, types: ['addon'] }
    ],
    // Shootout prizes (owner 13 Nov ~05:22, till answers in DECISIONS 13 Nov). One per order; the customer's voucher turns USED first.
    // free: that sparkling is a 3rd drink, free, on top of 2 paid drinks (a 3 for $16 = 3 drinks; oat milk is not a drink).
    // pct: % off the whole order (oat milk and a 3 for $16 included), rounded to the nearest cent, with 3+ drinks.
    // set: one "3 for $16" set at that price.
    prizes: [
      { id: 'fy',   label: 'Free Yuzu sparkling',       kind: 'free', item: 'sy', paid: 2, miss: 'Free Yuzu: add a Yuzu sparkling + 2 drinks' },
      { id: 'fs',   label: 'Free Strawberry sparkling', kind: 'free', item: 'ss', paid: 2, miss: 'Free Strawberry: add a Strawberry sparkling + 2 drinks' },
      { id: 'p10',  label: '10% off',                   kind: 'pct',  pct: 10,    min: 3,  miss: '10% off: needs 3 drinks' },
      { id: 'b149', label: '3 for $14.90',              kind: 'set',  price: 1490,         miss: '3 for $14.90: add a 3 for $16' }
    ],
    maxOrderCents: 50000,                  // S$500: a bigger order is a typo
    maxQty: 50
  };

  // ---------- helpers ----------
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function item(id) { for (var i = 0; i < EVENT.menu.length; i++) if (EVENT.menu[i].id === id) return EVENT.menu[i]; return null; }
  function prize(id) { for (var i = 0; i < EVENT.prizes.length; i++) if (EVENT.prizes[i].id === id) return EVENT.prizes[i]; return null; }
  function has(m, t) { return m.types.indexOf(t) >= 0; }
  // 1234 → "S$12.34"; −700 → "−S$7.00"
  function money(c) {
    var s = (Math.abs(c) / 100).toFixed(2).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (c < 0 ? '−' : '') + 'S$' + s.join('.');
  }
  var SGT = 8 * 3600 * 1000;
  // ms → "2026-11-13" (Singapore date)
  function sgtDate(ms) { var d = new Date(ms + SGT); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2); }
  // ms → minutes since SGT midnight
  function sgtMin(ms) { var d = new Date(ms + SGT); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  function day(date) { for (var i = 0; i < EVENT.days.length; i++) if (EVENT.days[i].date === date) return EVENT.days[i]; return null; }
  function hhmm(s) { var p = s.split(':'); return +p[0] * 60 + +p[1]; }
  // inside booth hours (with 60 min slack each side for set-up and late customers)
  function inHours(ms) { var d = day(sgtDate(ms)); if (!d) return false; var m = sgtMin(ms); return m >= hhmm(d.open) - 60 && m <= hhmm(d.close) + 60; }
  function ref(till, n) { return EVENT.refPrefix + till + pad(n, 3); }   // GMA132
  function code(till, n) { return till + '-' + pad(n, 3); }               // A-132

  // ---------- an order ----------
  // q = {itemId: quantity}. Returns {ok, lines:[{id,q,p}], gross, disc, total, cups, prize} or {ok:false, err}.
  // Prices always come from EVENT.menu (the server never trusts the page's prices).
  function price(q, prizeId) {
    var lines = [], gross = 0, cups = 0, drinks = 0, sets = 0, n = 0;
    if (!q || typeof q !== 'object') return { ok: false, err: 'empty' };
    for (var i = 0; i < EVENT.menu.length; i++) {
      var m = EVENT.menu[i], k = q[m.id];
      if (k === undefined || k === 0) continue;
      if (typeof k !== 'number' || k !== Math.floor(k) || k < 0 || k > EVENT.maxQty) return { ok: false, err: 'qty' };
      lines.push({ id: m.id, q: k, p: m.p });
      gross += m.p * k; cups += m.cups * k; drinks += m.cups * k; n += k;
      if (has(m, 'trio')) sets += k;
    }
    for (var key in q) if (Object.prototype.hasOwnProperty.call(q, key) && !item(key)) return { ok: false, err: 'item' };
    if (!drinks) return { ok: false, err: 'empty' };          // oat milk alone is not an order
    var disc = 0, pz = null;
    if (prizeId) {
      pz = prize(prizeId);
      if (!pz) return { ok: false, err: 'prize' };
      if (pz.kind === 'free') disc = ((q[pz.item] || 0) >= 1 && drinks - 1 >= pz.paid) ? item(pz.item).p : 0;
      else if (pz.kind === 'pct') disc = drinks >= pz.min ? Math.round(gross * pz.pct / 100) : 0;
      else if (pz.kind === 'set') disc = sets >= 1 ? item('t3y').p - pz.price : 0;
      if (!disc) return { ok: false, err: 'prize-rule', miss: pz.miss || 'Add a drink first' };
    }
    var total = gross - disc;
    if (total <= 0) return { ok: false, err: 'zero' };
    if (total > EVENT.maxOrderCents) return { ok: false, err: 'too-big' };
    return { ok: true, lines: lines, gross: gross, disc: disc, total: total, cups: cups, prize: pz ? pz.id : null };
  }
  // can this prize go on this order? (for greying out chips)
  function prizeFits(q, prizeId) { return price(q, prizeId).ok; }

  // ---------- PayNow dynamic QR (EMVCo merchant-presented, SGQR PayNow template; proven by a bank-app scan 12 Nov 2026) ----------
  function tlv(id, v) { return id + pad(v.length, 2) + v; }
  function crc16(s) { // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF
    var crc = 0xFFFF;
    for (var i = 0; i < s.length; i++) {
      crc ^= s.charCodeAt(i) << 8;
      for (var j = 0; j < 8; j++) { crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1); crc &= 0xFFFF; }
    }
    return pad(crc.toString(16).toUpperCase(), 4);
  }
  // cents > 0, ref ≤ 25 chars, expiry "YYYYMMDD" (the sale day). Amount not editable (03 = 0).
  function paynow(cents, refText, expiry) {
    if (!(cents > 0) || cents !== Math.floor(cents)) throw new Error('PayNow amount must be whole cents above 0');
    var acct = tlv('00', 'SG.PAYNOW') + tlv('01', '2') + tlv('02', EVENT.company.uen) + tlv('03', '0') + tlv('04', expiry);
    var s = tlv('00', '01') + tlv('01', '12') + tlv('26', acct) + tlv('52', '0000') + tlv('53', '702') +
            tlv('54', (cents / 100).toFixed(2)) + tlv('58', 'SG') + tlv('59', EVENT.company.name) + tlv('60', EVENT.company.city) +
            tlv('62', tlv('01', refText)) + '6304';
    return s + crc16(s);
  }

  root.TillRules = {
    EVENT: EVENT, pad: pad, item: item, prize: prize, money: money, sgtDate: sgtDate, sgtMin: sgtMin, day: day, inHours: inHours,
    ref: ref, code: code, price: price, prizeFits: prizeFits, crc16: crc16, paynow: paynow
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
