// Geometry scripts: a JavaScript function generate(a) -> [primitive…] plus an `args`
// declaration whose entries are typed like primitive inputs. Pure module shared by the
// editor (runs scripts in a Web Worker) and the simulator (scripts/geometry_scripts.mjs
// runs them in a Node vm), so both expand a config identically.
import { SHAPES } from "./schema.js";
import { rotationMatrix, transformer, vec3 as transformVec3 } from "./geometry.js";

export const SCRIPT_LIMITS = { sourceChars: 50000, objects: 2000, timeoutMs: 2000 };
export const SCRIPT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Argument types and the editor control each one maps to.
export const ARG_TYPES = {
  point: { label: "Point", control: "vec3", handle: true },
  vector: { label: "Vector", control: "vec3" },
  length: { label: "Length", control: "num", unit: "mm" },
  number: { label: "Number", control: "num" },
  int: { label: "Integer", control: "int" },
  angle: { label: "Angle", control: "num", unit: "°" },
  material: { label: "Material", control: "material" },
  choice: { label: "Choice", control: "select" },
  bool: { label: "Yes / no", control: "bool" },
};

// Built-in scripts ship with the editor and the simulator; files use them by name
// ({"script": "helix"}) without storing their source. File scripts cannot reuse these names.
export const BUILTIN_SCRIPTS = {
  helix: {
    label: "Helix",
    description: "Helical wire coil (one CSXCAD Wire through computed points).",
    source: `// Built-in: helical wire. CSXCAD has no helix primitive; this returns one Wire
// through points on the coil (same construction as the legacy "helix" shape).
const args = {
  origin:            { type: "point",  default: [0, 0, 0], label: "Origin", step: 0.5,
                       hint: "Centre of the first turn's base." },
  axis:              { type: "vector", default: [0, 0, 1], label: "Axis", more: true,
                       hint: "Direction the coil advances; any length." },
  diameter:          { type: "length", default: 22, label: "Coil diameter", step: 0.1,
                       handle: { from: "origin", dir: "axis", perp: true, scale: 2 } },
  height:            { type: "length", default: 24, label: "Height", step: 0.1,
                       handle: { from: "origin", dir: "axis" }, hint: "Pitch = height / turns." },
  turns:             { type: "number", default: 4, min: 0.01, label: "Turns", step: 0.25 },
  wire_diameter:     { type: "length", default: 1.2, label: "Wire diameter", step: 0.1 },
  phase:             { type: "angle",  default: 0, label: "Start phase (°)", more: true, step: 15 },
  segments_per_turn: { type: "int",    default: 24, min: 8, max: 80, label: "Segments / turn", more: true,
                       hint: "Straight wire segments per turn (8–80, at most 8000 in total)." },
  material:          { type: "material" },
};

function generate(a) {
  const n = Math.hypot(...a.axis);
  if (!(n > 0)) throw new Error("axis must be nonzero");
  if (!(a.diameter > 0 && a.height > 0 && a.wire_diameter > 0)) throw new Error("diameter, height and wire diameter must be positive");
  if (a.turns * a.segments_per_turn > 8000) throw new Error("at most 8000 segments");
  const w = a.axis.map(x => x / n);
  const trial = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = trial[0] * w[0] + trial[1] * w[1] + trial[2] * w[2];
  let u = trial.map((x, i) => x - w[i] * d);
  const un = Math.hypot(...u);
  u = u.map(x => x / un);
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const count = Math.max(2, Math.ceil(a.turns * a.segments_per_turn));
  const phase = a.phase * Math.PI / 180, r = a.diameter / 2;
  const points = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count, al = 2 * Math.PI * a.turns * t + phase;
    points.push([0, 1, 2].map(k => a.origin[k] + t * a.height * w[k] + r * (Math.cos(al) * u[k] + Math.sin(al) * v[k])));
  }
  return [{ name: "coil", shape: "wire", points, wire_diameter: a.wire_diameter }];
}
`,
  },
};
BUILTIN_SCRIPTS.hemisphere = {
  label: "Hemisphere",
  description: "Hemispherical dome or shell (one CSXCAD Polyhedron).",
  source: `// Built-in: hemisphere / hemispherical shell. CSXCAD has no hemisphere primitive; this
// returns one Polyhedron, meshed exactly like the legacy "hemisphere" shape.
const args = {
  center:    { type: "point",  default: [0, 0, 0], label: "Center (rim plane)", step: 0.5 },
  axis:      { type: "vector", default: [0, 0, 1], label: "Axis (towards the dome top)", more: true },
  radius:    { type: "length", default: 10, label: "Outer radius", step: 0.1,
               handle: { from: "center", dir: "axis" } },
  thickness: { type: "length", default: 0, label: "Shell thickness", step: 0.1,
               hint: "0 = solid dome; otherwise a shell of this wall thickness." },
  rings:     { type: "int",    default: 10, min: 2, max: 60, label: "Latitude steps", more: true,
               hint: "Mesh resolution; defaults match the simulator's legacy hemisphere." },
  segments:  { type: "int",    default: 32, min: 6, max: 128, label: "Azimuth steps", more: true },
  material:  { type: "material" },
};

function generate(a) {
  const r = a.radius, w = a.thickness, lat = a.rings, az = a.segments;
  if (!(r > 0)) throw new Error("radius must be positive");
  if (w && !(w > 0 && w < r)) throw new Error("thickness must be between 0 and radius");
  const verts = [], faces = [], rings = [];
  for (const rad of w ? [r, r - w] : [r]) {
    const top = verts.length;
    verts.push([0, 0, rad]);
    const sets = [];
    for (let level = 1; level <= lat; level++) {
      const th = (Math.PI / 2) * level / lat, ring = [];
      for (let j = 0; j < az; j++) {
        const ph = 2 * Math.PI * j / az;
        ring.push(verts.length);
        verts.push([rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)]);
      }
      sets.push(ring);
    }
    rings.push([top, sets]);
  }
  const [top, outer] = rings[0], nx = j => (j + 1) % az;
  for (let j = 0; j < az; j++) faces.push([top, outer[0][j], outer[0][nx(j)]]);
  for (let s = 0; s + 1 < outer.length; s++) {
    const p = outer[s], q = outer[s + 1];
    for (let j = 0; j < az; j++) faces.push([p[j], q[j], q[nx(j)]], [p[j], q[nx(j)], p[nx(j)]]);
  }
  const lastO = outer[outer.length - 1];
  if (!w) {
    const cap = verts.length;
    verts.push([0, 0, 0]);
    for (let j = 0; j < az; j++) faces.push([cap, lastO[nx(j)], lastO[j]]);
  } else {
    const [itop, inner] = rings[1];
    for (let j = 0; j < az; j++) faces.push([itop, inner[0][nx(j)], inner[0][j]]);
    for (let s = 0; s + 1 < inner.length; s++) {
      const p = inner[s], q = inner[s + 1];
      for (let j = 0; j < az; j++) faces.push([p[j], q[nx(j)], q[j]], [p[j], p[nx(j)], q[nx(j)]]);
    }
    const lastI = inner[inner.length - 1];
    // Rim outward normal is -Z before the axis rotation.
    for (let j = 0; j < az; j++) faces.push([lastO[j], lastI[nx(j)], lastO[nx(j)]], [lastO[j], lastI[j], lastI[nx(j)]]);
  }
  // Orient local +Z along the axis with the smallest rotation (identity for [0, 0, 1]).
  const n = Math.hypot(...a.axis);
  if (!(n > 0)) throw new Error("axis must be nonzero");
  const d = a.axis.map(x => x / n);
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (d[2] < 1 - 1e-12) {
    if (d[2] <= -1 + 1e-12) R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
    else {
      const k = [-d[1], d[0], 0], s = Math.hypot(k[0], k[1]), c = d[2];
      const kx = k[0] / s, ky = k[1] / s, t = 1 - c;
      R = [[c + kx * kx * t, kx * ky * t, ky * s], [kx * ky * t, c + ky * ky * t, -kx * s], [-ky * s, kx * s, c]];
    }
  }
  const vertices = verts.map(p => [0, 1, 2].map(i => a.center[i] + R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]));
  return [{ name: w ? "shell" : "dome", shape: "polyhedron", vertices, faces }];
}
`,
};

