import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { WsClient } from '../public/js/ws-client.js';
import { LIMITS } from '../public/js/security.js';

const FAST = { ...LIMITS, minConnectGapMs: 0, minReconnectDelay: 20, maxReconnectDelay: 100, minHeartbeatMs: 50 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (c, evt) => new Promise((res) => { const off = c.on(evt, (d) => { off(); res(d); }); });

async function server(onConn) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const conns = { n: 0 };
  wss.on('connection', (s) => { conns.n++; onConn?.(s, conns); });
  return { wss, conns, url: `ws://127.0.0.1:${wss.address().port}` };
}
const echo = (s) => s.on('message', (d, isBin) => s.send(d, { binary: isBin }));
const close = (srv) => new Promise((r) => { srv.wss.clients.forEach((c) => c.terminate()); srv.wss.close(r); });

test('text echo emits sent/message with sizes', async () => {
  const srv = await server(echo);
  const c = new WsClient({ limits: FAST });
  const sent = [], got = [];
  c.on('sent', (d) => sent.push(d)); c.on('message', (d) => got.push(d));
  const opened = once(c, 'open');
  assert.equal(c.connect(srv.url).ok, true);
  const info = await opened;
  assert.equal(typeof info.connectMs, 'number');
  assert.equal(c.send('héllo').size, 6);
  await once(c, 'message');
  assert.equal(sent[0].kind, 'text'); assert.equal(got[0].text, 'héllo'); assert.equal(got[0].size, 6);
  c.destroy(); await close(srv);
});

test('binary roundtrip', async () => {
  const srv = await server(echo);
  const c = new WsClient({ limits: FAST });
  const opened = once(c, 'open'); c.connect(srv.url); await opened;
  const m = once(c, 'message');
  assert.equal(c.send(new Uint8Array([1, 2, 3, 255])).ok, true);
  const d = await m;
  assert.equal(d.kind, 'binary'); assert.deepEqual([...d.bytes], [1, 2, 3, 255]);
  c.destroy(); await close(srv);
});

test('ping/pong measures latency and pong is still delivered', async () => {
  const srv = await server((s) => s.on('message', (d) => {
    if (JSON.parse(d.toString()).type === 'ping') setTimeout(() => s.send('{"type":"pong"}'), 30);
  }));
  const c = new WsClient({ limits: FAST });
  const opened = once(c, 'open'); c.connect(srv.url); await opened;
  const lat = once(c, 'latency'), msg = once(c, 'message');
  assert.equal(c.ping().ok, true);
  const { ms } = await lat;
  assert.ok(ms >= 25 && ms < 500, `latency ${ms}`);
  assert.match((await msg).text, /pong/);
  c.destroy(); await close(srv);
});

test('heartbeat sends pings with origin=heartbeat and can be changed live', async () => {
  const srv = await server();
  const c = new WsClient({ limits: FAST, heartbeatMs: 50 });
  const origins = []; c.on('sent', (d) => origins.push(d.origin));
  const opened = once(c, 'open'); c.connect(srv.url); await opened;
  await wait(180);
  assert.ok(origins.length >= 2 && origins.every((o) => o === 'heartbeat'));
  c.updateOptions({ heartbeatMs: 0 });
  const n = origins.length; await wait(150);
  assert.equal(origins.length, n);
  c.destroy(); await close(srv);
});

test('disconnect during reconnect wait does NOT reconnect (no ghost)', async () => {
  const srv = await server((s) => s.close());
  const c = new WsClient({ limits: FAST, reconnect: { enabled: true, maxAttempts: 5, baseDelay: 60, maxDelay: 100 } });
  c.connect(srv.url);
  await once(c, 'reconnecting');
  c.disconnect();
  assert.equal(c.state, 'closed');
  const n = srv.conns.n; await wait(300);
  assert.equal(srv.conns.n, n);
  c.destroy(); await close(srv);
});

test('connect() replaces old socket; stale events are ignored', async () => {
  const a = await server(echo), b = await server(echo);
  const c = new WsClient({ limits: FAST });
  let closes = 0; c.on('close', () => closes++);
  const o1 = once(c, 'open'); c.connect(a.url); await o1;
  const o2 = once(c, 'open'); c.connect(b.url); await o2;
  await wait(100);
  assert.equal(closes, 0); assert.equal(c.state, 'open'); assert.equal(c.info.url, b.url);
  c.destroy(); await close(a); await close(b);
});

