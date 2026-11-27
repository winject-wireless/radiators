// "Run in browser" section of the Simulation panel: builds the openEMS model for the current
// case, runs it in the openEMS wasm build (Web Worker), shows progress and the results.
import { OpenEMS } from "../../vendor/openems/openems.js";
import { buildModel } from "./model.js";
import { runSimulation, summarize, hasValidS11 } from "./run.js";
import { lineChart, polarChart, smithChart } from "./plot.js";
import { registerServiceWorker, isolationUnavailableReason } from "../platform.js";

const sim = {
  engine: "cpu", threads: 0, running: false, stage: "", progress: null, log: [], error: null,
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
const appendChildren = (parent, ...children) => parent.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
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

// Persistent results are keyed by the complete resolved simulation input, not
// the sweep index or filename. Increment the store version when solver/model
// output compatibility changes. IndexedDB stores large patterns without the
// small synchronous localStorage quota.
let runs = new Map(), caseStates = new Map(), cacheAttempts = new Map();
const CACHE_DB = "radiators-csxcad-results", CACHE_STORE = "resolved-v1";
let dbPromise;
function resultDB() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject)=>{
    if (!globalThis.indexedDB) { reject(Error("IndexedDB unavailable")); return; }
    const req=indexedDB.open(CACHE_DB,1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(CACHE_STORE))req.result.createObjectStore(CACHE_STORE);};
    req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{db.close();dbPromise=null;};resolve(db);};
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(Error("Result cache blocked by another tab"));
  }).catch(e=>{dbPromise=null;throw e;});
  return dbPromise;
}
// Expanded scripted hemisphere meshes already produce different resolved
// keys when their faces change. Legacy shell primitives need a targeted
// cache revision; unrelated existing results remain valid.
function cacheStorageKey(key) {
  const cfg=JSON.parse(key);
  return cfg.geometry?.some(g=>(g.shape??g.type)==="hemispherical_shell")
    ? "hemisphere-rim-v2:"+key : key;
}
async function cacheGet(key) {
  const db=await resultDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(CACHE_STORE,"readonly").objectStore(CACHE_STORE).get(cacheStorageKey(key));
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function cachePut(key, run) {
  const db=await resultDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(CACHE_STORE,"readwrite");
    tx.oncomplete=()=>resolve();
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Result cache write aborted"));
    tx.objectStore(CACHE_STORE).put({result:run.result,frequency:run.frequency,savedAt:Date.now()},cacheStorageKey(key));
  });
}
export function clearResults() {
  if (sim.running) stop();
  runs=new Map();caseStates=new Map();cacheAttempts=new Map();
}
export const caseRunState = id => caseStates.get(id);
export const resultFor = id => runs.get(id);

// Called as the document resolves (including asynchronous geometry scripts).
// Only exact config matches are restored; in-flight simulations take priority.
export async function restoreResults(ctx) {
  const target=runs, states=caseStates, attempts=cacheAttempts;
  const jobs=[];
  for(const c of ctx.getCases()){
    if(!c.config)continue;
    const key=JSON.stringify(c.config);
    if(target.get(c.id)?.key===key || attempts.get(c.id)===key)continue;
    if(["queued","running"].includes(states.get(c.id)?.status))continue;
    attempts.set(c.id,key);
    jobs.push({id:c.id,key});
  }
  if(!jobs.length)return;
  const cached=await Promise.all(jobs.map(async j=>{
    try{return {...j,entry:await cacheGet(j.key)};}catch{return j;}
  }));
  if(runs!==target)return;
  const current=new Map(ctx.getCases().filter(c=>c.config).map(c=>[c.id,JSON.stringify(c.config)]));
  let changed=false;
  for(const {id,key,entry} of cached){
    if(!entry?.result || current.get(id)!==key || attempts.get(id)!==key ||
      target.get(id)?.key===key || ["queued","running"].includes(states.get(id)?.status))continue;
    if(!hasValidS11(entry.result)){states.set(id,{status:"failed",key,error:"Cached simulation has no valid S11. Check feed excitation and rerun."});changed=true;continue;}
    target.set(id,{result:entry.result,key,frequency:entry.frequency,cached:true});
    states.set(id,{status:entry.result.postprocessing_incomplete?"partial":"done",key});changed=true;
  }
  if(changed)ctx.refresh();
}

