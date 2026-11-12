// Repo checks: the shared rules copy, the vendored files, the offline app shell (sw.js) and the cache-busting tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// the shared copy and the server's copy, wherever they sit next to this repo (SHARED_RULES= adds another); none found = skipped, said so
const COPIES = [process.env.SHARED_RULES, path.join(ROOT, '..', 'shared', 'rules.js'), path.join(ROOT, '..', 'event-till-server', 'src', 'rules.js')]
  .filter((f) => f && fs.existsSync(f));
test('assets/rules.js is byte-identical to the shared / server rules.js', { skip: !COPIES.length && 'no other copy next to this repo' }, () => {
  for (const f of COPIES) assert.ok(Buffer.compare(fs.readFileSync(path.join(ROOT, 'assets/rules.js')), fs.readFileSync(f)) === 0, 'assets/rules.js differs from ' + f);
});

function sums(file) {
  for (const line of read(file).trim().split('\n')) {
    const [want, f] = line.split(/\s+/);
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    assert.equal(got, want, f + ' changed (vendored files stay unmodified)');
  }
}
test('the vendored QR library matches its SHA256SUMS', () => sums('assets/vendor/qrcode-generator-1.4.4/SHA256SUMS'));
test('the vendored fonts match their SHA256SUMS', () => sums('assets/fonts/SHA256SUMS'));

const SW = read('sw.js');
const VERSION = (/var VERSION = '([^']+)'/.exec(SW) || [])[1];
const SHELL = JSON.parse(((/var SHELL = (\[[\s\S]*?\]);/.exec(SW) || [])[1] || 'null').replace(/'/g, '"'));
test('sw.js has a version and a shell list', () => {
  assert.ok(VERSION, 'VERSION constant'); assert.ok(Array.isArray(SHELL) && SHELL.length > 5, 'SHELL list');
});
test('a shell file changed → a new VERSION (SHELL_HASH in sw.js; renew with node test/shell-hash.mjs --write)', async () => {
  const { readSw, shellHash } = await import('./shell-hash.mjs');
  const { version, stored } = readSw();
  assert.ok(stored, 'sw.js has SHELL_HASH');
  assert.equal(stored.v, VERSION, 'SHELL_HASH was made for another VERSION: run node test/shell-hash.mjs --write');
  assert.equal(stored.sha, shellHash(), 'a shell file changed: raise VERSION in sw.js + ?v= on both pages, then node test/shell-hash.mjs --write');
  assert.equal(version, VERSION);
});
test('every file sw.js caches exists', () => {
  for (const u of SHELL) {
    const f = u.replace(/^\.\//, '').replace(/\?.*$/, '').replace(/(^|\/)$/, '$1index.html');
    assert.ok(fs.existsSync(path.join(ROOT, f)), u + ' → ' + f + ' is missing');
  }
});

// every local file a page loads: in the shell (so a reload with no signal opens it) and on the sw.js VERSION (so a deploy reaches phones)
for (const page of ['index.html', 'admin/index.html']) {
  test(page + ': every local script / style / font is in the shell, with ?v=' + VERSION, () => {
    const html = read(page), dir = path.posix.dirname(page);
    const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|mailto:)/.test(u));
    assert.ok(refs.length >= 5, 'found the page\'s files');
    for (const u of refs) {
      if (/\.(html)$|\/$/.test(u.replace(/\?.*$/, ''))) continue;   // links to the other page
      const fromRoot = './' + path.posix.normalize(path.posix.join(dir, u));
      if (/sw\.js/.test(u)) continue;
      assert.ok(SHELL.includes(fromRoot), fromRoot + ' (from ' + page + ') is not in the sw.js shell');
      assert.match(u, new RegExp('\\?v=' + VERSION + '$'), u + ' should end ?v=' + VERSION);
    }
    for (const f of [...read('assets/till.css').matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, ''))) {
      assert.ok(SHELL.includes('./' + path.posix.normalize(path.posix.join('assets', f))), f + ' (till.css) is not in the shell');
    }
  });
}
test('pages: no CDN or outside script at run time; plain ES5 in our own scripts', () => {
  for (const page of ['index.html', 'admin/index.html']) assert.doesNotMatch(read(page), /<(script|link)[^>]+(src|href)="https?:/i, page);
  for (const f of ['assets/core.js', 'assets/api.js', 'assets/till.js', 'assets/admin.js', 'sw.js']) {
    const src = read(f).replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // strings first: 'https://…' is not a comment
    assert.doesNotMatch(src, /\b(let|const|class)\s|=>|`/, f + ' must stay ES5 (var / function)');
  }
});
