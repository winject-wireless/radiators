// Pure tessellation of *resolved* schema v2 components (no three.js here so
// the same code runs in node checks). Mirrors antennas/v2_geometry.py:
// transform = rotate X, then Y, then Z (degrees), then translate.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const n = len(a); if (!n) throw Error("Zero-length axis"); return mul(a, 1 / n); };

export function vec3(v, label) {
  if (!Array.isArray(v) || v.length !== 3 || v.some(x => typeof x !== "number" || !Number.isFinite(x))) {
    throw Error(label + " must contain 3 finite coordinates");
  }
  return v;
}
export function positive(v, label) {
  const x = Number(v);
  if (typeof v === "boolean" || !Number.isFinite(x) || x <= 0) throw Error(label + " must be positive");
  return x;
}

export function rotationMatrix(deg) {
  const [r, p, y] = vec3(deg, "rotation").map(d => d * Math.PI / 180);
  const cx = Math.cos(r), sx = Math.sin(r), cy = Math.cos(p), sy = Math.sin(p), cz = Math.cos(y), sz = Math.sin(y);
  // Rz @ Ry @ Rx
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}
export function transformer(g) {
  const t = g.transform || {};
  const m = rotationMatrix(t.rotate_deg || [0, 0, 0]);
  const shift = vec3(t.translate || [0, 0, 0], "transform.translate");
  return p => [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + shift[0],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + shift[1],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + shift[2],
  ];
}
const isRotated = g => (g.transform?.rotate_deg || [0, 0, 0]).some(v => v !== 0);

export function helixPoints(g) {
  const origin = vec3(g.origin, "helix.origin");
  const axis = unit(vec3(g.axis || [0, 0, 1], "helix.axis"));
  const trial = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(trial, mul(axis, dot(trial, axis))));
  const v = cross(axis, u);
  const turns = positive(g.turns, "helix.turns");
  const height = positive(g.height, "helix.height");
  const diameter = positive(g.diameter, "helix.diameter");
  const spt = Math.trunc(Number(g.segments_per_turn ?? 24));
  if (!(spt >= 8 && spt <= 80) || turns * spt > 8000) {
    throw Error("Helix segments_per_turn must be 8..80, total segments <= 8000");
  }
  const count = Math.max(2, Math.ceil(turns * spt));
  const phase = Number(g.phase_deg || 0) * Math.PI / 180;
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count, a = 2 * Math.PI * turns * t + phase;
    return add(add(origin, mul(axis, t * height)),
      add(mul(u, diameter / 2 * Math.cos(a)), mul(v, diameter / 2 * Math.sin(a))));
  });
}

// --- mesh builders ---------------------------------------------------------
class Mesh {
  constructor() { this.p = []; this.i = []; }
  v(pt) { this.p.push(pt); return this.p.length - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
}

function frame(axis) {
  const trial = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(trial, mul(axis, dot(trial, axis))));
  return [u, cross(axis, u)];
}

function ring(mesh, center, u, v, r, n) {
  return Array.from({ length: n }, (_, j) => {
    const a = 2 * Math.PI * j / n;
    return mesh.v(add(center, add(mul(u, r * Math.cos(a)), mul(v, r * Math.sin(a)))));
  });
}
function bridge(mesh, A, B, flip = false) {
  const n = A.length;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    if (flip) mesh.quad(A[j], A[k], B[k], B[j]); else mesh.quad(A[j], B[j], B[k], A[k]);
  }
}
function cap(mesh, R, center, flip) {
  const c = mesh.v(center);
  for (let j = 0; j < R.length; j++) {
    const k = (j + 1) % R.length;
    if (flip) mesh.tri(c, R[k], R[j]); else mesh.tri(c, R[j], R[k]);
  }
}

