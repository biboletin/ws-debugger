// Dependency-free SVG line charts (CSP-safe: classes and presentation attributes only).
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
};

/** Rounds up to 1, 2, 5 or 10 times a power of ten. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/**
 * @param {{series:{cls:string, points:{x:number,y:number}[], dots?:boolean}[], yMax:number,
 *   yFormat?:(v:number)=>string, xLabels?:[string,string], label?:string}} o   x in 0..1
 */
export function lineChart({ series, yMax, yFormat = String, xLabels = ['', ''], label = '' }) {
  const W = 320, H = 150, L = 46, R = 8, T = 8, B = 22;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': label });
  root.append(svg('title', {}, label));
  const px = (x) => L + x * (W - L - R);
  const py = (y) => T + (1 - Math.min(Math.max(y, 0), yMax) / yMax) * (H - T - B);
  for (const f of [0, 0.5, 1]) {
    const y = py(f * yMax);
    root.append(
      svg('line', { class: 'chart-grid', x1: L, x2: W - R, y1: y, y2: y }),
      svg('text', { class: 'chart-tick', x: L - 4, y: y + 3, 'text-anchor': 'end' }, yFormat(f * yMax)),
    );
  }
  root.append(
    svg('text', { class: 'chart-tick', x: L, y: H - 6 }, xLabels[0]),
    svg('text', { class: 'chart-tick', x: W - R, y: H - 6, 'text-anchor': 'end' }, xLabels[1]),
  );
  for (const s of series) {
    const pts = s.points.map((p) => [px(p.x), py(p.y)]);
    if (pts.length > 1) root.append(svg('polyline', { class: `chart-line ${s.cls}`, points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') }));
    if (s.dots) for (const p of pts) root.append(svg('circle', { class: `chart-dot ${s.cls}`, cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 2.5 }));
  }
  return root;
}
