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
import { evaluate, parameterSets, resolveCase, fieldToValue, valueToField, renameParameter, sweepValues, parseUnitField, formatUnitField, normalizeWorkspaceUnits, resolveTemplate } from "./js/params.js";
import { tessellate, solverBounds, displayBounds, helixPoints, transformer } from "./js/geometry.js";
import { checkCase } from "./js/checks.js";
import { STARTER, SHAPES } from "./js/schema.js";
import { expandScripts, scriptBody, SCRIPT_TEMPLATE, normalizeSpec } from "./js/scriptcore.js";
import { buildModel } from "./js/sim/model.js";
import { sampleDirection, angularValue, defaultProbe, planeSegments } from "./js/sim/radiation.js";

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
// Units compile to ordinary schema numbers / expressions, not new syntax.
for(const v of ["1 GHz","1000 MHz","1e9 Hz","1","1GHz"])assert.equal(parseUnitField(v,"Hz","GHz"),1e9,v);
assert.equal(parseUnitField("1 in","mm","mm"),25.4);
assert.equal(parseUnitField("35 µm","m","mm"),35e-6);
assert.equal(parseUnitField("2 kΩ","Ω","Ω"),2000);
assert.ok(Math.abs(parseUnitField("pi rad","°","°").$expr?resolveTemplate(parseUnitField("pi rad","°","°"),{})-180:1)<1e-10);
const unitExpr=parseUnitField("{f_ghz * 1000} MHz","Hz","GHz");
assert.equal(resolveTemplate(unitExpr,{f_ghz:2.45}),2.45e9);
assert.equal(formatUnitField(unitExpr,"Hz","GHz"),"{f_ghz * 1000} MHz");
assert.deepEqual(parseUnitField(formatUnitField({$expr:"f_ghz * 1e9"},"Hz","GHz"),"Hz","GHz"),{$expr:"f_ghz * 1e9"});
assert.equal(formatUnitField(2.45e9,"Hz","MHz"),"2450");
assert.equal(normalizeWorkspaceUnits({frequency:"invalid"}).frequency,"GHz");
assert.throws(()=>parseUnitField("1 mm","Hz","GHz"));
assert.throws(()=>parseUnitField("1 bananas","Hz","GHz"));
assert.deepEqual(resolveCase({workspace_units:{frequency:"MHz"},frequency:1e9},{}),{frequency:1e9});
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

// Script placement composes parent and emitted primitive transforms, including
// gimbal lock. Both browser and native expansion use normalizeObjects.
{
  const source = 'const args = {}; function generate() { return [{shape:"cylinder",material:"m",start:[1,2,3],stop:[1,2,5],radius:1,transform:{rotate_deg:[12,15,60],translate:[1,2,3]}}]; }';
  const instance = {name:"group",script:"test",transform:{rotate_deg:[17,35,-22],translate:[2,4,6]}};
  const config = {materials:[{name:"m",type:"pec"}],scripts:{test:{source}},geometry:[instance]};
  const expanded = expandScripts(config,editorRun).geometry[0];
  const local = {transform:{rotate_deg:[12,15,60],translate:[1,2,3]}};
  for (const p of [[1,2,3],[0,0,0],[-4,7,8]]) {
    const expected = transformer(instance)(transformer(local)(p));
    const actual = transformer(expanded)(p);
    actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-9));
  }
  const plain = expandScripts({...config,geometry:[{...instance,transform:undefined}]},editorRun).geometry[0];
  assert.deepEqual(plain.transform,local.transform);
}

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
    const edges=new Map();
    let volume=0;
    for(const [a,b,c] of x.faces){
      const [u,v,t]=[a,b,c].map(i=>x.vertices[i]);
      volume+=(u[0]*(v[1]*t[2]-v[2]*t[1])+u[1]*(v[2]*t[0]-v[0]*t[2])+u[2]*(v[0]*t[1]-v[1]*t[0]))/6;
      for(const [i,j] of [[a,b],[b,c],[c,a]]){
        const k=Math.min(i,j)+","+Math.max(i,j),e=edges.get(k)||[0,0];
        e[0]++;e[1]+=i<j?1:-1;edges.set(k,e);
      }
    }
    assert.ok([...edges.values()].every(([count,orientation])=>count===2&&orientation===0),"Hemisphere mesh winding/closure");
    const expected=2*Math.PI/3*(12**3-(w?(12-w)**3:0));
    assert.ok(volume>0&&Math.abs(volume-expected)/expected<.03,"Hemisphere mesh volume");
    x.vertices.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - (ref.verts[i][k] + [0, 0, 5][k])) < 1e-9)));
    assert.ok(tessellate(x).indices.length / 3 === ref.faces.length);
  }
}