BUILTIN_SCRIPTS.tapered_cylinder = {
  label: "Tapered cylinder",
  description: "Frustum / cone between two points, solid or hollow (one CSXCAD Polyhedron).",
  source: `// Built-in: tapered cylinder (frustum). CSXCAD has no cone primitive; this returns one
// Polyhedron. A radius of 0 gives a cone tip; thickness 0 = solid, > 0 = hollow wall.
const args = {
  start:        { type: "point",  default: [0, 0, 0], label: "Start (axis)", step: 0.5 },
  stop:         { type: "point",  default: [0, 0, 30], label: "Stop (axis)", step: 0.5 },
  radius_start: { type: "length", default: 10, label: "Radius at start", step: 0.1, min: 0,
                  handle: { from: "start", dir: "stop", perp: true } },
  radius_stop:  { type: "length", default: 5, label: "Radius at stop", step: 0.1, min: 0,
                  handle: { from: "stop", dir: "start", perp: true } },
  thickness:    { type: "length", default: 0, label: "Wall thickness", step: 0.1,
                  hint: "0 = solid. Otherwise a hollow wall measured inward from the outer surface." },
  segments:     { type: "int",    default: 32, min: 6, max: 256, label: "Segments", more: true,
                  hint: "Facets around the axis." },
  material:     { type: "material" },
};

function generate(a) {
  const ax = [0, 1, 2].map(i => a.stop[i] - a.start[i]);
  const len = Math.hypot(...ax);
  if (!(len > 0)) throw new Error("start and stop must differ");
  const r1 = a.radius_start, r2 = a.radius_stop, t = a.thickness, n = a.segments;
  if (!(r1 > 0 || r2 > 0)) throw new Error("at least one radius must be positive");
  if (t && !(t > 0 && t < Math.min(r1, r2))) throw new Error("thickness must be below both radii");
  const w = ax.map(x => x / len);
  const trial = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = trial[0] * w[0] + trial[1] * w[1] + trial[2] * w[2];
  let u = trial.map((x, i) => x - w[i] * d);
  const un = Math.hypot(...u);
  u = u.map(x => x / un);
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const vertices = [], faces = [];
  // A ring of n vertices (or one point when r = 0) around c; returns indices.
  const ring = (c, r) => {
    if (r === 0) { vertices.push([...c]); return Array(n).fill(vertices.length - 1); }
    const ids = [];
    for (let j = 0; j < n; j++) {
      const ph = 2 * Math.PI * j / n;
      ids.push(vertices.length);
      vertices.push([0, 1, 2].map(i => c[i] + r * (Math.cos(ph) * u[i] + Math.sin(ph) * v[i])));
    }
    return ids;
  };
  const nx = j => (j + 1) % n;
  const tri = (p, q, r) => { if (p !== q && q !== r && p !== r) faces.push([p, q, r]); };
  const B = ring(a.start, r1), T = ring(a.stop, r2);
  for (let j = 0; j < n; j++) { tri(B[j], B[nx(j)], T[nx(j)]); tri(B[j], T[nx(j)], T[j]); } // outer side
  if (!t) {
    if (r1 > 0) { vertices.push([...a.start]); const cb = vertices.length - 1; for (let j = 0; j < n; j++) tri(cb, B[nx(j)], B[j]); }
    if (r2 > 0) { vertices.push([...a.stop]); const ct = vertices.length - 1; for (let j = 0; j < n; j++) tri(ct, T[j], T[nx(j)]); }
  } else {
    const Bi = ring(a.start, r1 - t), Ti = ring(a.stop, r2 - t);
    for (let j = 0; j < n; j++) {
      tri(Bi[j], Ti[nx(j)], Bi[nx(j)]); tri(Bi[j], Ti[j], Ti[nx(j)]);   // inner side (faces inward)
      tri(B[j], Bi[j], Bi[nx(j)]); tri(B[j], Bi[nx(j)], B[nx(j)]);      // start annulus
      tri(T[j], T[nx(j)], Ti[nx(j)]); tri(T[j], Ti[nx(j)], Ti[j]);      // stop annulus
    }
  }
  return [{ name: t ? "tube" : r1 === 0 || r2 === 0 ? "cone" : "frustum", shape: "polyhedron", vertices, faces }];
}
`,
};

