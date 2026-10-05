// Pure helpers for the Inspector / Learn features (RFC 6455). DOM-free.
import { redactUrl } from './security.js';

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const CODE_NAMES = Object.freeze({
  1000: 'Normal Closure', 1001: 'Going Away', 1002: 'Protocol Error', 1003: 'Unsupported Data',
  1005: 'No Status Received', 1006: 'Abnormal Closure', 1007: 'Invalid Frame Payload Data',
  1008: 'Policy Violation', 1009: 'Message Too Big', 1010: 'Mandatory Extension', 1011: 'Internal Error',
  1012: 'Service Restart', 1013: 'Try Again Later', 1014: 'Bad Gateway', 1015: 'TLS Handshake',
});
export const CLOSE_CODES = Object.keys(CODE_NAMES).map(Number);
export const RESERVED_CODES = new Set([1005, 1006, 1015]);

/** i18n key describing a close code. */
export function closeCodeKey(code) {
  if (CODE_NAMES[code]) return `code.${code}`;
  if (code >= 3000 && code <= 3999) return 'code.3xxx';
  if (code >= 4000 && code <= 4999) return 'code.4xxx';
  if (code >= 1000 && code <= 2999) return 'code.reserved_range';
  return 'code.unknown';
}

/** Estimated frame header size for one unfragmented frame (RFC 6455 §5.2). */
export function frameOverhead(payloadBytes, fromClient) {
  const ext = payloadBytes <= 125 ? 0 : payloadBytes <= 65535 ? 2 : 8;
  return 2 + ext + (fromClient ? 4 : 0);
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

/** Sec-WebSocket-Accept = base64(SHA-1(key + GUID)). Returns null without WebCrypto. */
export async function computeAccept(key, subtle = globalThis.crypto?.subtle) {
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return toBase64(new Uint8Array(digest));
}

export function randomKey(c = globalThis.crypto) {
  if (!c?.getRandomValues) return null;
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return toBase64(b);
}

/**
 * Illustrative handshake built from a URL. Only lines tagged "observed" come from the real socket.
 * @param {{url:string, origin?:string, protocols?:string[], key:string, accept:string,
 *   observed?:{protocol?:string, extensions?:string}, labels:Record<string,string>}} o
 */
export function buildHandshakePreview({ url, origin, protocols = [], key, accept, observed = {}, labels }) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const c = (text) => `  # ${text}`;
  const path = redactUrl((u.pathname || '/') + u.search);
  const req = [
    `GET ${path} HTTP/1.1`,
    `Host: ${u.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}${c(labels.key)}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (origin) req.push(`Origin: ${origin}${c(labels.origin)}`);
  if (protocols.length) req.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
  req.push(`Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits${c(labels.ext)}`);
  const res = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}${c(labels.accept)}`,
  ];
  if (observed.protocol) res.push(`Sec-WebSocket-Protocol: ${observed.protocol}${c(labels.observed)}`);
  if (observed.extensions) res.push(`Sec-WebSocket-Extensions: ${observed.extensions}${c(labels.observed)}`);
  return { request: req.join('\n'), response: res.join('\n') };
}
