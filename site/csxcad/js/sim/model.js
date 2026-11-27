// openEMS model for in-browser runs: a port of antennas/simulate_v2.py output_data()
// up to fdtd.Run(), using the same CSXCAD / openEMS python semantics (install_geometry,
// ports.LumpedPort, CreateNF2FFBox), so the XML matches what the Python simulator writes.
// Input: a resolved, script-expanded schema v2 config (see editor expandResolved()).
import { transformer, helixPoints, hemisphereMesh, polyhedronData, rotationMatrix } from "../geometry.js";
import { setupMesh, boundaryInfo } from "./mesh.js";
import { meshStatistics } from "./diagnostics.js";

const require = (cond, msg) => { if (!cond) throw Error(msg); };
const positive = (v, label) => { const x = Number(v); if (typeof v === "boolean" || !Number.isFinite(x) || x <= 0) throw Error(label + " must be positive"); return x; };
const vec3 = (v, label) => { require(Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x)), label + " must contain 3 finite coordinates"); return v.map(Number); };
const AXES = ["x", "y", "z"];
const minv = pts => [0, 1, 2].map(i => Math.min(...pts.map(p => p[i])));
const maxv = pts => [0, 1, 2].map(i => Math.max(...pts.map(p => p[i])));
// Full precision (shortest round-trip): openEMS snaps primitives to mesh lines, and a
// coordinate written with fewer digits than the mesh line can snap to the neighbour.
const num = x => String(Number(x));
const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// simulate_v2.frequencies(): sorted unique S11 points rounded to 4 decimals (Hz)
export function frequencies(sweeps, f0, fc) {
  require(Array.isArray(sweeps) && sweeps.length > 0, "At least one S11 sweep is required");
  const pts = new Set();
  const r4 = v => Math.round(v * 1e4) / 1e4;
  for (const s of sweeps) {
    const a = Number(s.start), b = Number(s.end), step = positive(s.step, "s11.step");
    require(a > 0 && b >= a, "S11 start/end invalid");
    const n = Math.floor((b - a) / step + 1e-8) + 1;
    require(n <= 20001, "Single sweep exceeds 20001 points");
    for (let i = 0; i < n; i++) pts.add(r4(a + i * step));
    if (Math.abs(a + (n - 1) * step - b) > 0.001) pts.add(r4(b));
  }
  const out = [...pts].sort((x, y) => x - y);
  require(out.length <= 30000, "Too many S11 frequency points");
  require(out[0] >= f0 - fc && out[out.length - 1] <= f0 + fc, "S11 frequencies outside excitation band");
  return out;
}

// v2_geometry.box_data faces (for rotated boxes)
const BOX_FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

