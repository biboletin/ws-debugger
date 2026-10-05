// UI smoke test: bundle main.js, run it in jsdom against a local echo server.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bundle = (await build({ entryPoints: ['public/js/main.js'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;
const html = readFileSync('public/index.html', 'utf8').replace(/<script type="module"[^>]*><\/script>/, '').replace(/<link[^>]*fonts[^>]*>/g, '');

const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on('listening', r));
wss.on('connection', (s) => {
  s.send('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
  s.on('message', (d, bin) => s.send(d, { binary: bin }));
});
const url = `ws://127.0.0.1:${wss.address().port}`;

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window; const d = w.document;
w.TextEncoder = TextEncoder; w.Blob = Blob;
Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
w.eval(bundle);
const $ = (id) => d.getElementById(id);
const entries = () => [...d.querySelectorAll('.entry')];
const click = (id) => $(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// invalid URL -> error entry, no socket
$('url-input').value = 'http://nope.example';
click('btn-connect'); await wait(60);
assert.match(entries().at(-1).textContent, /ws:\/\/ or wss:\/\//);

// valid connect
$('url-input').value = url + '?token=SECRET123&room=1';
click('btn-connect'); await wait(400);
assert.equal($('status-text').textContent, 'Connected');
assert.equal($('btn-send').disabled, false);
assert.equal(d.body.dataset.state, 'open');
const text = d.getElementById('log').textContent;
assert.ok(!text.includes('SECRET123'), 'token must be redacted in log');
assert.ok(text.includes('token=***'));

// XSS: server payload must stay text
assert.equal(d.querySelector('#log img'), null); assert.equal(d.querySelector('#log script'), null);
assert.equal(w.__xss, undefined);

// send JSON and get echo with highlighted tokens
$('msg-input').value = '{"a":1,"b":[true,null]}';
click('btn-send'); await wait(300);
assert.ok(d.querySelector('.entry.send .json-key'));
assert.ok(d.querySelector('.entry.recv .json-num'));
assert.equal($('stat-sent').textContent, '1');
assert.equal($('stat-recv').textContent, '2');

// invalid JSON rejected client-side
$('msg-input').value = '{bad'; click('btn-send'); await wait(60);
assert.match(entries().at(-1).textContent, /Invalid JSON/);
assert.equal($('stat-sent').textContent, '1');

// hex binary
$('msg-type').value = 'hex'; $('msg-type').dispatchEvent(new w.Event('change'));
$('msg-input').value = '48 65 6c 6c 6f'; click('btn-send'); await wait(300);
assert.ok([...d.querySelectorAll('.entry.recv')].some((e) => e.textContent.includes('Hello')));

// inspector: live connection tab, handshake (real SHA-1 accept), learn, codes
click('btn-inspect'); await wait(80);
assert.ok($('insp-overlay').classList.contains('open')); assert.equal($('app').inert, true);
const kv = d.querySelector('#insp-body .kv').textContent;
assert.match(kv, /127\.0\.0\.1/); assert.match(kv, /token=\*\*\*/); assert.ok(!kv.includes('SECRET123'));
assert.ok(d.querySelectorAll('#insp-body .timeline li').length >= 3);
const tab = (n) => d.querySelector(`.tab[data-tab="${n}"]`);
tab('handshake').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(150);
const pres = [...d.querySelectorAll('#insp-body pre.code')].map((e) => e.textContent);
assert.equal(pres.length, 2);
assert.match(pres[0], /^GET \/\?token=\*\*\*&room=1 HTTP\/1\.1\nHost: 127\.0\.0\.1:\d+/);
assert.match(pres[0], /Sec-WebSocket-Version: 13/); assert.ok(!pres[0].includes('SECRET123'));
assert.match(pres[1], /Sec-WebSocket-Accept: [A-Za-z0-9+\/]{27}=/);
tab('learn').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(50);
assert.equal(d.querySelectorAll('#insp-body details.learn').length, 11);
tab('codes').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(50);
assert.ok(d.querySelectorAll('#insp-body .code-row').length >= 17);
tab('conn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
click('btn-insp-close'); await wait(30);
assert.ok(!$('insp-overlay').classList.contains('open')); assert.equal($('app').inert, false);
// frame meta on log entries
assert.match(d.querySelector('.entry.send .entry-meta').textContent, /^TEXT · /);
assert.match(d.querySelector('.entry.send .entry-meta').title, /Opcode 0x1/);

// templates: validation, secret screening, variable expansion, persistence, delete
click('btn-templates'); await wait(40);
assert.ok($('tpl-overlay').classList.contains('open')); assert.equal($('app').inert, true);
$('tpl-name').value = ''; click('btn-tpl-save');
assert.match($('tpl-status').textContent, /Enter a template name/);
$('msg-type').value = 'json'; $('msg-input').value = '{"op":"sub","id":"{{uuid}}","n":{{counter}}}'; $('tpl-name').value = 'sub'; click('btn-tpl-save');
assert.equal(d.querySelectorAll('.tpl-row').length, 1);
assert.match(d.querySelector('.tpl-name').textContent, /^sub$/);
assert.match(w.localStorage.getItem('wsd.templates'), /"name":"sub"/);
$('msg-input').value = '{"token":"abc"}'; $('tpl-name').value = 'secret'; click('btn-tpl-save');
assert.match($('tpl-status').textContent, /secret/); assert.equal(d.querySelectorAll('.tpl-row').length, 1);
d.querySelector('.tpl-use').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(30);
assert.ok(!$('tpl-overlay').classList.contains('open')); assert.equal($('app').inert, false);
assert.match($('msg-input').value, /^\{"op":"sub","id":"[0-9a-f-]{36}","n":1\}$/);
assert.equal($('msg-type').value, 'json');
click('btn-templates'); await wait(30);
d.querySelector('.tpl-del').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
assert.equal(d.querySelectorAll('.tpl-row').length, 0); assert.equal(w.localStorage.getItem('wsd.templates'), '[]');
click('btn-tpl-close'); await wait(20);
assert.ok(!$('tpl-overlay').classList.contains('open'));

// filter
$('filter-text').value = 'hello'; $('filter-text').dispatchEvent(new w.Event('input')); await wait(60);
const vis = entries().filter((e) => !e.classList.contains('hidden'));
assert.ok(vis.length >= 1 && vis.every((e) => /hello/i.test(e.textContent)));

// Bulgarian
click('btn-settings'); assert.equal($('app').inert, true); $('cfg-lang').value = 'bg'; click('btn-settings-close'); await wait(30);
assert.equal($('status-text').textContent, 'Свързан');
assert.equal(d.documentElement.lang, 'bg'); assert.equal($('app').inert, false);

// disconnect
click('btn-disconnect'); await wait(300);
assert.equal($('status-text').textContent, 'Прекъсната');
assert.equal($('btn-connect').disabled, false);
assert.equal(d.body.dataset.state, 'closed');
assert.match(entries().at(-1).textContent, /1000[\s\S]*Нормално затваряне/);

// invalid subprotocol blocked before any connection attempt
click('btn-settings'); $('cfg-protocols').value = 'bad proto'; click('btn-settings-close');
click('btn-connect'); await wait(60);
assert.match(entries().at(-1).textContent, /Невалидни подпротоколи/);
assert.equal($('btn-connect').disabled, false);
console.log('UI smoke: ALL OK (' + entries().length + ' entries)');
w.close(); wss.close(); process.exit(0);
