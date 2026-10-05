// Production build: bundle + minify JS/CSS with content hashes, copy static files,
// generate the service worker and the Apache .htaccess. Output: dist/
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(root, 'public');
const OUT = join(root, 'dist');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (buf) => sha(buf).slice(0, 10);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'assets', 'fonts'), { recursive: true });

// JS
const js = (await build({
  entryPoints: [join(SRC, 'js/main.js')], bundle: true, minify: true, format: 'esm', target: 'es2022',
  write: false, legalComments: 'none', logLevel: 'warning',
})).outputFiles[0].contents;
const jsName = `assets/app-${short(js)}.js`;
await writeFile(join(OUT, jsName), js);

// CSS: fonts first; font URLs move from ../fonts/ to fonts/ because the bundle lives in assets/
const cssSrc = (await readFile(join(SRC, 'css/fonts.css'), 'utf8')).replaceAll('../fonts/', 'fonts/')
  + await readFile(join(SRC, 'css/style.css'), 'utf8');
const css = (await transform(cssSrc, { loader: 'css', minify: true })).code;
const cssName = `assets/app-${short(css)}.css`;
await writeFile(join(OUT, cssName), css);

// Fonts (woff2 + licences), icons, manifest, robots
const fonts = [];
for (const f of await readdir(join(SRC, 'fonts'))) {
  await cp(join(SRC, 'fonts', f), join(OUT, 'assets/fonts', f));
  if (f.endsWith('.woff2')) fonts.push(`assets/fonts/${f}`);
}
await cp(join(SRC, 'icons'), join(OUT, 'icons'), { recursive: true });
for (const f of ['manifest.webmanifest', 'robots.txt']) await cp(join(SRC, f), join(OUT, f));
const icons = (await readdir(join(SRC, 'icons'))).map((f) => `icons/${f}`);

// Service worker
const precache = ['./', jsName, cssName, 'manifest.webmanifest', ...fonts, ...icons];
const idParts = [];
for (const p of precache.filter((x) => x !== './')) idParts.push(p, sha(await readFile(join(OUT, p))));
const buildId = short(idParts.join('|'));
const swTpl = await readFile(join(root, 'scripts/sw.template.js'), 'utf8');
await writeFile(join(OUT, 'sw.js'), swTpl.replace('__BUILD__', buildId).replace('__PRECACHE__', JSON.stringify(precache, null, 2)));

// index.html
let html = await readFile(join(SRC, 'index.html'), 'utf8');
const rep = (a, b) => { if (!html.includes(a)) throw new Error(`index.html marker missing: ${a}`); html = html.replace(a, b); };
rep('<link rel="stylesheet" href="css/fonts.css" />\n  ', '');
rep('<link rel="stylesheet" href="css/style.css" />', `<link rel="stylesheet" href="${cssName}" />`);
rep('<script type="module" src="js/main.js"></script>', `<script type="module" src="${jsName}"></script>`);
rep('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n  <meta name="wsd-build" content="${buildId}" />`);
await writeFile(join(OUT, 'index.html'), html);

// Apache config
await cp(join(root, 'deploy/.htaccess'), join(OUT, '.htaccess'));

const kb = (b) => (b / 1024).toFixed(1);
console.log(`build ${buildId}: ${jsName} ${kb(js.length)} KB (${kb(gzipSync(js).length)} gz), ${cssName} ${kb(css.length)} KB (${kb(gzipSync(css).length)} gz), ${precache.length} precached files`);