// v2_geometry.install_geometry → { xml (primitive element), lo, hi, preview }
export function installGeometry(g) {
  const shape = g.shape ?? g.type;
  const priority = Math.trunc(Number(g.priority ?? 10));
  const T = transformer(g);
  const rotated = (g.transform?.rotate_deg ?? [0, 0, 0]).some(v => v !== 0);
  const P = (tag, p) => `<${tag} X="${num(p[0])}" Y="${num(p[1])}" Z="${num(p[2])}" />`;
  const poly = (verts, faces) => `<Polyhedron Priority="${priority}">${verts.map(v => `<Vertex>${v.map(num).join(",")}</Vertex>`).join("")}${faces.map(f => `<Face>${f.join(",")}</Face>`).join("")}</Polyhedron>`;
  switch (shape) {
    case "box": {
      const a = vec3(g.start, "box.start"), b = vec3(g.stop, "box.stop");
      require(a.every((v, i) => v <= b[i]), "box.start must be <= box.stop");
      const verts = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]],
        [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]];
      const flat = a.some((v, i) => v === b[i]);
      const world = verts.map(T);
      require(!(flat && rotated), "Rotated zero-thickness boxes are unsupported: use a 3D box or a mesh");
      const xml = rotated ? poly(world, BOX_FACES) : `<Box Priority="${priority}">${P("P1", T(a))}${P("P2", T(b))}</Box>`;
      return { xml, lo: minv(world), hi: maxv(world), preview: { vertices: world, faces: BOX_FACES } };
    }
    case "cylinder": case "cylindrical_shell": {
      const a = T(vec3(g.start, "cylinder.start")), b = T(vec3(g.stop, "cylinder.stop"));
      const r = positive(g.radius, "cylinder.radius");
      require(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) !== 0, "cylinder start and stop must differ");
      let xml;
      if (shape === "cylinder") xml = `<Cylinder Priority="${priority}" Radius="${num(r)}">${P("P1", a)}${P("P2", b)}</Cylinder>`;
      else {
        const w = positive(g.thickness, "cylindrical_shell.thickness");
        require(w < 2 * r, "cylindrical_shell.thickness must be less than diameter");
        xml = `<CylindricalShell Priority="${priority}" Radius="${num(r)}" ShellWidth="${num(w)}">${P("P1", a)}${P("P2", b)}</CylindricalShell>`;
      }
      return { xml, lo: minv([a, b]).map(v => v - r), hi: maxv([a, b]).map(v => v + r), preview: { start: a, stop: b, radius: r } };
    }
    case "sphere": case "spherical_shell": {
      const c = T(vec3(g.center, "sphere.center")), r = positive(g.radius, "sphere.radius");
      let xml;
      if (shape === "sphere") xml = `<Sphere Priority="${priority}" Radius="${num(r)}">${P("Center", c)}</Sphere>`;
      else {
        const w = positive(g.thickness, "spherical_shell.thickness");
        require(w < r, "spherical_shell thickness must be < radius");
        xml = `<SphericalShell Priority="${priority}" Radius="${num(r)}" ShellWidth="${num(w)}">${P("Center", c)}</SphericalShell>`;
      }
      return { xml, lo: c.map(v => v - r), hi: c.map(v => v + r), preview: { center: c, radius: r } };
    }
    case "wire": case "helix": {
      let pts;
      if (shape === "wire") {
        pts = g.points;
        require(Array.isArray(pts) && pts.length >= 2 && pts.length <= 8001 && pts.every(p => Array.isArray(p) && p.length === 3),
          "wire.points must be list of 2..8001 XYZ vertices");
        pts = pts.map(p => p.map(Number));
      } else pts = helixPoints(g);
      require(pts.every(p => p.every(Number.isFinite)), "Non-finite wire coordinates");
      pts = pts.map(T);
      const r = positive(g.wire_diameter, "wire_diameter") / 2;
      const xml = `<Wire Priority="${priority}" WireRadius="${num(r)}">${pts.map(p => P("Vertex", p)).join("")}</Wire>`;
      return { xml, lo: minv(pts).map(v => v - r), hi: maxv(pts).map(v => v + r), preview: { points: pts, radius: r } };
    }
    case "hemisphere": case "hemispherical_shell": {
      const w = shape === "hemispherical_shell" ? positive(g.thickness, "hemispherical_shell.thickness") : null;
      const { verts, faces } = hemisphereMesh(positive(g.radius, "hemisphere.radius"), w);
      const c = vec3(g.center, "hemisphere.center");
      const world = verts.map(v => T([v[0] + c[0], v[1] + c[1], v[2] + c[2]]));
      return { xml: poly(world, faces), lo: minv(world), hi: maxv(world), preview: { vertices: world, faces } };
    }
    case "polyhedron": {
      const { verts, faces } = polyhedronData(g);
      const world = verts.map(T);
      return { xml: poly(world, faces), lo: minv(world), hi: maxv(world), preview: { vertices: world, faces: faces.flatMap(f => f.slice(2).map((v, i) => [f[0], f[i + 1], v])) } };
    }
  }
  throw Error(`Unsupported schema v2 shape: ${JSON.stringify(shape)}`);
}

