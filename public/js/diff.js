// Pure diff helpers: LCS (lines / tokens) and structural JSON diff. DOM-free.
const MAX_CELLS = 4_000_000;
export const MAX_LINES = 5000;
export const MAX_TOKENS = 6000;

/** Longest-common-subsequence ops over two arrays. Falls back to "all removed / all added" when too large. */
export function lcsOps(a, b) {
  const n = a.length, m = b.length;
  let s = 0;
  while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0;
  while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e);
  const N = A.length, M = B.length;
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ type: 'same', text: a[i] });
  let approximate = false;
  if (N * M > MAX_CELLS) {
    approximate = true;
    for (const x of A) ops.push({ type: 'del', text: x });
    for (const x of B) ops.push({ type: 'add', text: x });
  } else {
    const W = M + 1;
    const dp = new Uint32Array((N + 1) * W);
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (A[i] === B[j]) { ops.push({ type: 'same', text: A[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) ops.push({ type: 'del', text: A[i++] });
      else ops.push({ type: 'add', text: B[j++] });
    }
    while (i < N) ops.push({ type: 'del', text: A[i++] });
    while (j < M) ops.push({ type: 'add', text: B[j++] });
  }
  for (let k = n - e; k < n; k++) ops.push({ type: 'same', text: a[k] });
  return { ops, approximate };
}

const splitLines = (t) => t.split(/\r?\n/);

export function lineDiff(aText, bText) {
  const A = splitLines(aText), B = splitLines(bText);
  const capped = A.length > MAX_LINES || B.length > MAX_LINES;
  const r = lcsOps(A.slice(0, MAX_LINES), B.slice(0, MAX_LINES));
  return { ...r, capped };
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
export function tokenDiff(aText, bText) {
  const A = aText.match(TOKEN) ?? [], B = bText.match(TOKEN) ?? [];
  const capped = A.length > MAX_TOKENS || B.length > MAX_TOKENS;
  const r = lcsOps(A.slice(0, MAX_TOKENS), B.slice(0, MAX_TOKENS));
  return { ...r, capped };
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const ID = /^[A-Za-z_$][\w$]*$/;
const keyPath = (p, k) => (ID.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);

/** Structural diff: arrays compared by index, objects by key. */
export function jsonDiff(a, b, limit = 500) {
  const changes = [];
  let truncated = false;
  const push = (c) => { if (changes.length >= limit) { truncated = true; return false; } changes.push(c); return true; };
  const walk = (path, x, y) => {
    if (truncated) return;
    const tx = typeOf(x), ty = typeOf(y);
    if (tx !== ty) { push({ path, kind: 'changed', before: x, after: y }); return; }
    if (tx === 'array') {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n && !truncated; i++) {
        const p = `${path}[${i}]`;
        if (i >= x.length) push({ path: p, kind: 'added', after: y[i] });
        else if (i >= y.length) push({ path: p, kind: 'removed', before: x[i] });
        else walk(p, x[i], y[i]);
      }
    } else if (tx === 'object') {
      const keys = [...Object.keys(x), ...Object.keys(y).filter((k) => !Object.hasOwn(x, k))];
      for (const k of keys) {
        if (truncated) break;
        const p = keyPath(path, k);
        if (!Object.hasOwn(y, k)) push({ path: p, kind: 'removed', before: x[k] });
        else if (!Object.hasOwn(x, k)) push({ path: p, kind: 'added', after: y[k] });
        else walk(p, x[k], y[k]);
      }
    } else if (!Object.is(x, y)) push({ path, kind: 'changed', before: x, after: y });
  };
  walk('$', a, b);
  return { changes, truncated };
}

/** Collapses long runs of unchanged lines, keeping `ctx` lines of context around changes. */
export function collapse(ops, ctx = 2) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== 'same') { out.push(ops[i++]); continue; }
    let j = i;
    while (j < ops.length && ops[j].type === 'same') j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : ctx, tail = j === ops.length ? 0 : ctx;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { type: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

export const summarize = (ops) => ({
  add: ops.filter((o) => o.type === 'add').length,
  del: ops.filter((o) => o.type === 'del').length,
});
