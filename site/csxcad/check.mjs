#!/usr/bin/env node
// Node checks for the CSXCAD editor (no browser needed):
//  1. expression grammar parity with scripts/sweep.py (_expression)
//  2. sweep expansion + template resolution parity with sweep.expand_cases
//     for every schema v2 config in antennas/ and examples/
//  3. every resolved component tessellates, and the repo's simulated
//     antennas pass the pre-flight checks (no false positives)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, parameterSets, resolveCase, fieldToValue, valueToField, renameParameter, sweepValues } from "./js/params.js";
import { tessellate, solverBounds, helixPoints } from "./js/geometry.js";
import { checkCase } from "./js/checks.js";
import { STARTER, SHAPES } from "./js/schema.js";
import { expandScripts, scriptBody, SCRIPT_TEMPLATE, normalizeSpec } from "./js/scriptcore.js";
import { buildModel } from "./js/sim/model.js";
import { interpolatePattern, samplePattern, peakProbe, sectionSegments } from "./js/sim/radiation.js";

// The editor's runner (same as js/script-worker.js, minus the worker).
const editorRun = (source, argsJSON) => new Function("__args", scriptBody(source))(argsJSON);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const py = (code, input) => JSON.parse(execFileSync("python3", ["-c", code], {
  cwd: repo, input: JSON.stringify(input), maxBuffer: 1 << 28, encoding: "utf8" }));

// 1. expressions --------------------------------------------------------
const params = { a: 3, b: 0.5, n: 4, s: "pec", t: true };
const exprs = ["1+2*3", "-2**2", "2**-1", "(1+2)*3", "a*b", "7 % 3", "-7 % 3", "7 % -3", "7.5 % 2",
  "max(a, b, 1)", "min(a,b)", "abs(-a)", "sqrt(16)", "floor(2.7)", "ceil(-2.2)", "sin(pi/2)", "cos(0)+tan(0)",
  "e", "2**12", "2**13", "1e3/4", ".5+5.", "1/0", "a % 0", "sqrt(-1)", "unknown+1", "s+1", "t+1",
  "max(1)", "min()", "abs(1,2)", "a.b", "__import__('os')", "a if b else n", "1e400", "10**12*10**4",
  "+a--b", "n*(n+1)/2", "2**0.5", "(-8)**(1/3)", "a b", "", "1,2", "pow(2,3)", "1e16*1e16"];
const pyResults = py(`
import json, sys
sys.path.insert(0, "scripts")
from sweep import _expression
items, params = json.load(sys.stdin)
out = []
for e in items:
    try: out.append({"ok": float(_expression(e, params))})
    except Exception as x: out.append({"err": str(x)})
print(json.dumps(out))`, [exprs, params]);
exprs.forEach((e, i) => {
  let js;
  try { js = { ok: evaluate(e, params) }; } catch (x) { js = { err: x.message }; }
  const p = pyResults[i];
  assert.equal("ok" in js, "ok" in p, `expression ${JSON.stringify(e)}: JS ${JSON.stringify(js)} vs Python ${JSON.stringify(p)}`);
  if ("ok" in p) assert.ok(Math.abs(js.ok - p.ok) <= 1e-12 * Math.max(1, Math.abs(p.ok)), `expression ${e}: ${js.ok} != ${p.ok}`);
});

// Field text round trip
assert.deepEqual(fieldToValue("12.5"), 12.5);
assert.deepEqual(fieldToValue("gap"), { $param: "gap" });
assert.deepEqual(fieldToValue("gap * 2"), { $expr: "gap * 2" });
assert.deepEqual(fieldToValue("pi"), { $expr: "pi" });
assert.throws(() => fieldToValue("2 +"));
assert.equal(valueToField({ $expr: "a*2" }), "a*2");
const renamed = renameParameter({ parameters: { gap: 1 }, geometry: [{ r: { $expr: "gap*2 + gapx + 1e3" }, s: { $param: "gap" } }], sweep: { parameters: { gap: { values: [1] } } } }, "gap", "g");
assert.deepEqual(renamed, { parameters: { g: 1 }, geometry: [{ r: { $expr: "g*2 + gapx + 1e3" }, s: { $param: "g" } }], sweep: { parameters: { g: { values: [1] } } } });

// Range parity incl. awkward decimals
const ranges = [{ start: 0.1, stop: 0.7, step: 0.2 }, { start: 3, stop: 5, step: 1 }, { start: 1, stop: 2, step: 0.3 },
  { start: 5, stop: 1, step: -1.5 }, { start: 1e-3, stop: 4e-3, step: 1e-3 }, { start: 0, stop: 1, step: 0 }];
