import { LIMITS, validateWsUrl, redactUrl, stripSensitive, sanitizeSettings, parseProtocols } from './security.js';
import { WsClient } from './ws-client.js';
import { LogStore, classifyText } from './log-store.js';
import { LogView } from './entry-list.js';
import { t, setLang, detectLang, getLang } from './i18n.js';
import { load, save, remove } from './storage.js';
import { formatUptime, formatBytes, hexDump, parseHex } from './utils.js';
import { closeCodeKey, frameOverhead } from './protocol-info.js';
import { Session } from './session.js';
import { Sheet } from './sheet.js';
import { Inspector, TABS } from './inspector.js';
import { TemplatePanel } from './templates-ui.js';
import { DiffPanel } from './diff-ui.js';
import { Metrics } from './metrics.js';

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries([
  'status-pill', 'status-text', 'stat-sent', 'stat-recv', 'stat-latency', 'stat-uptime', 'btn-theme', 'btn-settings',
  'filter-text', 'filter-clear', 'filter-count', 'log', 'empty-state', 'url-input', 'btn-connect', 'btn-disconnect',
  'btn-clear', 'btn-export', 'toggle-reconnect', 'msg-type', 'msg-input', 'btn-send', 'settings-overlay',
  'btn-settings-close', 'cfg-lang', 'cfg-heartbeat', 'cfg-reconnect-delay', 'cfg-max-delay', 'cfg-max-attempts',
  'cfg-max-log', 'cfg-protocols', 'btn-clear-history', 'btn-inspect', 'compare-bar', 'btn-compare-cancel', 'diff-overlay', 'btn-diff-close', 'diff-body', 'diff-modes', 'btn-templates', 'tpl-overlay', 'btn-tpl-close', 'tpl-name', 'btn-tpl-save', 'tpl-status', 'tpl-vars', 'tpl-list', 'insp-overlay', 'btn-insp-close', 'insp-body', 'hint-heartbeat', 'hint-attempts', 'limits-text',
].map((id) => [id, $(id)]));

// ── State ────────────────────────────────────────────────────────────────
let settings = sanitizeSettings(load('settings', {}));
setLang(detectLang(settings.lang));
let autoReconnect = load('reconnect', true) !== false;
let sent = 0, recv = 0, connectedAt = 0, uptimeTimer = 0;
const filter = { type: 'all', text: '' };
const msgHistory = []; let histIdx = -1; // in-memory only: may contain secrets

const store = new LogStore(settings.maxLogEntries);
let picks = []; // entry ids selected for comparison
const view = new LogView({ container: el.log, emptyEl: el['empty-state'], onPick: (e) => pick(e) });
const client = new WsClient({
  heartbeatMs: settings.heartbeatMs,
  reconnect: { enabled: autoReconnect, maxAttempts: settings.maxAttempts, baseDelay: settings.reconnectDelay, maxDelay: settings.maxDelay },
});

const app = $('app');
const session = new Session();
const metrics = new Metrics();
const inspector = new Inspector({
  body: el['insp-body'],
  tabButtons: [...document.querySelectorAll('.tab')].filter((b) => TABS.includes(b.dataset.tab)),
  ctx: {
    session: () => session.data,
    metrics: () => metrics,
    client: () => ({ state: client.state, info: client.info }),
    draft: () => {
      const v = validateWsUrl(el['url-input'].value, { pageProtocol: location.protocol });
      const p = parseProtocols(settings.protocols);
      return { url: v.ok ? v.url : '', protocols: p.ok ? p.list : [] };
    },
  },
});

const diffPanel = new DiffPanel({
  overlay: el['diff-overlay'], app, body: el['diff-body'], modesEl: el['diff-modes'], closeBtn: el['btn-diff-close'],
});

