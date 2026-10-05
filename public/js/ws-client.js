// WebSocket engine. DOM-free; every socket is tagged with a generation id so
// events from replaced/closed sockets can never leak into the current session.
import { LIMITS, RateLimiter, ConnectionGuard, sanitizeSettings } from './security.js';

const enc = new TextEncoder();
export const utf8Length = (s) => enc.encode(s).length;
const PREVIEW_BYTES = 512;

export class WsClient {
  #L; #WS; #now;
  #o = { enabled: true, maxAttempts: 5, baseDelay: 1000, maxDelay: 30000, heartbeatMs: 0 };
  #ws = null; #gen = 0; #state = 'idle'; #url = ''; #protocols = [];
  #attempt = 0; #manual = false; #retryTimer = null; #hbTimer = null;
  #pingAt = null; #t0 = 0; #connectMs = null; #opened = false; #connTimer = null;
  #ls = new Map(); #limiter; #guard;

  constructor({ reconnect = {}, heartbeatMs = 0, limits = LIMITS, WebSocketImpl, now } = {}) {
    this.#L = limits;
    this.#WS = WebSocketImpl ?? globalThis.WebSocket;
    this.#now = now ?? (() => performance.now());
    this.#limiter = new RateLimiter({ capacity: limits.sendBurst, refillPerSec: limits.sendPerSecond, now: this.#now });
    this.#guard = new ConnectionGuard({
      windowMs: limits.connectWindowMs, max: limits.maxConnectsPerWindow,
      minGapMs: limits.minConnectGapMs, now: this.#now,
    });
    this.updateOptions({ reconnect, heartbeatMs });
  }

  get state() { return this.#state; }
  get limits() { return this.#L; }
  get info() {
    const ws = this.#ws;
    return {
      url: this.#url, state: this.#state, protocol: ws?.protocol ?? '', extensions: ws?.extensions ?? '',
      bufferedAmount: ws?.bufferedAmount ?? 0, connectMs: this.#connectMs, attempt: this.#attempt,
    };
  }

  on(evt, fn) {
    if (!this.#ls.has(evt)) this.#ls.set(evt, new Set());
    this.#ls.get(evt).add(fn);
    return () => this.#ls.get(evt)?.delete(fn);
  }
  #emit(evt, data) {
    for (const fn of this.#ls.get(evt) ?? []) {
      try { fn(data); } catch (e) { console.error(`[ws-client] listener for "${evt}" threw`, e); }
    }
  }
  #setState(s) {
    if (s === this.#state) return;
    this.#state = s;
    this.#emit('state', s);
  }

  updateOptions({ reconnect, heartbeatMs } = {}) {
    const cur = this.#o;
    const s = sanitizeSettings({
      heartbeatMs: heartbeatMs ?? cur.heartbeatMs,
      reconnectDelay: reconnect?.baseDelay ?? cur.baseDelay,
      maxDelay: reconnect?.maxDelay ?? cur.maxDelay,
      maxAttempts: reconnect?.maxAttempts ?? cur.maxAttempts,
    }, this.#L);
    const hbChanged = s.heartbeatMs !== cur.heartbeatMs;
    this.#o = {
      enabled: reconnect?.enabled ?? cur.enabled,
      maxAttempts: s.maxAttempts, baseDelay: s.reconnectDelay, maxDelay: s.maxDelay, heartbeatMs: s.heartbeatMs,
    };
    if (hbChanged && this.#state === 'open') { this.#stopHeartbeat(); this.#startHeartbeat(); }
  }

  /** @returns {{ok:true}|{ok:false,error:{key:string}}} */
  connect(url, protocols = []) {
    const g = this.#guard.attempt();
    if (!g.ok) return { ok: false, error: { key: 'err.rate.connect', retryAfterMs: g.retryAfterMs } };
    this.#manual = false;
    this.#attempt = 0;
    return this.#open(url, protocols);
  }

  #open(url, protocols) {
    this.#teardown();
    const gen = ++this.#gen;
    this.#url = url; this.#protocols = protocols;
    this.#setState('connecting');
    this.#t0 = this.#now(); this.#connectMs = null; this.#opened = false;
    let ws;
    try {
      ws = new this.#WS(url, protocols);
    } catch (e) {
      this.#setState('closed');
      const error = { key: 'err.ws.construct', detail: String(e?.message ?? e) };
      this.#emit('error', error);
      return { ok: false, error };
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    let done = false;
    const finish = (e) => {
      if (done || gen !== this.#gen) return;
      done = true;
      clearTimeout(this.#connTimer); this.#connTimer = null;
      this.#stopHeartbeat();
      this.#ws = null;
      const wasOpen = this.#opened;
      this.#opened = false;
      this.#emit('close', { code: e.code, reason: e.reason, wasClean: e.wasClean, wasOpen });
      if (this.#manual) { this.#setState('closed'); return; }
      this.#scheduleReconnect();
    };
    // Some runtimes never fire "close" after a failed handshake, and blackholed hosts
    // can hang for minutes: synthesise a 1006 close so state and reconnect stay consistent.
    const synthesise = (reason) => {
      if (done || gen !== this.#gen) return;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* ignore */ }
      finish({ code: 1006, reason, wasClean: false });
    };
    this.#connTimer = setTimeout(() => {
      if (done || gen !== this.#gen) return;
      this.#emit('error', { key: 'err.ws.timeout', ms: this.#L.connectTimeoutMs });
      synthesise('connect timeout');
    }, this.#L.connectTimeoutMs);

    ws.onopen = () => {
      if (gen !== this.#gen) return;
      clearTimeout(this.#connTimer); this.#connTimer = null;
      this.#attempt = 0; this.#opened = true;
      this.#connectMs = Math.round(this.#now() - this.#t0);
      this.#setState('open');
      this.#startHeartbeat();
      this.#emit('open', this.info);
    };
    ws.onmessage = (e) => {
      if (gen !== this.#gen) return;
      const d = this.#describe(e.data);
      if (d.kind === 'text' && d.size <= 4096 && d.text.charCodeAt(0) === 123 && this.#pingAt !== null) {
        try {
          if (JSON.parse(d.text)?.type === 'pong') {
            const ms = Math.round(this.#now() - this.#pingAt);
            this.#pingAt = null;
            this.#emit('latency', { ms });
          }
        } catch { /* not JSON, ignore */ }
      }
      this.#emit('message', d);
    };
    ws.onerror = () => {
      if (gen !== this.#gen) return;
      // Browsers deliberately hide error details (anti network-probing).
      this.#emit('error', { key: 'err.ws.generic', readyState: ws.readyState });
      if (!this.#opened) {
        clearTimeout(this.#connTimer);
        this.#connTimer = setTimeout(() => synthesise(''), 250);
      }
    };
    ws.onclose = (e) => finish(e);
    return { ok: true };
  }

  #teardown() {
    clearTimeout(this.#retryTimer); this.#retryTimer = null;
    clearTimeout(this.#connTimer); this.#connTimer = null;
    this.#stopHeartbeat();
    const old = this.#ws;
    this.#ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try { old.close(); } catch { /* already closed */ }
    }
  }

  #scheduleReconnect() {
    const o = this.#o;
    if (!o.enabled || this.#attempt >= o.maxAttempts) {
      this.#setState('closed');
      if (o.enabled && o.maxAttempts > 0) this.#emit('reconnect-failed', { attempts: this.#attempt });
      return;
    }
    const base = Math.min(o.baseDelay * 2 ** this.#attempt, o.maxDelay);
    const delay = Math.min(Math.round(base * (0.8 + Math.random() * 0.4)), o.maxDelay);
    this.#attempt += 1;
    this.#setState('reconnecting');
    this.#emit('reconnecting', { attempt: this.#attempt, max: o.maxAttempts, delay });
    this.#armRetry(delay);
  }
  #armRetry(delay) {
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#manual) return;
      const g = this.#guard.attempt();
      if (!g.ok) { this.#armRetry(g.retryAfterMs); return; }
      this.#open(this.#url, this.#protocols);
    }, delay);
  }

  disconnect() {
    this.#manual = true;
    clearTimeout(this.#retryTimer); this.#retryTimer = null;
    this.#stopHeartbeat();
    const ws = this.#ws;
    if (ws && this.#state === 'connecting') {
      // Abort a pending handshake locally; don't wait for a close event that may never come.
      this.#teardown();
      this.#emit('close', { code: 1006, reason: 'aborted by user', wasClean: false, wasOpen: false });
      this.#setState('closed');
      return;
    }
    if (!ws) {
      if (this.#state !== 'idle') this.#setState('closed');
      return;
    }
    this.#setState('closing');
    try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
  }

  destroy() {
    this.disconnect();
    this.#teardown();
    this.#gen += 1;
    this.#ls.clear();
  }

  /** @param {string|Uint8Array} data */
  send(data, { origin = 'user' } = {}) {
    const ws = this.#ws;
    if (this.#state !== 'open' || !ws || ws.readyState !== 1) return { ok: false, error: { key: 'err.send.notopen' } };
    const isText = typeof data === 'string';
    if (!isText && !(data instanceof Uint8Array)) return { ok: false, error: { key: 'err.send.type' } };
    const size = isText ? utf8Length(data) : data.byteLength;
    if (size > this.#L.maxSendBytes) return { ok: false, error: { key: 'err.send.toolarge', max: this.#L.maxSendBytes } };
    if (ws.bufferedAmount > this.#L.maxBuffered) return { ok: false, error: { key: 'err.send.backpressure' } };
    if (!this.#limiter.take()) {
      return { ok: false, error: { key: 'err.send.rate', retryAfterMs: this.#limiter.retryAfterMs() } };
    }
    try { ws.send(data); } catch (e) {
      return { ok: false, error: { key: 'err.ws.construct', detail: String(e?.message ?? e) } };
    }
    this.#emit('sent', isText
      ? { kind: 'text', size, text: data, origin }
      : { kind: 'binary', size, bytes: data.slice(0, PREVIEW_BYTES), origin });
    return { ok: true, size };
  }

  /** Application-level ping: {"type":"ping"}; latency measured if peer answers {"type":"pong"}. */
  ping(origin = 'user') {
    const r = this.send(JSON.stringify({ type: 'ping', t: Date.now() }), { origin });
    if (r.ok) this.#pingAt = this.#now();
    return r;
  }

  #describe(data) {
    if (typeof data === 'string') return { kind: 'text', size: utf8Length(data), text: data };
    const u8 = new Uint8Array(data);
    return { kind: 'binary', size: u8.byteLength, bytes: u8.slice(0, PREVIEW_BYTES) };
  }
  #startHeartbeat() {
    const ms = this.#o.heartbeatMs;
    if (!ms) return;
    this.#hbTimer = setInterval(() => { this.ping('heartbeat'); }, ms);
  }
  #stopHeartbeat() {
    clearInterval(this.#hbTimer); this.#hbTimer = null; this.#pingAt = null;
  }
}
