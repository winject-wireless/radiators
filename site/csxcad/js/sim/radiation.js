// Far-field sampling and exact cuts through the displayed triangulated surface.
// The radius of the display surface is arbitrary; only angular quantities are physical.
const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => ((a % 360) + 360) % 360;
const finite = Number.isFinite;

function interval(grid, x) {
  let lo = 0, hi = grid.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (grid[m] <= x) lo = m; else hi = m;
  }
  return [lo, hi, grid[hi] === grid[lo] ? 0 : clamp((x - grid[lo]) / (grid[hi] - grid[lo]), 0, 1)];
}

// Interpolate in linear power, then convert to dB. Ignore zero-weight corners,
// but never interpret absent/null samples as 0 dBi.
export function angularValue(record, grid, theta, phi) {
  const t = record.theta_deg, p = record.phi_deg;
  if (!t?.length || !p?.length || !grid || !finite(theta) || !finite(phi)) return null;
  const [a, b, u] = interval(t, clamp(theta, t[0], t.at(-1)));
  let f = wrap(phi - p[0]) + p[0], c, d, v;
  if (f >= p.at(-1)) {
    c = p.length - 1; d = 0;
    v = (f - p[c]) / (p[0] + 360 - p[c] || 1);
  } else [c, d, v] = interval(p, f);
  const terms = [[a,c,(1-u)*(1-v)], [a,d,(1-u)*v], [b,c,u*(1-v)], [b,d,u*v]];
  let power = 0;
  for (const [i,j,w] of terms) {
    if (w <= 1e-12) continue;
    const db = grid[i]?.[j];
    if (!finite(db)) return null;
    power += w * 10 ** (db / 10);
  }
  return power > 0 && finite(power) ? 10 * Math.log10(power) : null;
}

export function sampleDirection(record, point) {
  if (!record?.radiation_valid || !point?.every(finite)) return null;
  const length = Math.hypot(...point);
  const eta = record.radiation_efficiency, mismatch = record.mismatch_efficiency;
  const metrics = { radiationEfficiency: finite(eta) ? eta : null, mismatchEfficiency: finite(mismatch) ? mismatch : null,
    radiatedPower: finite(record.radiated_power_w) ? record.radiated_power_w : null };
  if (length < 1e-8) return { ...metrics, theta: null, phi: null, directivity: null, gain: null, realizedGain: null, relativeField: null };
  const theta = Math.acos(clamp(point[2] / length, -1, 1)) / RAD;
  const phi = wrap(Math.atan2(point[1], point[0]) / RAD);
  const directivity = angularValue(record, record.directivity_dbi, theta, phi);
  const gain = directivity !== null && eta > 0 && finite(eta) ? directivity + 10 * Math.log10(eta) : null;
  const derived = gain !== null && mismatch > 0 && finite(mismatch) ? gain + 10 * Math.log10(mismatch) : null;
  const realizedGain = angularValue(record, record.realized_gain_dbi, theta, phi) ?? derived;
  return { ...metrics, theta, phi, directivity, gain, realizedGain,
    relativeField: directivity !== null && finite(record.max_directivity_dbi) ? 10 ** ((directivity - record.max_directivity_dbi) / 20) : null };
}

export function defaultProbe(record, radius) {
  let best = -Infinity, theta = 90, phi = 0;
  record.theta_deg.forEach((t,i) => record.phi_deg.forEach((p,j) => {
    const d = record.directivity_dbi[i]?.[j];
    if (finite(d) && d > best) { best = d; theta = t; phi = p; }
  }));
  const r = radius * 0.8, t = theta * RAD, p = phi * RAD;
  return [r * Math.sin(t) * Math.cos(p), r * Math.sin(t) * Math.sin(p), r * Math.cos(t)];
}

// Intersect each surface triangle with an axis-aligned plane. Unique edges are
// retained once (including when the plane contains a triangle edge). Coplanar
// triangles are skipped, avoiding interior tessellation lines.
export function planeSegments(positions, indices, axis, offset = 0, epsilon = 1e-6) {
  const lines = [], seen = new Set();
  const key = p => p.map(v => Math.round(v / epsilon)).join(",");
  const vertex = i => [positions[3*i], positions[3*i+1], positions[3*i+2]];
  for (let i = 0; i < indices.length; i += 3) {
    const vs = [vertex(indices[i]), vertex(indices[i+1]), vertex(indices[i+2])];
    const ds = vs.map(v => v[axis] - offset);
    if (ds.every(d => Math.abs(d) <= epsilon) || ds.every(d => d > epsilon) || ds.every(d => d < -epsilon)) continue;
    const pts = [];
    const add = p => {
      p[axis] = offset;
      if (!pts.some(q => Math.hypot(...q.map((v,k)=>v-p[k])) <= epsilon)) pts.push(p);
    };
    for (let j = 0; j < 3; j++) {
      const k = (j+1)%3, a = ds[j], b = ds[k];
      if (Math.abs(a) <= epsilon) add(vs[j].slice());
      if ((a < -epsilon && b > epsilon) || (a > epsilon && b < -epsilon)) {
        const t = a / (a-b);
        add(vs[j].map((v,n) => v + t*(vs[k][n]-v)));
      }
    }
    if (pts.length !== 2) continue;
    const id = [key(pts[0]),key(pts[1])].sort().join("|");
    if (seen.has(id)) continue;
    seen.add(id); lines.push(...pts[0], ...pts[1]);
  }
  return lines;
}