const templates = new TemplatePanel({
  overlay: el['tpl-overlay'], app,
  els: { openBtn: el['btn-templates'], closeBtn: el['btn-tpl-close'], list: el['tpl-list'], name: el['tpl-name'], saveBtn: el['btn-tpl-save'], status: el['tpl-status'], vars: el['tpl-vars'] },
  getDraft: () => ({ type: el['msg-type'].value, text: el['msg-input'].value }),
  apply: (type, text) => {
    el['msg-type'].value = type; updatePlaceholder();
    el['msg-input'].value = text; el['msg-input'].focus();
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────
const errText = (e) => t(e.key, {
  ...e,
  seconds: e.retryAfterMs != null ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : '',
  max: e.max != null ? formatBytes(e.max) : '',
  detail: e.detail ?? '',
});

let countQueued = false;
function scheduleCount() {
  if (countQueued) return;
  countQueued = true;
  requestAnimationFrame(() => {
    countQueued = false;
    const active = filter.text || filter.type !== 'all';
    el['filter-count'].textContent = active
      ? `${store.entries.filter((e) => LogStore.matches(e, filter)).length} / ${store.entries.length}` : '';
  });
}

function syncPicks() { view.setPicked(picks); el['compare-bar'].hidden = picks.length !== 1; }
function pick(entry) {
  const i = picks.indexOf(entry.id);
  if (i >= 0) picks.splice(i, 1); else picks.push(entry.id);
  if (picks.length === 2) {
    const [a, b] = picks.map((id) => store.entries.find((x) => x.id === id));
    picks = []; syncPicks();
    if (a && b) diffPanel.show(a, b);
    return;
  }
  syncPicks();
}
el['btn-compare-cancel'].addEventListener('click', () => { picks = []; syncPicks(); });

function addEntry(e) {
  const { entry, dropped } = store.add(e);
  view.remove(dropped);
  if (dropped.length && picks.some((id) => dropped.includes(id))) { picks = picks.filter((id) => !dropped.includes(id)); syncPicks(); }
  view.add(entry, LogStore.matches(entry, filter));
  scheduleCount();
}
const note = (type, tag, raw) => addEntry({ type, tag, kind: 'system', raw });

function logPayload(type, tag, d) {
  const binary = d.kind === 'binary';
  const header = frameOverhead(d.size, type === 'send');
  const op = binary ? '0x2' : '0x1';
  const extra = {
    meta: binary ? 'BINARY' : 'TEXT',
    hint: t('log.frame_hint', { op, header, mask: t(type === 'send' ? 'log.masked' : 'log.unmasked') }),
  };
  if (binary) {
    const more = d.size > d.bytes.length ? `\n… +${d.size - d.bytes.length} B` : '';
    addEntry({ type, tag, kind: 'binary', raw: hexDump(d.bytes) + more, size: d.size, ...extra });
  } else {
    addEntry({ type, tag, kind: classifyText(d.text), raw: d.text, size: d.size, ...extra });
  }
}

function setStatus(state) {
  const pill = el['status-pill'];
  pill.className = 'status-pill';
  if (state === 'open') pill.classList.add('open');
  else if (state === 'connecting' || state === 'closing' || state === 'reconnecting') pill.classList.add('closing');
  el['status-text'].textContent = t(`status.${state}`);
  document.body.dataset.state = state;
  const idle = state === 'idle' || state === 'closed';
  el['btn-connect'].disabled = !idle;
  el['btn-disconnect'].disabled = idle || state === 'closing';
  el['btn-send'].disabled = state !== 'open';
}

function startUptime() {
  stopUptime();
  connectedAt = Date.now();
  const tick = () => { el['stat-uptime'].textContent = formatUptime(Date.now() - connectedAt); };
  tick();
  uptimeTimer = setInterval(tick, 1000);
}
function stopUptime() { clearInterval(uptimeTimer); uptimeTimer = 0; el['stat-uptime'].textContent = '—'; }

// ── Client events ────────────────────────────────────────────────────────
client.on('state', (s) => { setStatus(s); if (s !== 'open') stopUptime(); inspector.touch(true); });
client.on('open', (info) => {
  startUptime();
  session.open(info);
  note('open', 'OPEN', t('info.connected', { url: redactUrl(info.url) }));
  note('info', 'INFO', t('info.handshake', {
    ms: info.connectMs, protocol: info.protocol || t('info.none'), ext: info.extensions || t('info.none'),
  }));
});
client.on('sent', (d) => { session.sent(d.size); metrics.addSent(d.size); inspector.touch(); sent += 1; el['stat-sent'].textContent = String(sent); logPayload('send', d.origin === 'heartbeat' ? 'PING' : 'SEND', d); });
client.on('message', (d) => { session.message(d.size); metrics.addRecv(d.size); inspector.touch(); recv += 1; el['stat-recv'].textContent = String(recv); logPayload('recv', 'RECV', d); });
client.on('latency', ({ ms }) => { metrics.addLatency(ms); el['stat-latency'].textContent = `${ms} ms`; inspector.touch(); });
client.on('error', (e) => note('error', 'ERROR', errText(e)));
client.on('close', (d) => {
  session.close(d);
  note('close', 'CLOSE', t('info.close', {
    code: d.code, reason: d.reason || t('info.none'), clean: d.wasClean, meaning: t(closeCodeKey(d.code)),
  }));
  el['stat-latency'].textContent = '—';
});
client.on('reconnecting', (d) => { session.mark('tl.retry', { attempt: d.attempt }); note('warn', 'RETRY', t('info.retry', d)); });
client.on('reconnect-failed', (d) => note('warn', 'RETRY', t('info.retry_failed', d)));

// ── Connect / disconnect ─────────────────────────────────────────────────
function markUrlError(on) { el['url-input'].classList.toggle('error', on); }

function connect() {
  const v = validateWsUrl(el['url-input'].value, { pageProtocol: location.protocol });
  if (!v.ok) { markUrlError(true); note('error', 'ERROR', errText(v)); return; }
  const pr = parseProtocols(settings.protocols);
  if (!pr.ok) { note('error', 'ERROR', errText(pr)); return; }
  markUrlError(false);
  const r = client.connect(v.url, pr.list);
  if (!r.ok) { note('error', 'ERROR', errText(r.error)); return; }
  session.start(v.url, pr.list);
  metrics.reset();
  save('url', stripSensitive(v.url));
  note('info', 'INFO', t('info.connecting', { url: redactUrl(v.url) }));
}
el['btn-connect'].addEventListener('click', connect);
el['btn-disconnect'].addEventListener('click', () => { if (client.state === 'open') note('info', 'INFO', t('info.closing')); client.disconnect(); });
el['url-input'].addEventListener('input', () => markUrlError(false));
el['url-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !el['btn-connect'].disabled) connect(); });

// ── Sending ──────────────────────────────────────────────────────────────
function updatePlaceholder() {
  const type = el['msg-type'].value;
  const key = type === 'hex' ? 'msg.placeholder_hex' : type === 'ping' ? 'msg.placeholder_ping' : 'msg.placeholder';
  el['msg-input'].placeholder = t(key);
  el['msg-input'].disabled = type === 'ping';
}
el['msg-type'].addEventListener('change', updatePlaceholder);

function sendMessage() {
  const type = el['msg-type'].value;
  let res;
  if (type === 'ping') {
    res = client.ping();
  } else {
    const text = el['msg-input'].value;
    if (!text.trim()) return;
    if (type === 'json') {
      try { JSON.parse(text); } catch (e) { note('error', 'ERROR', t('err.json.invalid', { detail: e.message })); return; }
    }
    let payload = text;
    if (type === 'hex') {
      payload = parseHex(text);
      if (!payload) { note('error', 'ERROR', t('err.hex.invalid')); return; }
    }
    res = client.send(payload);
    if (res.ok) {
      if (msgHistory[0] !== text) msgHistory.unshift(text);
      msgHistory.length = Math.min(msgHistory.length, 50);
      histIdx = -1;
      el['msg-input'].value = '';
    }
  }
  if (!res.ok) note('error', 'ERROR', errText(res.error));
}
el['btn-send'].addEventListener('click', sendMessage);
el['msg-input'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!el['btn-send'].disabled) sendMessage(); return; }
  if (e.key === 'ArrowUp' && msgHistory.length) {
    e.preventDefault(); histIdx = Math.min(histIdx + 1, msgHistory.length - 1); el['msg-input'].value = msgHistory[histIdx];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault(); histIdx = Math.max(histIdx - 1, -1); el['msg-input'].value = histIdx < 0 ? '' : msgHistory[histIdx];
  }
});

// ── Log controls ─────────────────────────────────────────────────────────
function clearLog() { store.clear(); view.clear(); picks = []; syncPicks(); scheduleCount(); }
el['btn-clear'].addEventListener('click', clearLog);
el['btn-export'].addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.export(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ws-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function applyFilter() {
  view.refilter(store.entries, (e) => LogStore.matches(e, filter));
  el['filter-clear'].hidden = !filter.text;
  scheduleCount();
}
el['filter-text'].addEventListener('input', () => { filter.text = el['filter-text'].value.trim(); applyFilter(); });
el['filter-clear'].addEventListener('click', () => { el['filter-text'].value = ''; filter.text = ''; applyFilter(); });
document.querySelectorAll('.filter-type').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.filter-type').forEach((x) => x.classList.toggle('active', x === b));
  filter.type = b.dataset.type; applyFilter();
}));