function materialXml(m, id, prims) {
  const name = esc(m.name), body = `<Primitives>${prims.join("")}</Primitives>`;
  switch (m.type) {
    case "pec": return `<Metal ID="${id}" Name="${name}">${body}</Metal>`;
    case "dielectric": {
      const eps = positive(m.epsilon, "dielectric.epsilon");
      require(eps >= 1, "relative permittivity must be >= 1");
      const kappa = Number(m.kappa_s_per_m ?? 0);
      require(Number.isFinite(kappa) && kappa >= 0, "dielectric conductivity invalid");
      return `<Material ID="${id}" Name="${name}" Isotropy="1"><Property Epsilon="${num(eps)}" Mue="1" Kappa="${num(kappa)}" Sigma="0" />${body}</Material>`;
    }
    case "conductive": {
      const kappa = positive(m.conductivity_s_per_m, "conductive conductivity");
      return `<Material ID="${id}" Name="${name}" Isotropy="1"><Property Epsilon="1" Mue="1" Kappa="${num(kappa)}" Sigma="0" />${body}</Material>`;
    }
    case "conducting_sheet": {
      const s = positive(m.conductivity_s_per_m, "sheet conductivity"), t = positive(m.thickness_m, "sheet thickness in meters");
      return `<ConductingSheet ID="${id}" Name="${name}" Conductivity="${num(s)}" Thickness="${num(t)}">${body}</ConductingSheet>`;
    }
  }
  throw Error(`Unsupported material type ${JSON.stringify(m.type)}`);
}

export const PATTERN_GRID = cfg => {
  const outputs = cfg.outputs ?? {};
  const ang = cfg.radiation_pattern_grid ?? outputs.radiation_grid ?? {};
  const ts = positive(ang.theta_step_deg ?? 10, "theta_step_deg"), ps = positive(ang.phi_step_deg ?? 10, "phi_step_deg");
  require(ts <= 30 && ps <= 30, "Angular steps must be <=30 deg");
  const nt = Math.round(180 / ts) + 1, np = Math.round(360 / ps);
  const theta = Array.from({ length: nt }, (_, i) => 180 * i / (nt - 1));
  const phi = Array.from({ length: np }, (_, i) => 360 * i / np);
  require(nt * np <= 30000, "Radiation grid too large");
  return { theta, phi };
};