function cylinderMesh(mesh, a, b, rOuter, rInner, n = 32) {
  const axis = unit(sub(b, a));
  const [u, v] = frame(axis);
  const A = ring(mesh, a, u, v, rOuter, n), B = ring(mesh, b, u, v, rOuter, n);
  bridge(mesh, A, B);
  if (rInner) {
    const Ai = ring(mesh, a, u, v, rInner, n), Bi = ring(mesh, b, u, v, rInner, n);
    bridge(mesh, Ai, Bi, true);
    bridge(mesh, Ai, A, false); // annular end caps
    bridge(mesh, B, Bi, false);
  } else {
    cap(mesh, A, a, true);
    cap(mesh, B, b, false);
  }
}

function sphereMesh(mesh, c, r, lat = 16, lon = 32) {
  const top = mesh.v(add(c, [0, 0, r]));
  const rings = [];
  for (let i = 1; i < lat; i++) {
    const th = Math.PI * i / lat;
    rings.push(Array.from({ length: lon }, (_, j) => {
      const ph = 2 * Math.PI * j / lon;
      return mesh.v(add(c, [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]));
    }));
  }
  const bottom = mesh.v(add(c, [0, 0, -r]));
  for (let j = 0; j < lon; j++) mesh.tri(top, rings[0][j], rings[0][(j + 1) % lon]);
  for (let i = 0; i + 1 < rings.length; i++) bridge(mesh, rings[i], rings[i + 1], false);
  const last = rings[rings.length - 1];
  for (let j = 0; j < lon; j++) mesh.tri(bottom, last[(j + 1) % lon], last[j]);
}

// Validation mirrors v2_geometry's polyhedron branch.
export function polyhedronData(g) {
  const verts = g.vertices, faces = g.faces;
  if (!Array.isArray(verts) || verts.length < 4 || verts.length > 20000) throw Error("polyhedron.vertices must be a list of 4..20000 XYZ vertices");
  verts.forEach((v, i) => vec3(v, `polyhedron.vertices[${i}]`));
  if (!Array.isArray(faces) || faces.length < 4 || faces.length > 40000) throw Error("polyhedron.faces must be a list of 4..40000 faces");
  for (const f of faces) {
    if (!Array.isArray(f) || f.length < 3 || !f.every(i => Number.isInteger(i) && i >= 0 && i < verts.length)) {
      throw Error("polyhedron.faces must list >=3 valid vertex indices each");
    }
  }
  return { verts, faces };
}

// Port of v2_geometry.hemisphere_mesh (same lat/azimuth counts as the solver).
export function hemisphereMesh(radius, thickness = null, lat = 10, az = 32) {
  const r = positive(radius, "hemisphere.radius");
  if (thickness !== null && !(thickness > 0 && thickness < r)) {
    throw Error("hemisphere shell thickness must be between 0 and radius");
  }
  const verts = [], faces = [], rings = [];
  for (const rad of thickness === null ? [r] : [r, r - thickness]) {
    const topIndex = verts.length;
    verts.push([0, 0, rad]);
    const sets = [];
    for (let level = 1; level <= lat; level++) {
      const th = (Math.PI / 2) * level / lat;
      const rr = [];
      for (let j = 0; j < az; j++) {
        const ph = 2 * Math.PI * j / az;
        rr.push(verts.length);
        verts.push([rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)]);
      }
      sets.push(rr);
    }
    rings.push([topIndex, sets]);
  }
  const [top, outer] = rings[0];
  for (let j = 0; j < az; j++) faces.push([top, outer[0][j], outer[0][(j + 1) % az]]);
  for (let s = 0; s + 1 < outer.length; s++) {
    const a = outer[s], b = outer[s + 1];
    for (let j = 0; j < az; j++) { const n = (j + 1) % az; faces.push([a[j], b[j], b[n]], [a[j], b[n], a[n]]); }
  }
  const lastO = outer[outer.length - 1];
  if (thickness === null) {
    const c = verts.length;
    verts.push([0, 0, 0]);
    for (let j = 0; j < az; j++) faces.push([c, lastO[(j + 1) % az], lastO[j]]);
  } else {
    const [itop, inner] = rings[1];
    for (let j = 0; j < az; j++) faces.push([itop, inner[0][(j + 1) % az], inner[0][j]]);
    for (let s = 0; s + 1 < inner.length; s++) {
      const a = inner[s], b = inner[s + 1];
      for (let j = 0; j < az; j++) { const n = (j + 1) % az; faces.push([a[j], b[n], b[j]], [a[j], a[n], b[n]]); }
    }
    const lastI = inner[inner.length - 1];
    for (let j = 0; j < az; j++) {
      const n = (j + 1) % az;
      faces.push([lastO[j], lastO[n], lastI[n]], [lastO[j], lastI[n], lastI[j]]);
    }
  }
  return { verts, faces };
}

