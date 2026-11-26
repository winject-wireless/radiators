// "Run in browser" section of the Simulation panel: builds the openEMS model for the current
// case, runs it in the openEMS wasm build (Web Worker), shows progress and the results.
import { OpenEMS } from "../../vendor/openems/openems.js";
import { buildModel } from "./model.js";
import { runSimulation, summarize } from "./run.js";
import { lineChart, polarChart } from "./plot.js";
import { registerServiceWorker, isolationUnavailableReason } from "../platform.js";

const sim = {
  engine: "basic", threads: 0, running: false, stage: "", progress: null, log: [], error: null,
  ems: null, model: null, startedAt: 0, aborting: false, stopTimer: null,
};
let ui = null; // live DOM refs of the rendered panel

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const ghz = f => `${+(f / 1e9).toFixed(4)} GHz`;
const fmt = (v, d = 2) => v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
const hc = () => Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

// The solver blocks its host worker, so every concurrent pthread must already be
// loaded. Field dumps keep a second team (one thread per 1024 face nodes), plus
// a writer. The CPU engine also starts temporary gather/energy threads while
// the engine and dump teams are still alive.
function workerPoolSize(model, engine, requested) {
  const threads = Math.min(requested, navigator.hardwareConcurrency || requested);
  const [a, b] = model.counts.map(n => n + 1).sort((x, y) => y - x);
  const dumpHelpers = Math.max(0, Math.min(threads, Math.floor(a * b / 1024)) - 1);
  const runtime = threads + dumpHelpers + 2; // writer and abort watcher
  if (engine !== "cpu") return runtime;
  // CPU operator setup also builds six components concurrently on small teams.
  return Math.max(6, runtime + threads - 1);
}

let runs = new Map();
export function clearResults() { runs = new Map(); }
export const resultFor = id => runs.get(id);

export const simStatus = () => sim.running ? `${Math.round((sim.progress?.fraction ?? 0) * 100)}%` : runs.size ? "✓" : "";

// ctx: { getCase() -> {config?, error?, pending?, id, name}, slug, onBadge(text), notify(msg, isError) }
export function renderRunPanel(box, ctx) {
  const c = ctx.getCase();
  ctx.onBadge(simStatus());
  if (!sim.threads) sim.threads = hc();
  const engine = h("select", { "aria-label": "openEMS engine", disabled: sim.running },
    h("option", { value: "basic", text: "basic engine" }), h("option", { value: "cpu", text: "cpu engine (faster, experimental)" }));
  engine.value = sim.engine;
  engine.addEventListener("change", () => { sim.engine = engine.value; });
  const threads = h("input", { type: "number", min: 1, max: 64, value: sim.threads, "aria-label": "Threads", disabled: sim.running });
  threads.addEventListener("change", () => { sim.threads = Math.max(1, Math.min(64, Math.trunc(Number(threads.value)) || hc())); });
  const unavailable = OpenEMS.unsupportedReason();
  const isolationBlocked = isolationUnavailableReason();
  const runBtn = h("button", { type: "button", class: "primary", disabled: sim.running || !c.config || !!unavailable, onclick: () => start(ctx) }, sim.running ? "Running…" : "Run in browser");
  const abortBtn = h("button", { type: "button", hidden: !sim.running, disabled: sim.aborting, onclick: stop, title: "Stop this run. Partial results are kept if they finish within one second." }, sim.aborting ? "Stopping…" : "Stop");
  const bar = h("div", { class: "sim-bar" }, h("div", { class: "sim-bar-fill" }));
  const stats = h("div", { class: "sim-stats" });
  const logPre = h("pre", { class: "sim-log" });
  const logBox = h("details", { class: "sim-log-box" }, h("summary", { text: "openEMS log" }), logPre);
  ui = { bar, stats, logPre, runBtn, abortBtn };

  const caseLine = c.config
    ? `Case ${c.id}${c.name && c.name !== "Default" ? ` (${c.name})` : ""}`
    : c.pending ? "Geometry scripts are still running…" : `Cannot simulate: ${c.error}`;
  box.append(h("div", { class: "form-section sim-run" },
    h("h3", { text: "Run in browser" }),
    h("p", { class: "hint", text: `${caseLine}. openEMS (WebAssembly) runs on this device; nothing is uploaded. Lumped ports only.` }),
    h("div", { class: "sim-controls" }, runBtn, abortBtn, engine, h("label", { class: "sim-threads" }, "Threads", threads)),
    unavailable ? h("div", { class: "note warn" },
      h("p", { text: isolationBlocked || "Browser simulation needs cross-origin isolation. The editor is preparing the service worker; it will reload once when ready." }),
      !isolationBlocked ? h("button", { type: "button", onclick: async e => {
        const button = e.currentTarget;
        button.disabled = true;
        button.textContent = "Checking isolation…";
        const error = await registerServiceWorker({ manual: true });
        if (error) { sim.error = error; ctx.refresh(); }
      } }, "Retry isolation") : null,
      h("a", { href: location.href, target: "_blank", rel: "noopener noreferrer" }, "Open editor directly (new tab)")) : null,
    sim.running || sim.progress ? bar : null, stats, sim.error ? h("div", { class: "note warn", text: sim.error }) : null,
    sim.running || sim.log.length ? logBox : null));
  updateProgress();
}

