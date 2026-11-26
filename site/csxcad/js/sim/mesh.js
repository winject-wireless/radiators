// Mesh generation for in-browser runs: a line-by-line port of CSXCAD's
// python/CSXCAD/SmoothMeshLines.py (pinned commit in wasm/openems/versions.env) and of
// antennas/simulate_v2.py setup_mesh / v2_geometry.add_local_mesh, including the numpy
// semantics they rely on, so the editor produces the same grid as the Python simulator.

// ---- numpy helpers -------------------------------------------------------
const uniqueSorted = a => {
  const s = [...a].sort((x, y) => x - y);
  return s.filter((v, i) => i === 0 || v !== s[i - 1]);
};
const diff = a => a.slice(1).map((v, i) => v - a[i]);
const mean = a => a.length ? npSum(a) / a.length : NaN;
// numpy.linspace(start, stop, num) with endpoint=True
export function linspace(start, stop, num) {
  if (num === 1) return [start];
  const step = (stop - start) / (num - 1);
  const y = Array.from({ length: num }, (_, i) => i * step + start);
  y[num - 1] = stop;
  return y;
}
// numpy's pairwise summation (float64 add.reduce)
export function npSum(a, lo = 0, n = a.length) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[lo + i];
    return res;
  }
  if (n <= 128) {
    const r = a.slice(lo, lo + 8);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a, lo, n2) + npSum(a, lo + n2, n - n2);
}
const powRange = (base, ratio, from, to) => { // base * ratio ** arange(from, to+1)
  const out = [];
  for (let k = from; k <= to; k++) out.push(base * ratio ** k);
  return out;
};

// ---- SmoothMeshLines.py ----------------------------------------------------
export function Unique(l, tol = 1e-7) {
  let u = uniqueSorted(l);
  const dl = diff(u);
  const m = mean(dl);
  const drop = new Set();
  dl.forEach((d, i) => { if (d < m * tol) drop.add(i); });
  if (drop.size) u = u.filter((_, i) => !drop.has(i));
  return u;
}

function SmoothRange(start, stop, start_res, stop_res, max_res, ratio) {
  if (!(ratio > 1)) throw Error("SmoothRange: ratio must be > 1");
  const rng = stop - start;
  const wrap = tmp => [start, ...tmp.slice(1, -1), stop];
  if (rng < max_res && rng < start_res * ratio && rng < stop_res * ratio) return Unique([start, stop]);
  if (start_res >= max_res / ratio && stop_res >= max_res / ratio) {
    const N = Math.ceil(rng / max_res);
    return wrap(linspace(start, stop, N + 1));
  }
  const one_side_taper = (start_res, ratio, max_res) => {
    let res = start_res, pos = 0, N = 0;
    while (res < max_res && pos < rng) { res *= ratio; pos += res; N += 1; }
    if (pos > rng) {
      const l = [];
      for (let n = 0; n <= N; n++) l.push(npSum(powRange(start_res, ratio, 1, n)));
      return l.map(v => v * rng / pos);
    }
    const _ratio = Math.E ** ((Math.log(max_res) - Math.log(start_res)) / N);
    const l = [0];
    pos = 0; res = start_res;
    for (let n = 0; n < N; n++) { res *= _ratio; pos += res; l.push(pos); }
    while (pos < rng) { pos += max_res; l.push(pos); }
    const last = l[l.length - 1];
    return l.map(v => v * rng / last);
  };
  if (start_res < max_res / ratio && stop_res >= max_res / ratio) {
    return wrap(one_side_taper(start_res, ratio, max_res).map(v => start + v));
  }
  if (start_res >= max_res / ratio && stop_res < max_res / ratio) {
    return wrap(one_side_taper(stop_res, ratio, max_res).map(v => stop - v).sort((a, b) => a - b));
  }
  let pos1 = 0, N1 = 0, res = start_res;
  while (res < max_res) { res *= ratio; pos1 += res; N1 += 1; }
  const ratio1 = Math.E ** ((Math.log(max_res) - Math.log(start_res)) / N1);
  pos1 = npSum(powRange(start_res, ratio1, 1, N1));
  let pos2 = 0, N2 = 0;
  res = stop_res;
  while (res < max_res) { res *= ratio; pos2 += res; N2 += 1; }
  const ratio2 = Math.E ** ((Math.log(max_res) - Math.log(stop_res)) / N2);
  pos2 = npSum(powRange(stop_res, ratio2, 1, N2));
  if (pos1 + pos2 < rng) {
    const l = [0];
    for (let n = 1; n <= N1; n++) l.push(l[l.length - 1] + start_res * ratio1 ** n);
    const r = [0];
    for (let n = 1; n <= N2; n++) r.push(r[r.length - 1] + stop_res * ratio2 ** n);
    const left = rng - pos1 - pos2;
    const N = Math.ceil(left / max_res);
    for (let n = 0; n < N; n++) l.push(l[l.length - 1] + max_res);
    const length = l[l.length - 1] + r[r.length - 1];
    const c = Unique([...l, ...r.map(v => length - v)]);
    return wrap(c.map(v => start + v * rng / length));
  }
  const l = [0], r = [0];
  while (l[l.length - 1] + r[r.length - 1] < rng) {
    if (start_res === stop_res) {
      start_res *= ratio; l.push(l[l.length - 1] + start_res);
      stop_res *= ratio; r.push(r[r.length - 1] + start_res);
    } else if (start_res < stop_res) {
      start_res *= ratio; l.push(l[l.length - 1] + start_res);
    } else {
      stop_res *= ratio; r.push(r[r.length - 1] + start_res); // (sic) upstream adds start_res here
    }
  }
  const length = l[l.length - 1] + r[r.length - 1];
  const c = Unique([...l, ...r.map(v => length - v)]);
  return wrap(c.map(v => start + v * rng / length));
}