const pyRanges = py(`
import json, sys
sys.path.insert(0, "scripts")
from sweep import _values
out = []
for r in json.load(sys.stdin):
    try: out.append({"ok": _values({"range": r}, "x")})
    except Exception as x: out.append({"err": str(x)})
print(json.dumps(out))`, ranges);
ranges.forEach((r, i) => {
  let js;
  try { js = { ok: sweepValues({ range: r }, "x") }; } catch (x) { js = { err: x.message }; }
  assert.deepEqual("ok" in js ? js : "err", "ok" in pyRanges[i] ? pyRanges[i] : "err", `range ${JSON.stringify(r)}`);
});

// 2 + 3. configs ----------------------------------------------------------
const close = (a, b, where) => {
  if (typeof a === "number" && typeof b === "number") {
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${where}: ${a} != ${b}`);
  } else if (Array.isArray(a)) {
    assert.ok(Array.isArray(b) && a.length === b.length, `${where}: array mismatch`);
    a.forEach((v, i) => close(v, b[i], `${where}[${i}]`));
  } else if (a && typeof a === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${where}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${where}.${k}`);
  } else assert.equal(a, b, where);
};
const files = ["antennas", "examples"].flatMap(dir => fs.readdirSync(path.join(repo, dir))
  .filter(f => f.endsWith(".json")).map(f => path.join(dir, f)));
let compared = 0, parts = 0;
for (const rel of files) {
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, rel), "utf8"));
  if (cfg.schema_version !== 2) continue;
  const pyCases = py(`
import json, sys
sys.path.insert(0, "scripts")
from sweep import expand_cases
cfg, src = json.load(sys.stdin)
cases = expand_cases(cfg, src)
for c in cases: c["config"].pop("simulation", None)
print(json.dumps([{"id": c["case_id"], "name": c["case_name"], "parameters": c["parameters"], "config": c["config"]} for c in cases]))`, [cfg, rel]);
  const jsCases = parameterSets(cfg);
  assert.deepEqual(jsCases.map(c => c.id), pyCases.map(c => c.id), `${rel}: case ids`);
  jsCases.forEach((c, i) => {
    assert.equal(c.name, pyCases[i].name, `${rel} ${c.id}: case name`);
    close(c.parameters, pyCases[i].parameters, `${rel} ${c.id} parameters`);
    if (cfg.generator) return; // Python generators run only in the simulator
    let resolved = resolveCase(cfg, c.parameters);
    if (cfg.scripts) resolved = expandScripts(resolved, editorRun);
    close(resolved, pyCases[i].config, `${rel} ${c.id}`);
    for (const g of resolved.geometry) {
      const t = tessellate(g);
      assert.ok(t.indices.length > 0 && t.positions.every(Number.isFinite), `${rel}: ${g.name} tessellation`);
      solverBounds(g);
      parts++;
    }
    if (rel.startsWith("antennas/")) {
      const errors = checkCase(resolved).filter(x => x.level === "error");
      assert.deepEqual(errors, [], `${rel} ${c.id}: simulated antenna must pass pre-flight checks`);
    }
    compared++;
  });
}

// Script template is valid and expands
const tplSpec = normalizeSpec(JSON.parse(editorRun(SCRIPT_TEMPLATE, null)).args);
assert.deepEqual(Object.keys(tplSpec), ["start", "height", "radius", "count", "spacing", "material"]);
const tpl = expandScripts({ materials: [{ name: "m", type: "pec" }], scripts: { t: { source: SCRIPT_TEMPLATE } },
  geometry: [{ name: "arr", script: "t", args: { count: 3 } }] }, editorRun);
assert.deepEqual(tpl.geometry.map(g => g.name), ["arr/rod1", "arr/rod2", "arr/rod3"]);
for (const g of tpl.geometry) assert.ok(tessellate(g).indices.length > 0);
assert.throws(() => expandScripts({ materials: [], scripts: { t: { source: SCRIPT_TEMPLATE } },
  geometry: [{ name: "arr", script: "t", args: { count: 0 } }] }, editorRun), /count must be ≥ 1/);

