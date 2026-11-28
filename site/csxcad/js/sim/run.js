// Runs a built model (model.js) with openEMS (the wasm build) and post-processes it like
// antennas/simulate_v2.py: S11 / VSWR / Zin of the driven lumped port, then NF2FF per
// requested frequency (directivity, radiated power, efficiencies, realized gain).
// `ems` is the async API of openems.js (OpenEMS in a Web Worker) or an adapter with the
// same methods around OpenEMSCore (node tests): writeFile, readFile, list, run, nf2ff, readNf2ff.
import { lumpedPort, nf2ffXml, parseProbe } from "../../vendor/openems/openems-post.js";

import { probeDiagnostics, updateSolverDiagnostics, diagnosticWarnings } from "./diagnostics.js";
import { collectDiagnostics } from "./wasm-diagnostics.js";

const finite = x => (Number.isFinite(x) ? x : null);
// Radiation efficiency above 1 is non-physical; allow a small numeric margin.
// Keep this and antennas/simulate_v2.py (EFFICIENCY_LIMIT) in step.
export const EFFICIENCY_LIMIT = 1.02;
export const efficiencyWarning = eta =>
  `Radiation efficiency ${(eta * 100).toFixed(1)}% exceeds 100%, which is not physical: ` +
  "check NF2FF box clearance from the PML (and that no near-field plane is inside it), " +
  "that the run converged, and the feed's accepted power. Realized gain is not reported.";
const finiteArr = a => Array.from(a, finite);

// openEMS can return success even when an excitation primitive was never used.
export function solverWarning(line, drivenId) {
  const message = String(line).trim();
  if (!/\bwarning\s*[:,]/i.test(message)) return null;
  const unused = /Unused primitive.*property:\s*port_excite_(\d+)\b/i.exec(message);
  return { message, fatal: !!unused && Number(unused[1]) === Number(drivenId) };
}
export function hasValidS11(result) {
  return (result?.s11?.logmag_db ?? []).some(Number.isFinite);
}

