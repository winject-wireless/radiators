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
import { tessellate, solverBounds } from "./js/geometry.js";
import { checkCase } from "./js/checks.js";
import { STARTER, SHAPES } from "./js/schema.js";

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
    const resolved = resolveCase(cfg, c.parameters);
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