// Presentation keys are validated and kept
{
  const spec = normalizeSpec({ n: { type: "int", default: 2, step: 1, more: true, hint: "how many" } });
  assert.deepEqual([spec.n.step, spec.n.more, spec.n.hint], [1, true, "how many"]);
  assert.throws(() => normalizeSpec({ n: { type: "length", default: 1, step: 0 } }), /step must be a positive number/);
  assert.throws(() => normalizeSpec({ m: { type: "material", step: 1 } }), /step must be a positive number/);
  assert.throws(() => normalizeSpec({ n: { type: "int", default: 1, more: "yes" } }), /more must be true or false/);
}

// Built-in helix script == the legacy helix shape's wire points
{
  const hg = { origin: [1, 2, 3], axis: [0.3, -0.2, 1], diameter: 18, height: 30, turns: 5.25, wire_diameter: 1, phase_deg: 45, segments_per_turn: 20 };
  const x = expandScripts({ materials: [{ name: "m", type: "pec" }], geometry: [{ name: "h", script: "helix",
    args: (({ phase_deg, ...rest }) => ({ ...rest, phase: phase_deg }))(hg) }] }, editorRun);
  const want = helixPoints({ shape: "helix", ...hg });
  assert.equal(x.geometry[0].shape, "wire");
  assert.equal(x.geometry[0].points.length, want.length);
  x.geometry[0].points.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - want[i][k]) < 1e-9, "helix point")));
}

// Built-in hemisphere == the legacy hemisphere mesh, as a polyhedron
{
  const { hemisphereMesh } = await import("./js/geometry.js");
  for (const w of [0, 2]) {
    const x = expandScripts({ materials: [{ name: "m", type: "pec" }], geometry: [{ name: "d", script: "hemisphere",
      args: { center: [0, 0, 5], radius: 12, thickness: w } }] }, editorRun).geometry[0];
    const ref = hemisphereMesh(12, w || null);
    assert.equal(x.shape, "polyhedron");
    assert.deepEqual(x.faces, ref.faces);
    x.vertices.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - (ref.verts[i][k] + [0, 0, 5][k])) < 1e-9)));
    assert.ok(tessellate(x).indices.length / 3 === ref.faces.length);
  }
}

// Built-in tapered cylinder: closed, outward-oriented mesh with the right volume
{
  const vol = o => o.faces.reduce((V, [i, j, k]) => { const [A, B, C] = [o.vertices[i], o.vertices[j], o.vertices[k]];
    return V + (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6; }, 0);
  const closed = o => { const m = new Map(); for (const f of o.faces) for (let k = 0; k < 3; k++) m.set(f[k] + "," + f[(k + 1) % 3], (m.get(f[k] + "," + f[(k + 1) % 3]) || 0) + 1);
    return [...m].every(([e, n]) => { const [x, y] = e.split(","); return n === 1 && m.get(y + "," + x) === 1; }); };
  for (const [r1, r2, t] of [[10, 5, 0], [10, 0, 0], [0, 6, 0], [10, 5, 2]]) {
    const o = expandScripts({ materials: [{ name: "m", type: "pec" }], geometry: [{ name: "tc", script: "tapered_cylinder",
      args: { start: [0, 0, 0], stop: [3, 4, 12], radius_start: r1, radius_stop: r2, thickness: t, segments: 128 } }] }, editorRun).geometry[0];
    const cone = (a, b) => Math.PI * 13 / 3 * (a * a + a * b + b * b);
    const exact = t ? cone(r1, r2) - cone(r1 - t, r2 - t) : cone(r1, r2);
    assert.equal(o.shape, "polyhedron");
    assert.ok(closed(o), `tapered ${r1}/${r2}/${t}: mesh must be closed and consistently oriented`);
    assert.ok(Math.abs(vol(o) - exact) / exact < 1e-3, `tapered ${r1}/${r2}/${t}: volume ${vol(o)} vs ${exact}`);
  }
  assert.throws(() => expandScripts({ materials: [{ name: "m", type: "pec" }], geometry: [{ name: "x", script: "tapered_cylinder",
    args: { radius_start: 5, radius_stop: 0, thickness: 1 } }] }, editorRun), /thickness must be below both radii/);
}

// In-browser simulation model == the Python simulator's XML (golden file from simulate_v2,
// site/openems/examples/dipole.xml): mesh lines, port elements, NF2FF box
{
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, "wasm/openems/test/dipole_v2.json"), "utf8"));
  const gold = fs.readFileSync(path.join(repo, "site/openems/examples/dipole.xml"), "utf8");
  const m = buildModel(cfg);
  const lines = xml => ["X", "Y", "Z"].map(a => new RegExp(`<${a}Lines Qty="\\d+">([^<]+)<`).exec(xml)[1].split(",").map(Number));
  const [gl, ml] = [lines(gold), lines(m.xml)];
  gl.forEach((l, i) => {
    assert.equal(ml[i].length, l.length, `dipole ${"XYZ"[i]} mesh line count`);
    l.forEach((v, k) => assert.ok(Math.abs(ml[i][k] - v) < 1e-9, `dipole ${"XYZ"[i]} line ${k}: ${ml[i][k]} vs ${v}`));
  });
  for (const tag of ['Name="port_resist_1" Direction="2"', 'Name="port_excite_1"', 'Name="port_ut_1"', 'Name="port_it_1"', 'Name="nf2ff_E"', 'Name="nf2ff_H"']) {
    assert.ok(m.xml.includes(tag), `dipole model has ${tag}`);
  }
  const box = /Name="nf2ff_E"[\s\S]*?<P1 X="([^"]+)" Y="([^"]+)" Z="([^"]+)"/.exec(gold).slice(1).map(Number);
  box.forEach((v, i) => assert.ok(Math.abs(m.nf2ff.start[i] - v) < 1e-9, "dipole NF2FF box start"));
  assert.equal(m.cells, 38 * 38 * 90);
  assert.throws(() => buildModel({ ...cfg, ports: [{ ...cfg.ports[0], type: "msl" }] }), /not supported in the browser/);
}