function updateProgress() {
  if (!ui) return;
  const p = sim.progress;
  ui.bar.firstChild.style.width = `${Math.round((p?.fraction ?? (sim.running ? 0 : 1)) * 100)}%`;
  const el = sim.running ? Math.round((Date.now() - sim.startedAt) / 1000) : null;
  ui.stats.textContent = sim.running
    ? `${sim.stage}${p ? ` · timestep ${p.timestep}${p.maxTimesteps ? "/" + p.maxTimesteps : ""} · ${fmt(p.speedMCellsPerSec, 1)} MC/s · energy ${fmt(p.energyDb, 1)} dB` : ""} · ${el} s` +
      (sim.model ? ` · ${(sim.model.cells / 1e6).toFixed(2)} M cells` : "")
    : "";
  ui.logPre.textContent = sim.log.slice(-200).join("\n");
}

async function start(ctx) {
  const c = ctx.getCase();
  if (!c.config || sim.running) return;
  sim.error = null; sim.log = []; sim.progress = null; sim.aborting = false;
  let model;
  try { model = buildModel(c.config); } catch (e) { sim.error = e.message; ctx.refresh(); return; }
  const why = OpenEMS.unsupportedReason();
  if (why) {
    sim.error = isolationUnavailableReason() || why;
    ctx.refresh();
    return;
  }
  Object.assign(sim, { running: true, model, stage: "starting openEMS", startedAt: Date.now() });
  const runCases = runs;
  const key = JSON.stringify(c.config);
  ctx.onBadge(simStatus());
  ctx.refresh();
  const tick = setInterval(updateProgress, 1000);
  try {
    sim.ems = new OpenEMS({ threads: workerPoolSize(model, sim.engine, sim.threads) });
    await sim.ems.initialize();
    const result = await runSimulation(sim.ems, model, {
      config: c.config, engine: sim.engine, threads: sim.threads,
      onLog: line => { sim.log.push(line); if (sim.log.length > 2000) sim.log.splice(0, 500); },
      onProgress: p => { sim.progress = p; ctx.onBadge(simStatus()); updateProgress(); },
      onStage: s => { sim.stage = s; updateProgress(); },
    });
    result.aborted = result.aborted || sim.aborting;
    const firstValid = result.patterns.findIndex(p => p.record.radiation_valid);
    runCases.set(c.id, { result, key, frequency: firstValid });
    const s = summarize(result, c.config.excitation.center_hz);
    ctx.notify(`${result.aborted ? "Simulation stopped" : "Simulation done"} in ${result.seconds.toFixed(0)} s: best S11 ${fmt(s.bestDb, 1)} dB at ${ghz(s.bestHz)}`);
  } catch (e) {
    if (sim.aborting) {
      sim.progress = null;
      ctx.notify("Simulation stopped");
    } else {
      sim.error = `Simulation failed: ${e.message}`;
      ctx.notify(sim.error, true);
    }
  } finally {
    clearTimeout(sim.stopTimer);
    clearInterval(tick);
    sim.ems?.terminate();
    Object.assign(sim, { ems: null, running: false, aborting: false, stage: "" });
    ctx.onBadge(simStatus());
    ctx.refresh();
  }
}

function stop() {
  if (!sim.ems || sim.aborting) return;
  sim.aborting = true;
  ui.abortBtn.disabled = true;
  ui.abortBtn.textContent = "Stopping…";
  const ems = sim.ems;
  if (sim.stage === "FDTD") {
    ems.abort();
    sim.stopTimer = setTimeout(() => ems.terminate(), 1000);
  } else {
    ems.terminate();
  }
}

