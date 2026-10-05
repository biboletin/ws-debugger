// Live per-connection facts for the Inspector. Pure data; main.js feeds it events.
const MAX_TIMELINE = 50;

export class Session {
  data = null;

  start(url, protocols = [], now = Date.now()) {
    this.data = {
      url, protocols, startedAt: now, openedAt: null, firstMsgAt: null, closedAt: null,
      protocol: '', extensions: '', connectMs: null,
      sentMsgs: 0, recvMsgs: 0, sentBytes: 0, recvBytes: 0, lastClose: null,
      timeline: [{ key: 'tl.connecting', ts: now, params: {} }],
    };
  }
  mark(key, params = {}, now = Date.now()) {
    const d = this.data;
    if (!d) return;
    d.timeline.push({ key, ts: now, params });
    if (d.timeline.length > MAX_TIMELINE) d.timeline.splice(1, d.timeline.length - MAX_TIMELINE);
  }
  open(info, now = Date.now()) {
    const d = this.data;
    if (!d) return;
    d.openedAt = now; d.firstMsgAt = null; d.closedAt = null;
    d.protocol = info.protocol || ''; d.extensions = info.extensions || ''; d.connectMs = info.connectMs;
    this.mark('tl.open', { ms: info.connectMs }, now);
  }
  sent(size) { const d = this.data; if (d) { d.sentMsgs += 1; d.sentBytes += size; } }
  message(size, now = Date.now()) {
    const d = this.data;
    if (!d) return;
    d.recvMsgs += 1; d.recvBytes += size;
    if (d.firstMsgAt === null && d.openedAt !== null) {
      d.firstMsgAt = now;
      this.mark('tl.first', { ms: now - d.openedAt }, now);
    }
  }
  close(c, now = Date.now()) {
    const d = this.data;
    if (!d) return;
    d.closedAt = now; d.openedAt = d.openedAt; // keep openedAt for uptime calc
    d.lastClose = { code: c.code, reason: c.reason, wasClean: c.wasClean };
    this.mark('tl.close', { code: c.code }, now);
  }
}
