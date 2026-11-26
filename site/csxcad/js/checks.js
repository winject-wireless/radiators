// Pre-flight checks for a resolved case, mirroring the requirements that
// antennas/simulate_v2.py enforces before it starts openEMS. Passing these
// does not mean the model is electrically sound (feed, mesh convergence).

import { solverBounds, vec3 } from "./geometry.js";

const fin = v => typeof v === "number" && Number.isFinite(v);

export function checkCase(cfg) {
  const out = [];
  const err = (where, msg, ref) => out.push({ level: "error", where, msg, ref });
  const warn = (where, msg, ref) => out.push({ level: "warn", where, msg, ref });
  const tryv = (fn, where, ref) => { try { return fn(); } catch (e) { err(where, e.message, ref); return null; } };

  if (cfg.schema_version !== 2) err("document", "schema_version must be 2");
  if (cfg.units !== "mm") err("document", "units must be \"mm\"");
  if (!cfg.name) err("document", "Simulation needs a nonempty name");

  // Excitation and outputs
  const ex = cfg.excitation || {};
  const f0 = ex.center_hz, fc = ex.bandwidth_hz;
  if (!(fin(f0) && f0 > 0)) err("excitation", "center_hz must be positive");
  if (!(fin(fc) && fc > 0)) err("excitation", "bandwidth_hz must be positive");
  else if (fin(f0) && !(f0 > fc)) err("excitation", "Excitation bandwidth must be < center frequency");
  const outputs = cfg.outputs || {};
  const s11 = outputs.s11 ?? cfg.s11;
  if (!Array.isArray(s11) || !s11.length) err("outputs", "At least one S11 sweep is required");
  else s11.forEach((s, i) => {
    if (!(fin(s.start) && fin(s.end) && fin(s.step) && s.step > 0 && s.start > 0 && s.end >= s.start)) {
      err("outputs", `S11 sweep ${i + 1}: start/end/step invalid`);
    } else {
      if ((s.end - s.start) / s.step + 1 > 20001) err("outputs", `S11 sweep ${i + 1} exceeds 20001 points`);
      if (fin(f0) && fin(fc) && (s.start < f0 - fc || s.end > f0 + fc)) {
        err("outputs", `S11 sweep ${i + 1} is outside the excitation band ${((f0 - fc) / 1e9).toFixed(3)}–${((f0 + fc) / 1e9).toFixed(3)} GHz`);
      }
    }
  });
  const pats = outputs.radiation_frequencies_hz ?? cfg.radiation_pattern_frequencies_hz ?? [];
  if (!Array.isArray(pats) || pats.length < 1 || pats.length > 12) err("outputs", "Must request 1..12 far-field frequencies");
  else if (fin(f0) && fin(fc) && pats.some(f => !(f >= f0 - fc && f <= f0 + fc))) {
    err("outputs", "Far-field frequencies outside excitation bandwidth");
  }

  // Domain
  const dom = cfg.domain || {};
  const ds = tryv(() => vec3(dom.start, "domain.start"), "domain");
  const de = tryv(() => vec3(dom.stop, "domain.stop"), "domain");
  if (ds && de && !ds.every((v, i) => de[i] > v)) err("domain", "Invalid simulation domain (stop must exceed start)");
  const boundary = dom.boundary ?? Array(6).fill("PML_8");
  if (!Array.isArray(boundary) || boundary.length !== 6) err("domain", "Require six boundary conditions");

  // Mesh
  const mesh = cfg.mesh;
  if (!mesh) err("mesh", "mesh section is required");
  else {
    const res = mesh.resolution_mm ?? mesh.max_cell_mm ?? 5;
    if (!(fin(res) && res > 0)) err("mesh", "mesh max_cell_mm must be positive");
    const gr = mesh.growth_ratio ?? 1.4;
    if (!(gr >= 1.01 && gr <= 2)) err("mesh", "mesh.growth_ratio must be 1.01..2");
    if (fin(f0) && fin(fc) && fin(res)) {
      const lambda = 299792458 / (f0 + fc) * 1000;
      if (res > lambda / 10) warn("mesh", `max_cell_mm ${res} > λmin/10 (${(lambda / 10).toFixed(2)} mm)`);
    }
    for (const [i, r] of (mesh.refinements || []).entries()) {
      try {
        const a = vec3(r.start, "refinement.start"), b = vec3(r.stop, "refinement.stop");
        if (!a.every((v, k) => b[k] > v)) err("mesh", `refinement ${i + 1}: stop <= start`);
        if (!(r.resolution_mm > 0)) err("mesh", `refinement ${i + 1}: resolution_mm must be positive`);
      } catch (e) { err("mesh", `refinement ${i + 1}: ${e.message}`); }
    }
  }

  // Materials
  const mats = new Map();
  for (const m of cfg.materials || []) {
    if (mats.has(m.name)) err("materials", "Duplicate material " + m.name);
    mats.set(m.name, m);
    if (m.type === "dielectric") {
      if (!(m.epsilon >= 1)) err("materials", `${m.name}: relative permittivity must be >= 1`);
      if (m.kappa_s_per_m !== undefined && !(m.kappa_s_per_m >= 0)) err("materials", `${m.name}: dielectric conductivity invalid`);
    } else if (m.type === "conductive") {
      if (!(m.conductivity_s_per_m > 0)) err("materials", `${m.name}: conductivity must be positive`);
      warn("materials", `${m.name}: bulk conductors need the mesh to resolve skin depth; prefer PEC for ideal comparisons`);
    } else if (m.type === "conducting_sheet") {
      if (!(m.conductivity_s_per_m > 0)) err("materials", `${m.name}: sheet conductivity must be positive`);
      if (!(m.thickness_m > 0)) err("materials", `${m.name}: sheet thickness (metres) must be positive`);
      else if (m.thickness_m > 1e-3) warn("materials", `${m.name}: thickness_m is ${m.thickness_m} m — the unit is metres, not mm`);
    } else if (m.type !== "pec") err("materials", `${m.name}: unsupported material type ${JSON.stringify(m.type)}`);
  }

  // Geometry
  const geometry = cfg.geometry;
  if (!Array.isArray(geometry) || !geometry.length) err("geometry", "At least one geometry object required");
  (geometry || []).forEach((g, i) => {
    const label = g.name || g.shape || `#${i + 1}`;
    const ref = { kind: "geometry", index: i };
    const m = mats.get(g.material);
    if (!m) err(label, "Undefined material " + JSON.stringify(g.material), ref);
    if (m?.type === "conducting_sheet") {
      if ((g.shape ?? g.type) !== "box") err(label, "Conducting sheets require 2D box geometry", ref);
      else if (Array.isArray(g.start) && Array.isArray(g.stop) &&
               g.start.filter((v, k) => v === g.stop[k]).length !== 1) {
        err(label, "Conducting sheet must have exactly one zero-thickness dimension", ref);
      }
    }
    if (g.priority !== undefined && !Number.isInteger(g.priority)) err(label, "priority must be an integer", ref);
    const bounds = tryv(() => solverBounds(g), label, ref);
    if (bounds && bounds.flat().some(v => !Number.isFinite(v))) err(label, "Non-finite geometry bounding box", ref);
    else if (bounds && ds && de && !(bounds[0].every((v, k) => v >= ds[k]) && bounds[1].every((v, k) => v <= de[k]))) {
      err(label, "Geometry must fit inside domain including thickness", ref);
    }
  });

  // Ports
  const ports = cfg.ports ?? cfg.sources ?? [];
  if (!ports.length) err("ports", "At least one port is required");
  const active = ports.filter(p => p.excite ?? p.enabled ?? false);
  if (ports.length && active.length !== 1) err("ports", `Exactly one port must be excited per run (now ${active.length})`);
  const ids = ports.map(p => Math.trunc(Number(p.id ?? p.port_number ?? 1)));
  if (new Set(ids).size !== ids.length) err("ports", "Port IDs must be unique");
  ports.forEach((p, i) => {
    const label = "port " + (p.name || p.id || i + 1);
    const ref = { kind: "port", index: i };
    if (!(ids[i] >= 1)) err(label, "Port ID must be >= 1", ref);
    const a = tryv(() => vec3(p.start, "port.start"), label, ref);
    const b = tryv(() => vec3(p.stop, "port.stop"), label, ref);
    if (a && b && ds && de) {
      const lo = a.map((v, k) => Math.min(v, b[k])), hi = a.map((v, k) => Math.max(v, b[k]));
      if (!(lo.every((v, k) => v >= ds[k]) && hi.every((v, k) => v <= de[k]))) err(label, "Port must fit within domain", ref);
    }
    if (p.type === "lumped" || p.type === "lumped_port") {
      const d = p.direction ?? p.excitation_direction;
      if (!["x", "y", "z"].includes(d)) err(label, "Lumped port requires direction=x/y/z", ref);
      if (p.impedance_ohm !== undefined && !(p.impedance_ohm > 0)) err(label, "port impedance must be positive", ref);
      if (a && b && ["x", "y", "z"].includes(d)) {
        const k = "xyz".indexOf(d);
        if (a[k] === b[k]) err(label, `Lumped port has zero length along its direction ${d}`, ref);
      }
    } else if (p.type === "msl" || p.type === "coaxial") {
      const metal = mats.get(p.metal_material);
      if (!metal) err(label, "Unknown metal_material " + JSON.stringify(p.metal_material), ref);
      else if (metal.type !== "pec") err(label, "metal_material must be PEC", ref);
      if (p.type === "msl") {
        const pr = p.propagation_direction, ed = p.excitation_direction;
        if (!["x", "y", "z"].includes(pr) || !["x", "y", "z"].includes(ed) || pr === ed) {
          err(label, "MSL port propagation/excitation axes invalid", ref);
        }
      } else {
        if (p.dielectric_material && mats.get(p.dielectric_material)?.type !== "dielectric") {
          err(label, "Coax dielectric must be a dielectric material", ref);
        }
        if (!(p.inner_radius > 0 && p.inner_radius < p.outer_inner_radius && p.outer_inner_radius < p.outer_radius)) {
          err(label, "Coax radii must satisfy 0 < inner < outer_inner < outer", ref);
        }
        if (!["x", "y", "z"].includes(p.propagation_direction)) err(label, "Coax propagation direction must be x/y/z", ref);
      }
    } else err(label, "Unsupported port type " + JSON.stringify(p.type), ref);
  });

  const res = cfg.solver?.resources;
  if (res && (!(res.cpus > 0) || !(res.memory_gib > 0))) warn("solver", "solver.resources needs positive cpus and memory_gib");
  return out;
}