export function renderResults(box, ctx, run, caseId, stale) {
  box.replaceChildren();
  if (!run || stale) {
    box.append(h("p", { class: "hint", text: stale ? "This case has changed. Run it again to update its results." : "Run this case in the Simulation tab to see its results." }));
    return;
  }
  const r = run.result;
  const s = summarize(r, r.input_config.excitation.center_hz);
  const f = r.s11.frequency_hz.map(v => v / 1e9);
  const download = () => {
    const blob = new Blob([JSON.stringify(r, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${ctx.slug()}__${caseId}.result.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  box.append(
    h("h3", { text: "Results" }),
    r.aborted ? h("div", { class: "note warn", text: "Stopped early: the results use the time steps computed so far." }) : null,
    h("div", { class: "sim-kpis" },
      kpi("Best S11", `${fmt(s.bestDb, 1)} dB`, ghz(s.bestHz)),
      kpi("−10 dB band", s.band ? `${fmt((s.band[1] - s.band[0]) / 1e6, 0)} MHz` : "none", s.band ? `${ghz(s.band[0])} – ${ghz(s.band[1])}` : ""),
      s.zin ? kpi("Zin", `${fmt(s.zin[0], 1)} ${s.zin[1] < 0 ? "−" : "+"} j${fmt(Math.abs(s.zin[1]), 1)} Ω`, `at ${ghz(s.zin[2])}`) : null,
      ...s.patterns.map(p => kpi(`Dmax ${ghz(p.f)}`, `${fmt(p.dmax)} dBi`, `efficiency ${p.eta === null ? "—" : fmt(p.eta * 100, 1) + "%"}${p.gain !== null ? ` · gain ${fmt(p.gain)} dBi` : ""}`)),
      kpi("Mesh / time", `${(r.mesh_total_cells / 1e6).toFixed(2)} M cells`, `${fmt(r.seconds, 0)} s on this device`)),
    h("div", { class: "sim-charts" },
      chartCard("S11 (dB)", lineChart({ series: [{ x: f, y: r.s11.logmag_db }], xLabel: "GHz", yLabel: "dB", hlines: [{ y: -10, label: "−10 dB" }], yMax: 0, xFmt: v => String(+v.toFixed(3)) })),
      chartCard("S11 phase", lineChart({ series: [{ x: f, y: r.s11.phase_deg }], xLabel: "GHz", yLabel: "Degrees", yMin: -180, yMax: 180 })),
      r.impedance ? chartCard("Input impedance (Ω)", lineChart({ series: [{ x: f, y: r.impedance.real_ohm, label: "R" }, { x: f, y: r.impedance.imag_ohm, label: "X" }],
        xLabel: "GHz", yLabel: "Ω  (R, X)", hlines: [{ y: 0 }], xFmt: v => String(+v.toFixed(3)) })) : null,
      chartCard("VSWR", lineChart({ series: [{ x: f, y: r.s11.vswr.map(v => v === null ? null : Math.min(v, 10)) }], xLabel: "GHz", yLabel: "VSWR", yMin: 1, hlines: [{ y: 2, label: "2:1" }], xFmt: v => String(+v.toFixed(3)) }))),
    ...r.patterns.map(p => patternCards(p)),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: download }, "Download result.json")));
}

const kpi = (label, value, sub) => h("div", { class: "kpi" }, h("div", { class: "kpi-label", text: label }), h("div", { class: "kpi-value", text: value }), sub ? h("div", { class: "kpi-sub", text: sub }) : null);
const chartCard = (title, svg) => h("figure", { class: "chart-card" }, h("figcaption", { text: title }), svg);

// Three principal cuts of the directivity: φ = 0° (xz), φ = 90° (yz) and θ = 90° (xy).
function patternCards(p) {
  const rec = p.record;
  if (!rec.radiation_valid) return h("div", { class: "note warn", text: `${ghz(p.frequency_hz)}: ${rec.radiation_warning}` });
  const th = rec.theta_deg, ph = rec.phi_deg, D = rec.directivity_dbi;
  const col = a => ph.findIndex(v => Math.abs(v - a) < 1e-6);
  const elevation = (a, b) => {
    const ia = col(a), ib = col(b), angle = [], value = [];
    if (ia >= 0) th.forEach((t, i) => { angle.push(t); value.push(D[i][ia]); });
    if (ib >= 0) [...th].reverse().forEach((t, k) => { const i = th.length - 1 - k; angle.push(360 - t); value.push(D[i][ib]); });
    return { angleDeg: angle, value };
  };
  const it90 = th.findIndex(v => Math.abs(v - 90) < 1e-6);
  const azimuth = it90 >= 0 ? { angleDeg: [...ph], value: D[it90] } : null;
  const rMax = Math.ceil((p.max_directivity_dbi ?? 0) / 5) * 5;
  return h("div", { class: "sim-pattern" }, h("h4", { text: `Directivity at ${ghz(p.frequency_hz)} · Dmax ${fmt(p.max_directivity_dbi)} dBi` }),
    h("div", { class: "sim-polars" },
      chartCard("φ = 0° cut (xz), angle = θ", polarChart({ series: [elevation(0, 180)], rMax, rMin: rMax - 30 })),
      chartCard("φ = 90° cut (yz), angle = θ", polarChart({ series: [elevation(90, 270)], rMax, rMin: rMax - 30 })),
      azimuth ? chartCard("θ = 90° cut (xy), angle = φ", polarChart({ series: [azimuth], rMax, rMin: rMax - 30 })) : null));
}