export const isBuiltinScript = name => Object.prototype.hasOwnProperty.call(BUILTIN_SCRIPTS, name);
// Source of a script: the file's own definition, else a built-in.
export function scriptSource(defs, name) {
  if (defs && typeof defs === "object" && Object.prototype.hasOwnProperty.call(defs, name)) return defs[name]?.source;
  return isBuiltinScript(name) ? BUILTIN_SCRIPTS[name].source : undefined;
}

export const SCRIPT_TEMPLATE = `// Arguments: each one becomes an input in the object editor.
// Types: point, vector, length, number, int, angle, material, choice, bool.
// Optional keys: label, hint (help text), more (show under "More"), step (snapping),
// min, max, options (choice), handle (drag diamond for length/number).
const args = {
  start:    { type: "point",    default: [0, 0, 0], label: "First rod base", step: 0.5 },
  height:   { type: "length",   default: 30, step: 0.5,
              handle: { from: "start", dir: [0, 0, 1] } },
  radius:   { type: "length",   default: 1, step: 0.1, more: true },
  count:    { type: "int",      default: 4, min: 1, max: 64 },
  spacing:  { type: "length",   default: 15, step: 0.5, hint: "Centre-to-centre distance along x." },
  material: { type: "material" },
};

// Return CSXCAD primitives, written exactly like entries of the geometry list.
function generate(a) {
  return Array.from({ length: a.count }, (_, i) => ({
    name: \`rod\${i + 1}\`,
    shape: "cylinder",
    material: a.material,
    start: [a.start[0] + i * a.spacing, a.start[1], a.start[2]],
    stop: [a.start[0] + i * a.spacing, a.start[1], a.start[2] + a.height],
    radius: a.radius,
  }));
}
`;

