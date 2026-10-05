# WS Debugger

Browser-based WebSocket testing and learning tool (English / Bulgarian, mobile-first, installable PWA).
Everything runs in the visitor's browser: **there is no backend and no proxy**, so the server never connects to anything on a visitor's behalf.

## Features

- Connect to any `ws://` / `wss://` endpoint; send raw text, JSON, binary (hex) and ping; filter, copy and export the log.
- **Inspector:** live connection facts, handshake preview (real `Sec-WebSocket-Accept` calculation), close-code reference, 11 short protocol lessons.
- **Message templates:** save, insert and delete named messages (max 30, 4 KB each). Variables `{{uuid}}`, `{{timestamp}}`, `{{iso}}`, `{{counter}}` are expanded when a template is inserted, so you see exactly what will be sent. Messages that look like secrets (tokens, passwords, keys, JWTs) are refused; templates stay in this browser only.
- Optional subprotocols, heartbeat, bounded auto-reconnect with backoff and jitter.

## Develop

Requires Node >= 22.13. If npm warns that esbuild's `postinstall` is not approved, it is safe to ignore: the binary comes from esbuild's platform package (verified with `npm install --ignore-scripts`).

```bash
npm install
npm run serve        # http://localhost:8080  (serves public/ directly, no build)
npm test             # unit tests (ws engine, security, protocol helpers, build, service worker)
npm run test:ui      # jsdom smoke test of the full UI against a local echo server
npm run build        # -> dist/  (hashed bundles, service worker, .htaccess)
```

Source layout: `public/js/` ES modules (`ws-client.js` engine, `security.js`, `inspector.js`, `main.js` wiring), `public/css/`, `public/fonts/` (self-hosted, SIL OFL), `deploy/` (Apache), `scripts/` (build).

## Deploy on Apache

1. `npm ci && npm run build`, then upload **only `dist/`** (including the hidden `.htaccess`).
2. Enable modules: `a2enmod headers deflate ssl` (a missing `mod_headers` makes Apache return 500 on purpose).
3. Use `deploy/ws-debugger.vhost.conf` as a template: `AllowOverride FileInfo` is required for `.htaccess`.
4. `apache2ctl configtest && systemctl reload apache2`.

Behind Cloudflare: keep HTML, `sw.js` and `manifest.webmanifest` uncached (the origin already sends `Cache-Control: no-cache`; add a Cache Rule to bypass them if you changed defaults), enable HSTS in Cloudflare as well, and purge nothing else: hashed assets are immutable.

## Security model

| Risk | Mitigation |
| --- | --- |
| Used as flood / DoS tool | 5 msg/s (burst 10), 64 KB per message, send-buffer backpressure, 8 connection attempts per minute, min 1 s between attempts |
| Used as port scanner | connection attempt limits above, one connection at a time, reconnect capped at 10 attempts with exponential backoff, 15 s handshake timeout, no batch or multi-target features |
| Drive-by links that make visitors attack a host | no URL-parameter prefill and no auto-connect: every connection needs an explicit click |
| URL abuse | only `ws:`/`wss:`, no credentials (`user:pass@`), no fragments, no control characters, length cap; mixed content explained instead of failing silently |
| Secrets leaking | sensitive query parameters (`token`, `key`, `auth`, ...) are masked in the log/inspector and never saved; message history stays in memory only |
| XSS from server data | server payloads are rendered only through `textContent`; strict CSP (`script-src 'self'`, no inline code) |
| Tampered localStorage | all stored settings are clamped by `sanitizeSettings` |

Limits live in `public/js/security.js` (`LIMITS`). They are client-side guards: they protect third-party servers from casual misuse through this page, not from someone who writes their own script.

## Known limits

- Browsers do not expose handshake headers, HTTP status of a failed upgrade, protocol-level ping/pong frames or error reasons. The handshake view is an illustrative reconstruction; lines tagged "observed" come from the real socket.
- Fonts ship `latin` and `cyrillic` subsets only.