const fraction = () => sim.batch ? (sim.batch.finished + (sim.progress?.fraction ?? 0)) / sim.batch.total : sim.progress?.fraction ?? 0;
export const simStatus = () => sim.running ? `${Math.min(99,Math.round(Math.min(1,fraction()) * 100))}%` : [...caseStates.values()].some(s=>s.status==="failed"||s.status==="partial") ? "!" : runs.size ? "✓" : "";

// ctx: { getCase() -> {config?, error?, pending?, id, name}, slug, onBadge(text), notify(msg, isError) }
export function renderRunPanel(box, ctx) {
  const c = ctx.getCase();
  const cases = ctx.getCases();
  const sweep = cases.length > 1;
  const pending = cases.some(x=>x.pending);
  ctx.onBadge(simStatus());
  if (!sim.threads) sim.threads = hc();
  const engine = h("select", { "aria-label": "openEMS engine", disabled: sim.running },
    h("option", { value: "cpu", text: "CPU (experimental)" }), h("option", { value: "basic", text: "Basic" }));
  engine.value = sim.engine;
  engine.addEventListener("change", () => { sim.engine = engine.value; });
  const threads = h("input", { type: "number", min: 1, max: 64, value: sim.threads, "aria-label": "Threads", disabled: sim.running });
  threads.addEventListener("change", () => { sim.threads = Math.max(1, Math.min(64, Math.trunc(Number(threads.value)) || hc())); });
  const unavailable = OpenEMS.unsupportedReason();
  const isolationBlocked = isolationUnavailableReason();
  const runBtn = h("button", { type: "button", class: "primary", disabled: sim.running || !c.config || !!unavailable, onclick: () => start(ctx, false) }, sim.running ? "Running…" : sweep ? "Run case" : "Run in browser");
  const allBtn = sweep ? h("button", { type: "button", class: "primary", disabled: sim.running || pending || !!unavailable || !cases.some(x=>x.config), onclick: () => start(ctx, true) }, `Run all (${cases.length})`) : null;
  if (sweep) runBtn.classList.remove("primary");
  if (sim.running && allBtn) allBtn.hidden = true;
  const abortBtn = h("button", { type: "button", hidden: !sim.running, disabled: sim.aborting, onclick: stop, title: "Stop the current simulation and remaining sweep. Completed results are retained." }, sim.aborting ? "Stopping…" : "Stop");
  const bar = h("div", { class: "sim-bar" }, h("div", { class: "sim-bar-fill" }));
  const stats = h("div", { class: "sim-stats" });
  const logPre = h("pre", { class: "sim-log" });
  const logBox = h("details", { class: "sim-log-box" }, h("summary", { text: "openEMS log" }), logPre);
  const warningBox = h("div", { class: "note warn", role: "alert", hidden: true });
  ui = { bar, stats, logPre, runBtn, abortBtn, warningBox };

  const caseLine = c.config
    ? sweep ? `${c.label} · ${cases.length} cases` : "Single case"
    : c.pending ? "Geometry scripts are still running…" : `Cannot simulate: ${c.error}`;
  box.append(h("div", { class: "form-section sim-run" },
    h("div",{class:"sim-run-head"},h("h3",{text:"Run in browser"}),h("span",{class:"hint sim-case-hint",title:c.name||"",text:`${caseLine}${pending&&!c.pending?" · preparing cases":""}`})),
    h("div", { class: "sim-controls" }, h("div",{class:"sim-run-actions"},allBtn,runBtn,abortBtn),
      h("div",{class:"sim-run-options"},h("label", { class: "sim-engine" }, "Engine", engine), h("label", { class: "sim-threads" }, "Threads", threads))),
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
    sim.running || sim.progress ? bar : null, stats, warningBox,
    sim.cacheWarning ? h("p",{class:"hint",text:sim.cacheWarning}) : null,
    sim.running || sim.log.length ? logBox : null));
  updateProgress();
}

