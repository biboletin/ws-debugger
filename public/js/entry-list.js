// DOM rendering of log entries. Server data is untrusted: only textContent / text nodes are used.
import { t } from './i18n.js';
import { formatTime, formatBytes } from './utils.js';

const PREVIEW = 8000;
const TOKEN = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}[\],:])/g;

function tokenClass(tok, isKey) {
  if (tok[0] === '"') return isKey ? 'json-key' : 'json-str';
  if (tok === 'true' || tok === 'false') return 'json-bool';
  if (tok === 'null') return 'json-null';
  if (/^[{}[\],:]$/.test(tok)) return 'json-punct';
  return 'json-num';
}

function renderJson(parent, text) {
  let pretty;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { parent.append(text); return; }
  let last = 0;
  for (const m of pretty.matchAll(TOKEN)) {
    if (m.index > last) parent.append(pretty.slice(last, m.index));
    const isKey = Boolean(m[2]);
    const tok = isKey ? m[0].replace(/\s*:$/, '') : m[0];
    const s = document.createElement('span');
    s.className = tokenClass(tok, isKey);
    s.textContent = tok;
    parent.append(s);
    last = m.index + tok.length;
  }
  if (last < pretty.length) parent.append(pretty.slice(last));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-copy';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

export class LogView {
  #box; #empty; #els = new Map(); #queue = []; #raf = 0;
  constructor({ container, emptyEl }) { this.#box = container; this.#empty = emptyEl; }

  add(entry, visible = true) {
    this.#queue.push({ entry, visible });
    if (!this.#raf) this.#raf = requestAnimationFrame(() => this.#flush());
  }

  remove(ids) {
    if (!ids.length) return;
    const set = new Set(ids);
    this.#queue = this.#queue.filter((q) => !set.has(q.entry.id));
    for (const id of ids) { this.#els.get(id)?.remove(); this.#els.delete(id); }
    this.#syncEmpty();
  }

  clear() {
    this.#queue = [];
    for (const el of this.#els.values()) el.remove();
    this.#els.clear();
    this.#syncEmpty();
  }

  refilter(entries, pred) {
    for (const e of entries) this.#els.get(e.id)?.classList.toggle('hidden', !pred(e));
  }

  #syncEmpty() { this.#empty.hidden = this.#els.size > 0 || this.#queue.length > 0; }

  #flush() {
    this.#raf = 0;
    const box = this.#box;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const frag = document.createDocumentFragment();
    for (const { entry, visible } of this.#queue) {
      const el = this.#build(entry);
      if (!visible) el.classList.add('hidden');
      this.#els.set(entry.id, el);
      frag.append(el);
    }
    this.#queue = [];
    box.append(frag);
    if (nearBottom) box.scrollTop = box.scrollHeight;
    this.#syncEmpty();
  }

  #build(entry) {
    const el = document.createElement('div');
    el.className = `entry ${entry.type}`;
    el.dataset.id = String(entry.id);
    const mk = (cls, text) => { const s = document.createElement('span'); s.className = cls; if (text != null) s.textContent = text; return s; };
    const body = mk('entry-body');
    this.#fillBody(body, entry, false);
    const copy = mk('entry-copy');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('log.copy');
    btn.setAttribute('aria-label', t('log.copy_aria'));
    btn.addEventListener('click', async () => {
      if (await copyText(entry.raw)) {
        btn.textContent = t('log.copied');
        setTimeout(() => { btn.textContent = t('log.copy'); }, 1200);
      }
    });
    copy.append(btn);
    el.append(mk('entry-ts', formatTime(entry.ts)), mk('entry-tag', entry.tag), body, copy);
    return el;
  }

  #fillBody(body, entry, full) {
    body.textContent = '';
    const long = entry.raw.length > PREVIEW && !full;
    if (entry.kind === 'json' && !long) renderJson(body, entry.raw);
    else body.append(long ? entry.raw.slice(0, PREVIEW) : entry.raw);
    if (entry.truncated && (full || !long)) body.append(t('log.truncated', { max: entry.raw.length }));
    if (long) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'entry-more';
      more.textContent = t('log.show_all', { size: formatBytes(entry.raw.length) });
      more.addEventListener('click', () => this.#fillBody(body, entry, true));
      body.append(' ', more);
    }
    if (entry.size != null) {
      const m = document.createElement('span');
      m.className = 'entry-meta';
      m.textContent = entry.meta ? `${entry.meta} · ${formatBytes(entry.size)}` : formatBytes(entry.size);
      if (entry.hint) m.title = entry.hint;
      body.append(' ', m);
    }
  }
}
