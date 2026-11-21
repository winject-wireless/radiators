/* Radiators JSCAD antenna editor.
 * Part identity belongs to the simulation JSON (editor_id/name), not to
 * @jscad/modeling geom3 instances, which operations replace immutably.
 */
(function (root) {
  "use strict";

  const copy = value => JSON.parse(JSON.stringify(value));
  const degrees = value => Number(value || 0) * Math.PI / 180;
  const xyz = (value, label) => {
    if (!Array.isArray(value) || value.length !== 3 ||
        value.some(n => !Number.isFinite(n))) {
      throw Error(label + " must be [x, y, z] with finite numbers");
    }
    return value;
  };
  const positive = (n, label) => {
    if (!Number.isFinite(n) || n <= 0) throw Error(label + " must be > 0");
    return n;
  };
  const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
  const norm = a => {
    const n = Math.hypot(...a);
    if (!n) throw Error("Axis cannot be zero");
    return a.map(v => v / n);
  };

  function cylinderBetween(start, stop, radius, modeling) {
    const a = xyz(start, "cylinder.start");
    const b = xyz(stop, "cylinder.stop");
    const length = positive(distance(a, b), "cylinder length");
    const d = b.map((v, i) => (v - a[i]) / length);
    const { cylinder } = modeling.primitives;
    const { rotateY, rotateZ, translate } = modeling.transforms;
    const inclination = Math.acos(Math.max(-1, Math.min(1, d[2])));
    const azimuth = Math.atan2(d[1], d[0]);
    return translate(a.map((v, i) => (v + b[i]) / 2),
      rotateZ(azimuth, rotateY(inclination,
        cylinder({ radius: positive(radius, "radius"), height: length, segments: 16 }))));
  }

  function helixPoints(g) {
    const origin = xyz(g.origin, "helix.origin");
    const axis = norm(xyz(g.axis || [0, 0, 1], "helix.axis"));
    const trial = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const scalar = dot(axis, trial);
    const u = norm(trial.map((v, i) => v - scalar * axis[i]));
    const v = cross(axis, u);
    const turns = positive(g.turns, "helix.turns");
    const diameter = positive(g.diameter, "helix.diameter");
    const height = positive(g.height, "helix.height");
    const segments = g.segments_per_turn === undefined ? 24 : g.segments_per_turn;
    if (!Number.isInteger(segments) || segments < 8 || segments > 80 ||
        turns * segments > 8000) throw Error("Invalid helix segments_per_turn");
    const count = Math.ceil(turns * segments);
    const phase = degrees(g.phase_deg || 0);
    return Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count;
      const alpha = 2 * Math.PI * turns * t + phase;
      return origin.map((base, j) => base + t * height * axis[j] +
        diameter / 2 * (Math.cos(alpha) * u[j] + Math.sin(alpha) * v[j]));
    });
  }

  function applyTransform(solid, g, modeling) {
    const transform = g.transform || {};
    const r = xyz(transform.rotate_deg || [0, 0, 0], "transform.rotate_deg");
    const t = xyz(transform.translate || [0, 0, 0], "transform.translate");
    const { rotateX, rotateY, rotateZ, translate } = modeling.transforms;
    return translate(t, rotateZ(degrees(r[2]), rotateY(degrees(r[1]),
      rotateX(degrees(r[0]), solid))));
  }

  function componentSolids(g, modeling) {
    if (!g || typeof g !== "object" || Array.isArray(g)) throw Error("Invalid component");
    const { cuboid, sphere } = modeling.primitives;
    let solids = [];
    switch (g.shape) {
      case "box": {
        const a = xyz(g.start, "box.start"), b = xyz(g.stop, "box.stop");
        if (a.some((v, i) => v > b[i])) throw Error("box.start must be <= box.stop");
        // A native 2D CSXCAD conducting sheet gets a visual-only thickness.
        const size = a.map((v, i) => Math.max(b[i] - v, 0.05));
        solids = [modeling.transforms.translate(
          a.map((v, i) => (v + b[i]) / 2), cuboid({ size }))];
        break;
      }
      case "cylinder":
        solids = [cylinderBetween(g.start, g.stop, positive(g.radius, "radius"), modeling)];
        break;
      case "sphere":
        solids = [modeling.transforms.translate(xyz(g.center, "sphere.center"),
          sphere({ radius: positive(g.radius, "radius"), segments: 20 }))];
        break;
      case "wire":
      case "helix": {
        const points = g.shape === "helix" ? helixPoints(g) : g.points;
        if (!Array.isArray(points) || points.length < 2 || points.length > 8001) {
          throw Error("wire needs 2–8001 points");
        }
        points.forEach((p, i) => xyz(p, "wire.points[" + i + "]"));
        const radius = positive(g.wire_diameter, "wire_diameter") / 2;
        // Preview with cylinders/spheres. The simulator uses a native CSXCAD wire.
        // Limit large models in-browser; never alter the exported native wire.
        const stride = Math.max(1, Math.ceil((points.length - 1) / 240));
        const sampled = points.filter((_, i) => i % stride === 0);
        if (sampled[sampled.length - 1] !== points[points.length - 1]) {
          sampled.push(points[points.length - 1]);
        }
        solids = sampled.slice(1).map((p, i) =>
          cylinderBetween(sampled[i], p, radius, modeling));
        solids.push(...sampled.map(p => modeling.transforms.translate(p,
          sphere({ radius, segments: 8 }))));
        break;
      }
      default:
        throw Error("Unsupported editor preview shape: " + g.shape);
    }
    return solids.map(s => applyTransform(s, g, modeling));
  }

  function normalizeConfig(config) {
    if (!config || config.schema_version !== 2 ||
        !Array.isArray(config.geometry) || !Array.isArray(config.materials)) {
      throw Error("Import requires radiators schema_version 2 with geometry and materials arrays");
    }
    const result = copy(config);
    const seenIds = new Set();
    const seenNames = new Set();
    result.geometry.forEach((g, i) => {
      if (!g || typeof g !== "object" || Array.isArray(g)) {
        throw Error("Invalid geometry entry " + (i + 1));
      }
      let name = String(g.name || g.shape || "Component").trim();
      let candidate = name, suffix = 2;
      while (seenNames.has(candidate)) candidate = name + " " + suffix++;
      g.name = candidate;
      seenNames.add(candidate);
      let id = String(g.editor_id || "component-" + String(i + 1).padStart(3, "0"));
      while (seenIds.has(id)) id += "-copy";
      g.editor_id = id;
      seenIds.add(id);
    });
    return result;
  }

  function buildJscadSource(config) {
    const normalized = normalizeConfig(config);
    const helpers = [degrees, xyz, positive, distance, cross, dot, norm,
      cylinderBetween, helixPoints, applyTransform, componentSolids]
      .map(fn => fn.toString()).join("\n\n");
    return `// Generated by Radiators antenna editor. Units: millimetres.
// Named components are retained in config.geometry. JSCAD geom3 has no
// persistent native object name; main() returns the component solids.
const modeling = require('@jscad/modeling');
const config = ${JSON.stringify(normalized, null, 2)};

${helpers}

function main() {
  return config.geometry.flatMap(component => componentSolids(component, modeling));
}
module.exports = { main, config };
`;
  }

  const initial = {
    schema_version: 2,
    name: "antenna-draft",
    description: "Starter PEC monopole; review feed, domain and mesh before simulation.",
    units: "mm",
    domain: { start: [-120, -120, -100], stop: [120, 120, 120],
      boundary: Array(6).fill("PML_8") },
    mesh: { max_cell_mm: 3, growth_ratio: 1.4, max_cells: 5000000 },
    solver: { max_timesteps: 20000, end_criteria: 0.0001,
      resources: { cpus: 2, memory_gib: 5 } },
    excitation: { center_hz: 2450000000, bandwidth_hz: 350000000 },
    materials: [{ name: "pec-metal", type: "pec" }],
    geometry: [
      { editor_id: "ground-001", name: "Ground disk", material: "pec-metal",
        shape: "cylinder", start: [0, 0, -0.5], stop: [0, 0, 0], radius: 35 },
      { editor_id: "radiator-001", name: "Radiator", material: "pec-metal",
        shape: "cylinder", start: [0, 0, 3], stop: [0, 0, 29], radius: 1 }
    ],
    ports: [{ id: 1, name: "feed", type: "lumped",
      start: [0, 0, 0], stop: [0, 0, 3], direction: "z",
      impedance_ohm: 50, excite: true }],
    outputs: { s11: [{ start: 2300000000, step: 10000000, end: 2600000000 }],
      radiation_frequencies_hz: [2450000000],
      radiation_grid: { theta_step_deg: 10, phi_step_deg: 10 } }
  };

  const api = Object.freeze({ normalizeConfig, buildJscadSource,
    componentSolids, helixPoints, initial: copy(initial) });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  let config = normalizeConfig(initial);
  let selectedId = config.geometry[0].editor_id;
  const hidden = new Set();
  let plotInitialized = false;
  const $ = id => document.getElementById(id);
  const component = () => config.geometry.find(g => g.editor_id === selectedId);
  const message = (value, error = false) => {
    $("editorStatus").textContent = value;
    $("editorStatus").classList.toggle("error", error);
  };
  const shapeTemplate = {
    box: { shape: "box", start: [-10, -10, 0], stop: [10, 10, 1] },
    cylinder: { shape: "cylinder", start: [0, 0, 0], stop: [0, 0, 30], radius: 1 },
    sphere: { shape: "sphere", center: [0, 0, 0], radius: 8 },
    wire: { shape: "wire", points: [[0, 0, 0], [0, 0, 25]], wire_diameter: 2 },
    helix: { shape: "helix", origin: [0, 0, 0], axis: [0, 0, 1],
      height: 24, diameter: 22, turns: 4, wire_diameter: 1.2 }
  };
  const omit = g => {
    const result = copy(g);
    delete result.name;
    delete result.material;
    delete result.editor_id;
    return result;
  };

  function showInspector() {
    const g = component();
    $("inspector").hidden = !g;
    $("emptyInspector").hidden = !!g;
    if (!g) return;
    $("partName").value = g.name;
    $("material").replaceChildren(...config.materials.map(item => {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      return option;
    }));
    $("material").value = g.material;
    $("partSpec").value = JSON.stringify(omit(g), null, 2);
    $("partId").textContent = "ID: " + g.editor_id;
  }

  function showTree() {
    const tree = $("partTree");
    tree.replaceChildren();
    for (const g of config.geometry) {
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "object-row" + (g.editor_id === selectedId ? " active" : "");
      const view = document.createElement("button");
      view.type = "button";
      view.className = "visibility";
      view.textContent = hidden.has(g.editor_id) ? "○" : "◉";
      view.title = "Toggle preview visibility (does not change simulation export)";
      view.setAttribute("aria-label", "Show or hide " + g.name);
      view.addEventListener("click", () => {
        if (hidden.has(g.editor_id)) hidden.delete(g.editor_id);
        else hidden.add(g.editor_id);
        render();
      });
      const select = document.createElement("button");
      select.type = "button";
      select.className = "object-name";
      select.textContent = g.name + " · " + g.shape;
      select.addEventListener("click", () => {
        selectedId = g.editor_id;
        render(false);
      });
      row.append(view, select);
      item.appendChild(row);
      tree.appendChild(item);
    }
  }

  function updateConfigText() {
    $("configText").value = JSON.stringify(config, null, 2);
    $("documentName").textContent = config.name || "unnamed antenna";
  }

  function render(updatePlot = true) {
    showTree();
    showInspector();
    updateConfigText();
    if (updatePlot) draw();
  }

  function draw() {
    if (!root.Plotly || !root.jscadModeling) {
      message("JSCAD or Plotly bundle unavailable. Check deployment assets.", true);
      return;
    }
    try {
      const traces = [];
      const colors = ["#59c7f9", "#ffd184", "#7ddb9c", "#ef9dd6", "#abb7f7"];
      for (let index = 0; index < config.geometry.length; index++) {
        const g = config.geometry[index];
        if (hidden.has(g.editor_id)) continue;
        const points = [], ii = [], jj = [], kk = [];
        const solids = componentSolids(g, root.jscadModeling);
        for (const solid of solids) {
          for (const polygon of root.jscadModeling.geometries.geom3.toPolygons(solid)) {
            const vertices = root.jscadModeling.geometries.poly3.toPoints(polygon);
            if (vertices.length < 3) continue;
            const offset = points.length;
            points.push(...vertices);
            for (let t = 1; t < vertices.length - 1; t++) {
              ii.push(offset); jj.push(offset + t); kk.push(offset + t + 1);
            }
          }
        }
        if (ii.length) traces.push({
          type: "mesh3d", name: g.name, meta: { partId: g.editor_id },
          x: points.map(v => v[0]), y: points.map(v => v[1]), z: points.map(v => v[2]),
          i: ii, j: jj, k: kk,
          color: colors[index % colors.length], opacity: g.editor_id === selectedId ? 1 : 0.78,
          flatshading: true, hovertemplate: g.name + "<extra></extra>",
          showlegend: true, lighting: { ambient: 0.65, diffuse: 0.6, specular: 0.15 }
        });
      }
      for (const port of config.ports || []) {
        if (Array.isArray(port.start) && Array.isArray(port.stop)) {
          traces.push({ type: "scatter3d", mode: "lines+markers",
            name: "Port: " + (port.name || port.id),
            x: [port.start[0], port.stop[0]],
            y: [port.start[1], port.stop[1]],
            z: [port.start[2], port.stop[2]],
            line: { color: "#ff6d75", width: 7 }, marker: { color: "#ff6d75", size: 3 },
            hovertemplate: "Feed/port<extra></extra>" });
        }
      }
      const layout = {
        paper_bgcolor: "#111b2b", plot_bgcolor: "#111b2b",
        font: { color: "#cbd9ea" }, margin: { l: 0, r: 0, t: 0, b: 0 },
        showlegend: true, legend: { x: 0, y: 1, bgcolor: "rgba(0,0,0,0)" },
        scene: { aspectmode: "data", bgcolor: "#111b2b",
          xaxis: { title: "X (mm)", color: "#a2b7ce" },
          yaxis: { title: "Y (mm)", color: "#a2b7ce" },
          zaxis: { title: "Z (mm)", color: "#a2b7ce" } }
      };
      const plot = $("modelView");
      const done = plotInitialized
        ? root.Plotly.react(plot, traces, layout, { responsive: true, displaylogo: false })
        : root.Plotly.newPlot(plot, traces, layout, { responsive: true, displaylogo: false });
      if (!plotInitialized) {
        plotInitialized = true;
        Promise.resolve(done).then(() => {
          plot.on("plotly_click", event => {
            const id = event.points?.[0]?.data?.meta?.partId;
            if (id) { selectedId = id; render(false); }
          });
        });
      }
      message(config.geometry.length + " named components · preview only, no solver run");
    } catch (err) {
      message("Preview failed: " + err.message, true);
    }
  }

  function commitInspector() {
    const current = component();
    if (!current) return;
    try {
      const name = $("partName").value.trim();
      if (!name) throw Error("Name is required");
      if (config.geometry.some(g => g !== current && g.name === name)) {
        throw Error("Component name must be unique");
      }
      const spec = JSON.parse($("partSpec").value);
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw Error("Specification must be a JSON object");
      }
      const next = { ...spec, name, material: $("material").value,
        editor_id: current.editor_id };
      // Validate shape and coordinates against the real JSCAD kernel.
      componentSolids(next, root.jscadModeling);
      config.geometry.splice(config.geometry.indexOf(current), 1, next);
      render();
    } catch (err) { message(err.message, true); }
  }

  const download = (filename, content, mime) => {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const safeName = () => (config.name || "antenna").replace(/[^A-Za-z0-9_-]/g, "_");

  $("applyPart").addEventListener("click", commitInspector);
  $("newPart").addEventListener("click", () => {
    const shape = $("newShape").value;
    const entry = copy(shapeTemplate[shape]);
    const used = new Set(config.geometry.map(g => g.editor_id));
    let n = 1;
    while (used.has("part-" + n)) n++;
    entry.editor_id = "part-" + n;
    let name = shape + " " + n;
    while (config.geometry.some(g => g.name === name)) name += " copy";
    entry.name = name;
    entry.material = config.materials[0]?.name || "pec-metal";
    config.geometry.push(entry);
    selectedId = entry.editor_id;
    render();
  });
  $("duplicatePart").addEventListener("click", () => {
    const g = component();
    if (!g) return;
    const item = copy(g);
    let i = 2;
    while (config.geometry.some(p => p.editor_id === g.editor_id + "-copy-" + i)) i++;
    item.editor_id = g.editor_id + "-copy-" + i;
    item.name = g.name + " copy " + i;
    config.geometry.push(item);
    selectedId = item.editor_id;
    render();
  });
  $("removePart").addEventListener("click", () => {
    if (!component()) return;
    config.geometry = config.geometry.filter(g => g.editor_id !== selectedId);
    hidden.delete(selectedId);
    selectedId = config.geometry[0]?.editor_id || null;
    render();
  });
  $("applyConfig").addEventListener("click", () => {
    try {
      const candidate = normalizeConfig(JSON.parse($("configText").value));
      // Require a valid shape/metadata before replacing the working state.
      for (const part of candidate.geometry) componentSolids(part, root.jscadModeling);
      config = candidate;
      hidden.clear();
      selectedId = config.geometry[0]?.editor_id || null;
      render();
    } catch (err) { message("Invalid config: " + err.message, true); }
  });
  $("importJson").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const candidate = normalizeConfig(JSON.parse(await file.text()));
      for (const part of candidate.geometry) componentSolids(part, root.jscadModeling);
      config = candidate;
      hidden.clear();
      selectedId = config.geometry[0]?.editor_id || null;
      render();
    } catch (err) { message("Import failed: " + err.message, true); }
    event.target.value = "";
  });
  $("exportJson").addEventListener("click", () =>
    download(safeName() + ".json", JSON.stringify(config, null, 2) + "\n", "application/json"));
  $("exportJscad").addEventListener("click", () =>
    download(safeName() + ".jscad", buildJscadSource(config), "text/javascript"));
  $("resetEditor").addEventListener("click", () => {
    config = normalizeConfig(initial);
    hidden.clear();
    selectedId = config.geometry[0].editor_id;
    render();
  });

  render();
})(typeof window !== "undefined" ? window : globalThis);