export async function runSimulation(ems, model, { config, engine = "basic", threads, onLog, onProgress, onStage, onWarning, onPartial } = {}) {
  const t0 = Date.now();
  onStage?.("writing model");
  await ems.writeFile("model.xml", model.xml);
  onStage?.("FDTD");
  const args = threads ? [`--numThreads=${threads}`] : [];
  const warnings = [];
  const solver = {};
  let fatal = null;
  const run = await ems.run("model.xml", { args, engine, onProgress, onLog: (line, stream) => {
    onLog?.(line, stream);
    updateSolverDiagnostics(solver,line);
    const warning = solverWarning(line, model.driven.id);
    if (!warning) return;
    if (!warnings.includes(warning.message)) warnings.push(warning.message);
    onWarning?.(warning);
    if (warning.fatal && !fatal) {
      fatal = "Feed excitation was not used by openEMS. Check the feed gap, mesh alignment and conductor overlap. " + warning.message;
      ems.abort?.();
    }
  } });
  if (fatal) throw Error(fatal);
  if (run.exitCode !== 0) throw Error(`openEMS exited with code ${run.exitCode}`);
  const aborted = !!run.aborted || solver.termination === "aborted";

  // ---- port: S11, VSWR, Zin (ports.LumpedPort.CalcPort with Z_ref = R)
  onStage?.("port");
  const drv = model.driven;
  const ut = await ems.readFile(`port_ut_${drv.id}`, "utf8"), it = await ems.readFile(`port_it_${drv.id}`, "utf8");
  const voltage = probeDiagnostics(parseProbe(ut)), current = probeDiagnostics(parseProbe(it));
  let source=null;
  try { source=probeDiagnostics(parseProbe(await ems.readFile("et","utf8"))); } catch { /* optional solver dump */ }
  for(const message of diagnosticWarnings(solver,voltage,current)) if(!warnings.includes(message)) warnings.push(message);
  const port = lumpedPort(ut, it, model.freq, drv.R);
  const n = model.freq.length;
  if (!port.pInc.some(v => Number.isFinite(v) && v > 0)) throw Error("No nonzero incident power at the driven port. Check feed excitation and mesh alignment.");
  const mag = Array.from({ length: n }, (_, k) => Math.hypot(port.s11.re[k], port.s11.im[k]));
  const result = {
    schema_version: 2,
    name: config?.name ?? "",
    description: config?.description ?? "",
    generated_at_utc: new Date().toISOString(),
    generator: "csxcad-editor (openEMS wasm)",
    input_config: config,
    geometry_preview: model.previews,
    mesh_cells: model.counts,
    mesh_total_cells: model.cells,
    mesh_lines_mm: model.meshLines,
    mesh_algorithm: "priority-refinement-v2",
    port_name: drv.name,
    port_id: drv.id,
    s11: {
      frequency_hz: [...model.freq],
      real: finiteArr(port.s11.re),
      imag: finiteArr(port.s11.im),
      logmag_db: mag.map(m => finite(20 * Math.log10(Math.max(m, 1e-16)))),
      phase_deg: finiteArr(Array.from({ length: n }, (_, k) => Math.atan2(port.s11.im[k], port.s11.re[k]) * 180 / Math.PI)),
      vswr: mag.map(m => finite(m < 1 ? (1 + m) / Math.max(1 - m, 1e-15) : Infinity)),
    },
    impedance: { frequency_hz: [...model.freq], real_ohm: finiteArr(port.zin.re), imag_ohm: finiteArr(port.zin.im) },
    patterns: [],
    diagnostics: {
      solver, mesh: model.meshStatistics ?? [], voltage, current, source,
      power_spectrum: {frequency_hz:[...model.freq], incident:finiteArr(port.pInc), reflected:finiteArr(port.pRef), accepted:finiteArr(port.pAcc)},
    },
    solver_warnings: warnings,
    aborted,
  };
  if (!hasValidS11(result)) throw Error("No valid S11 samples: check the feed excitation and port probes.");
  const outputs = config?.outputs ?? {};
  if (outputs.include_impedance === false) delete result.impedance;

  // Publish valid port data before any expensive or fallible far-field work.
  result.fdtd_seconds = run.seconds ?? null;
  result.postprocessing_pending = true;
  result.seconds = (Date.now() - t0) / 1000;
  onPartial?.({...result, patterns: [...result.patterns], solver_warnings: [...warnings]});

  // ---- far field per frequency (nf2ff.CalcNF2FF + simulate_v2's derived numbers)
  let files;
  try { files = new Set((await ems.list()).map(f => f.path)); }
  catch (e) {
    warnings.push("Far-field file listing failed: " + e.message);
    result.postprocessing_incomplete = true;
    files = null;
  }
  const box = model.nf2ff;
  if (aborted || (solver.excitation_timesteps && solver.executed_timesteps < solver.excitation_timesteps)) {
    result.postprocessing_incomplete = true;
  }
  for (const f of result.postprocessing_incomplete ? [] : model.patterns) {
    onStage?.(`far field ${(f / 1e9).toFixed(3)} GHz`);
    try {
    if (!files) throw Error("Near-field files unavailable");
    const outfile = `nf2ff_${Math.trunc(f)}.h5`;
    // only the planes openEMS wrote (faces on PEC/PMC walls are mirrored instead)
    const xml = nf2ffXml({ freqs: [f], thetaDeg: model.theta, phiDeg: model.phi, outfile, box, deltaUnit: model.deltaUnit })
      .split("\n").filter(l => {
        const m = /<Planes E_Field="([^"]+)" H_Field="([^"]+)"/.exec(l);
        return !m || (files.has(m[1]) && files.has(m[2]));
      }).join("\n");
    await ems.writeFile("nf2ff.xml", xml);
    const nr = await ems.nf2ff("nf2ff.xml", {onLog});
    if (nr.exitCode !== 0) throw Error(`nf2ff exited with code ${nr.exitCode}`);
    const ff = await ems.readNf2ff(outfile);
    const nt = model.theta.length, np = model.phi.length;
    const field = Array.from(ff.eNorm[0]);
    const prad = finite(ff.prad[0]), rawDmax = finite(ff.dmax[0]);
    const fmax = Math.max(...field);
    const valid = prad !== null && prad > 0 && rawDmax !== null && rawDmax > 0 && field.every(Number.isFinite) && fmax > 0;
    const dmax = valid ? 10 * Math.log10(rawDmax) : null;
    const dbi = [];
    for (let t = 0; t < nt; t++) {
      dbi.push(Array.from({ length: np }, (_, p) => valid ? dmax + 20 * Math.log10(Math.max(field[t * np + p] / fmax, 1e-16)) : null));
    }
    const pf = lumpedPort(ut, it, [f], drv.R);
    const accepted = pf.pAcc[0];
    const eta = accepted > 0 ? finite(ff.prad[0] / accepted) : null;
    const refl = Math.hypot(pf.s11.re[0], pf.s11.im[0]);
    const mismatch = Math.max(0, 1 - refl * refl);
    // P_rad > P_accepted is not physical. It means the near-field box is too
    // close to the PML (or has planes inside it), the run did not converge, or
    // the accepted power is near zero from a bad feed. Realized gain would be
    // inflated by the same factor, so it is not reported.
    const efficiencyValid = eta === null ? null : eta <= EFFICIENCY_LIMIT;
    const gainFactor = eta !== null && efficiencyValid ? eta * mismatch : null;
    const record = {
      frequency_hz: f, theta_deg: [...model.theta], phi_deg: [...model.phi], directivity_dbi: dbi,
      max_directivity_dbi: dmax, radiated_power_w: prad, radiation_valid: valid,
      radiation_warning: valid ? (efficiencyValid === false ? efficiencyWarning(eta) : null)
        : "Far-field unavailable: zero radiated power or undefined directivity. Check feed, mesh, and NF2FF boundaries.",
      radiation_efficiency: eta, efficiency_valid: efficiencyValid, mismatch_efficiency: finite(mismatch), unit: "dBi",
    };
    if (outputs.include_realized_gain) {
      record.realized_gain_dbi = valid && gainFactor !== null ? dbi.map(r => r.map(v => v + 10 * Math.log10(Math.max(gainFactor, 1e-30)))) : null;
    }
    result.patterns.push({
      frequency_hz: f, file: `pattern_${Math.trunc(f)}Hz.json`, max_directivity_dbi: dmax, radiation_efficiency: eta,
      efficiency_valid: efficiencyValid,
      max_realized_gain_dbi: valid && gainFactor !== null && outputs.include_realized_gain ? finite(dmax + 10 * Math.log10(Math.max(gainFactor, 1e-30))) : null,
      record,
    });
    if (!valid) result.postprocessing_incomplete = true;
    if (efficiencyValid === false) { const w = efficiencyWarning(eta); warnings.push(w); onWarning?.({ message: w, fatal: false }); }
    } catch (e) {
      result.postprocessing_incomplete = true;
      const message = "Far-field " + (f / 1e9).toFixed(3) + " GHz failed: " + e.message;
      warnings.push(message);
      onWarning?.({message, fatal: false});
      result.patterns.push({frequency_hz:f,max_directivity_dbi:null,radiation_efficiency:null,max_realized_gain_dbi:null,
        record:{frequency_hz:f,radiation_valid:false,radiation_warning:message}});
    }
    result.seconds = (Date.now() - t0) / 1000;
    onPartial?.({...result, patterns:[...result.patterns], solver_warnings:[...warnings]});
  }
  if(model.diagnosticObjects?.length){
    onStage?.("diagnostic capture");
    result.diagnostic_probes=await collectDiagnostics(ems,model.diagnosticObjects);
    for(const record of result.diagnostic_probes)if(record.warning){
      const message="Diagnostic "+record.name+": "+record.warning;
      warnings.push(message);onWarning?.({message,fatal:false});
    }
  }
  result.postprocessing_pending = false;
  result.seconds = (Date.now() - t0) / 1000;
  result.fdtd_seconds = run.seconds ?? null;
  onStage?.("done");
  return result;
}

// Headline numbers for the UI: best match, -10 dB band, Zin at the centre, far-field summary.
export function summarize(result, f0) {
  const s = result.s11, f = s.frequency_hz, db = s.logmag_db;
  let best = 0;
  db.forEach((v, i) => { if (v !== null && (db[best] === null || v < db[best])) best = i; });
  let band = null;
  for (let i = 0; i < f.length; i++) {
    if (db[i] !== null && db[i] <= -10) {
      let j = i;
      while (j + 1 < f.length && db[j + 1] !== null && db[j + 1] <= -10) j++;
      if (best >= i && best <= j) band = [f[i], f[j]];
      i = j;
    }
  }
  const near = k => f.reduce((b, v, i) => Math.abs(v - k) < Math.abs(f[b] - k) ? i : b, 0);
  const c = near(f0);
  return {
    bestHz: f[best], bestDb: db[best], band,
    zin: result.impedance ? [result.impedance.real_ohm[c], result.impedance.imag_ohm[c], f[c]] : null,
    patterns: result.patterns.map(p => ({ f: p.frequency_hz, dmax: p.max_directivity_dbi, eta: p.radiation_efficiency, gain: p.max_realized_gain_dbi })),
  };
}