// ── Reconnect toggle, theme ──────────────────────────────────────────────
function paintToggle() { el['toggle-reconnect'].classList.toggle('on', autoReconnect); el['toggle-reconnect'].setAttribute('aria-checked', String(autoReconnect)); }
function flipReconnect() { autoReconnect = !autoReconnect; save('reconnect', autoReconnect); client.updateOptions({ reconnect: { enabled: autoReconnect } }); paintToggle(); }
el['toggle-reconnect'].addEventListener('click', (e) => { e.preventDefault(); flipReconnect(); });
el['toggle-reconnect'].addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipReconnect(); } });

const savedTheme = load('theme', null);
const lightPref = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.classList.toggle('light', (savedTheme ?? (lightPref ? 'light' : 'dark')) === 'light');
el['btn-theme'].addEventListener('click', () => {
  const light = document.documentElement.classList.toggle('light');
  save('theme', light ? 'light' : 'dark');
});

// ── Settings ─────────────────────────────────────────────────────────────
function fillSettings() {
  el['cfg-lang'].value = getLang();
  el['cfg-heartbeat'].value = settings.heartbeatMs;
  el['cfg-reconnect-delay'].value = settings.reconnectDelay;
  el['cfg-max-delay'].value = settings.maxDelay;
  el['cfg-max-attempts'].value = settings.maxAttempts;
  el['cfg-max-log'].value = settings.maxLogEntries;
  el['cfg-protocols'].value = settings.protocols;
  el['hint-heartbeat'].textContent = t('settings.heartbeat_hint', { min: LIMITS.minHeartbeatMs, max: LIMITS.maxHeartbeatMs });
  el['hint-attempts'].textContent = t('settings.max_attempts_hint', { max: LIMITS.maxReconnectAttempts });
  el['limits-text'].textContent = t('settings.limits_text', {
    rate: LIMITS.sendPerSecond, size: formatBytes(LIMITS.maxSendBytes), conn: LIMITS.maxConnectsPerWindow,
  });
}
const settingsSheet = new Sheet({ overlay: el['settings-overlay'], app, onRequestClose: () => closeSettings() });
function openSettings() { fillSettings(); settingsSheet.open(el['cfg-lang']); }
function closeSettings() {
  settings = sanitizeSettings({
    heartbeatMs: el['cfg-heartbeat'].value, reconnectDelay: el['cfg-reconnect-delay'].value, maxDelay: el['cfg-max-delay'].value,
    maxAttempts: el['cfg-max-attempts'].value, maxLogEntries: el['cfg-max-log'].value, lang: el['cfg-lang'].value,
    protocols: el['cfg-protocols'].value,
  });
  save('settings', settings);
  client.updateOptions({ heartbeatMs: settings.heartbeatMs, reconnect: { maxAttempts: settings.maxAttempts, baseDelay: settings.reconnectDelay, maxDelay: settings.maxDelay } });
  view.remove(store.setMax(settings.maxLogEntries));
  setLang(settings.lang);
  templates.refreshLabels();
  setStatus(client.state);
  inspector.touch(true);
  updatePlaceholder();
  settingsSheet.close();
  scheduleCount();
}
el['btn-settings'].addEventListener('click', openSettings);
el['btn-settings-close'].addEventListener('click', closeSettings);

