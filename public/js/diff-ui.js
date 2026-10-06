// Message comparison sheet. All message content is rendered through textContent.
import { t } from './i18n.js';
import { Sheet } from './sheet.js';
import { lineDiff, tokenDiff, jsonDiff, collapse, summarize } from './diff.js';
import { formatBytes, formatTime } from './utils.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const pretty = (e) => {
  if (e.kind !== 'json' || e.truncated) return e.raw;
  try { return JSON.stringify(JSON.parse(e.raw), null, 2); } catch { return e.raw; }
};
const fmt = (v) => { const s = JSON.stringify(v); return s.length > 300 ? `${s.slice(0, 300)}…` : s; };

export function availableModes(a, b) {
  if (a.kind === 'json' && b.kind === 'json' && !a.truncated && !b.truncated) return ['structure', 'lines'];
  if (a.kind !== 'binary' && b.kind !== 'binary' && !a.raw.includes('\n') && !b.raw.includes('\n')) return ['inline', 'lines'];
  return ['lines'];
}

export class DiffPanel {
  #sheet; #body; #modesEl; #closeBtn; #a; #b; #avail = []; #mode = 'lines';

  constructor({ overlay, app, body, modesEl, closeBtn }) {
    this.#body = body; this.#modesEl = modesEl; this.#closeBtn = closeBtn;
    this.#sheet = new Sheet({ overlay, app });
    closeBtn.addEventListener('click', () => this.#sheet.requestClose());
  }

  show(a, b) {
    this.#a = a; this.#b = b;
    this.#avail = availableModes(a, b);
    this.#mode = this.#avail[0];
    this.#renderModes();
    this.#render();
    this.#sheet.open(this.#avail.length > 1 ? this.#modesEl.querySelector('button') : this.#closeBtn);
  }

  #renderModes() {
    const box = this.#modesEl;
    box.textContent = '';
    box.hidden = this.#avail.length < 2;
    for (const m of this.#avail) {
      const b = h('button', 'tab', t(`diff.mode.${m}`));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(m === this.#mode));
      b.addEventListener('click', () => {
        this.#mode = m;
        box.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-selected', String(this.#avail[i] === m)));
        this.#render();
      });
      box.append(b);
    }
  }

  #meta(labelKey, e) {
    const d = h('div', 'diff-meta-item');
    d.append(h('strong', null, t(labelKey)), h('span', null, [e.tag, formatTime(e.ts), e.size != null ? formatBytes(e.size) : ''].filter(Boolean).join(' · ')));
    return d;
  }

  #render() {
    const a = this.#a, b = this.#b, body = this.#body;
    body.textContent = '';
    const meta = h('div', 'diff-meta');
    meta.append(this.#meta('diff.a', a), this.#meta('diff.b', b));
    body.append(meta);
    if (a.truncated || b.truncated) body.append(h('p', 'muted', t('diff.truncated_msg')));

    if (this.#mode === 'structure') {
      let r;
      try { r = jsonDiff(JSON.parse(a.raw), JSON.parse(b.raw)); } catch { this.#mode = 'lines'; this.#render(); return; }
      if (!r.changes.length) { body.append(h('p', 'diff-identical', t('diff.identical'))); return; }
      body.append(h('p', 'diff-summary', t('diff.count', { n: r.changes.length })));
      for (const c of r.changes) {
        const row = h('div', `diff-row ${c.kind}`);
        const head = h('div', 'diff-row-head');
        head.append(h('span', 'diff-kind', t(`diff.${c.kind}`)), h('code', 'diff-path', c.path));
        row.append(head);
        if (c.kind !== 'added') row.append(h('div', 'diff-del', `- ${fmt(c.before)}`));
        if (c.kind !== 'removed') row.append(h('div', 'diff-add', `+ ${fmt(c.after)}`));
        body.append(row);
      }
      if (r.truncated) body.append(h('p', 'muted', t('diff.limit', { n: r.changes.length })));
      return;
    }

    const r = this.#mode === 'inline' ? tokenDiff(a.raw, b.raw) : lineDiff(pretty(a), pretty(b));
    if (r.ops.every((o) => o.type === 'same')) { body.append(h('p', 'diff-identical', t('diff.identical'))); return; }
    const s = summarize(r.ops);
    body.append(h('p', 'diff-summary', t('diff.summary', { add: s.add, del: s.del })));
    if (r.approximate || r.capped) body.append(h('p', 'muted', t('diff.approx')));
    if (this.#mode === 'inline') {
      const p = h('p', 'diff-inline');
      for (const o of r.ops) {
        if (o.type === 'same') p.append(o.text);
        else p.append(h('span', o.type === 'add' ? 'diff-add' : 'diff-del', o.text));
      }
      body.append(p);
      return;
    }
    const box = h('div', 'diff-lines');
    const prefix = { same: '  ', add: '+ ', del: '- ' };
    for (const o of collapse(r.ops, 2)) {
      if (o.type === 'skip') box.append(h('div', 'diff-skip', t('diff.skipped', { n: o.count })));
      else box.append(h('div', `diff-line diff-${o.type}`, prefix[o.type] + o.text));
    }
    body.append(box);
  }
}