function updateProgress() {
  if (!ui) return;
  const p = sim.progress;
  ui.bar.firstChild.style.width = `${Math.round(Math.min(1, sim.batch ? fraction() : p?.fraction ?? (sim.running ? 0 : 1)) * 100)}%`;
  const el = sim.running ? Math.round((Date.now() - sim.startedAt) / 1000) : null;
  ui.stats.textContent = sim.running
    ? `${sim.batch ? `${sim.batch.finished}/${sim.batch.total} finished · ${sim.batch.id} · ` : ""}${sim.stage}${p ? ` · timestep ${p.timestep}${p.maxTimesteps ? "/" + p.maxTimesteps : ""} · ${fmt(p.speedMCellsPerSec, 1)} MC/s · energy ${fmt(p.energyDb, 1)} dB` : ""} · ${el} s` +
      (sim.model ? ` · ${(sim.model.cells / 1e6).toFixed(2)} M cells` : "")
    : sim.summary || "";
  ui.logPre.textContent = sim.log.slice(-200).join("\n");
  const message = sim.error || sim.warning || "";
  ui.warningBox.hidden = !message;
  ui.warningBox.textContent = message;
}

async function start(ctx, all = false) {
  if (sim.running) return;
  const cases = all ? ctx.getCases() : [ctx.getCase()];
  if (!cases.some(c=>c.config) || cases.some(c=>c.pending)) return;
  const why = OpenEMS.unsupportedReason();
  if (why) { sim.error = isolationUnavailableReason() || why; ctx.refresh(); return; }
  // Capture immutable resolved configs; selecting another case or editing the document
  // during the sweep cannot change the queued simulation inputs.
  const queue = cases.map(c=>({...c, config:c.config ? structuredClone(c.config) : null}));
  const runCases = runs, states = caseStates;
  for (const c of queue) { states.set(c.id,{status:"queued",key: c.config ? JSON.stringify(c.config) : null}); }
  Object.assign(sim,{running:true,aborting:false,error:null,warning:null,cacheWarning:null,summary:"",log:[],progress:null,model:null,
    batch:{total:queue.length,finished:0,id:queue[0].id},stage:"preparing",startedAt:Date.now()});
  let completed=0, failed=0, stopped=0, partial=0;
  const publish=()=>{ctx.onBadge(simStatus());ctx.refresh();};
  publish();
  const tick=setInterval(updateProgress,1000);
  try {
    for (const c of queue) {
      if (sim.aborting || runs!==runCases) break;
      const key=c.config ? JSON.stringify(c.config) : null;
      sim.batch.id=c.id;
      Object.assign(sim,{progress:null,model:null,stage:"preparing",startedAt:Date.now(),log:[],warning:null});
      states.set(c.id,{status:"running",key});
      let partialRun=null;
      publish();
      try {
        if (!c.config) throw Error(c.error || "Case configuration unavailable");
        const model=buildModel(c.config);
        sim.model=model;
        sim.stage="starting openEMS";
        sim.ems=new OpenEMS({threads:workerPoolSize(model,sim.engine,sim.threads)});
        await sim.ems.initialize();
        if (sim.aborting) throw Error("Stopped");
        const result=await runSimulation(sim.ems,model,{
          config:c.config,engine:sim.engine,threads:sim.threads,
          onLog:line=>{sim.log.push(line);if(sim.log.length>2000)sim.log.splice(0,500);},
          onWarning:w=>{sim.warning=w.fatal?"Invalid feed — "+w.message:w.message;updateProgress();},
          onProgress:p=>{sim.progress=p;ctx.onBadge(simStatus());updateProgress();},
          onStage:s=>{sim.stage=s;updateProgress();},
          onPartial:r=>{
            const previous=partialRun;
            partialRun={...previous,result:r,key,frequency:previous?.frequency>=0?previous.frequency:r.patterns.findIndex(p=>p.record.radiation_valid)};
            runCases.set(c.id,partialRun);
            publish();
          }
        });
        result.aborted=!!(result.aborted||sim.aborting);
        const firstValid=result.patterns.findIndex(p=>p.record.radiation_valid);
        const run={...partialRun,result,key,frequency:partialRun?.frequency>=0?partialRun.frequency:firstValid};
        runCases.set(c.id,run);
        publish();
        sim.stage="saving result";updateProgress();
        // Commit the cache before publishing completion, so an immediate reload
        // after the completion badge cannot race the persistent write.
        if(!result.aborted)try{await cachePut(key,run);}catch(e){sim.cacheWarning="Result cache unavailable: "+e.message;}
        runCases.set(c.id,run);
        states.set(c.id,{status:result.aborted?"stopped":result.postprocessing_incomplete?"partial":"done",key});
        if(result.aborted)stopped++;else if(result.postprocessing_incomplete)partial++;else completed++;
        const s=summarize(result,c.config.excitation.center_hz);
        ctx.notify(`${c.id}: ${result.aborted?"Stopped":result.postprocessing_incomplete?"Partial result":"Done"} · S11 ${fmt(s.bestDb,1)} dB at ${ghz(s.bestHz)}`);
      } catch(e) {
        if(partialRun){
          const result={...partialRun.result,postprocessing_pending:false,postprocessing_incomplete:true,aborted:sim.aborting,solver_warnings:[...(partialRun.result.solver_warnings??[]),"Post-processing interrupted: "+e.message]};
          runCases.set(c.id,{...partialRun,result});
          states.set(c.id,{status:sim.aborting?"stopped":"partial",key,error:e.message});
          if(sim.aborting)stopped++;else {partial++;sim.error=c.id+": "+e.message;ctx.notify(sim.error,true);}
        } else if(sim.aborting){states.set(c.id,{status:"stopped",key});stopped++;}
        else {runCases.delete(c.id);states.set(c.id,{status:"failed",key,error:e.message});sim.error=c.id+": "+e.message;failed++;ctx.notify(sim.error,true);}
      } finally {
        clearTimeout(sim.stopTimer);
        sim.ems?.terminate();
        sim.ems=null;
        sim.batch.finished++;
        sim.progress=null;
        // Publish each result immediately, without changing the user's selected case.
        publish();
      }
    }
  } finally {
    clearTimeout(sim.stopTimer);clearInterval(tick);
    sim.ems?.terminate();
    for(const c of queue)if(states.get(c.id)?.status==="queued")states.set(c.id,{...states.get(c.id),status:"cancelled"});
    const cancelled=queue.length-completed-failed-stopped-partial;
    sim.summary=`${completed}/${queue.length} completed${partial?" · "+partial+" partial":""}${failed?" · "+failed+" failed":""}${stopped?" · "+stopped+" stopped":""}${cancelled?" · "+cancelled+" cancelled":""}`;
    Object.assign(sim,{ems:null,running:false,aborting:false,stage:"",batch:null,progress:null});
    publish();
    ctx.notify(sim.summary,failed>0||partial>0);
  }
}
function stop() {
  if (!sim.running || sim.aborting) return;
  sim.aborting=true;
  if(ui?.abortBtn){ui.abortBtn.disabled=true;ui.abortBtn.textContent="Stopping…";}
  const ems=sim.ems;
  if(!ems)return;
  if(sim.stage==="FDTD"){ems.abort();sim.stopTimer=setTimeout(()=>ems.terminate(),1000);}
  else ems.terminate();
}