// Function body run by both runners with one string parameter `__args`:
// null -> only describe the arguments; JSON text -> also generate.
// Only JSON crosses the boundary, so no host objects leak into the script.
export function scriptBody(source) {
  if (typeof source !== "string") throw Error("Script source must be text");
  if (source.length > SCRIPT_LIMITS.sourceChars) throw Error(`Script is longer than ${SCRIPT_LIMITS.sourceChars} characters`);
  return `"use strict";
${source}
;
if (typeof generate !== "function") throw new Error("Script must define function generate(a)");
const __spec = typeof args === "undefined" ? {} : args;
return JSON.stringify({ args: __spec, objects: __args === null ? null : generate(JSON.parse(__args)) });`;
}

const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x));
const isNum = v => typeof v === "number" && Number.isFinite(v);

// Validate an `args` declaration; returns a normalized copy.
export function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw Error("args must be an object of argument declarations");
  const out = {};
  for (const [key, d] of Object.entries(spec)) {
    if (!SCRIPT_NAME.test(key)) throw Error(`Invalid argument name: ${key}`);
    if (!d || typeof d !== "object") throw Error(`args.${key} must be an object like { type: "length", default: 1 }`);
    const type = d.type;
    if (!(type in ARG_TYPES)) throw Error(`args.${key}.type must be one of ${Object.keys(ARG_TYPES).join(", ")}`);
    const auto = key.replace(/_/g, " ");
    const n = { type, label: typeof d.label === "string" ? d.label : auto[0].toUpperCase() + auto.slice(1) };
    if (isNum(d.min)) n.min = d.min;
    if (isNum(d.max)) n.max = d.max;
    // Editor presentation: help text, "More" placement, snapping / nudge step.
    if (d.hint !== undefined) {
      if (typeof d.hint !== "string") throw Error(`args.${key}.hint must be text`);
      n.hint = d.hint;
    }
    if (d.more !== undefined) {
      if (typeof d.more !== "boolean") throw Error(`args.${key}.more must be true or false`);
      n.more = d.more;
    }
    if (d.step !== undefined) {
      if (!["point", "vector", "length", "number", "int", "angle"].includes(type) || !isNum(d.step) || d.step <= 0) {
        throw Error(`args.${key}.step must be a positive number (numeric and point arguments only)`);
      }
      n.step = d.step;
    }
    if (d.handle !== undefined) {
      // Drag handle in the 3D view: value = scale × distance from point arg `from`
      // along vector arg (or literal [x,y,z]) `dir`, or perpendicular to it with perp: true.
      const hd = d.handle;
      if (!["length", "number"].includes(type)) throw Error(`args.${key}.handle is only for length or number arguments`);
      if (!hd || typeof hd.from !== "string" || !(typeof hd.dir === "string" || vec3(hd.dir))) {
        throw Error(`args.${key}.handle must be { from: "<point arg>", dir: "<vector arg>" or [x, y, z] }`);
      }
      n.handle = { from: hd.from, dir: hd.dir, perp: !!hd.perp, scale: isNum(hd.scale) && hd.scale > 0 ? hd.scale : 1 };
    }
    if (type === "choice") {
      if (!Array.isArray(d.options) || !d.options.length || !d.options.every(o => typeof o === "string")) {
        throw Error(`args.${key}.options must be a list of strings`);
      }
      n.options = [...d.options];
    }
    if (d.default !== undefined) n.default = checkValue(n, d.default, `args.${key}.default`);
    else if (type !== "material") throw Error(`args.${key} needs a default`);
    out[key] = n;
  }
  for (const [key, n] of Object.entries(out)) {
    if (!n.handle) continue;
    if (out[n.handle.from]?.type !== "point") throw Error(`args.${key}.handle.from must name a point argument`);
    if (typeof n.handle.dir === "string" && !["vector", "point"].includes(out[n.handle.dir]?.type)) {
      throw Error(`args.${key}.handle.dir must name a vector argument`);
    }
  }
  return out;
}

