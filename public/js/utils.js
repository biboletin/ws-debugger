export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
export function formatTime(ts) {
  const d = new Date(ts);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
export function hexDump(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const c = bytes.subarray(i, i + 16);
    const hex = [...c].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asc = [...c].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${asc}`);
  }
  return out.join('\n');
}
export function parseHex(str) {
  const s = String(str).replace(/\s+/g, '');
  if (!s || s.length % 2 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const u = new Uint8Array(s.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return u;
}