function tubeMesh(mesh, pts, r, sides = 10, maxRings = 1500) {
  // Down-sample very long curves for display only; the export keeps all points.
  const stride = Math.max(1, Math.ceil(pts.length / maxRings));
  const P = pts.filter((_, i) => i % stride === 0);
  if (P[P.length - 1] !== pts[pts.length - 1]) P.push(pts[pts.length - 1]);
  let prevU = null, prevRing = null;
  for (let i = 0; i < P.length; i++) {
    const t = unit(sub(P[Math.min(i + 1, P.length - 1)], P[Math.max(i - 1, 0)]));
    let u;
    if (prevU) { u = sub(prevU, mul(t, dot(prevU, t))); u = len(u) > 1e-9 ? unit(u) : frame(t)[0]; }
    else u = frame(t)[0];
    const v = cross(t, u);
    const R = ring(mesh, P[i], u, v, r, sides);
    if (prevRing) bridge(mesh, prevRing, R);
    else cap(mesh, R, P[i], true);
    prevU = u; prevRing = R;
  }
  cap(mesh, prevRing, P[P.length - 1], false);
}

// Returns { positions:Float32Array, indices:Uint32Array, flat:boolean }
// for one resolved component. `flat` marks a 2D sheet (zero-thickness box).
export function tessellate(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) throw Error("Invalid component");
  const shape = g.shape ?? g.type;
  const T = transformer(g);
  const mesh = new Mesh();
  let flat = false;
  switch (shape) {
    case "box": {
      const a = vec3(g.start, "box.start"), b = vec3(g.stop, "box.stop");
      if (a.some((x, i) => x > b[i])) throw Error("box.start must be <= box.stop");
      const zero = a.map((x, i) => x === b[i]);
      flat = zero.some(Boolean);
      if (zero.filter(Boolean).length > 1) throw Error("box has more than one zero-thickness axis");
      if (flat && isRotated(g)) throw Error("Rotated zero-thickness boxes are unsupported: use a 3D box or a mesh");
      const c = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]],
        [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]].map(p => mesh.v(p));
      if (flat) {
        const ax = zero.indexOf(true);
        const q = ax === 2 ? [0, 1, 2, 3] : ax === 1 ? [0, 1, 5, 4] : [0, 3, 7, 4];
        mesh.quad(c[q[0]], c[q[1]], c[q[2]], c[q[3]]);
        mesh.quad(c[q[0]], c[q[3]], c[q[2]], c[q[1]]);
      } else {
        [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
          .forEach(([p, q, r, s]) => mesh.quad(c[p], c[q], c[r], c[s]));
      }
      break;
    }
    case "cylinder":
    case "cylindrical_shell": {
      const a = vec3(g.start, "cylinder.start"), b = vec3(g.stop, "cylinder.stop");
      const r = positive(g.radius, "cylinder.radius");
      if (len(sub(b, a)) === 0) throw Error("cylinder start and stop must differ");
      if (shape === "cylinder") cylinderMesh(mesh, a, b, r, 0);
      else {
        const w = positive(g.thickness, "cylindrical_shell.thickness");
        if (w >= 2 * r) throw Error("cylindrical_shell.thickness must be less than diameter");
        cylinderMesh(mesh, a, b, r + w / 2, r - w / 2);
      }
      break;
    }
    case "sphere":
    case "spherical_shell": {
      const c = vec3(g.center, "sphere.center"), r = positive(g.radius, "sphere.radius");
      if (shape === "spherical_shell") {
        const w = positive(g.thickness, "spherical_shell.thickness");
        if (w >= r) throw Error("spherical_shell thickness must be < radius");
        sphereMesh(mesh, c, r + w / 2);
      } else sphereMesh(mesh, c, r);
      break;
    }
    case "polyhedron": {
      // Native CSXCAD Polyhedron; polygon faces are fan-triangulated for display.
      const { verts, faces } = polyhedronData(g);
      const base = mesh.p.length;
      verts.forEach(p => mesh.v(p));
      for (const f of faces) for (let k = 1; k + 1 < f.length; k++) mesh.tri(base + f[0], base + f[k], base + f[k + 1]);
      break;
    }
    case "hemisphere":
    case "hemispherical_shell": {
      const w = shape === "hemispherical_shell" ? positive(g.thickness, "hemispherical_shell.thickness") : null;
      const c = vec3(g.center, "hemisphere.center");
      const { verts, faces } = hemisphereMesh(g.radius, w);
      const base = mesh.p.length;
      verts.forEach(p => mesh.v(add(p, c)));
      faces.forEach(([x, y, z]) => mesh.tri(base + x, base + y, base + z));
      break;
    }
    case "wire":
    case "helix": {
      const pts = shape === "wire" ? g.points : helixPoints(g);
      if (!Array.isArray(pts) || pts.length < 2 || pts.length > 8001) {
        throw Error("wire.points must be list of 2..8001 XYZ vertices");
      }
      pts.forEach((p, i) => vec3(p, `wire.points[${i}]`));
      const r = positive(g.wire_diameter, "wire_diameter") / 2;
      tubeMesh(mesh, pts, r);
      break;
    }
    default:
      throw Error("Unsupported schema v2 shape: " + JSON.stringify(shape));
  }
  const positions = new Float32Array(mesh.p.length * 3);
  mesh.p.forEach((p, k) => { const w = T(p); positions[3 * k] = w[0]; positions[3 * k + 1] = w[1]; positions[3 * k + 2] = w[2]; });
  return { positions, indices: Uint32Array.from(mesh.i), flat };
}

