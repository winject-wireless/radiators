#!/usr/bin/env node
// End-to-end check of in-browser simulation: builds the model with js/sim/model.js, runs it in
// the openEMS wasm build (node, OpenEMSCore) through js/sim/run.js, and compares S11, Zin and
// the far field with a native simulate_v2 result.json.
//   node tools/sim_e2e.mjs <expanded case config.json> <native result.json> [threads]
// Needs `python3 prepare.py` first (vendor/openems).
import { readFileSync } from "node:fs";
import factory from "../vendor/openems/openems.mjs";
import { OpenEMSCore, ProgressParser } from "../vendor/openems/openems-core.js";
import { readNf2ff } from "../vendor/openems/openems-post.js";
import { buildModel } from "../js/sim/model.js";
import { runSimulation } from "../js/sim/run.js";

const [cfgPath, refPath, threads = "4"] = process.argv.slice(2);
const config = JSON.parse(readFileSync(cfgPath, "utf8"));
const ref = JSON.parse(readFileSync(refPath, "utf8"));
const pp = new ProgressParser();
let last = 0;
const core = await OpenEMSCore.create(factory, {
  pthreadPoolSize: Number(threads) + 2,
  print: l => { const p = pp.line(l); if (p && Date.now() - last > 3000) { last = Date.now(); console.log(`  timestep ${p.timestep} energy ${p.energyDb?.toFixed?.(1)} dB`); } },
  printErr: () => {},
});
// the async API of openems.js, over the synchronous core
const ems = {
  writeFile: async (p, d) => core.writeFile(p, d),
  readFile: async (p, e) => core.readFile(p, e),
  list: async () => core.list(),
  run: async (p, { args = [], engine }) => { const t = Date.now(); return { exitCode: core.run(p, [`--engine=${engine}`, ...args]), seconds: (Date.now() - t) / 1000 }; },
  nf2ff: async p => ({ exitCode: core.nf2ff(p) }),
  readNf2ff: async p => readNf2ff(core, p),
};
const model = buildModel(config);
console.log(`${config.name}: ${model.cells} cells, ${model.freq.length} S11 points, ${model.patterns.length} far-field frequencies`);
const res = await runSimulation(ems, model, { config, threads: Number(threads) });
console.log(`run ${res.seconds.toFixed(1)} s (FDTD ${res.fdtd_seconds.toFixed(1)} s)`);

const maxAbs = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const checks = [];
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got.toFixed(4)} vs ${want.toFixed(4)} (tol ${tol})`); };
checks.push(JSON.stringify(res.s11.frequency_hz) === JSON.stringify(ref.s11.frequency_hz));
console.log(`${checks.at(-1) ? "ok  " : "FAIL"} S11 frequency grid (${res.s11.frequency_hz.length} points)`);
near("max |S11 dB diff|", maxAbs(res.s11.logmag_db, ref.s11.logmag_db), 0, 0.01);
if (ref.impedance) near("max |Zin re diff| ohm", maxAbs(res.impedance.real_ohm, ref.impedance.real_ohm), 0, 0.01);
res.patterns.forEach((p, k) => {
  const r = ref.patterns[k];
  near(`Dmax ${p.frequency_hz / 1e9} GHz dBi`, p.max_directivity_dbi, r.max_directivity_dbi, 0.005);
  if (r.radiation_efficiency !== null) near(`efficiency ${p.frequency_hz / 1e9} GHz`, p.radiation_efficiency, r.radiation_efficiency, 0.002);
});
const ok = checks.every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