const inspectSheet = new Sheet({
  overlay: el['insp-overlay'], app,
  onRequestClose: () => { inspector.setOpen(false); inspectSheet.close(); },
});
el['btn-inspect'].addEventListener('click', () => {
  inspectSheet.open(document.querySelector('.tab[aria-selected="true"]'));
  inspector.setOpen(true);
});
el['btn-insp-close'].addEventListener('click', () => inspectSheet.requestClose());
el['btn-clear-history'].addEventListener('click', () => {
  ['url', 'settings', 'reconnect', 'theme', 'templates'].forEach(remove);
  templates.reset();
  note('info', 'INFO', t('settings.cleared'));
});

// ── Global shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); clearLog(); return; }
  if (e.key === 'Escape') {
    if (Sheet.current) Sheet.current.requestClose();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
});

// ── Mobile viewport: keep composer above the on-screen keyboard ──────────
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
if (coarse && window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    if (vv.scale > 1.01) return; // user is pinch-zooming; don't resize the layout
    app.style.height = `${Math.round(vv.height)}px`;
    app.classList.toggle('kbd', vv.height < 480);
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// ── Init ─────────────────────────────────────────────────────────────────
const savedUrl = load('url', '');
if (typeof savedUrl === 'string' && validateWsUrl(savedUrl, { pageProtocol: location.protocol }).ok) el['url-input'].value = savedUrl;
paintToggle(); updatePlaceholder(); setStatus(client.state);

// ── PWA: only in production builds (the build script stamps this meta tag) ──
if ('serviceWorker' in navigator && document.querySelector('meta[name="wsd-build"]')) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* needs HTTPS or localhost */ }); });
}
