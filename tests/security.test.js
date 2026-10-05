import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWsUrl, redactUrl, stripSensitive, RateLimiter, ConnectionGuard, sanitizeSettings, LIMITS } from '../public/js/security.js';

test('validateWsUrl accepts ws/wss', () => {
  assert.equal(validateWsUrl('wss://echo.example.com/path?x=1').ok, true);
  assert.equal(validateWsUrl('ws://localhost:8080').ok, true);
  assert.equal(validateWsUrl('  ws://192.168.1.5:9000  ').ok, true);
});
test('validateWsUrl rejects bad input', () => {
  const k = (u, env) => validateWsUrl(u, env).key;
  assert.equal(k(''), 'err.url.empty');
  assert.equal(k('http://x.com'), 'err.url.scheme');
  assert.equal(k('javascript:alert(1)'), 'err.url.scheme');
  assert.equal(k('wss://u:p@x.com'), 'err.url.credentials');
  assert.equal(k('wss://x.com/#frag'), 'err.url.fragment');
  assert.equal(k('wss://x .com'), 'err.url.chars');
  assert.equal(k('wss://x.com/\n'.trim() + '\u0000'), 'err.url.chars');
  assert.equal(k('wss://'), 'err.url.format');
  assert.equal(k('wss://' + 'a'.repeat(LIMITS.maxUrlLength)), 'err.url.long');
});
test('mixed content: ws:// blocked on https except loopback', () => {
  const env = { pageProtocol: 'https:' };
  assert.equal(validateWsUrl('ws://example.com', env).key, 'err.url.mixed');
  assert.equal(validateWsUrl('ws://localhost:1', env).ok, true);
  assert.equal(validateWsUrl('ws://127.0.0.1:1', env).ok, true);
  assert.equal(validateWsUrl('ws://[::1]:1', env).ok, true);
  assert.equal(validateWsUrl('wss://example.com', env).ok, true);
  assert.equal(validateWsUrl('ws://example.com', { pageProtocol: 'http:' }).ok, true);
});
test('redact / strip sensitive params', () => {
  assert.equal(redactUrl('wss://h/p?token=abc&room=1&API_KEY=z'), 'wss://h/p?token=***&room=1&API_KEY=***');
  assert.equal(stripSensitive('wss://h/p?token=abc&room=1'), 'wss://h/p?room=1');
  assert.equal(stripSensitive('wss://h/p?token=abc'), 'wss://h/p');
  assert.equal(stripSensitive('wss://h/p'), 'wss://h/p');
});
test('RateLimiter token bucket', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 2, now: () => t });
  assert.ok(rl.take() && rl.take() && rl.take());
  assert.equal(rl.take(), false);
  assert.equal(rl.retryAfterMs(), 500);
  t = 500; assert.equal(rl.take(), true);
  t = 100000; assert.ok(rl.take() && rl.take() && rl.take());
  assert.equal(rl.take(), false); // capped at capacity
});
test('ConnectionGuard gap + window', () => {
  let t = 0;
  const g = new ConnectionGuard({ windowMs: 10000, max: 2, minGapMs: 1000, now: () => t });
  assert.equal(g.attempt().ok, true);
  t = 500; assert.deepEqual(g.attempt(), { ok: false, retryAfterMs: 500 });
  t = 1000; assert.equal(g.attempt().ok, true);
  t = 3000; assert.deepEqual(g.attempt(), { ok: false, retryAfterMs: 7000 });
  t = 10000; assert.equal(g.attempt().ok, true);
});
test('sanitizeSettings clamps garbage', () => {
  const s = sanitizeSettings({ heartbeatMs: 1, reconnectDelay: -5, maxDelay: 9e9, maxAttempts: 999, maxLogEntries: 'x', lang: 'fr' });
  assert.equal(s.heartbeatMs, LIMITS.minHeartbeatMs);
  assert.equal(s.reconnectDelay, LIMITS.minReconnectDelay);
  assert.equal(s.maxDelay, LIMITS.maxReconnectDelay);
  assert.equal(s.maxAttempts, LIMITS.maxReconnectAttempts);
  assert.equal(s.maxLogEntries, 500);
  assert.equal(s.lang, null);
  assert.equal(sanitizeSettings(null).heartbeatMs, 0);
  assert.equal(sanitizeSettings({ heartbeatMs: 0 }).heartbeatMs, 0);
});