function CheckSymmetry(lines) {
  const tolerance = 1e-10, NP = lines.length;
  if (NP <= 2) return 0;
  const range = lines[NP - 1] - lines[0], center = 0.5 * (lines[NP - 1] + lines[0]);
  for (let n = 0; n < Math.floor(NP / 2); n++) {
    if (Math.abs((center - lines[n]) - (lines[NP - n - 1] - center)) > range * tolerance) return 0;
  }
  if (NP % 2 === 1 && Math.abs(lines[Math.floor(NP / 2)] - center) > range * tolerance) return 0;
  return NP % 2 === 0 ? 2 : 1;
}

function SnapToLines(lines, ref, tol = 1e-10) {
  if (ref.length < 2) return [...lines];
  const absTol = (ref[ref.length - 1] - ref[0]) * tol;
  return lines.map(v => {
    let i = 0, hi = ref.length; // searchsorted(side="left")
    while (i < hi) { const m = (i + hi) >> 1; if (ref[m] < v) i = m + 1; else hi = m; }
    i = Math.min(Math.max(i, 1), ref.length - 1);
    const left = ref[i - 1], right = ref[i];
    const nearest = v - left <= right - v ? left : right;
    return Math.abs(v - nearest) <= absTol ? nearest : v;
  });
}

export function SmoothMeshLines(lines, max_res, ratio = 1.5, check_symmetry = true) {
  let out = Unique(lines);
  const orig = out;
  const sym = check_symmetry ? CheckSymmetry(out) : 0;
  let center = 0;
  if (sym === 1) { center = 0.5 * (out[out.length - 1] + out[0]); out = out.slice(0, Math.floor(out.length / 2) + 1); }
  else if (sym === 2) { center = 0.5 * (out[out.length - 1] + out[0]); out = out.slice(0, Math.floor(out.length / 2)); }
  let dl = diff(out);
  while (dl.some(d => d > max_res * (1 + 1e-10))) {
    const N = out.length;
    const mx = Math.max(...dl);
    dl = dl.map(d => d <= max_res ? mx * 2 : d);
    let idx = 0;
    for (let i = 1; i < dl.length; i++) if (dl[i] < dl[idx]) idx = i;
    dl = diff(out);
    const start_res = idx > 0 ? dl[idx - 1] : max_res;
    const stop_res = idx < dl.length - 1 ? dl[idx + 1] : max_res;
    const l = SmoothRange(out[idx], out[idx + 1], start_res, stop_res, max_res, ratio);
    out = Unique([...out, ...l]);
    dl = diff(out);
    if (out.length === N) break;
  }
  if (sym === 1) return SnapToLines(Unique([...out, ...out.slice(0, -1).map(v => 2 * center - v)]), orig);
  if (sym === 2) {
    const last = out[out.length - 1];
    const l = SmoothRange(last, 2 * center - last, dl[dl.length - 1], dl[dl.length - 1], max_res, ratio);
    return SnapToLines(Unique([...out, ...l, ...out.map(v => 2 * center - v)]), orig);
  }
  return Unique(out);
}

