// Security primitives: URL validation, rate limiting, settings sanitising.
// DOM-free so it can be unit-tested in Node.

export const LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxSendBytes: 64 * 1024,
  maxBuffered: 1024 * 1024,
  sendBurst: 10,
  sendPerSecond: 5,
  connectTimeoutMs: 15_000,
  connectWindowMs: 60_000,
  maxConnectsPerWindow: 8,
  minConnectGapMs: 1_000,
  maxReconnectAttempts: 10,
  minReconnectDelay: 1_000,
  maxReconnectDelay: 60_000,
  minHeartbeatMs: 5_000,
  maxHeartbeatMs: 300_000,
  maxStoredPayload: 256 * 1024,
  minLogEntries: 50,
  maxLogEntries: 2_000,
});

const SENSITIVE_KEY = /(token|secret|passw|pwd|api[-_]?key|apikey|auth|sig|signature|jwt|bearer|session|cred)/i;

const toInt = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fb; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

const fail = (key) => ({ ok: false, key });

/** Strict ws:// / wss:// validation. Returns {ok:true,url,...} or {ok:false,key}. */
export function validateWsUrl(raw, env = {}) {
  const url = String(raw ?? '').trim();
  if (!url) return fail('err.url.empty');
  if (url.length > LIMITS.maxUrlLength) return fail('err.url.long');
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) return fail('err.url.chars');
  if (!/^wss?:\/\//i.test(url)) return fail('err.url.scheme');
  let u;
  try { u = new URL(url); } catch { return fail('err.url.format'); }
  if (!u.hostname) return fail('err.url.format');
  if (u.username || u.password) return fail('err.url.credentials');
  if (u.hash) return fail('err.url.fragment');
  if (env.pageProtocol === 'https:' && u.protocol === 'ws:' && !isLoopbackHost(u.hostname)) {
    return fail('err.url.mixed');
  }
  return { ok: true, url, secure: u.protocol === 'wss:', host: u.host, hostname: u.hostname };
}

const PROTO_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parse a comma-separated Sec-WebSocket-Protocol list (RFC 6455 tokens, max 8, unique). */
export function parseProtocols(raw) {
  const list = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ok = list.length <= 8 && new Set(list).size === list.length
    && list.every((p) => p.length <= 64 && PROTO_TOKEN.test(p));
  return ok ? { ok: true, list } : fail('err.proto.invalid');
}

/** Mask values of sensitive query parameters (for logs / display). */
export function redactUrl(url) {
  return String(url).replace(/([?&])([^=&#]*)=([^&#]*)/g,
    (m, sep, k) => (SENSITIVE_KEY.test(safeDecode(k)) ? `${sep}${k}=***` : m));
}

/** Remove sensitive query parameters entirely (for anything persisted). */
export function stripSensitive(url) {
  const s = String(url);
  const q = s.indexOf('?');
  if (q < 0) return s;
  const kept = s.slice(q + 1).split('&')
    .filter((p) => p && !SENSITIVE_KEY.test(safeDecode(p.split('=')[0])));
  return s.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '');
}

export class RateLimiter {
  #cap; #rate; #now; #tokens; #last;
  constructor({ capacity, refillPerSec, now = () => performance.now() }) {
    this.#cap = capacity; this.#rate = refillPerSec; this.#now = now;
    this.#tokens = capacity; this.#last = now();
  }
  #refill() {
    const t = this.#now();
    this.#tokens = Math.min(this.#cap, this.#tokens + ((t - this.#last) / 1000) * this.#rate);
    this.#last = t;
  }
  take(n = 1) {
    this.#refill();
    if (this.#tokens >= n) { this.#tokens -= n; return true; }
    return false;
  }
  retryAfterMs(n = 1) {
    this.#refill();
    return Math.max(0, Math.ceil(((n - this.#tokens) / this.#rate) * 1000));
  }
}

/** Limits how often new connections may be opened (anti port-scan / flood). */
export class ConnectionGuard {
  #win; #max; #gap; #now; #stamps = [];
  constructor({ windowMs, max, minGapMs, now = () => performance.now() }) {
    this.#win = windowMs; this.#max = max; this.#gap = minGapMs; this.#now = now;
  }
  attempt() {
    const t = this.#now();
    this.#stamps = this.#stamps.filter((s) => t - s < this.#win);
    const last = this.#stamps[this.#stamps.length - 1];
    if (last !== undefined && t - last < this.#gap) {
      return { ok: false, retryAfterMs: Math.ceil(this.#gap - (t - last)) };
    }
    if (this.#stamps.length >= this.#max) {
      return { ok: false, retryAfterMs: Math.ceil(this.#win - (t - this.#stamps[0])) };
    }
    this.#stamps.push(t);
    return { ok: true };
  }
}

/** Clamp any untrusted settings object (e.g. from localStorage) to safe ranges. */
export function sanitizeSettings(raw, L = LIMITS) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hb = toInt(r.heartbeatMs, 0);
  const maxDelay = clamp(toInt(r.maxDelay, 30_000), L.minReconnectDelay, L.maxReconnectDelay);
  const base = clamp(toInt(r.reconnectDelay, 1_000), L.minReconnectDelay, L.maxReconnectDelay);
  return {
    heartbeatMs: hb <= 0 ? 0 : clamp(hb, L.minHeartbeatMs, L.maxHeartbeatMs),
    reconnectDelay: Math.min(base, maxDelay),
    maxDelay,
    maxAttempts: clamp(toInt(r.maxAttempts, 5), 0, L.maxReconnectAttempts),
    maxLogEntries: clamp(toInt(r.maxLogEntries, 500), L.minLogEntries, L.maxLogEntries),
    lang: r.lang === 'bg' || r.lang === 'en' ? r.lang : null,
    protocols: typeof r.protocols === 'string' ? r.protocols.slice(0, 512) : '',
  };
}
