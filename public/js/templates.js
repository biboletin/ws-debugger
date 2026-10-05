// Message templates: validation, secret screening and {{variable}} expansion. DOM-free.
export const MAX_TEMPLATES = 30;
export const MAX_NAME = 40;
export const MAX_TEXT = 4096;
export const VARS = Object.freeze(['uuid', 'timestamp', 'iso', 'counter']);
const TYPES = ['raw', 'json', 'hex'];

const SECRET_PATTERNS = [
  /["']?(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|authorization|private[-_]?key|access[-_]?key)["']?\s*[:=]\s*\S/i,
  /bearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
];
export const containsSecret = (text) => SECRET_PATTERNS.some((re) => re.test(text));

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fail = (key, extra = {}) => ({ ok: false, error: { key, ...extra } });

/** Clamp untrusted stored data (localStorage may be tampered with). */
export function sanitizeTemplates(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, MAX_NAME) : '';
    const text = typeof r.text === 'string' ? r.text : '';
    const id = typeof r.id === 'string' && /^[a-z0-9]{1,40}$/.test(r.id) ? r.id : '';
    if (!name || !text || text.length > MAX_TEXT || !TYPES.includes(r.type) || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, type: r.type, text });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** Adds (or replaces a template with the same name, case-insensitive). */
export function addTemplate(list, { name, type, text }, makeId = newId) {
  const n = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!n) return fail('tpl.no_name');
  if (type === 'ping') return fail('tpl.ping');
  if (!TYPES.includes(type)) return fail('tpl.empty_msg');
  if (!String(text ?? '').trim()) return fail('tpl.empty_msg');
  if (text.length > MAX_TEXT) return fail('tpl.too_long', { max: '4 KB' });
  if (containsSecret(text)) return fail('tpl.secret');
  const i = list.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
  if (i < 0 && list.length >= MAX_TEMPLATES) return fail('tpl.full', { max: MAX_TEMPLATES });
  const item = { id: i >= 0 ? list[i].id : makeId(), name: n, type, text };
  const next = list.slice();
  if (i >= 0) next[i] = item; else next.push(item);
  return { ok: true, list: next };
}

export const removeTemplate = (list, id) => list.filter((x) => x.id !== id);

function fallbackUuid(c) {
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const defaultUuid = () => {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : c?.getRandomValues ? fallbackUuid(c) : '00000000-0000-4000-8000-000000000000';
};

/** Replaces {{uuid}} {{timestamp}} {{iso}} {{counter}}; unknown placeholders stay untouched. */
export function expandVars(text, { now = Date.now(), counter = 0, uuid = defaultUuid } = {}) {
  return text.replace(/\{\{(uuid|timestamp|iso|counter)\}\}/g, (_, k) => {
    if (k === 'uuid') return uuid();
    if (k === 'timestamp') return String(now);
    if (k === 'iso') return new Date(now).toISOString();
    return String(counter);
  });
}