function checkValue(def, v, where) {
  switch (def.type) {
    case "point": case "vector":
      if (!vec3(v)) throw Error(`${where} must be [x, y, z]`);
      return [...v];
    case "length": case "number": case "angle": case "int":
      if (!isNum(v)) throw Error(`${where} must be a number`);
      if (def.type === "int" && !Number.isInteger(v)) throw Error(`${where} must be an integer`);
      if (def.type === "length" && v < 0) throw Error(`${where} must not be negative`);
      if (def.min !== undefined && v < def.min) throw Error(`${where} must be ≥ ${def.min}`);
      if (def.max !== undefined && v > def.max) throw Error(`${where} must be ≤ ${def.max}`);
      return v;
    case "material":
      if (typeof v !== "string" || !v) throw Error(`${where} must be a material name`);
      return v;
    case "choice":
      if (!def.options.includes(v)) throw Error(`${where} must be one of ${def.options.join(", ")}`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw Error(`${where} must be true or false`);
      return v;
  }
  return v;
}

// Final argument values for one instance: declared defaults, overridden by the instance.
export function prepareArgs(spec, given, materials, where = "args") {
  given = given ?? {};
  if (typeof given !== "object" || Array.isArray(given)) throw Error(`${where} must be an object`);
  for (const k of Object.keys(given)) if (!(k in spec)) throw Error(`${where}.${k} is not declared by the script`);
  const names = new Set((materials || []).map(m => m.name));
  const out = {};
  for (const [k, d] of Object.entries(spec)) {
    let v = given[k] !== undefined ? given[k] : d.default;
    if (v === undefined && d.type === "material") v = materials?.[0]?.name;
    if (v === undefined) throw Error(`${where}.${k} has no value`);
    v = checkValue(d, v, `${where}.${k}`);
    if (d.type === "material" && !names.has(v)) throw Error(`${where}.${k}: undefined material ${v}`);
    out[k] = v;
  }
  return out;
}

// A script instance is a rigid group: child-local transform first, then
// instance rotation about its local origin and instance translation.
export function composeTransforms(parent, child) {
  if (!parent) return child;
  const pr = transformVec3(parent.rotate_deg ?? [0,0,0], "instance rotation");
  const pt = transformVec3(parent.translate ?? [0,0,0], "instance translation");
  if (![...pr,...pt].some(v=>v!==0)) return child;
  if (!child) return {...parent};
  const cr = transformVec3(child.rotate_deg ?? [0,0,0], "primitive rotation");
  const ct = transformVec3(child.translate ?? [0,0,0], "primitive translation");
  const translate = transformer({transform:parent})(ct);
  let rotate_deg;
  if (!pr.some(Boolean)) rotate_deg = [...cr];
  else if (!cr.some(Boolean)) rotate_deg = [...pr];
  else {
    const p = rotationMatrix(pr), c = rotationMatrix(cr);
    const m = p.map(row=>[0,1,2].map(j=>row.reduce((s,v,k)=>s+v*c[k][j],0)));
    // Rz Ry Rx decomposition; at gimbal lock choose X=0.
    const cy = Math.hypot(m[0][0],m[1][0]);
    const y = Math.atan2(-m[2][0],cy);
    const x = cy>1e-12 ? Math.atan2(m[2][1],m[2][2]) : 0;
    const z = cy>1e-12 ? Math.atan2(m[1][0],m[0][0]) : Math.atan2(-m[0][1],m[1][1]);
    rotate_deg = [x,y,z].map(v=>v*180/Math.PI);
  }
  return {...child,rotate_deg,translate};
}

// Check generate()'s output and turn it into geometry entries for the instance.
export function normalizeObjects(objects, instance, spec, values) {
  if (!Array.isArray(objects)) throw Error("generate() must return a list of primitives");
  if (objects.length > SCRIPT_LIMITS.objects) throw Error(`generate() returned more than ${SCRIPT_LIMITS.objects} objects`);
  const firstMaterial = Object.entries(spec).find(([, d]) => d.type === "material")?.[0];
  const seen = new Set();
  return objects.map((o, i) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) throw Error(`object ${i + 1} is not a primitive`);
    if (!(o.shape in SHAPES)) throw Error(`object ${i + 1}: unknown shape ${JSON.stringify(o.shape)}`);
    if ("script" in o) throw Error(`object ${i + 1}: scripts cannot create script instances`);
    const local = o.name === undefined ? String(i + 1) : String(o.name);
    const name = `${instance.name}/${local}`;
    if (seen.has(name)) throw Error(`object ${i + 1}: duplicate name ${local}`);
    seen.add(name);
    const out = { ...o, name };
    if (out.material === undefined && firstMaterial) out.material = values[firstMaterial];
    if (typeof out.material !== "string") throw Error(`object ${local}: material is required`);
    if (out.priority === undefined && instance.priority !== undefined) out.priority = instance.priority;
    const transform = composeTransforms(instance.transform, out.transform);
    if (transform) out.transform = transform;
    return out;
  });
}

