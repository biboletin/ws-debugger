import { LIMITS } from './security.js';

let seq = 0;
const GROUPS = { errors: ['error', 'warn'], info: ['info', 'open', 'close'] };

/** 'json' only for objects/arrays; scalars stay plain text. */
export function classifyText(text) {
  if (text.length > LIMITS.maxStoredPayload) return 'text';
  const c = text.trimStart()[0];
  if (c !== '{' && c !== '[') return 'text';
  try { JSON.parse(text); return 'json'; } catch { return 'text'; }
}

export class LogStore {
  #max;
  entries = [];
  constructor(max = 500) { this.#max = max; }

  setMax(n) { this.#max = n; return this.#trim(); }

  add(e) {
    const entry = { id: ++seq, ts: Date.now(), truncated: false, size: null, ...e };
    if (typeof entry.raw === 'string' && entry.raw.length > LIMITS.maxStoredPayload) {
      entry.raw = entry.raw.slice(0, LIMITS.maxStoredPayload);
      entry.truncated = true;
      if (entry.kind === 'json') entry.kind = 'text';
    }
    this.entries.push(entry);
    return { entry, dropped: this.#trim() };
  }

  #trim() {
    const dropped = [];
    while (this.entries.length > this.#max) dropped.push(this.entries.shift().id);
    return dropped;
  }

  clear() { this.entries = []; }

  static matches(entry, { type = 'all', text = '' } = {}) {
    if (type !== 'all') {
      const allowed = GROUPS[type] ?? [type];
      if (!allowed.includes(entry.type)) return false;
    }
    return !text || entry.raw.toLowerCase().includes(text.toLowerCase());
  }

  export() {
    return this.entries.map((e) => ({
      time: new Date(e.ts).toISOString(), type: e.type, tag: e.tag, kind: e.kind,
      size: e.size, data: e.raw, truncated: e.truncated,
    }));
  }
}
