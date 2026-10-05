import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

execFileSync('node', ['scripts/build.mjs'], { stdio: 'pipe' });
const read = (p) => readFileSync(`dist/${p}`, 'utf8');
const html = read('index.html');
const swSrc = read('sw.js');
const precache = JSON.parse(swSrc.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
const BUILD = swSrc.match(/const BUILD = '(\w+)'/)[1];

test('index.html: hashed assets exist, no third parties, no inline code', () => {
  const css = html.match(/href="(assets\/app-[0-9a-f]{10}\.css)"/)?.[1];
  const js = html.match(/src="(assets\/app-[0-9a-f]{10}\.js)"/)?.[1];
  assert.ok(css && existsSync(`dist/${css}`) && js && existsSync(`dist/${js}`));
  assert.doesNotMatch(html, /googleapis|gstatic|https?:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(html, /\sstyle=|<script(?![^>]*\bsrc=)|\son\w+=/);
  assert.match(html, new RegExp(`<meta name="wsd-build" content="${BUILD}"`));
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(read(css), /\.\.\/fonts\//);
  assert.match(read(css), /url\(fonts\/jetbrains-mono-cyrillic-400-normal\.woff2\)/);
});
test('service worker: placeholders replaced and every precached file exists', () => {
  assert.doesNotMatch(swSrc, /__BUILD__|__PRECACHE__/);
  assert.ok(precache.includes('./') && precache.length > 15);
  for (const p of precache.filter((x) => x !== './')) assert.ok(existsSync(`dist/${p}`), p);
});
test('dist ships .htaccess identical to deploy/.htaccess; fonts carry licences', () => {
  assert.equal(read('.htaccess'), readFileSync('deploy/.htaccess', 'utf8'));
  assert.ok(readdirSync('dist/assets/fonts').filter((f) => f.startsWith('LICENSE')).length === 2);
});
test('CSP header equals the CSP meta tag plus frame-ancestors', () => {
  const meta = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const hdr = read('.htaccess').match(/Content-Security-Policy "([^"]+)"/)[1];
  assert.equal(hdr, `${meta}; frame-ancestors 'none'`);
});

function sandbox({ online }) {
  const log = { added: [], deleted: [], put: [], listeners: {}, claimed: false };
  const store = new Map([['./', 'CACHED_INDEX']]);
  const caches = {
    open: async () => ({ addAll: async (l) => log.added.push(...l), put: async (k) => { log.put.push(String(k)); } }),
    keys: async () => ['wsd-old', 'other-app', `wsd-${BUILD}`],
    delete: async (k) => { log.deleted.push(k); return true; },
    match: async (r) => store.get(typeof r === 'string' ? r : r.url),
  };
  const self = {
    addEventListener: (k, f) => { log.listeners[k] = f; }, skipWaiting: async () => {},
    clients: { claim: async () => { log.claimed = true; } }, location: { origin: 'https://x.test' },
  };
  const fetch = async () => { if (!online) throw new Error('offline'); return { ok: true, type: 'basic', clone: () => ({}) }; };
  vm.runInNewContext(swSrc, { self, caches, fetch, URL, Response: { error: () => 'ERR' } });
  return log;
}
const ev = (request) => { const e = { request, result: undefined, p: [] }; e.respondWith = (v) => { e.result = v; }; e.waitUntil = (v) => e.p.push(v); return e; };

test('SW install precaches, activate removes only old wsd- caches', async () => {
  const log = sandbox({ online: true });
  const i = ev(); log.listeners.install(i); await Promise.all(i.p);
  assert.deepEqual(log.added, precache);
  const a = ev(); log.listeners.activate(a); await Promise.all(a.p);
  assert.deepEqual(log.deleted, ['wsd-old']); assert.equal(log.claimed, true);
});
test('SW ignores non-GET and cross-origin requests', () => {
  const log = sandbox({ online: true });
  for (const req of [{ method: 'POST', url: 'https://x.test/a', mode: 'cors' }, { method: 'GET', url: 'https://evil.test/a', mode: 'cors' }]) {
    const e = ev(req); log.listeners.fetch(e); assert.equal(e.result, undefined);
  }
});
test('SW navigation falls back to cached shell when offline', async () => {
  const log = sandbox({ online: false });
  const e = ev({ method: 'GET', url: 'https://x.test/?q=1', mode: 'navigate' });
  log.listeners.fetch(e);
  assert.equal(await e.result, 'CACHED_INDEX');
});