// Bounds exactly as install_geometry() reports them (used for domain checks).
export function solverBounds(g) {
  const shape = g.shape ?? g.type;
  const T = transformer(g);
  const box = pts => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    return [lo, hi];
  };
  if (shape === "box") {
    const a = g.start, b = g.stop;
    return box([[a[0], a[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], a[2]], [b[0], a[1], a[2]],
      [a[0], a[1], b[2]], [b[0], a[1], b[2]], [a[0], b[1], b[2]], [b[0], b[1], a[2]]].map(T));
  }
  if (shape === "cylinder" || shape === "cylindrical_shell") {
    const [lo, hi] = box([T(g.start), T(g.stop)]);
    return [lo.map(x => x - g.radius), hi.map(x => x + g.radius)];
  }
  if (shape === "sphere" || shape === "spherical_shell") {
    const c = T(g.center);
    return [c.map(x => x - g.radius), c.map(x => x + g.radius)];
  }
  if (shape === "wire" || shape === "helix") {
    const pts = (shape === "wire" ? g.points : helixPoints(g)).map(T);
    const r = g.wire_diameter / 2;
    const [lo, hi] = box(pts);
    return [lo.map(x => x - r), hi.map(x => x + r)];
  }
  if (shape === "polyhedron") return box(polyhedronData(g).verts.map(T));
  if (shape === "hemisphere" || shape === "hemispherical_shell") {
    const { verts } = hemisphereMesh(g.radius, shape === "hemispherical_shell" ? g.thickness : null);
    return box(verts.map(p => T(add(p, g.center))));
  }
  throw Error("Unsupported schema v2 shape: " + shape);
}