export const isScriptInstance = g => !!g && typeof g === "object" && typeof g.script === "string";

// Expand every script instance of a fully resolved config (no $param/$expr left).
// run(source, argsJSON|null) -> JSON text from scriptBody(); synchronous.
export function expandScripts(config, run) {
  const defs = config.scripts ?? {};
  if (typeof defs !== "object" || Array.isArray(defs)) throw Error("scripts must be an object");
  const specs = new Map();
  for (const name of Object.keys(defs)) if (isBuiltinScript(name)) throw Error(`Script name ${name} is reserved for the built-in script`);
  const sourceOf = name => {
    const source = scriptSource(defs, name);
    if (typeof source !== "string") throw Error(`Undefined script: ${name}`);
    return source;
  };
  const specOf = name => {
    if (!specs.has(name)) specs.set(name, normalizeSpec(JSON.parse(run(sourceOf(name), null)).args));
    return specs.get(name);
  };
  const geometry = [];
  for (const g of config.geometry ?? []) {
    if(g.enabled===false)continue;
    if (!isScriptInstance(g)) { geometry.push(g); continue; }
    const where = `geometry ${g.name || g.script}`;
    try {
      const spec = specOf(g.script);
      const values = prepareArgs(spec, g.args, config.materials, "args");
      const result = JSON.parse(run(sourceOf(g.script), JSON.stringify(values)));
      geometry.push(...normalizeObjects(result.objects, g, spec, values));
    } catch (e) {
      throw Error(`${where} (script ${g.script}): ${e.message}`);
    }
  }
  const out = { ...config, geometry };
  delete out.scripts;
  return out;
}