// ---- simulate_v2.setup_mesh -------------------------------------------------
const AXES = ["x", "y", "z"];
const positive = (v, label) => { const x = Number(v); if (typeof v === "boolean" || !Number.isFinite(x) || x <= 0) throw Error(label + " must be positive"); return x; };
const require = (cond, msg) => { if (!cond) throw Error(msg); };

// Rectilinear grid with CSXCAD semantics: lines are kept sorted and unique.
export class Grid {
  constructor() { this.lines = [[], [], []]; }
  add(axis, values) { this.lines[axis] = uniqueSorted([...this.lines[axis], ...[].concat(values).map(Number)]); }
  set(axis, values) { this.lines[axis] = uniqueSorted(values); }
}

function addLocalMesh(grid, ds, de, lo, hi, step) {
  step = positive(step, "mesh.local_min_cell_mm");
  for (let i = 0; i < 3; i++) {
    const left = Math.max(ds[i], lo[i]), right = Math.min(de[i], hi[i]);
    if (right <= left) continue;
    const n = Math.ceil((right - left) / step) + 1;
    if (n > 1800) throw Error(`Local mesh region ${AXES[i]} has ${n} requested lines (> 1800)`);
    grid.add(i, linspace(left, right, n));
  }
}

// geometryBounds / sourceBounds: [[lo, hi]]; previews: [{start, stop} | {center} | {points}]
export function setupMesh(cfg, geometryBounds, sourceBounds, previews, ports, ds, de) {
  const m = cfg.mesh;
  const resolution = positive(m.resolution_mm ?? m.max_cell_mm ?? 5, "mesh max_cell_mm");
  const growth = Number(m.growth_ratio ?? 1.4);
  require(growth >= 1.01 && growth <= 2, "mesh.growth_ratio must be 1.01..2");
  const grid = new Grid();
  const maxCells = Math.trunc(Number(m.max_cells ?? 5000000));
  if ((m.grid_mode ?? "feature") === "uniform") {
    const step = positive(m.uniform_step_mm ?? resolution, "mesh.uniform_step_mm");
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const n = Math.max(1, Math.ceil((de[i] - ds[i]) / step));
      require(n <= 2500, `Uniform grid ${AXES[i]}: too many intervals (${n})`);
      grid.add(i, linspace(ds[i], de[i], n + 1));
      counts.push(n);
    }
    const cells = counts[0] * counts[1] * counts[2];
    require(cells <= maxCells, `Uniform mesh exceeds cell budget: ${cells}`);
    return { grid, counts, cells };
  }
  require((m.grid_mode ?? "feature") === "feature", "mesh.grid_mode must be 'feature' or 'uniform'");
  for (let i = 0; i < 3; i++) grid.add(i, [ds[i], de[i]]);
  for (const [lo, hi] of [...geometryBounds, ...sourceBounds]) {
    for (let i = 0; i < 3; i++) for (const v of [lo[i], hi[i]]) if (ds[i] < v && v < de[i]) grid.add(i, v);
  }
  const addPointPlanes = p => { for (let i = 0; i < 3; i++) { const v = Number(p[i]); if (ds[i] < v && v < de[i]) grid.add(i, v); } };
  for (const pv of previews) {
    if (pv.start) { addPointPlanes(pv.start); addPointPlanes(pv.stop); }
    else if (pv.center) addPointPlanes(pv.center);
    else if (pv.points) { addPointPlanes(pv.points[0]); addPointPlanes(pv.points[pv.points.length - 1]); }
  }
  for (const p of ports) { addPointPlanes(p.start); addPointPlanes(p.stop); }
  if (m.local_min_cell_mm != null) {
    const step = positive(m.local_min_cell_mm, "mesh.local_min_cell_mm");
    const maxSpan = Number(m.auto_refine_max_span_mm ?? 40);
    for (const [lo, hi] of [...geometryBounds, ...sourceBounds]) {
      if (Math.max(...hi.map((v, i) => v - lo[i])) <= maxSpan) addLocalMesh(grid, ds, de, lo, hi, step);
    }
  }
  for (const r of m.refinements ?? []) {
    require(r.stop.every((v, i) => v > r.start[i]), "mesh refinement stop <= start");
    addLocalMesh(grid, ds, de, r.start, r.stop, r.resolution_mm);
  }
  for (let i = 0; i < 3; i++) grid.set(i, SmoothMeshLines(grid.lines[i], resolution, growth));
  const counts = grid.lines.map(l => l.length - 1);
  const cells = counts[0] * counts[1] * counts[2];
  require(cells <= maxCells, `Mesh exceeds cell budget: ${cells} > ${maxCells}`);
  return { grid, counts, cells };
}
