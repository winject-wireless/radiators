// Small dependency-free SVG charts for simulation results (line charts and polar cuts).
// Colours come from CSS variables so both themes work.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
};
const text = (x, y, s, attrs = {}) => { const t = el("text", { x, y, ...attrs }); t.textContent = s; return t; };
export const SERIES_COLORS = ["var(--plot-1)", "var(--plot-2)", "var(--plot-3)", "var(--plot-4)"];

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

// series: [{x: [], y: [] (null = gap), label, color}]; hlines: [{y, label}]
export function lineChart({ series, xLabel = "", yLabel = "", hlines = [], yMin, yMax, xFmt = v => String(v), height = 190 }) {
  const W = 560, H = height, L = 46, R = 10, T = 10, B = 30;
  const xs = series.flatMap(s => s.x), ys = series.flatMap(s => s.y).filter(v => v !== null && Number.isFinite(v));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = yMin ?? Math.min(...ys, ...hlines.map(h => h.y)), y1 = yMax ?? Math.max(...ys, ...hlines.map(h => h.y));
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.06;
  if (yMin === undefined) y0 -= pad;
  if (yMax === undefined) y1 += pad;
  const X = v => L + (v - x0) / (x1 - x0 || 1) * (W - L - R), Y = v => T + (y1 - Math.min(Math.max(v, y0), y1)) / (y1 - y0) * (H - T - B);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": yLabel });
  const grid = el("g", { class: "chart-grid" });
  for (const v of niceTicks(y0, y1)) {
    grid.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }), text(L - 6, Y(v) + 4, String(v), { "text-anchor": "end", class: "chart-tick" }));
  }
  for (const v of niceTicks(x0, x1, 6)) {
    grid.append(el("line", { x1: X(v), x2: X(v), y1: T, y2: H - B }), text(X(v), H - B + 14, xFmt(v), { "text-anchor": "middle", class: "chart-tick" }));
  }
  svg.append(grid);
  for (const h of hlines) {
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(h.y), y2: Y(h.y), class: "chart-ref" }));
    if (h.label) svg.append(text(W - R - 2, Y(h.y) - 4, h.label, { "text-anchor": "end", class: "chart-tick" }));
  }
  series.forEach((s, k) => {
    let d = "", pen = false;
    s.x.forEach((x, i) => {
      const y = s.y[i];
      if (y === null || !Number.isFinite(y)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
      pen = true;
    });
    svg.append(el("path", { d, class: "chart-line", stroke: s.color ?? SERIES_COLORS[k % 4] }));
  });
  svg.append(text(L, H - 4, xLabel, { class: "chart-axis" }), text(4, 12, yLabel, { class: "chart-axis" }));
  return svg;
}

// Polar cut: series [{angleDeg: [], value: [] (dB), label, color}], radial range [rMin, rMax] dB
export function polarChart({ series, rMin, rMax, size = 230, label = "" }) {
  const S = size, C = S / 2, Rr = S / 2 - 22;
  const vals = series.flatMap(s => s.value).filter(v => v !== null && Number.isFinite(v));
  rMax ??= Math.ceil(Math.max(...vals) / 5) * 5;
  rMin ??= rMax - 30;
  const r = v => Math.max(0, (Math.min(v, rMax) - rMin) / (rMax - rMin)) * Rr;
  const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "chart polar", role: "img", "aria-label": label });
  const g = el("g", { class: "chart-grid" });
  for (let k = 0; k <= 3; k++) {
    const v = rMin + (rMax - rMin) * k / 3;
    g.append(el("circle", { cx: C, cy: C, r: r(v) || 0.5 }));
    if (k) g.append(text(C + 3, C - r(v) + 11, `${Math.round(v)}`, { class: "chart-tick" }));
  }
  for (let a = 0; a < 360; a += 30) {
    const t = a * Math.PI / 180;
    g.append(el("line", { x1: C, y1: C, x2: C + Rr * Math.sin(t), y2: C - Rr * Math.cos(t) }));
    g.append(text(C + (Rr + 11) * Math.sin(t), C - (Rr + 11) * Math.cos(t) + 4, `${a}°`, { "text-anchor": "middle", class: "chart-tick" }));
  }
  svg.append(g);
  series.forEach((s, k) => {
    let d = "";
    s.angleDeg.forEach((a, i) => {
      const v = s.value[i];
      if (v === null || !Number.isFinite(v)) return;
      const t = a * Math.PI / 180;
      d += `${d ? "L" : "M"}${(C + r(v) * Math.sin(t)).toFixed(1)},${(C - r(v) * Math.cos(t)).toFixed(1)}`;
    });
    svg.append(el("path", { d: d + "Z", class: "chart-line", stroke: s.color ?? SERIES_COLORS[k % 4] }));
  });
  if (label) svg.append(text(4, 12, label, { class: "chart-axis" }));
  return svg;
}
