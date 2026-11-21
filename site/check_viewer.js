#!/usr/bin/env node
"use strict";
/* Prevent regressions where the site deploys successfully but no data renders.
 * Run after build_site.py, before uploading or deploying GitHub Pages.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const selectors = require("./simulation_selectors.js");
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
for (const [control, handler] of [["simulation", "selectSimulation"], ["case", "renderRun"], ["freq", "renderPattern"]]) {
  const escaped = handler;
  const expr = new RegExp('el\\(["\\x27]' + control +
      '["\\x27]\\)\\.addEventListener\\(["\\x27]change["\\x27],\\s*' + escaped + '\\)');
  assert(expr.test(js), "Missing " + control + " change event handler: " + handler);
}
assert(ids.has("farfield") && ids.has("graphLegend") && ids.has("simulation") &&
       ids.has("caseControl") && ids.has("case") && ids.has("freq"),
       "Required 3D viewer controls are absent");
// Both dropdowns are permanently visible, including for a single default case.
const caseControl = html.match(/<label[^>]*id="caseControl"[^>]*>/)?.[0];
assert(caseControl && !/\bhidden(?:\s|=|>)/.test(caseControl),
       "Case dropdown must be visible for every simulation");
assert(html.includes('src="./simulation_selectors.js?v='),
       "Viewer must load cache-busted two-level selector code");
assert(js.includes('RadiatorsSelectors.readSimulations(manifest)') &&
       js.includes('RadiatorsSelectors.casesForSimulation(simulations,el("simulation").value)'),
       "Viewer must use grouped simulations, not the flat runs index");
assert(html.includes('src="./plotly.min.js?v='), "Viewer must load bundled Plotly");
assert(fs.statSync(path.join(root, "plotly.min.js")).size > 1_000_000,
       "Bundled Plotly is missing or invalid");

const manifest = JSON.parse(read("manifest.json"));
assert(Array.isArray(manifest.runs) && manifest.runs.length, "Viewer has no simulations");
assert.equal(manifest.schema_version,2, "Expected grouped manifest version 2");
assert(Array.isArray(manifest.simulations), "Grouped simulation index missing");
assert(manifest.simulations.length, "Grouped simulation index empty");
const normalized = selectors.readSimulations(manifest);
assert.equal(normalized.length, manifest.simulations.length);
for (const sim of normalized) {
 const actual = selectors.casesForSimulation(normalized, sim.id);
 assert.deepEqual(actual.map(x=>x.path), sim.cases.map(x=>x.path),
                  "Case options must be scoped to the selected simulation: " + sim.id);
}
// Test real menu behavior with two distinct simulations and a multi-case sweep.
const fixtures = selectors.readSimulations({schema_version:2,simulations:[
 {id:"single",name:"Single antenna",sweep:false,
  cases:[{id:"default",name:"Default",path:"data/single/result.json"}]},
 {id:"sweep",name:"Sweep antenna",sweep:true,
  cases:[{id:"case-0001",name:"width=1",path:"data/sweep__case-0001/result.json"},
         {id:"case-0002",name:"width=2",path:"data/sweep__case-0002/result.json"}]}
]});
const mockControls = {
 simulation: {value:"single"},
 case: {disabled:false,value:"",options:[],
        replaceChildren(...options){this.options=options}}
};
const selectionFn = js.match(/function selectSimulation\(\)\{[\s\S]*?\n\}/)?.[0];
assert(selectionFn, "Missing case-dropdown update function");
let calls=0;
const ctx = {
 simulations: fixtures, RadiatorsSelectors: selectors,
 el: name => mockControls[name],
 status: msg => { throw Error(msg) },
 renderRun: () => { calls++ },
 document: {createElement: () => ({value:"",textContent:""})}
};
vm.runInNewContext(selectionFn+"\nselectSimulation();",ctx);
assert.deepEqual(mockControls.case.options.map(x=>x.value),["data/single/result.json"]);
assert.equal(mockControls.case.value,"data/single/result.json");
mockControls.simulation.value="sweep";
vm.runInNewContext("selectSimulation();",ctx);
assert.deepEqual(mockControls.case.options.map(x=>x.value),[
 "data/sweep__case-0001/result.json","data/sweep__case-0002/result.json"
]);
assert.equal(mockControls.case.value,"data/sweep__case-0001/result.json");
assert.equal(calls,2, "Changing the simulation should load the default case each time");

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
// Preview/PR builds can restore only the previously published results.
// Production completeness (including every expected sweep case) is enforced
// by build_site.py --require-complete before the viewer smoke tests.
if(process.env.REQUIRE_COMPLETE==="true"){
 const configDir=path.join(__dirname,"..","antennas");
 const expected=fs.readdirSync(configDir).filter(n=>n.endsWith(".json"))
                  .map(n=>path.basename(n,".json"));
 for(const antenna of expected)
  assert(listed.has(antenna),"Simulation missing from Pages manifest: "+antenna);
}
console.log("Viewer smoke checks passed:", listed.size,
            "antennas,", frequencies, "frequency patterns, all UI bindings");