export function renderResults(box, ctx, run, caseId, stale) {
  box.replaceChildren();
  if (!run || stale) {
    const status=caseRunState(caseId);
    box.append(h("p", { class: status?.status==="failed" ? "note warn" : "hint", text: stale && status?.status!=="failed" ? "This case has changed. Run it again to update its results." : status?.status==="failed" ? "Failed: "+status.error : status?.status==="running" ? "Simulation running…" : status?.status==="queued" ? "Queued for simulation…" : status?.status==="cancelled" || status?.status==="stopped" ? "Simulation stopped before results were available." : "Run this case in the Simulation tab to see its results." }));
    return;
  }
  const r = run.result;
  const s = summarize(r, r.input_config.excitation.center_hz);
  const f = r.s11.frequency_hz.map(v => v / 1e9);
  const ports = r.input_config.ports ?? r.input_config.sources ?? [];
  const driven = ports.find(p => Number(p.id ?? p.port_number ?? 1) === Number(r.port_id)) ?? ports.find(p => p.excite ?? p.enabled);
  const z0 = Number(driven?.impedance_ohm ?? 50);
  const smithFrequency = r.patterns[run.frequency]?.frequency_hz ?? r.patterns[0]?.frequency_hz ?? r.input_config.excitation.center_hz;
  const download = () => {
    const blob = new Blob([JSON.stringify(r, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${ctx.slug()}__${caseId}.result.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  appendChildren(box,
    h("div",{class:"result-summary-head"},
      h("h3",{text:run.cached?"Results · cached on this device":"Overview"}),
      h("button",{type:"button",class:"small result-download",onclick:download},"Download result.json")),
    r.postprocessing_pending ? h("div",{class:"note",text:"Port results available. Radiation post-processing is still running."}) : null,
    r.postprocessing_incomplete ? h("div",{class:"note warn",text:"Partial result: S11 and impedance are available, but some radiation results are unavailable."}) : null,
    r.aborted ? h("div", { class: "note warn", text: "Stopped early: the results use the time steps computed so far." }) : null,
    ...(r.solver_warnings ?? []).map(message=>h("div",{class:"note warn",text:message})),
    h("div", { class: "sim-kpis" },
      kpi("Best S11", `${fmt(s.bestDb, 1)} dB`, ghz(s.bestHz)),
      kpi("−10 dB band", s.band ? `${fmt((s.band[1] - s.band[0]) / 1e6, 0)} MHz` : "none", s.band ? `${ghz(s.band[0])} – ${ghz(s.band[1])}` : ""),
      s.zin ? kpi("Zin", `${fmt(s.zin[0], 1)} ${s.zin[1] < 0 ? "−" : "+"} j${fmt(Math.abs(s.zin[1]), 1)} Ω`, `at ${ghz(s.zin[2])}`) : null,
      ...s.patterns.map(p => kpi(`Dmax ${ghz(p.f)}`, `${fmt(p.dmax)} dBi`, `efficiency ${p.eta === null ? "—" : fmt(p.eta * 100, 1) + "%"}${p.gain !== null ? ` · gain ${fmt(p.gain)} dBi` : ""}`)),
      kpi("Mesh / time", `${(r.mesh_total_cells / 1e6).toFixed(2)} M cells`, `${fmt(r.seconds, 0)} s on this device`)),
    h("div",{class:"result-section-head"},h("h3",{text:"Frequency response"})),
    h("div", { class: "sim-charts" },
      chartCard("S11 (dB)", lineChart({ series: [{ x: f, y: r.s11.logmag_db }], xLabel: "GHz", yLabel: "dB", hlines: [{ y: -10, label: "−10 dB" }], yMax: 0, xFmt: v => String(+v.toFixed(3)) })),
      chartCard("S11 phase", lineChart({ series: [{ x: f, y: r.s11.phase_deg }], xLabel: "GHz", yLabel: "Degrees", yMin: -180, yMax: 180 })),
      r.impedance ? chartCard("Input impedance (Ω)", lineChart({ series: [{ x: f, y: r.impedance.real_ohm, label: "R" }, { x: f, y: r.impedance.imag_ohm, label: "X" }],
        xLabel: "GHz", yLabel: "Ω  (R, X)", hlines: [{ y: 0 }], xFmt: v => String(+v.toFixed(3)) })) : null,
      chartCard("VSWR", lineChart({ series: [{ x: f, y: r.s11.vswr.map(v => v === null ? null : Math.min(v, 10)) }], xLabel: "GHz", yLabel: "VSWR", yMin: 1, hlines: [{ y: 2, label: "2:1" }], xFmt: v => String(+v.toFixed(3)) })),
      chartCard("Smith chart", smithChart({s11:r.s11,z0,frequencyHz:smithFrequency}))),
    diagnosticCards(r.diagnostics),
    r.patterns.length?h("div",{class:"result-section-head"},h("h3",{text:"Radiation patterns"})):null,
    ...r.patterns.map(p => patternCards(p)));
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
  return h("div", { class: "sim-pattern" }, h("h4", { text: `${ghz(p.frequency_hz)} · Dmax ${fmt(p.max_directivity_dbi)} dBi` }),
    h("div", { class: "sim-polars" },
      chartCard("φ = 0° cut (xz), angle = θ", polarChart({ series: [elevation(0, 180)], rMax, rMin: rMax - 30 })),
      chartCard("φ = 90° cut (yz), angle = θ", polarChart({ series: [elevation(90, 270)], rMax, rMin: rMax - 30 })),
      azimuth ? chartCard("θ = 90° cut (xy), angle = φ", polarChart({ series: [azimuth], rMax, rMin: rMax - 30 })) : null));
}

function diagnosticCards(d) {
  const root=h("details",{class:"sim-pattern",open:true},h("summary",{text:"Diagnostics"}));
  if(!d){root.append(h("p",{class:"hint",text:"This cached result predates diagnostics. Rerun to capture port waveforms and mesh statistics."}));return root;}
  const s=d.solver??{}, v=d.voltage, i=d.current;
  const sci=x=>Number.isFinite(x)?x.toExponential(3):"—";
  const ns=x=>Number.isFinite(x)?(x*1e9).toFixed(3)+" ns":"—";
  const duration=Number.isFinite(s.timestep_s)&&Number.isFinite(s.executed_timesteps)?s.timestep_s*s.executed_timesteps:null;
  root.append(h("div",{class:"sim-kpis"},
    kpi("FDTD timestep",Number.isFinite(s.timestep_s)?(s.timestep_s*1e15).toFixed(2)+" fs":"—"),
    kpi("Excitation",String(s.excitation_timesteps??"—")+" steps",ns(s.timestep_s*s.excitation_timesteps)),
    kpi("Executed",String(s.executed_timesteps??"—")+" steps",ns(duration)),
    kpi("Termination",s.termination??"unknown",Number.isFinite(s.final_energy_db)?s.final_energy_db+" dB":""),
    kpi("Peak voltage",sci(v?.peak_abs)+" V",String(v?.samples??0)+" samples"),
    kpi("Peak current",sci(i?.peak_abs)+" A",String(i?.samples??0)+" samples"),
    ...(d.mesh??[]).map(m=>kpi(m.axis.toUpperCase()+" min cell",sci(m.min_mm)+" mm",m.min_at_mm?.map(x=>x.toPrecision(8)).join(" → ")+" mm"))));
  const plots=[];
  for(const [label,p,unit] of [["Port voltage",v,"V"],["Port current",i,"A"]]){
    if(p?.time_s?.length>1) plots.push(chartCard(label+(p.preview_decimated?" (min/max preview)":""),lineChart({series:[{x:p.time_s.map(t=>t*1e9),y:p.value}],xLabel:"ns",yLabel:unit})));
  }
  const p=d.power_spectrum;
  if(p?.frequency_hz?.length){
    const peak=p.incident.reduce((m,x)=>Number.isFinite(x)?Math.max(m,x):m,0);
    if(peak>0)for(const [key,label] of [["incident","Incident"],["reflected","Reflected"],["accepted","Accepted (signed)"]]){
      const x=p.frequency_hz.map(f=>f/1e9),y=p[key].map(v=>Number.isFinite(v)?v/peak:null);
      if(y.some(Number.isFinite))plots.push(chartCard(label+" spectral power / peak incident",lineChart({series:[{x,y}],xLabel:"GHz",yLabel:"Ratio"})));
    }
  }
  if(plots.length)root.append(h("div",{class:"sim-charts"},...plots));
  root.append(h("p",{class:"hint",text:"Waveforms retain bucket extrema for plotting; peak and RMS use every finite probe sample. Spectral power is normalized to peak incident for display, not calibrated transmitter watts."}));
  return root;
}
