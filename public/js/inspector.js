// Inspector sheet: live connection facts, handshake preview, learning topics, close-code reference.
// All dynamic text goes through textContent (server-provided values are untrusted).
import { t } from './i18n.js';
import { redactUrl } from './security.js';
import { formatBytes, formatUptime } from './utils.js';
import { CLOSE_CODES, CODE_NAMES, closeCodeKey, buildHandshakePreview, computeAccept, randomKey } from './protocol-info.js';

export const TABS = ['conn', 'handshake', 'learn', 'codes'];
export const LEARN_TOPICS = ['what', 'handshake', 'frames', 'masking', 'pingpong', 'subproto', 'ext', 'close', 'tls', 'origin', 'limits'];

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Inspector {
  #body; #tabBtns; #ctx; #tab = 'conn'; #open = false; #timer = 0; #raf = 0; #renderId = 0;

  /** ctx: { session(): data|null, client(): {state, info}, draft(): {url, protocols} } */
  constructor({ body, tabButtons, ctx }) {
    this.#body = body; this.#tabBtns = tabButtons; this.#ctx = ctx;
    tabButtons.forEach((b, i) => {
      b.addEventListener('click', () => this.selectTab(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = tabButtons[(i + d + tabButtons.length) % tabButtons.length];
        n.focus(); this.selectTab(n.dataset.tab);
      });
    });
  }

  get tab() { return this.#tab; }
  setOpen(v) {
    this.#open = v;
    clearInterval(this.#timer); this.#timer = 0;
    if (v) { this.refresh(); this.#timer = setInterval(() => { if (this.#tab === 'conn') this.refresh(); }, 1000); }
  }
  selectTab(name) {
    if (!TABS.includes(name)) return;
    this.#tab = name;
    this.#tabBtns.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.#body.scrollTop = 0;
    if (this.#open) this.refresh();
  }
  /** Called on every event; `structural` = open/close/state changes. */
  touch(structural = false) {
    if (!this.#open || this.#raf) return;
    if (this.#tab !== 'conn' && !(structural && this.#tab !== 'learn')) return;
    this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.refresh(); });
  }

  refresh() {
    const id = ++this.#renderId;
    const keep = this.#body.scrollTop;
    this.#body.textContent = '';
    const render = { conn: () => this.#conn(), handshake: () => this.#handshake(id), learn: () => this.#learn(), codes: () => this.#codes() }[this.#tab];
    render();
    this.#body.scrollTop = keep;
  }

  #conn() {
    const root = this.#body;
    const d = this.#ctx.session();
    if (!d) { root.append(h('p', 'muted', t('insp.none'))); return; }
    let u = null;
    try { u = new URL(d.url); } catch { /* shown raw below */ }
    const secure = u?.protocol === 'wss:';
    const c = this.#ctx.client();
    const now = Date.now();
    const up = d.openedAt !== null ? (d.closedAt ?? now) - d.openedAt : null;
    const dash = '—';
    const msgs = (n, b) => t('insp.msgs', { n, size: formatBytes(b) });
    const rows = [
      ['insp.url', redactUrl(d.url)],
      ['insp.tls', secure ? t('insp.tls_yes') : t('insp.tls_no')],
      ['insp.host', u?.hostname ?? dash],
      ['insp.port', u ? (u.port || `${secure ? 443 : 80} ${t('insp.default')}`) : dash],
      ['insp.path', u?.pathname ?? dash],
      ['insp.query', u && u.search ? redactUrl(u.search) : dash],
      ['insp.state', t(`status.${c.state}`)],
      ['insp.offered', d.protocols.join(', ') || dash],
      ['insp.protocol', d.protocol || dash],
      ['insp.extensions', d.extensions || dash],
      ['insp.binary', t('insp.binary_val')],
      ['insp.handshake_ms', d.connectMs != null ? `${d.connectMs} ms` : dash],
      ['insp.ttfm', d.firstMsgAt !== null && d.openedAt !== null ? `${d.firstMsgAt - d.openedAt} ms` : dash],
      ['insp.uptime', up !== null ? formatUptime(up) : dash],
      ['insp.sent', msgs(d.sentMsgs, d.sentBytes)],
      ['insp.recv', msgs(d.recvMsgs, d.recvBytes)],
      ['insp.buffered', formatBytes(c.info.bufferedAmount)],
      ['insp.lastclose', d.lastClose ? `${d.lastClose.code} · ${t(closeCodeKey(d.lastClose.code))}` : dash],
    ];
    const dl = h('dl', 'kv');
    for (const [k, v] of rows) { dl.append(h('dt', null, t(k)), h('dd', null, v)); }
    root.append(dl, h('h3', 'section-title', t('insp.timeline')));
    const ol = h('ol', 'timeline');
    for (const ev of d.timeline) {
      const li = h('li');
      li.append(h('time', null, `+${ev.ts - d.startedAt} ms`), h('span', null, t(ev.key, ev.params)));
      ol.append(li);
    }
    root.append(ol);
  }

  async #handshake(id) {
    const d = this.#ctx.session();
    const draft = this.#ctx.draft();
    const url = d?.url ?? draft.url;
    const key = randomKey();
    const accept = key ? await computeAccept(key) : null;
    if (id !== this.#renderId) return; // a newer render replaced this one
    const origin = typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : '';
    const prev = url ? buildHandshakePreview({
      url, origin, protocols: d?.protocols ?? draft.protocols, key: key ?? dashKey(), accept: accept ?? t('hs.accept_na'),
      observed: { protocol: d?.protocol, extensions: d?.extensions },
      labels: { key: t('hs.c_key'), origin: t('hs.c_origin'), ext: t('hs.c_ext'), accept: t('hs.c_accept'), observed: t('hs.c_observed') },
    }) : null;
    if (!prev) { this.#body.append(h('p', 'muted', t('hs.no_url'))); return; }
    this.#body.append(
      h('h3', 'section-title', t('hs.request')), h('pre', 'code', prev.request),
      h('h3', 'section-title', t('hs.response')), h('pre', 'code', prev.response),
    );
    const ul = h('ul', 'notes');
    ['hs.note1', 'hs.note2', 'hs.note3'].forEach((k) => ul.append(h('li', null, t(k))));
    this.#body.append(ul);
  }

  #learn() {
    for (const k of LEARN_TOPICS) {
      const det = h('details', 'learn');
      det.append(h('summary', null, t(`learn.${k}.title`)), h('p', null, t(`learn.${k}.body`)));
      this.#body.append(det);
    }
  }

  #codes() {
    this.#body.append(h('p', 'muted', t('codes.intro')));
    const last = this.#ctx.session()?.lastClose?.code;
    const list = h('div', 'codes');
    const add = (code, label, key) => {
      const row = h('div', `code-row${code === last ? ' hl' : ''}`);
      row.append(h('span', 'code-num', String(code)), h('span', 'code-name', label), h('span', 'code-desc', t(key)));
      list.append(row);
    };
    for (const code of CLOSE_CODES) add(code, nameOf(code), `code.${code}`);
    add('3000–3999', 'IANA', 'code.3xxx');
    add('4000–4999', 'Private', 'code.4xxx');
    this.#body.append(list);
  }
}

const nameOf = (code) => CODE_NAMES[code];
const dashKey = () => '—';
