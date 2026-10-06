// Inspector sheet: live connection facts, handshake preview, learning topics, close-code reference.
// All dynamic text goes through textContent (server-provided values are untrusted).
import { t } from './i18n.js';
import { redactUrl } from './security.js';
import { formatBytes, formatUptime } from './utils.js';
import { lineChart, niceMax } from './charts.js';
import { latencyStats } from './metrics.js';
import { CLOSE_CODES, CODE_NAMES, closeCodeKey, buildHandshakePreview, computeAccept, randomKey } from './protocol-info.js';

export const TABS = ['conn', 'charts', 'handshake', 'learn', 'codes'];
const LIVE = ['conn', 'charts'];
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
    if (v) { this.refresh(); this.#timer = setInterval(() => { if (LIVE.includes(this.#tab)) this.refresh(); }, 1000); }
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
    if (!LIVE.includes(this.#tab) && !(structural && this.#tab !== 'learn')) return;
    this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.refresh(); });
  }

  refresh() {
    const id = ++this.#renderId;
    const keep = this.#body.scrollTop;
    this.#body.textContent = '';
    const render = { conn: () => this.#conn(), charts: () => this.#charts(), handshake: () => this.#handshake(id), learn: () => this.#learn(), codes: () => this.#codes() }[this.#tab];
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

  #charts() {
    const root = this.#body;
    const m = this.#ctx.metrics();
    if (!this.#ctx.session()) { root.append(h('p', 'muted', t('chart.no_conn'))); return; }
    const now = Date.now();
    const ago = (ms) => (ms < 1500 ? t('chart.now') : t('chart.ago', { s: Math.round(ms / 1000) }));
    const stats = latencyStats(m.latency);
    root.append(h('h3', 'section-title', t('chart.latency')), h('p', 'muted', t('chart.latency_hint')));
    if (!stats) {
      root.append(h('p', 'muted', t('chart.no_latency')));
    } else {
      const ms = (v) => `${Math.round(v * 10) / 10} ms`;
      const dl = h('dl', 'kv');
      for (const [k, v] of [['chart.last', stats.last], ['chart.min', stats.min], ['chart.avg', stats.avg], ['chart.p95', stats.p95], ['chart.max', stats.max], ['chart.jitter', stats.jitter]]) {
        dl.append(h('dt', null, t(k)), h('dd', null, ms(v)));
      }
      dl.append(h('dt', null, t('chart.samples')), h('dd', null, String(stats.n)));
      const t0 = m.latency[0].t, t1 = m.latency[m.latency.length - 1].t, span = Math.max(t1 - t0, 1);
      const points = m.latency.map((x) => ({ x: m.latency.length === 1 ? 0.5 : (x.t - t0) / span, y: x.ms }));
      root.append(dl, lineChart({
        series: [{ cls: 'latency', points, dots: true }], yMax: niceMax(stats.max), yFormat: (v) => String(Math.round(v)),
        xLabels: [ago(now - t0), ago(now - t1)], label: t('chart.aria_latency', { n: stats.n, last: Math.round(stats.last) }),
      }));
    }
    const s = m.series(60, now);
    const pts = (vals) => vals.map((y, i) => ({ x: i / 59, y }));
    const legend = () => {
      const l = h('div', 'legend');
      for (const [cls, key] of [['sent', 'chart.sent'], ['recv', 'chart.recv']]) {
        const item = h('span');
        item.append(h('span', `swatch ${cls}`), t(key));
        l.append(item);
      }
      return l;
    };
    const xl = [t('chart.ago', { s: 59 }), t('chart.now')];
    root.append(
      h('h3', 'section-title', t('chart.msgs')), legend(),
      lineChart({
        series: [{ cls: 'sent', points: pts(s.sentMsgs) }, { cls: 'recv', points: pts(s.recvMsgs) }],
        yMax: niceMax(Math.max(1, ...s.sentMsgs, ...s.recvMsgs)), yFormat: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
        xLabels: xl, label: t('chart.aria_rate'),
      }),
      h('h3', 'section-title', t('chart.bytes')), legend(),
      lineChart({
        series: [{ cls: 'sent', points: pts(s.sentBytes) }, { cls: 'recv', points: pts(s.recvBytes) }],
        yMax: niceMax(Math.max(10, ...s.sentBytes, ...s.recvBytes)), yFormat: (v) => formatBytes(Math.round(v)),
        xLabels: xl, label: t('chart.aria_rate'),
      }),
    );
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
