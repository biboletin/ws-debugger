import test from 'node:test';
import assert from 'node:assert/strict';
import { hexDump, parseHex, formatBytes, formatUptime } from '../public/js/utils.js';
import { LogStore, classifyText } from '../public/js/log-store.js';
import { LIMITS } from '../public/js/security.js';

test('hexDump / parseHex', () => {
  const b = new TextEncoder().encode('Hello, world! 123');
  const d = hexDump(b).split('\n');
  assert.equal(d.length, 2);
  assert.match(d[0], /^00000000  48 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21 20 31 32  Hello, world! 12$/);
  assert.deepEqual([...parseHex('48 65 6C6c')], [0x48, 0x65, 0x6c, 0x6c]);
  assert.equal(parseHex('abc'), null);
  assert.equal(parseHex('zz'), null);
  assert.equal(parseHex('  '), null);
});
test('format helpers', () => {
  assert.equal(formatBytes(10), '10 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(65536), '64 KB');
  assert.equal(formatUptime(65000), '01:05');
  assert.equal(formatUptime(3725000), '1:02:05');
});
test('classifyText', () => {
  assert.equal(classifyText('{"a":1}'), 'json');
  assert.equal(classifyText(' [1,2]'), 'json');
  assert.equal(classifyText('123'), 'text');
  assert.equal(classifyText('null'), 'text');
  assert.equal(classifyText('{bad'), 'text');
});
test('LogStore trim, truncate, filter, export', () => {
  const s = new LogStore(2);
  s.add({ type: 'send', tag: 'SEND', kind: 'text', raw: 'a' });
  s.add({ type: 'recv', tag: 'RECV', kind: 'text', raw: 'Hello' });
  const r = s.add({ type: 'error', tag: 'ERROR', kind: 'system', raw: 'boom' });
  assert.equal(s.entries.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(LogStore.matches(r.entry, { type: 'errors' }), true);
  assert.equal(LogStore.matches(r.entry, { type: 'recv' }), false);
  assert.equal(LogStore.matches(s.entries[0], { text: 'hELLo' }), true);
  const big = s.add({ type: 'recv', tag: 'RECV', kind: 'json', raw: 'x'.repeat(LIMITS.maxStoredPayload + 5) });
  assert.equal(big.entry.truncated, true);
  assert.equal(big.entry.kind, 'text');
  assert.equal(big.entry.raw.length, LIMITS.maxStoredPayload);
  assert.equal(s.export()[0].type, 'error');
  assert.equal(s.setMax(1).length, 1);
});

import { LANGS, t, setLang } from '../public/js/i18n.js';
import * as i18n from '../public/js/i18n.js';
test('i18n: en and bg have identical keys and placeholders', async () => {
  // dictionaries are private: compare via t() on keys found in source
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  const grab = (name) => {
    const block = src.split(`  ${name}: {`)[1].split('\n  },')[0];
    return Object.fromEntries([...block.matchAll(/'([\w.]+)': '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
  };
  const en = grab('en'), bg = grab('bg');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(bg).sort());
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => x !== 'type').sort().join();
  for (const k of Object.keys(en)) assert.equal(ph(bg[k]), ph(en[k]), `placeholders differ: ${k}`);
  assert.deepEqual(LANGS, ['en', 'bg']);
});

import { frameOverhead, closeCodeKey, computeAccept, buildHandshakePreview, CLOSE_CODES } from '../public/js/protocol-info.js';
import { Session } from '../public/js/session.js';
import { parseProtocols } from '../public/js/security.js';
import { LEARN_TOPICS } from '../public/js/inspector.js';
import { webcrypto } from 'node:crypto';

test('frameOverhead per RFC 6455 section 5.2', () => {
  assert.equal(frameOverhead(0, false), 2);
  assert.equal(frameOverhead(125, false), 2);
  assert.equal(frameOverhead(126, false), 4);
  assert.equal(frameOverhead(65535, false), 4);
  assert.equal(frameOverhead(65536, false), 10);
  assert.equal(frameOverhead(5, true), 6);
  assert.equal(frameOverhead(70000, true), 14);
});
test('closeCodeKey', () => {
  assert.equal(closeCodeKey(1006), 'code.1006');
  assert.equal(closeCodeKey(3500), 'code.3xxx');
  assert.equal(closeCodeKey(4001), 'code.4xxx');
  assert.equal(closeCodeKey(1004), 'code.reserved_range');
  assert.equal(closeCodeKey(999), 'code.unknown');
  assert.equal(closeCodeKey(5000), 'code.unknown');
});
test('computeAccept matches the RFC 6455 example vector', async () => {
  assert.equal(await computeAccept('dGhlIHNhbXBsZSBub25jZQ==', webcrypto.subtle), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(await computeAccept('x', null), null);
});
test('buildHandshakePreview', () => {
  const labels = { key: 'K', origin: 'O', ext: 'E', accept: 'A', observed: 'OBS' };
  const p = buildHandshakePreview({ url: 'wss://example.com:8443/chat?token=abc&room=1', origin: 'https://app.test', protocols: ['v1', 'v2'], key: 'KEY', accept: 'ACC', observed: { protocol: 'v2', extensions: 'permessage-deflate' }, labels });
  assert.match(p.request, /^GET \/chat\?token=\*\*\*&room=1 HTTP\/1\.1\nHost: example\.com:8443\n/);
  assert.match(p.request, /Sec-WebSocket-Version: 13/);
  assert.match(p.request, /Origin: https:\/\/app\.test {2}# O/);
  assert.match(p.request, /Sec-WebSocket-Protocol: v1, v2/);
  assert.match(p.response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(p.response, /Sec-WebSocket-Protocol: v2 {2}# OBS/);
  assert.equal(buildHandshakePreview({ url: 'nope', key: 'k', accept: 'a', labels }), null);
  const d = buildHandshakePreview({ url: 'ws://h:80/', key: 'k', accept: 'a', labels });
  assert.match(d.request, /Host: h\n/); // default port omitted
  assert.doesNotMatch(d.request, /Origin|Sec-WebSocket-Protocol:/);
});
test('Session tracks counters and timeline', () => {
  const s = new Session();
  s.start('ws://h/', ['a'], 1000);
  s.open({ protocol: 'a', extensions: '', connectMs: 12 }, 1012);
  s.sent(5); s.message(7, 1050); s.message(3, 1060);
  s.close({ code: 1000, reason: '', wasClean: true }, 2000);
  const d = s.data;
  assert.deepEqual([d.sentMsgs, d.sentBytes, d.recvMsgs, d.recvBytes], [1, 5, 2, 10]);
  assert.equal(d.firstMsgAt, 1050);
  assert.deepEqual(d.timeline.map((e) => e.key), ['tl.connecting', 'tl.open', 'tl.first', 'tl.close']);
  assert.equal(d.timeline[2].params.ms, 38);
  for (let i = 0; i < 100; i++) s.mark('tl.retry', { attempt: i });
  assert.equal(d.timeline.length, 50); assert.equal(d.timeline[0].key, 'tl.connecting');
  new Session().message(1); // no data -> no throw
});
test('parseProtocols', () => {
  assert.deepEqual(parseProtocols('graphql-transport-ws, v1.json').list, ['graphql-transport-ws', 'v1.json']);
  assert.deepEqual(parseProtocols('').list, []);
  for (const bad of ['a b', 'a,a', 'a;b', 'x'.repeat(65), 'a,b,c,d,e,f,g,h,i']) assert.equal(parseProtocols(bad).ok, false, bad);
});
test('every close code and learn topic has both translations', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  for (const lang of ['en', 'bg']) {
    const block = src.split(`  ${lang}: {`)[1].split('\n  },')[0];
    const keys = new Set([...block.matchAll(/'([\w.]+)':/g)].map((m) => m[1]));
    for (const c of CLOSE_CODES) assert.ok(keys.has(`code.${c}`), `${lang} code.${c}`);
    for (const k of LEARN_TOPICS) assert.ok(keys.has(`learn.${k}.title`) && keys.has(`learn.${k}.body`), `${lang} learn.${k}`);
    for (const k of ['code.3xxx', 'code.4xxx', 'code.reserved_range', 'code.unknown', 'info.close', 'tl.connecting', 'tl.open', 'tl.first', 'tl.close', 'tl.retry']) assert.ok(keys.has(k), `${lang} ${k}`);
  }
});
