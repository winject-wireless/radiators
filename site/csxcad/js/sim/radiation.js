// Directional far-field sampling and exact principal cuts of the displayed mesh.
// The probe position is in display coordinates (mm), not a physical field measurement.
const DEG = Math.PI / 180;
const finite = Number.isFinite;
const dbLoss = x => finite(x) && x > 0 ? 10 * Math.log10(x) : null;
const addDb = (a,b) => finite(a) && finite(b) ? a + b : null;

export function interpolatePattern(record, values, theta, phi) {
  const ts = record.theta_deg, ps = record.phi_deg;
  if (!values || !ts?.length || !ps?.length || !finite(theta) || !finite(phi)) return null;
  theta = Math.max(ts[0], Math.min(ts.at(-1), theta));
  let i = 0;
  while (i + 1 < ts.length - 1 && ts[i + 1] < theta) i++;
  const i2 = Math.min(i + 1, ts.length - 1);
  const wt = ts[i2] === ts[i] ? 0 : (theta - ts[i]) / (ts[i2] - ts[i]);
  phi = ((phi - ps[0]) % 360 + 360) % 360 + ps[0];
  let j = 0;
  while (j + 1 < ps.length && ps[j + 1] <= phi) j++;
  const j2 = (j + 1) % ps.length;
  const end = j2 === 0 ? ps[0] + 360 : ps[j2];
  const wp = end === ps[j] ? 0 : (phi - ps[j]) / (end - ps[j]);
  const corners = [[i,j,(1-wt)*(1-wp)], [i,j2,(1-wt)*wp], [i2,j,wt*(1-wp)], [i2,j2,wt*wp]];
  let v = 0;
  for (const [a,b,w] of corners) {
    if (!w) continue;
    const x = values[a]?.[b];
    if (!finite(x)) return null;
    v += w*x;
  }
  return v;
}

export function samplePattern(record, point) {
  const [x,y,z] = point, distance = Math.hypot(x,y,z);
  const base = { point: [...point], frequency: record.frequency_hz,
    radiationEfficiency: record.radiation_efficiency ?? null,
    mismatchEfficiency: record.mismatch_efficiency ?? null,
    radiatedPower: record.radiated_power_w ?? null };
  if (!finite(distance) || distance < 1e-8) return { ...base, theta: null, phi: null, directivity: null, gain: null, realizedGain: null, relativeField: null };
  const theta = Math.acos(Math.max(-1, Math.min(1,z/distance))) / DEG;
  const phi = ((Math.atan2(y,x)/DEG)%360+360)%360;
  const directivity = interpolatePattern(record, record.directivity_dbi, theta, phi);
  const gain = addDb(directivity, dbLoss(base.radiationEfficiency));
  const realizedGain = interpolatePattern(record, record.realized_gain_dbi, theta, phi) ??
    addDb(gain, dbLoss(base.mismatchEfficiency));
  const relativeField = finite(directivity) && finite(record.max_directivity_dbi)
    ? 10 ** ((directivity - record.max_directivity_dbi)/20) : null;
  return { ...base, theta, phi, directivity, gain, realizedGain, relativeField };
}

export function peakProbe(record, radius) {
  let best = -Infinity, theta = 90, phi = 0;
  for (let i=0;i<record.theta_deg.length;i++) for (let j=0;j<record.phi_deg.length;j++) {
    const d=record.directivity_dbi[i]?.[j];
    if (finite(d) && d > best) { best=d; theta=record.theta_deg[i]; phi=record.phi_deg[j]; }
  }
  const t=theta*DEG, p=phi*DEG;
  return [radius*Math.sin(t)*Math.cos(p),radius*Math.sin(t)*Math.sin(p),radius*Math.cos(t)];
}

// Cut every triangle against a plane through the origin, normal along axis.
// The segments follow exactly the triangulated surface, including non-cardinal angular grids.
export function sectionSegments(positions, indices, axis, radius) {
  const eps = Math.max(1e-9, radius*1e-8), segments = [], seen = new Set();
  const point = k => positions.slice(k*3,k*3+3);
  const key = p => p.map(v=>Math.round(v/eps)).join(",");
  for (let k=0;k<indices.length;k+=3) {
    const tri = [point(indices[k]),point(indices[k+1]),point(indices[k+2])];
    const d = tri.map(p=>Math.abs(p[axis])<=eps?0:p[axis]);
    if (d.every(v=>v===0) || d.every(v=>v>0) || d.every(v=>v<0)) continue;
    const hits = new Map();
    const add = p => { p[axis]=0; hits.set(key(p),p); };
    for (let a=0;a<3;a++) {
      const b=(a+1)%3;
      if (d[a]===0) add([...tri[a]]);
      if (d[a]*d[b]<0) {
        const t=d[a]/(d[a]-d[b]);
        add(tri[a].map((v,j)=>v+t*(tri[b][j]-v)));
      }
    }
    if (hits.size!==2) continue;
    const [a,b]=[...hits.keys()].sort(), id=a+"|"+b;
    if (seen.has(id)) continue;
    seen.add(id);
    segments.push(...hits.get(a),...hits.get(b));
  }
  return segments;
}