// Far-field directional sampling: angular interpolation including periodic seam,
// null data, undefined origin and gain / realized gain efficiency corrections.
{
  const r={frequency_hz:2.45e9,theta_deg:[0,90,180],phi_deg:[0,90,180,270],
    directivity_dbi:[[0,0,0,0],[6,2,0,2],[0,0,0,0]],max_directivity_dbi:6,
    radiation_efficiency:0.5,mismatch_efficiency:0.8,radiated_power_w:1};
  assert.equal(interpolatePattern(r,r.directivity_dbi,90,315),4);
  assert.equal(interpolatePattern(r,r.directivity_dbi,45,45),2);
  assert.equal(interpolatePattern(r,[[null]],90,45),null);
  const s=samplePattern(r,[10,0,0]);
  assert.equal(s.directivity,6);
  assert.ok(Math.abs(s.gain-(6+10*Math.log10(0.5)))<1e-12);
  assert.ok(Math.abs(s.realizedGain-(6+10*Math.log10(0.4)))<1e-12);
  assert.equal(s.relativeField,1);
  assert.equal(samplePattern(r,[0,0,0]).gain,null);
  assert.deepEqual(samplePattern(r,[100,0,0]).directivity,s.directivity);
  assert.ok(Math.abs(peakProbe(r,10)[0]-10)<1e-12);
  const verts=[1,1,1,-1,1,1,1,-1,-1,-1,-1,-1], faces=[0,1,2,1,0,3,0,2,3,1,3,2];
  for(let axis=0;axis<3;axis++){
    const seg=sectionSegments(verts,faces,axis,2);
    assert.ok(seg.length>0 && seg.length%6===0);
    for(let i=axis;i<seg.length;i+=3)assert.equal(seg[i],0);
  }
}

// Starter and templates
const starterCases = parameterSets(STARTER);
assert.equal(starterCases.length, 1);
const starter = resolveCase(STARTER, starterCases[0].parameters);
assert.deepEqual(checkCase(starter).filter(x => x.level === "error"), []);
assert.ok(Math.abs(starter.geometry[1].stop[2] - (3 + 0.95 * 299.792458 / 2.45 / 4)) < 1e-9);
for (const [shape, def] of Object.entries(SHAPES)) assert.ok(tessellate({ shape, ...def.template }).indices.length > 0, shape);

// Checks catch the classic mistakes
const broken = structuredClone(starter);
broken.ports.push({ ...broken.ports[0], excite: true });
broken.geometry[0].material = "copper";
broken.domain.stop[2] = 10;
const msgs = checkCase(broken).map(x => x.msg).join("\n");
assert.match(msgs, /Exactly one port must be excited/);
assert.match(msgs, /Port IDs must be unique/);
assert.match(msgs, /Undefined material/);
assert.match(msgs, /must fit inside domain/);

console.log(`CSXCAD editor: ${exprs.length} expressions + ${ranges.length} ranges match sweep.py; ` +
  `${compared} case(s) from ${files.length} configs resolve identically; ${parts} parts tessellated: OK`);