// Display primitive winding: closed surfaces must have opposite directed
// edges across each shared boundary and positive signed volume. Test tilted,
// reversed and transformed cylinders, annular walls/caps, and wire tubes.
{
  const sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function closedOutward(g,expectedVolume) {
    const {positions,indices}=tessellate(g);
    const v=i=>Array.from(positions.slice(3*i,3*i+3));
    const edges=new Map();
    let volume=0;
    for(let i=0;i<indices.length;i+=3){
      const ids=Array.from(indices.slice(i,i+3)),[a,b,c]=ids.map(v);
      assert.ok(Math.hypot(...cross(sub(b,a),sub(c,a)))>1e-8,g.shape+" degenerate triangle");
      volume+=dot(a,cross(b,c))/6;
      for(let j=0;j<3;j++){
        const a=ids[j],b=ids[(j+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(",");
        const e=edges.get(key)||[0,0];e[0]++;e[1]+=a<b?1:-1;edges.set(key,e);
      }
    }
    assert.ok([...edges.values()].every(([count,orientation])=>count===2&&orientation===0),g.shape+" inconsistent winding");
    assert.ok(volume>0,g.shape+" inward winding");
    assert.ok(Math.abs(volume-expectedVolume)/expectedVolume<1e-5,g.shape+" wrong signed volume "+volume);
  }
  const n=32,area=r=>n/2*r*r*Math.sin(2*Math.PI/n);
  for(const [start,stop] of [[[0,0,0],[0,0,30]],[[0,0,30],[0,0,0]],[[1,2,3],[9,-5,20]]]){
    const length=Math.hypot(...sub(stop,start));
    const transform={rotate_deg:[17,35,-22],translate:[10,-3,7]};
    closedOutward({shape:"cylinder",start,stop,radius:4,transform},area(4)*length);
    closedOutward({shape:"cylindrical_shell",start,stop,radius:4,thickness:2,transform},(area(5)-area(3))*length);
    const wireArea=5*Math.sin(2*Math.PI/10);
    closedOutward({shape:"wire",points:[start,stop],wire_diameter:2,transform},wireArea*length);
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

// Compact two-arm model: the coarse X mesh used to place the PML_8 dump
// faces past each other. All six faces must enclose the translated strips.
{
  const cfg = {
    ...STARTER,
    domain: { ...STARTER.domain, start: [-43, -39, -72], stop: [43, 39, 72] },
    mesh: { max_cell_mm: 6, growth_ratio: 1.4 },
    geometry: [1, -1].map(sign => ({
      shape: "box", material: "pec-metal",
      start: [-5, -0.25, Math.min(0, sign * 31)], stop: [5, 0.25, Math.max(0, sign * 31)],
      transform: { translate: [0, 0, sign * 2.5] },
    })),
    ports: [{ ...STARTER.ports[0], start: [0, 0, -2.6], stop: [0, 0, 2.6] }],
  };
  const model = buildModel(cfg);
  [5, 0.25, 33.5].forEach((extent, i) => {
    assert.ok(model.nf2ff.start[i] < -extent && model.nf2ff.stop[i] > extent);
  });
  assert.throws(() => buildModel({ ...cfg, mesh: { ...cfg.mesh, max_cells: model.cells - 1 } }), /cell budget/);
  assert.throws(() => buildModel({ ...cfg, mesh: { ...cfg.mesh, grid_mode: "uniform" } }), /NF2FF.*on x/);
}

// Far-field sampling and exact sections: dB interpolation in linear power,
// periodic phi, missing data, origin, and shared-edge deduplication.
{
  const record = { radiation_valid: true, theta_deg: [0,90,180], phi_deg: [0,90,180,270],
    directivity_dbi: [[0,0,0,0],[0,10,0,10],[0,0,0,0]], max_directivity_dbi: 10,
    radiation_efficiency: 0.5, mismatch_efficiency: 0.8, radiated_power_w: 1 };
  const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-9, a + " vs " + b);
  near(angularValue(record, record.directivity_dbi, 90, 45), 10*Math.log10(5.5));
  near(angularValue(record, record.directivity_dbi, 90, 315), 10*Math.log10(5.5));
  const s = sampleDirection(record,[0,20,0]);
  near(s.theta,90); near(s.phi,90); near(s.directivity,10);
  near(s.gain,10+10*Math.log10(.5)); near(s.realizedGain,10+10*Math.log10(.4)); near(s.relativeField,1);
  assert.equal(sampleDirection(record,[0,0,0]).gain,null);
  near(sampleDirection(record,defaultProbe(record,100)).directivity,10);
  assert.equal(angularValue(record,[[null,null,null,null],[null,10,0,10],[0,0,0,0]],90,0),null);
  near(angularValue(record,[[null,null,null,null],[null,10,0,10],[0,0,0,0]],90,90),10);
  const positions = [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0];
  const triangles = [0,1,2,0,2,3];
  const cut = planeSegments(positions,triangles,0,0.25);
  assert.equal(cut.length,12);
  for (let i=0;i<cut.length;i+=3) near(cut[i],.25);
  assert.deepEqual(planeSegments(positions,triangles,0,2),[]);
  const shared = planeSegments([0,0,0,0,1,0,1,0,0,-1,0,0],[0,1,2,1,0,3],0);
  assert.equal(shared.length,6);
}

// Starter and templates
const starterCases = parameterSets(STARTER);
assert.equal(starterCases.length, 1);
const starter = resolveCase(STARTER, starterCases[0].parameters);
assert.deepEqual(checkCase(starter).filter(x => x.level === "error"), []);
assert.ok(Math.abs(starter.geometry[1].stop[2] - (3 + 0.95 * 299.792458 / 2.45 / 4)) < 1e-9);
for (const [shape, def] of Object.entries(SHAPES)) assert.ok(tessellate({ shape, ...def.template }).indices.length > 0, shape);

// Feed connectivity checks: actual conductor, not just an enclosing AABB.
{
  const good=structuredClone(starter);
  const feedWarnings=c=>checkCase(c).filter(x=>x.where==="port feed").map(x=>x.msg);
  assert.equal(feedWarnings(good).length,0,"Flush planar monopole feed must pass");
  const gap=structuredClone(good);
  gap.geometry[0].start[2]=-1;gap.geometry[0].stop[2]=-.5;
  assert.ok(feedWarnings(gap).some(x=>x.includes("start terminal")&&x.includes("0.5 mm")));
  const shell=structuredClone(good);
  shell.geometry[1]={shape:"cylindrical_shell",name:"tube",material:"pec-metal",start:[0,0,3],stop:[0,0,35],radius:1.75,thickness:.5};
  assert.ok(feedWarnings(shell).some(x=>x.includes("stop terminal")&&x.includes("1.5 mm")));
  const test=structuredClone(gap);
  test.geometry[1]={shape:"sphere",name:"tip",material:"pec-metal",center:[0,0,4],radius:2};
  test.ports[0].stop=[0,0,2];
  assert.ok(feedWarnings(test).some(x=>x.includes("point/tip")));
  assert.ok(feedWarnings(test).some(x=>x.includes("Feed-tip mesh")));
  test.mesh.refinements=[{start:[-3,-3,-2],stop:[3,3,5],resolution_mm:.25}];
  assert.ok(!feedWarnings(test).some(x=>x.includes("Feed-tip mesh")));
  // Exact user's hemispherical shell with a missing lower terminal.
  const dome=expandScripts({materials:[{name:"pec-metal",type:"pec"}],geometry:[{name:"d_cap",script:"hemisphere",args:{center:[0,0,4],axis:[0,0,-1],radius:2,thickness:.5,rings:10,segments:32,material:"pec-metal"}}]},editorRun).geometry[0];
  test.geometry[1]=dome;
  const w=checkCase(test);
  assert.ok(!w.some(x=>x.msg.includes("inconsistent face winding")));
  assert.ok(w.some(x=>x.msg.includes("start terminal")&&x.msg.includes("0.5 mm")));
  assert.ok(w.some(x=>x.msg.includes("point/tip")));
  // Both facing shells from the revised user configuration. Both port ends
  // penetrate 0.1 mm into the metal rather than remaining in the hollow core.
  const two=structuredClone(good);
  two.geometry=expandScripts({materials:two.materials,geometry:[
    {name:"d",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,4],stop:[0,0,34],radius:1.75,thickness:.5},
    {name:"g",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,-2],stop:[0,0,-32],radius:1.75,thickness:.5},
    {name:"d_cap",script:"hemisphere",args:{center:[0,0,4],axis:[0,0,-1],radius:2,thickness:.5,rings:10,segments:32,material:"pec-metal"}},
    {name:"g_cap",script:"hemisphere",args:{center:[0,0,-2],axis:[0,0,1],radius:2,thickness:.5,rings:10,segments:32,material:"pec-metal"}}
  ]},editorRun).geometry;
  two.ports[0].start=[0,0,-.1];two.ports[0].stop=[0,0,2.1];
  two.mesh.max_cell_mm=6;two.mesh.refinements=[];
  // Actual display geometry must retain the translated +Z and -Z arms,
  // with each hemisphere's rim aligned to its corresponding tube.
  for(const [i,z] of [[0,[4,34]],[1,[-32,-2]],[2,[2,4]],[3,[-2,0]]]){
    const [lo,hi]=displayBounds(two.geometry[i]);
    assert.ok(Math.abs(lo[2]-z[0])<1e-6&&Math.abs(hi[2]-z[1])<1e-6,two.geometry[i].name+" wrong world Z");
  }
  const translated={...two.geometry[0],start:[0,0,0],stop:[0,0,30],transform:{translate:[0,0,4]}};
  assert.deepEqual(displayBounds(translated),displayBounds(two.geometry[0]));
  const corrected=checkCase(two);
  assert.ok(!corrected.some(x=>x.msg.includes("inconsistent face winding")||x.msg.includes("not a closed two-manifold")),JSON.stringify(corrected));
  assert.ok(!feedWarnings(two).some(x=>x.includes("no conductor contact detected")),"Penetrating endpoints must be recognized inside both shells");
  assert.ok(feedWarnings(two).some(x=>x.includes("transverse half-cell")),"Coarse grid must warn despite geometric contact");
  // Current user case: 8 mm outer diameter, 19 mm arms, 5 mm gap.
  const wide=structuredClone(two);
  wide.domain.start=[-79,-79,-102];wide.domain.stop=[79,79,107];
  wide.geometry=expandScripts({materials:wide.materials,geometry:[
    {name:"d",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,9],stop:[0,0,28],radius:3.75,thickness:.5},
    {name:"g",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,-4],stop:[0,0,-23],radius:3.75,thickness:.5},
    ...[[9,-1],[-4,1]].map(([z,axis],i)=>({name:i?"g_cap":"d_cap",script:"hemisphere",args:{center:[0,0,z],axis:[0,0,axis],radius:4,thickness:.5,rings:10,segments:32,material:"pec-metal"}}))
  ]},editorRun).geometry;
  wide.ports[0].stop=[0,0,5.1];
  const coarse=feedWarnings(wide);
  assert.equal(coarse.filter(x=>x.includes("transverse half-cell")).length,2,JSON.stringify(coarse));
  assert.ok(coarse.every(x=>!x.includes("no conductor contact detected")));
  wide.mesh.refinements=[{start:[-5,-5,-5],stop:[5,5,10],resolution_mm:.25}];
  assert.ok(!feedWarnings(wide).some(x=>x.includes("transverse half-cell")),"Refined contact should pass the transverse sampling heuristic");
  // Still detect genuine gaps, hollow interior and damaged meshes.
  const outside=structuredClone(two);outside.ports[0].start[2]=.1;
  assert.ok(feedWarnings(outside).some(x=>x.includes("start terminal")));
  const hollow=structuredClone(two);hollow.ports[0].start[2]=-.8;
  assert.ok(feedWarnings(hollow).some(x=>x.includes("start terminal")));
  const damaged=structuredClone(two);
  const cap=damaged.geometry.find(g=>g.name.startsWith("d_cap"));
  cap.faces[0].reverse();
  assert.ok(checkCase(damaged).some(x=>x.msg.includes("inconsistent face winding")));
  const rotated=structuredClone(good);
  rotated.geometry[1].transform={rotate_deg:[0,0,90],translate:[4,0,0]};
  assert.ok(feedWarnings(rotated).some(x=>x.includes("stop terminal")));
}

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