export function buildModel(config) {
  require(config.schema_version === 2, "simulate_v2 requires schema_version=2");
  require(config.units === "mm", "v2 supports millimetres only");
  const exc = config.excitation ?? {};
  const f0 = positive(exc.center_hz, "excitation.center_hz"), fc = positive(exc.bandwidth_hz, "excitation.bandwidth_hz");
  require(f0 > fc, "Excitation bandwidth must be < center frequency");
  const outputs = config.outputs ?? {};
  const freq = frequencies(outputs.s11 ?? config.s11, f0, fc);
  let patterns = outputs.radiation_frequencies_hz ?? config.radiation_pattern_frequencies_hz ?? [];
  require(patterns.length > 0 && patterns.length <= 12, "Must request 1..12 far-field frequencies");
  patterns = patterns.map(Number);
  require(patterns.every(f => f >= f0 - fc && f <= f0 + fc), "Far-field frequencies outside excitation bandwidth");
  const { theta, phi } = PATTERN_GRID(config);

  const ds = vec3(config.domain?.start, "domain.start"), de = vec3(config.domain?.stop, "domain.stop");
  require(de.every((v, i) => v > ds[i]), "Invalid simulation domain");
  const boundary = config.domain.boundary ?? Array(6).fill("PML_8");
  require(boundary.length === 6, "Require six boundary conditions");
  const solver = config.solver ?? {};

  // materials and geometry (one CSXCAD property per material, primitives in config order)
  const mats = new Map();
  for (const m of config.materials ?? []) {
    require(!mats.has(m.name), `Duplicate material ${m.name}`);
    mats.set(m.name, { def: m, prims: [] });
  }
  require((config.geometry ?? []).length > 0, "At least one geometry object required");
  const geometryBounds = [], previews = [];
  for (const g of config.geometry) {
    require(!("script" in g), "Script instances must be expanded before building the model");
    require(mats.has(g.material), `Undefined material ${g.material}`);
    const md = mats.get(g.material).def;
    if (md.type === "conducting_sheet") {
      require((g.shape ?? g.type) === "box", "Conducting sheets require 2D box geometry");
      require(g.start.filter((v, i) => Number(v) === Number(g.stop[i])).length === 1, "Conducting sheet must have exactly one zero-thickness dimension");
    }
    const r = installGeometry(g);
    require(r.lo.every((v, i) => v >= ds[i]) && r.hi.every((v, i) => v <= de[i]),
      `Geometry ${g.name ?? g.shape} must fit inside domain including thickness`);
    mats.get(g.material).prims.push(r.xml);
    previews.push({ shape: g.shape ?? g.type, name: g.name, material: g.material, ...r.preview });
    geometryBounds.push([r.lo, r.hi]);
  }

  // ports
  const ports = config.ports ?? config.sources ?? [];
  require(ports.length > 0, "At least one port is required");
  const active = ports.filter(p => p.excite ?? p.enabled ?? false);
  require(active.length === 1, "Exactly one port must be excited in each FDTD run");
  const pid = p => Math.trunc(Number(p.id ?? p.port_number ?? 1));
  require(new Set(ports.map(pid)).size === ports.length, "Port IDs must be unique");
  const sourceBounds = ports.map(p => {
    const a = vec3(p.start, "port.start"), b = vec3(p.stop, "port.stop");
    const ext = p.type === "coaxial" ? Number(p.outer_radius ?? 0) : 0;
    const lo = a.map((v, i) => Math.min(v, b[i]) - ext), hi = a.map((v, i) => Math.max(v, b[i]) + ext);
    require(lo.every((v, i) => v >= ds[i]) && hi.every((v, i) => v <= de[i]), "Port must fit within domain");
    return [lo, hi];
  });
  const { grid, counts, cells } = setupMesh(config, geometryBounds, sourceBounds, previews, ports, ds, de);

  // properties in creation order (IDs as CSXCAD assigns them)
  let id = 0;
  const props = [];
  for (const m of mats.values()) {
    if (m.prims.length) props.push(materialXml(m.def, id++, m.prims));
  }
  const portInfo = [];
  for (const s of ports) {
    const n = pid(s);
    require(n >= 1, "Port ID must be >= 1");
    const kind = s.type;
    require(kind === "lumped" || kind === "lumped_port", `${kind} ports are not supported in the browser yet (lumped only)`);
    const dir = s.direction ?? s.excitation_direction;
    require(["x", "y", "z"].includes(dir), "Lumped port requires direction=x/y/z");
    const R = positive(s.impedance_ohm ?? 50, "port impedance");
    const ny = AXES.indexOf(dir);
    const a = vec3(s.start, "port.start"), b = vec3(s.stop, "port.stop");
    require(a[ny] !== b[ny], "LumpedPort: start and stop may not be identical in excitation direction");
    const direction = Math.sign(b[ny] - a[ny]);
    const excite = (s.excite ?? s.enabled ?? false) ? 1 : 0;
    const prio = Math.trunc(Number(s.priority ?? 5));
    const box = (p1, p2, pr) => `<Box Priority="${pr}"><P1 X="${num(p1[0])}" Y="${num(p1[1])}" Z="${num(p1[2])}" /><P2 X="${num(p2[0])}" Y="${num(p2[1])}" Z="${num(p2[2])}" /></Box>`;
    props.push(`<LumpedElement ID="${id++}" Name="port_resist_${n}" Direction="${ny}" Caps="1" R="${num(R)}"><Primitives>${box(a, b, prio)}</Primitives></LumpedElement>`);
    if (excite) {
      const ev = [0, 0, 0]; ev[ny] = -1 * direction * excite;
      props.push(`<Excitation ID="${id++}" Name="port_excite_${n}" Number="0" Enabled="1" Frequency="0" Delay="0" Type="0" Excite="${ev.map(num).join(",")}"><Primitives>${box(a, b, prio)}</Primitives><Weight X="1" Y="1" Z="1" /></Excitation>`);
    }
    const mid = a.map((v, i) => 0.5 * (v + b[i]));
    const us = [...mid], ue = [...mid]; us[ny] = a[ny]; ue[ny] = b[ny];
    props.push(`<ProbeBox ID="${id++}" Name="port_ut_${n}" Number="0" Type="0" Weight="-1" NormDir="-1"><Primitives>${box(us, ue, 0)}</Primitives></ProbeBox>`);
    const is = [...a], ie = [...b]; is[ny] = 0.5 * (a[ny] + b[ny]); ie[ny] = is[ny];
    props.push(`<ProbeBox ID="${id++}" Name="port_it_${n}" Number="0" Type="1" Weight="${num(direction)}" NormDir="${ny}"><Primitives>${box(is, ie, 0)}</Primitives></ProbeBox>`);
    portInfo.push({ id: n, name: s.name ?? `port-${n}`, R, excite: !!excite });
  }

  // NF2FF box: openEMS.CreateNF2FFBox on the final grid
  const bcs = boundary.map(boundaryInfo);
  const start = [], stop = [];
  for (let n = 0; n < 3; n++) {
    const l = grid.lines[n];
    require(l.length - 1 > bcs[2 * n].size + bcs[2 * n + 1].size, `NF2FF box has no interior on ${AXES[n]}. Increase the domain or reduce the mesh step.`);
    start.push(l[bcs[2 * n].size]);
    stop.push(l[l.length - 1 - bcs[2 * n + 1].size]);
    for (const [lo, hi] of [...geometryBounds, ...sourceBounds]) {
      require((!bcs[2 * n].size || start[n] < lo[n]) && (!bcs[2 * n + 1].size || stop[n] > hi[n]),
        `NF2FF box intersects geometry or a port on ${AXES[n]}. Increase the domain or reduce the mesh step.`);
    }
  }
  const directions = bcs.map(b => b.type > 1), mirror = bcs.map(b => b.mirror);
  const nfBoxes = [];
  for (let ny = 0; ny < 3; ny++) {
    if (directions[2 * ny]) { const e = [...stop]; e[ny] = start[ny]; nfBoxes.push([start, e]); }
    if (directions[2 * ny + 1]) { const s0 = [...start]; s0[ny] = stop[ny]; nfBoxes.push([s0, stop]); }
  }
  const dumpBoxes = nfBoxes.map(([p, q]) => `<Box Priority="0"><P1 X="${num(p[0])}" Y="${num(p[1])}" Z="${num(p[2])}" /><P2 X="${num(q[0])}" Y="${num(q[1])}" Z="${num(q[2])}" /></Box>`).join("");
  props.push(`<DumpBox ID="${id++}" Name="nf2ff_E" Number="0" Type="0" Weight="1" NormDir="-1" DumpType="0" DumpMode="1" FileType="1" MultiGridLevel="0"><Primitives>${dumpBoxes}</Primitives></DumpBox>`);
  props.push(`<DumpBox ID="${id++}" Name="nf2ff_H" Number="0" Type="0" Weight="1" NormDir="-1" DumpType="1" DumpMode="1" FileType="1" MultiGridLevel="0"><Primitives>${dumpBoxes}</Primitives></DumpBox>`);

  const lines = grid.lines.map((l, i) => `<${"XYZ"[i]}Lines Qty="${l.length}">${l.map(num).join(",")}</${"XYZ"[i]}Lines>`).join("");
  const bc = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"].map((k, i) => `${k}="${esc(boundary[i])}"`).join(" ");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<openEMS>
<FDTD NumberOfTimesteps="${Math.trunc(Number(solver.max_timesteps ?? 20000))}" endCriteria="${num(solver.end_criteria ?? 1e-4)}" OverSampling="4" TimeStepMethod="3">
<Excitation Type="0" f0="${num(f0)}" fc="${num(fc)}" />
<BoundaryCond ${bc} />
</FDTD>
<ContinuousStructure CoordSystem="0">
<RectilinearGrid DeltaUnit="0.001" CoordSystem="0">${lines}</RectilinearGrid>
<BackgroundMaterial Epsilon="1" Mue="1" Kappa="0" Sigma="0" />
<ParameterSet />
<Properties>
${props.join("\n")}
</Properties>
</ContinuousStructure>
</openEMS>
`;
  const driven = portInfo.find(p => p.excite);
  return {
    xml, counts, cells, freq, patterns, theta, phi, ports: portInfo, driven,
    nf2ff: { e_file: "nf2ff_E", h_file: "nf2ff_H", start, stop, directions, mirror },
    previews, deltaUnit: 1e-3, meshStatistics: meshStatistics(grid.lines),
  };
}
