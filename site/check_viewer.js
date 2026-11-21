#!/usr/bin/env node
"use strict";
/* Prevent regressions where the site deploys successfully but no data renders.
 * Run after build_site.py, before uploading or deploying GitHub Pages.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[2] || "site/dist");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html"), js = read("app.js");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const match of js.matchAll(/\bel\(["']([^"']+)["']\)/g)) {
  assert(ids.has(match[1]), "Viewer JavaScript references missing element #" + match[1]);
}
for (const match of js.matchAll(/querySelector\('\[data-legend="([^"]+)"\]'\)/g)) {
  assert(html.includes('data-legend="' + match[1] + '"'),
         "Viewer JavaScript references missing legend " + match[1]);
}
for (const [control, handler] of [["simulation", "selectSimulation"], ["run", "renderRun"], ["freq", "renderPattern"]]) {
  const escaped = handler;
  const expr = new RegExp('el\\(["\\x27]' + control +
      '["\\x27]\\)\\.addEventListener\\(["\\x27]change["\\x27],\\s*' + escaped + '\\)');
  assert(expr.test(js), "Missing " + control + " change event handler: " + handler);
}
assert(ids.has("farfield") && ids.has("graphLegend") && ids.has("simulation") &&
       ids.has("caseControl") && ids.has("run") && ids.has("freq"),
       "Required 3D viewer controls are absent");
assert(html.includes('src="./plotly.min.js?v='), "Viewer must load bundled Plotly");
assert(fs.statSync(path.join(root, "plotly.min.js")).size > 1_000_000,
       "Bundled Plotly is missing or invalid");

const manifest = JSON.parse(read("manifest.json"));
assert(Array.isArray(manifest.runs) && manifest.runs.length, "Viewer has no simulations");
assert.equal(manifest.schema_version,2, "Expected grouped manifest version 2");
assert(Array.isArray(manifest.simulations), "Grouped simulation index missing");
assert(manifest.simulations.length, "Grouped simulation index empty");
const casesByPath=new Map();
for(const sim of manifest.simulations){
 assert(sim.id && sim.name && Array.isArray(sim.cases) && sim.cases.length,
   "Invalid simulation group");
 if(!sim.sweep)assert.equal(sim.cases.length,1,"Non-sweep must have one case");
 for(const item of sim.cases){
  assert(!casesByPath.has(item.path),"Duplicate grouped path: "+item.path);
  casesByPath.set(item.path,sim.id);
 }
}
assert.equal(casesByPath.size,manifest.runs.length,"Manifest group/flat indices disagree");
const listed = new Set();
let frequencies = 0;
for (const run of manifest.runs) {
  const result = JSON.parse(read(run.path));
  assert(Array.isArray(result.patterns) && result.patterns.length,
         "Simulation has no patterns: " + run.path);
  const dirname = path.dirname(run.path);
  for (const entry of result.patterns) {
    const name = entry.file;
    assert(name === path.basename(name) && name.startsWith("pattern_"),
           "Unsafe pattern file: " + name);
    const pattern = JSON.parse(read(path.join(dirname, name)));
    assert(Number(pattern.frequency_hz) === Number(entry.frequency_hz),
           "Frequency mismatch: " + name);
    assert(Array.isArray(pattern.directivity_dbi) && pattern.directivity_dbi.length,
           "Missing far-field grid: " + name);
    frequencies++;
  }
  assert(casesByPath.has(run.path),"Missing case group: "+run.path);
  assert.equal(casesByPath.get(run.path),run.simulation_id,"Simulation ID mismatch");
  listed.add(run.simulation_id||path.basename(dirname));
}
const configDir = path.join(__dirname, "..", "antennas");
const expected = fs.readdirSync(configDir).filter(n => n.endsWith(".json"))
                   .map(n => path.basename(n, ".json"));
for (const antenna of expected) {
  assert(listed.has(antenna), "Simulation missing from Pages manifest: " + antenna);
}
console.log("Viewer smoke checks passed:", listed.size,
            "antennas,", frequencies, "frequency patterns, all UI bindings");
