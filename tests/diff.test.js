import test from 'node:test';
import assert from 'node:assert/strict';
import { lcsOps, lineDiff, tokenDiff, jsonDiff, collapse, summarize, MAX_LINES } from '../public/js/diff.js';
import { Metrics, latencyStats } from '../public/js/metrics.js';
import { niceMax } from '../public/js/charts.js';

const rebuild = (ops, side) => ops.filter((o) => o.type === 'same' || o.type === side).map((o) => o.text);

test('lcsOps reconstructs both inputs', () => {
  const a = 'a b c d e f'.split(' '), b = 'a x c d f g'.split(' ');
  const { ops, approximate } = lcsOps(a, b);
  assert.equal(approximate, false);
  assert.deepEqual(rebuild(ops, 'del'), a); assert.deepEqual(rebuild(ops, 'add'), b);
  assert.deepEqual(summarize(ops), { add: 2, del: 2 });
  assert.deepEqual(lcsOps([], []).ops, []);
  assert.equal(lcsOps(['x'], ['x']).ops.every((o) => o.type === 'same'), true);
});
test('lcsOps falls back to approximate on huge inputs', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`), b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const r = lcsOps(a, b);
  assert.equal(r.approximate, true); assert.equal(r.ops.length, 6000);
});
test('lineDiff and tokenDiff', () => {
  const d = lineDiff('one\ntwo\nthree', 'one\n2\nthree');
  assert.deepEqual(d.ops.map((o) => o.type), ['same', 'del', 'add', 'same']);
  const t = tokenDiff('hello brave world', 'hello new world');
  assert.deepEqual(rebuild(t.ops, 'del').join(''), 'hello brave world');
  assert.deepEqual(rebuild(t.ops, 'add').join(''), 'hello new world');
  const cyr = tokenDiff('здравей свят', 'здравей мир');
  assert.deepEqual(cyr.ops.filter((o) => o.type !== 'same').map((o) => o.text).sort(), ['мир', 'свят']);
  assert.equal(lineDiff('x\n'.repeat(MAX_LINES + 5), 'y').capped, true);
});
test('jsonDiff paths and kinds', () => {
  const a = { a: 1, b: [1, 2, { k: 'x' }], c: null, 'we ird': true, gone: 1 };
  const b = { a: 2, b: [1, 3, { k: 'x' }, 9], c: [], 'we ird': true, added: 'n' };
  const { changes } = jsonDiff(a, b);
  const m = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
  assert.deepEqual(m, { '$.a': 'changed', '$.b[1]': 'changed', '$.b[3]': 'added', '$.c': 'changed', '$.gone': 'removed', '$.added': 'added' });
  assert.deepEqual(jsonDiff({ a: 1 }, { a: 1 }).changes, []);
  assert.deepEqual(jsonDiff(1, 1).changes, []);
  assert.equal(jsonDiff({ 'a-b': 1 }, { 'a-b': 2 }).changes[0].path, '$["a-b"]');
  const big = jsonDiff(Array.from({ length: 600 }, (_, i) => i), Array.from({ length: 600 }, (_, i) => -i - 1), 500);
  assert.equal(big.changes.length, 500); assert.equal(big.truncated, true);
});
test('collapse keeps context and folds long same-runs', () => {
  const same = (n) => Array.from({ length: n }, (_, i) => ({ type: 'same', text: `s${i}` }));
  const ops = [...same(10), { type: 'add', text: 'x' }, ...same(3), { type: 'del', text: 'y' }, ...same(10)];
  const c = collapse(ops, 2);
  assert.deepEqual(c.map((o) => o.type), ['skip', 'same', 'same', 'add', 'same', 'same', 'same', 'del', 'same', 'same', 'skip']);
  assert.equal(c[0].count, 8); assert.equal(c.at(-1).count, 8);
  assert.deepEqual(collapse(same(5), 2), [{ type: 'skip', count: 5 }]); // fully identical input folds into one marker
  assert.deepEqual(collapse(same(3), 2).length, 1);
});
test('Metrics series is zero-filled and aligned; old buckets pruned', () => {
  const m = new Metrics({ maxSeconds: 10 });
  const t0 = 1_000_000_000;
  m.addSent(5, t0); m.addSent(7, t0 + 100); m.addRecv(3, t0 + 2000);
  const s = m.series(4, t0 + 2500);
  assert.deepEqual(s.sentMsgs, [0, 2, 0, 0]);
  assert.deepEqual(s.sentBytes, [0, 12, 0, 0]);
  assert.deepEqual(s.recvMsgs, [0, 0, 0, 1]);
  m.addSent(1, t0 + 60_000);
  assert.deepEqual(m.series(4, t0 + 2500).sentMsgs, [0, 0, 0, 0]); // pruned
  m.reset(); assert.deepEqual(m.series(2, t0).sentMsgs, [0, 0]);
});
test('latencyStats', () => {
  assert.equal(latencyStats([]), null);
  const s = latencyStats([10, 30, 20, 40].map((ms, i) => ({ t: i, ms })));
  assert.deepEqual([s.n, s.last, s.min, s.max, s.avg, s.p95], [4, 40, 10, 40, 25, 40]);
  assert.equal(s.jitter, (20 + 10 + 20) / 3);
  assert.equal(latencyStats([{ t: 0, ms: 5 }]).jitter, 0);
});
test('niceMax', () => {
  assert.deepEqual([0, 0.3, 1, 1.1, 3, 7, 130, 999].map(niceMax), [1, 0.5, 1, 2, 5, 10, 200, 1000]);
});