test('reconnect gives up after maxAttempts', async () => {
  const srv = await server(); const url = srv.url; await close(srv);
  const c = new WsClient({ limits: FAST, reconnect: { enabled: true, maxAttempts: 2, baseDelay: 20, maxDelay: 50 } });
  let closes = 0, failed = null; c.on('close', () => closes++); c.on('reconnect-failed', (d) => { failed = d; });
  c.connect(url);
  await once(c, 'reconnect-failed');
  assert.equal(failed.attempts, 2); assert.equal(closes, 3); assert.equal(c.state, 'closed');
  c.destroy();
});

test('reconnect disabled -> closes once', async () => {
  const srv = await server((s) => s.close());
  const c = new WsClient({ limits: FAST, reconnect: { enabled: false } });
  const cl = once(c, 'close'); c.connect(srv.url); await cl; await wait(50);
  assert.equal(c.state, 'closed');
  c.destroy(); await close(srv);
});

test('send guards: not open, rate, size, type', async () => {
  const srv = await server();
  const c = new WsClient({ limits: { ...FAST, sendBurst: 3, sendPerSecond: 1, maxSendBytes: 10 } });
  assert.equal(c.send('x').error.key, 'err.send.notopen');
  const opened = once(c, 'open'); c.connect(srv.url); await opened;
  assert.equal(c.send('12345678901').error.key, 'err.send.toolarge');
  assert.equal(c.send(123).error.key, 'err.send.type');
  assert.ok(c.send('a').ok && c.send('a').ok && c.send('a').ok);
  const r = c.send('a');
  assert.equal(r.error.key, 'err.send.rate'); assert.ok(r.error.retryAfterMs > 0);
  c.destroy(); await close(srv);
});

test('connect guard limits connection attempts', async () => {
  const srv = await server();
  const c = new WsClient({ limits: { ...FAST, maxConnectsPerWindow: 2 } });
  assert.equal(c.connect(srv.url).ok, true);
  assert.equal(c.connect(srv.url).ok, true);
  const r = c.connect(srv.url);
  assert.equal(r.ok, false); assert.equal(r.error.key, 'err.rate.connect');
  c.destroy(); await close(srv);
});

test('invalid subprotocol -> construct error, state closed', () => {
  const c = new WsClient({ limits: FAST });
  const r = c.connect('ws://127.0.0.1:1', ['bad protocol']);
  assert.equal(r.ok, false); assert.equal(r.error.key, 'err.ws.construct');
  assert.equal(c.state, 'closed');
  c.destroy();
});

test('manual disconnect emits close and settles on closed', async () => {
  const srv = await server();
  const c = new WsClient({ limits: FAST });
  const opened = once(c, 'open'); c.connect(srv.url); await opened;
  const cl = once(c, 'close'); c.disconnect();
  const d = await cl;
  assert.equal(d.code, 1000); assert.equal(c.state, 'closed');
  c.destroy(); await close(srv);
});

test('disconnect while connecting aborts immediately', async () => {
  const c = new WsClient({ limits: FAST });
  const closes = []; c.on('close', (d) => closes.push(d));
  c.connect('ws://10.255.255.1:81'); // unroutable -> stays CONNECTING
  assert.equal(c.state, 'connecting');
  c.disconnect();
  assert.equal(c.state, 'closed'); assert.equal(closes.length, 1);
  await wait(50); assert.equal(closes.length, 1);
  c.destroy();
});

test('connect timeout produces error + close and stops when reconnect off', async () => {
  const c = new WsClient({ limits: { ...FAST, connectTimeoutMs: 80 }, reconnect: { enabled: false } });
  const evts = []; c.on('error', (e) => evts.push(e.key)); c.on('close', (d) => evts.push(d.reason));
  c.connect('ws://10.255.255.1:81');
  await once(c, 'close');
  assert.deepEqual(evts.slice(0, 2).sort(), ['connect timeout', 'err.ws.timeout'].sort());
  assert.equal(c.state, 'closed');
  c.destroy();
});
