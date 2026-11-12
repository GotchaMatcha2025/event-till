// The offline shell's fingerprint: sha256 over every file sw.js caches. sw.js keeps it as SHELL_HASH {vh, sha}, vh = a short hash of the
// VERSION it was made for (not the VERSION text, which a find-and-replace of the version would change too). The tests fail when a shell
// file changed and SHELL_HASH was not renewed; this tool refuses to renew it without a new VERSION (so phones update).
//   node test/shell-hash.mjs           → prints the stored and the current hash
//   node test/shell-hash.mjs --write   → stores the current hash (only after VERSION and the pages' ?v= went up)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export function readSw(root = ROOT) {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const version = (/var VERSION = '([^']+)'/.exec(sw) || [])[1];
  const shell = JSON.parse(((/var SHELL = (\[[\s\S]*?\]);/.exec(sw) || [])[1] || '[]').replace(/'/g, '"'));
  const m = /var SHELL_HASH = \{ vh: '([^']*)', sha: '([^']*)' \};/.exec(sw);
  return { sw, version, shell, stored: m ? { vh: m[1], sha: m[2] } : null };
}
export const vh = (version) => crypto.createHash('sha256').update('gm-till ' + version).digest('hex').slice(0, 12);
export function fileOf(u) { return u.replace(/^\.\//, '').replace(/\?.*$/, '').replace(/(^|\/)$/, '$1index.html'); }
export function shellHash(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of [...new Set(readSw(root).shell.map(fileOf))].sort()) { h.update(f + '\0'); h.update(fs.readFileSync(path.join(root, f))); h.update('\0'); }
  return h.digest('hex');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { sw, version, stored } = readSw(), sha = shellHash();
  console.log('VERSION ' + version + ' · stored ' + JSON.stringify(stored) + ' · current ' + sha);
  if (process.argv.includes('--write')) {
    if (stored && stored.sha && stored.sha !== sha && stored.vh === vh(version)) { console.error('Shell files changed: raise VERSION in sw.js and ?v= on both pages first.'); process.exit(1); }
    fs.writeFileSync(path.join(ROOT, 'sw.js'), sw.replace(/var SHELL_HASH = \{ v[h]?: '[^']*', sha: '[^']*' \};/, "var SHELL_HASH = { vh: '" + vh(version) + "', sha: '" + sha + "' };"));
    console.log('stored.');
  }
}
