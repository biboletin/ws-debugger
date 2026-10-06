// Per-session traffic and latency samples for the Charts tab. DOM-free.
export function latencyStats(samples) {
  const v = samples.map((s) => s.ms);
  const n = v.length;
  if (!n) return null;
  const sorted = [...v].sort((a, b) => a - b);
  let jitter = 0;
  for (let i = 1; i < n; i++) jitter += Math.abs(v[i] - v[i - 1]);
  return {
    n, last: v[n - 1], min: sorted[0], max: sorted[n - 1],
    avg: v.reduce((x, y) => x + y, 0) / n,
    p95: sorted[Math.ceil(0.95 * n) - 1],
    jitter: n > 1 ? jitter / (n - 1) : 0,
  };
}

export class Metrics {
  #buckets = new Map(); #maxSeconds; #maxLatency;
  latency = [];

  constructor({ maxSeconds = 300, maxLatency = 300 } = {}) { this.#maxSeconds = maxSeconds; this.#maxLatency = maxLatency; }

  reset() { this.#buckets.clear(); this.latency = []; }

  #bucket(now) {
    const sec = Math.floor(now / 1000);
    let b = this.#buckets.get(sec);
    if (!b) {
      b = { sm: 0, rm: 0, sb: 0, rb: 0 };
      this.#buckets.set(sec, b);
      for (const k of this.#buckets.keys()) if (k < sec - this.#maxSeconds) this.#buckets.delete(k);
    }
    return b;
  }
  addSent(size, now = Date.now()) { const b = this.#bucket(now); b.sm += 1; b.sb += size; }
  addRecv(size, now = Date.now()) { const b = this.#bucket(now); b.rm += 1; b.rb += size; }
  addLatency(ms, now = Date.now()) {
    this.latency.push({ t: now, ms });
    if (this.latency.length > this.#maxLatency) this.latency.shift();
  }

  /** Zero-filled per-second arrays for the last `seconds` seconds (oldest first, last = current second). */
  series(seconds = 60, now = Date.now()) {
    const end = Math.floor(now / 1000);
    const out = { sentMsgs: [], recvMsgs: [], sentBytes: [], recvBytes: [] };
    for (let s = end - seconds + 1; s <= end; s++) {
      const b = this.#buckets.get(s);
      out.sentMsgs.push(b?.sm ?? 0); out.recvMsgs.push(b?.rm ?? 0);
      out.sentBytes.push(b?.sb ?? 0); out.recvBytes.push(b?.rb ?? 0);
    }
    return out;
  }
}
