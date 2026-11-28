// End-to-end convergence check for a small internal dipole fixture, using the shipped WASM.
import assert from "node:assert/strict";
import factory from "../../openems/openems.mjs";
import { OpenEMSCore } from "../../openems/openems-core.js";
import { readNf2ff } from "../../openems/openems-post.js";
import { readFileSync } from "node:fs";
const STARTER = JSON.parse(readFileSync(new URL("../../../tests/fixtures/dipole_2450.json", import.meta.url), "utf8"));
import { buildModel } from "../js/sim/model.js";
import { runSimulation } from "../js/sim/run.js";

let log = () => {};
const core = await OpenEMSCore.create(factory, {
  pthreadPoolSize: 4,
  print: line => { console.log(line); log(line, "stdout"); },
  printErr: line => { console.error(line); log(line, "stderr"); },
});
const ems = {
  writeFile: async (p,d) => core.writeFile(p,d),
  readFile: async (p,e) => core.readFile(p,e),
  list: async () => core.list(),
  run: async (p,{args=[],engine,onLog}) => {
    log = onLog ?? (() => {});
    try { return {exitCode:core.run(p,[`--engine=${engine}`,...args])}; }
    finally { log=()=>{}; }
  },
  nf2ff: async p => ({exitCode:core.nf2ff(p)}),
  readNf2ff: async p => readNf2ff(core,p),
};
try {
  const model=buildModel(STARTER);
  const result=await runSimulation(ems,model,{config:STARTER,threads:2});
  const s=result.diagnostics.solver;
  console.log("Dipole convergence:",JSON.stringify(s));
  assert.equal(s.termination,"converged");
  assert.ok(s.excitation_timesteps>0 && s.executed_timesteps>=s.excitation_timesteps,"Excitation must finish");
  assert.ok(s.final_energy_db<=10*Math.log10(STARTER.solver.end_criteria)+0.1,"Energy criterion must be met");
  assert.ok(!result.postprocessing_incomplete && !result.aborted,"Complete result required");
  assert.ok(result.s11.logmag_db.length && result.s11.logmag_db.every(Number.isFinite),"Finite S11 required");
  assert.ok(result.impedance.real_ohm.every(Number.isFinite) && result.impedance.imag_ohm.every(Number.isFinite),"Finite impedance required");
  assert.equal(result.patterns.length,model.patterns.length);
  for(const p of result.patterns){
    assert.equal(p.record.radiation_valid,true);
    assert.ok(Number.isFinite(p.max_realized_gain_dbi),"Finite realized gain required");
  }
  console.log("Internal dipole convergence PASS");
  process.exit(0);
}catch(e){console.error(e);process.exit(1);}
