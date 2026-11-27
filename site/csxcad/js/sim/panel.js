// "Run in browser" section of the Simulation panel: builds the openEMS model for the current
// case, runs it in the openEMS wasm build (Web Worker), shows progress and the results.
import { OpenEMS } from "../../vendor/openems/openems.js";
import { buildModel } from "./model.js";
import { runSimulation, summarize, hasValidS11 } from "./run.js";
import { lineChart, polarChart, smithChart } from "./plot.js";
import { updateSolverDiagnostics } from "./diagnostics.js";
import { registerServiceWorker, isolationUnavailableReason, storage } from "../platform.js";
import { RemoteRunner, remoteEndpoint } from "./remote.js";
import { ProgressParser } from "../../vendor/openems/openems-core.js";

const sim = {
  engine: "cpu", threads: 0, active:new Map(), runner:storage.get("radiators.runner")==="remote"?"remote":"browser", remoteUrl:storage.get("radiators.runner.url")||"", remoteToken:"", remote:null, running: false, stage: "", progress: null, log: [], error: null,
  ems: null, model: null, startedAt: 0, aborting: false, stopTimer: null,
};
let ui = null; // live DOM refs of the rendered panel
let resultLogUI=null;
const logExpanded=new Map();
const validationLogs=new Map();

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
    tx.objectStore(CACHE_STORE).put({result:run.result,frequency:run.frequency,log:run.log,savedAt:Date.now()},cacheStorageKey(key));
  });
}
export function clearResults() {
  if (sim.running) stop();
  runs=new Map();caseStates=new Map();cacheAttempts=new Map();logExpanded.clear();validationLogs.clear();
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
    target.set(id,{result:entry.result,key,frequency:entry.frequency,log:entry.log,cached:true});
    states.set(id,{status:entry.result.postprocessing_incomplete?"partial":"done",key});changed=true;
  }
  if(changed)ctx.refresh();
}

const fraction = () => sim.batch ? (sim.batch.finished + [...sim.active.values()].reduce((n,j)=>n+(j.progress?.fraction??0),0)) / sim.batch.total : sim.progress?.fraction ?? 0;
const cpuSettings=()=>{
  const remote=sim.runner==="remote",cap=remote?128:Math.min(navigator.hardwareConcurrency||4,64);
  const saved=storage.get("radiators.cpu."+sim.runner)||{};
  const pool=Math.max(1,Math.min(cap,Math.trunc(saved.pool)|| (remote?16:hc())));
  const perJob=Math.max(1,Math.min(pool,Math.trunc(saved.perJob)||2));
  return {pool,perJob,cap};
};
export const simStatus = () => sim.running ? `${Math.min(99,Math.round(Math.min(1,fraction()) * 100))}%` : [...caseStates.values()].some(s=>s.status==="failed"||s.status==="partial") ? "!" : runs.size ? "✓" : "";

// ctx: { getCase() -> {config?, error?, pending?, id, name}, slug, onBadge(text), notify(msg, isError) }
export function renderRunPanel(box, ctx) {
  const c = ctx.getCase();
  const cases = ctx.getCases();
  const sweep = cases.length > 1;
  const pending = cases.some(x=>x.pending);
  ctx.onBadge(simStatus());
  const cpu=cpuSettings();
  sim.threads=cpu.perJob;
  const engine = h("select", { "aria-label": "openEMS engine", disabled: sim.running },
    h("option", { value: "cpu", text: "CPU (experimental)" }), h("option", { value: "basic", text: "Basic" }));
  engine.value = sim.engine;
  engine.addEventListener("change", () => { sim.engine = engine.value; });
  const pool=h("input",{type:"number",min:1,max:cpu.cap,value:cpu.pool,"aria-label":"CPU pool",disabled:sim.running});
  const threads=h("input",{type:"number",min:1,max:cpu.pool,value:cpu.perJob,"aria-label":"Threads",disabled:sim.running});
  const saveCPU=()=>{
    const n=Math.max(1,Math.min(cpu.cap,Math.trunc(Number(pool.value))||1));
    const t=Math.max(1,Math.min(n,Math.trunc(Number(threads.value))||1));
    storage.set("radiators.cpu."+sim.runner,{pool:n,perJob:t});
    sim.threads=t;pool.value=n;threads.value=t;threads.max=n;
    parallel.textContent=Math.min(cases.length,Math.floor(n/t))+" concurrent case(s) maximum";
  };
  const parallel=h("span",{class:"hint",text:Math.min(cases.length,Math.floor(cpu.pool/cpu.perJob))+" concurrent case(s) maximum"});
  pool.addEventListener("change",saveCPU);threads.addEventListener("change",saveCPU);
  const remote=sim.runner==="remote";
  const runnerSelect=h("select",{"aria-label":"Simulation runner",disabled:sim.running},h("option",{value:"browser",text:"Browser"}),h("option",{value:"remote",text:"Remote"}));
  runnerSelect.value=sim.runner;
  runnerSelect.addEventListener("change",()=>{sim.runner=runnerSelect.value;storage.set("radiators.runner",sim.runner);sim.error=null;ctx.refresh();});
  const url=h("input",{type:"url",value:sim.remoteUrl,placeholder:"https://runner.example.com","aria-label":"Remote runner URL",disabled:sim.running});
  const token=h("input",{type:"password",value:sim.remoteToken,placeholder:"Runner token",autocomplete:"off","aria-label":"Remote runner token",disabled:sim.running});
  const connection=h("span",{class:"hint",text:"Token stays in this session."});
  const save=()=>{sim.remoteUrl=url.value.trim();sim.remoteToken=token.value;storage.set("radiators.runner.url",sim.remoteUrl);};
  url.addEventListener("input",save);token.addEventListener("input",save);
  const test=h("button",{type:"button",disabled:sim.running,onclick:async()=>{
    save();test.disabled=true;
    try{const info=await new RemoteRunner(sim.remoteUrl,sim.remoteToken).health();
      if(info.api_version!==1)throw Error("Incompatible runner API");
      connection.textContent="Connected · "+info.max_cpus+" CPUs · "+info.max_memory_gib+" GiB max per job";
    }catch(e){connection.textContent=e.message;}finally{test.disabled=false;}
  }},"Test connection");
  const unavailable = remote ? null : OpenEMS.unsupportedReason();
  const isolationBlocked = remote ? null : isolationUnavailableReason();
  const runBtn = h("button", { type: "button", class: "primary", disabled: sim.running || !c.config || !!unavailable, onclick: () => start(ctx, false) }, sim.running ? "Running…" : sweep ? "Run case" : remote?"Run remotely":"Run in browser");
  const validateBtn = h("button",{type:"button",hidden:remote,disabled:sim.running||!c.config||!!unavailable,onclick:()=>validateMesh(ctx),title:"Run openEMS operator setup only and download the actual discretized PEC edges (VTP)."},"Validate mesh / export PEC");
  const allBtn = sweep ? h("button", { type: "button", class: "primary", disabled: sim.running || pending || !!unavailable || !cases.some(x=>x.config), onclick: () => start(ctx, true) }, `Run all (${cases.length})`) : null;
  if (sweep) runBtn.classList.remove("primary");
  if (sim.running && allBtn) allBtn.hidden = true;
  const abortBtn = h("button", { type: "button", hidden: !sim.running, disabled: sim.aborting, onclick: stop, title: "Stop the current simulation and remaining sweep. Completed results are retained." }, sim.aborting ? "Stopping…" : "Stop");
  const bar = h("div", { class: "sim-bar" }, h("div", { class: "sim-bar-fill" }));
  const stats = h("div", { class: "sim-stats" });
  const warningBox = h("div", { class: "note warn", role: "alert", hidden: true });
  const caseList=h("div",{class:"sim-case-list"});
  const counts=h("div",{class:"sim-counts"});
  const countRefs={};
  for(const [key,label] of [["done","Completed"],["running","Running"],["queued","Queued"],["other","Other"]]){
    const value=h("strong",{text:"0"});
    counts.append(h("div",{class:"sim-count","data-status":key},value,h("span",{text:label})));
    countRefs[key]=value;
  }
  const caseRows=cases.map(c=>{
    const label=c.label||c.id;
    const state=h("span",{class:"sim-case-state"});
    const percent=h("span",{class:"sim-case-percent"});
    const fill=h("div",{class:"sim-case-fill"});
    const track=h("div",{class:"sim-case-track",role:"progressbar","aria-label":label,"aria-valuemin":0,"aria-valuemax":100},fill);
    const detail=h("div",{class:"sim-case-detail"});
    const row=h("div",{class:"sim-case-row","data-case-id":c.id},h("div",{class:"sim-case-top"},h("strong",{class:"sim-case-name",text:label,title:c.id}),state,percent),track,detail);
    caseList.append(row);
    return {id:c.id,key:c.config?JSON.stringify(c.config):null,row,state,percent,fill,track,detail};
  });
  ui = { bar, stats, runBtn, abortBtn, warningBox, caseRows, countRefs, counts, caseList, caseId:c.id };

  const caseLine = c.config
    ? sweep ? `${c.label} · ${cases.length} cases` : "Single case"
    : c.pending ? "Geometry scripts are still running…" : `Cannot simulate: ${c.error}`;
  box.append(h("div", { class: "form-section sim-run" },
    h("div",{class:"sim-run-head"},h("h3",{text:"Simulation runner"}),h("span",{class:"hint sim-case-hint",title:c.name||"",text:`${caseLine}${pending&&!c.pending?" · preparing cases":""}`})),
    h("div", { class: "sim-controls" }, h("div",{class:"sim-run-actions"},allBtn,runBtn,validateBtn,abortBtn),
      h("div",{class:"sim-run-options"},h("label",{},"Runner",runnerSelect),!remote?h("label", { class: "sim-engine" }, "Engine", engine):null,h("label",{class:"sim-threads"},"ncpu_pool",pool),h("label",{class:"sim-threads"},"ncpu_per_job",threads),parallel)),
    remote?h("div",{class:"sim-remote-settings"},h("label",{},"Runner URL",url),h("label",{},"Access token",token),h("div",{class:"sim-remote-actions"},test,connection),h("p",{class:"hint",text:"CPU threads per case: ncpu_per_job. RAM per case: solver.resources.memory_gib. The server enforces shared resource limits."})):null,
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
    h("div",{class:"sim-queue"},h("div",{class:"sim-queue-title"},"Case progress"),counts,bar,stats,caseList),warningBox,
    sim.cacheWarning ? h("p",{class:"hint",text:sim.cacheWarning}) : null));
  updateProgress();
}

function caseView(id,key) {
  const job=sim.active.get(id);
  const state=caseStates.get(id);
  if(!state||state.key!==key)return {status:"idle",progress:0,detail:"Not run"};
  const status=job?.remoteState==="queued"?"queued":state.status;
  const done=status==="done";
  const progress=done||status==="partial"?100:Math.round(100*Math.max(0,Math.min(.99,job?.progress?.fraction??state.progress??0)));
  const detail=job?.progress?.timestep!=null
    ? "Step "+job.progress.timestep+(job.progress.maxTimesteps?"/"+job.progress.maxTimesteps:"")+" · "+fmt(job.progress.speedMCellsPerSec,1)+" MC/s"
    : job?.stage??state.error??({queued:"Waiting for resources",done:"Result available",partial:"Partial result available",failed:"Simulation failed",stopped:"Stopped",cancelled:"Cancelled",idle:"Not run"})[status]??"Preparing";
  return {status,progress,detail,job};
}
function updateResultLog() {
  const ref=resultLogUI;
  if(!ref?.pre.isConnected)return;
  const job=sim.active.get(ref.id), state=caseStates.get(ref.id), run=runs.get(ref.id);
  const validation=validationLogs.get(ref.id);
  const lines=state?.key===ref.key?(job?.log??state.log??(run?.key===ref.key?run.log:null)):run?.key===ref.key?run.log:null;
  const log=lines??(validation?.key===ref.key?validation.log:null)??[];
  const content=log.length?log.join("\n"):(state?.key===ref.key&&state?.error?state.error:"No log captured for this case yet.");
  if(ref.pre.textContent!==content){
    const follow=ref.pre.scrollHeight-ref.pre.scrollTop-ref.pre.clientHeight<24;
    ref.pre.textContent=content;
    if(follow)ref.pre.scrollTop=ref.pre.scrollHeight;
  }
}
function resultLog(caseId,key) {
  const pre=h("pre",{class:"sim-log","aria-label":"openEMS log for "+caseId});
  const box=h("details",{class:"sim-log-box result-case-log",open:logExpanded.get(caseId)??false},
    h("summary",{text:"openEMS log · "+caseId}),pre);
  box.addEventListener("toggle",()=>logExpanded.set(caseId,box.open));
  resultLogUI={id:caseId,key,pre};
  return box;
}
function updateProgress() {
  updateResultLog();
  if (!ui) return;
  const counts={done:0,running:0,queued:0,other:0};
  let sum=0;
  for(const ref of ui.caseRows){
    const v=caseView(ref.id,ref.key);
    if(v.status==="done")counts.done++;else if(v.status==="running")counts.running++;else if(v.status==="queued")counts.queued++;else counts.other++;
    sum+=v.progress;
    ref.row.dataset.status=v.status;
    ref.state.textContent=({done:"Completed",running:"Running",queued:"Queued",partial:"Partial",failed:"Failed",stopped:"Stopped",cancelled:"Cancelled",idle:"Not run"})[v.status]??v.status;
    ref.percent.textContent=v.progress+"%";
    ref.fill.style.width=v.progress+"%";
    ref.track.setAttribute("aria-valuenow",String(v.progress));
    ref.detail.textContent=v.detail;
  }
  for(const k of Object.keys(counts))ui.countRefs[k].textContent=counts[k];
  const pct=sim.batch?Math.round(Math.min(1,fraction())*100):Math.round(sum/Math.max(1,ui.caseRows.length));
  ui.bar.firstChild.style.width=pct+"%";
  const el = sim.running ? Math.round((Date.now()-sim.startedAt)/1000):null;
  ui.stats.textContent=sim.batch?`${sim.batch.finished}/${sim.batch.total} finished · ${counts.running} running · ${counts.queued} queued · ${el} s`:sim.running?`${sim.stage} · ${el} s`:sim.summary||"";
  const selected=sim.active.get(ui.caseId);
  const message=sim.error||selected?.warning||sim.warning||"";
  ui.warningBox.hidden=!message;
  ui.warningBox.textContent=message;
}

// This uses the pinned solver's actual PEC operator dump, not a voxelization
// of the geometry preview. SetupFDTD deliberately returns 1 for --no-simulation.
async function validateMesh(ctx) {
  if(sim.running)return;
  const c=ctx.getCase();
  if(!c.config||OpenEMS.unsupportedReason())return;
  Object.assign(sim,{running:true,aborting:false,error:null,warning:null,summary:"",log:[],progress:null,model:null,
    stage:"validating mesh",startedAt:Date.now(),batch:null});
  validationLogs.set(c.id,{key:JSON.stringify(c.config),log:sim.log});
  ctx.refresh();
  const tick=setInterval(updateProgress,1000);
  try{
    const model=buildModel(structuredClone(c.config));sim.model=model;
    // Basic engine supports the original operator debug dump. Use the selected
    // number of threads within the device's concurrency and preloaded pool.
    const threads=Math.min(sim.threads,navigator.hardwareConcurrency||sim.threads);
    sim.ems=new OpenEMS({threads:workerPoolSize(model,"basic",threads)});
    await sim.ems.initialize();
    if(sim.aborting)throw Error("Stopped");
    await sim.ems.writeFile("model.xml",model.xml);
    const solver={};
    const run=await sim.ems.run("model.xml",{engine:"basic",args:["--numThreads="+threads,"--debug-PEC","--debug-boxes","--no-simulation"],
      onLog:line=>{sim.log.push(line);updateSolverDiagnostics(solver,line);}});
    if(sim.aborting)throw Error("Stopped");
    if(![0,1].includes(run.exitCode)||!solver.timestep_s||!await sim.ems.exists("PEC_dump.vtp"))
      throw Error("PEC debug export unavailable (exit "+run.exitCode+"). Inspect openEMS log.");
    const data=await sim.ems.readFile("PEC_dump.vtp");
    if(!data?.byteLength)throw Error("PEC debug dump is empty");
    const blob=new Blob([data],{type:"application/octet-stream"});
    const a=h("a",{href:URL.createObjectURL(blob),download:ctx.slug()+"__"+c.id+".PEC_dump.vtp"});
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    const ratio=solver.max_timesteps/solver.excitation_timesteps;
    sim.summary="Mesh validated · "+(solver.timestep_s*1e15).toFixed(2)+" fs · excitation "+(solver.excitation_timesteps??"—")+" steps · PEC exported";
    if(Number.isFinite(ratio)&&ratio<3)sim.warning="Maximum timesteps below 3× excitation length.";
    ctx.notify(sim.summary);
  }catch(e){
    if(!sim.aborting){sim.error="Mesh validation: "+e.message;ctx.notify(sim.error,true);}
    else sim.summary="Mesh validation stopped";
  }finally{
    clearInterval(tick);
    sim.ems?.terminate();
    Object.assign(sim,{running:false,aborting:false,ems:null,stage:"",progress:null});
    ctx.onBadge(simStatus());ctx.refresh();
  }
}
async function start(ctx, all = false) {
  if (sim.running) return;
  const cases = all ? ctx.getCases() : [ctx.getCase()];
  if (!cases.some(c=>c.config) || cases.some(c=>c.pending)) return;
  const remote=sim.runner==="remote";
  const why = remote ? null : OpenEMS.unsupportedReason();
  if(remote){try{remoteEndpoint(sim.remoteUrl);if(!sim.remoteToken)throw Error("Enter runner token");}catch(e){sim.error=e.message;ctx.refresh();return;}}
  if (why) { sim.error = isolationUnavailableReason() || why; ctx.refresh(); return; }
  // Capture immutable resolved configs; selecting another case or editing the document
  // during the sweep cannot change the queued simulation inputs.
  const queue = cases.map(c=>({...c, config:c.config ? structuredClone(c.config) : null}));
  const runCases = runs, states = caseStates;
  for (const c of queue) { states.set(c.id,{status:"queued",key: c.config ? JSON.stringify(c.config) : null}); }
  const cpu=cpuSettings(),engine=sim.engine;
  const endpoint=sim.remoteUrl,token=sim.remoteToken;
  Object.assign(sim,{running:true,aborting:false,error:null,warning:null,cacheWarning:null,summary:"",log:[],progress:null,model:null,active:new Map(),
    batch:{total:queue.length,finished:0},stage:"preparing",startedAt:Date.now()});
  let completed=0, failed=0, stopped=0, partial=0;
  const publish=()=>{ctx.onBadge(simStatus());ctx.refresh();};
  publish();
  const tick=setInterval(updateProgress,1000);
  const runCase=async c=>{
      const key=c.config ? JSON.stringify(c.config) : null;
      const job={id:c.id,progress:null,model:null,stage:"preparing",log:[],warning:null,ems:null,remote:null,stopTimer:null};
      sim.active.set(c.id,job);
      states.set(c.id,{status:"running",key});
      let partialRun=null;
      publish();
      try {
        if (!c.config) throw Error(c.error || "Case configuration unavailable");
        let result;
        if(remote){
          job.remote=new RemoteRunner(endpoint,token);
          const config=structuredClone(c.config);config.solver??={};config.solver.resources??={};config.solver.resources.cpus=cpu.perJob;
          job.stage="submitting remote job";updateProgress();
          result=await job.remote.run(config,{onStatus:status=>{
            job.remoteState=status.state;
            job.stage=status.state==="queued"?"Waiting for server CPU / RAM":status.state==="starting"?"Starting native solver":status.state==="done"?"Retrieving result":"Native solver · "+status.state;
            job.log=(status.log||"").split("\n").slice(-2000);
            const parser=new ProgressParser();parser.maxTimesteps=c.config.solver?.max_timesteps??20000;parser.endCriteria=c.config.solver?.end_criteria??0.0001;
            for(const line of job.log){const progress=parser.line(line);if(progress)job.progress=progress;}
            ctx.onBadge(simStatus());updateProgress();
          }});
          if(!hasValidS11(result))throw Error("Remote solver returned no valid S11");
        }else{
        const model=buildModel(c.config);
        job.model=model;
        job.stage="starting openEMS";
        job.ems=new OpenEMS({threads:workerPoolSize(model,engine,cpu.perJob)});
        await job.ems.initialize();
        if (sim.aborting) throw Error("Stopped");
        result=await runSimulation(job.ems,model,{
          config:c.config,engine,threads:cpu.perJob,
          onLog:line=>{job.log.push(line);if(job.log.length>2000)job.log.splice(0,500);},
          onWarning:w=>{job.warning=w.fatal?"Invalid feed — "+w.message:w.message;updateProgress();},
          onProgress:p=>{job.progress=p;ctx.onBadge(simStatus());updateProgress();},
          onStage:s=>{job.stage=s;updateProgress();},
          onPartial:r=>{
            const previous=partialRun;
            partialRun={...previous,result:r,key,frequency:previous?.frequency>=0?previous.frequency:r.patterns.findIndex(p=>p.record.radiation_valid)};
            runCases.set(c.id,partialRun);
            publish();
          }
        });
        }
        result.aborted=!!(result.aborted||sim.aborting);
        const firstValid=result.patterns.findIndex(p=>p.record.radiation_valid);
        const run={...partialRun,result,key,log:job.log.slice(-2000),frequency:partialRun?.frequency>=0?partialRun.frequency:firstValid};
        runCases.set(c.id,run);
        publish();
        job.stage="saving result";updateProgress();
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
        clearTimeout(job.stopTimer);
        job.ems?.terminate();
        job.ems=null;job.remote=null;
        const last=states.get(c.id);
        if(last)states.set(c.id,{...last,log:job.log.slice(-2000),progress:job.progress?.fraction??0});
        sim.active.delete(c.id);
        sim.batch.finished++;
        job.progress=null;
        // Publish each result immediately, without changing the user's selected case.
        publish();
      }
  };
  try {
    let limit=cpu.pool;
    if(remote){
      const info=await new RemoteRunner(endpoint,token).health();
      if(info.api_version!==1)throw Error("Incompatible runner API");
      if(cpu.perJob>Math.min(info.max_cpus,info.ncpu_pool??info.max_cpus))throw Error("ncpu_per_job exceeds remote CPU limit");
      limit=Math.min(limit,info.ncpu_pool??info.max_cpus);
      if(!info.parallel_jobs)limit=cpu.perJob; // older single-job server
    }
    const slots=Math.max(1,Math.floor(limit/cpu.perJob));
    let next=0;
    await Promise.all(Array.from({length:Math.min(slots,queue.length)},async()=>{
      while(!sim.aborting&&runs===runCases&&next<queue.length){const c=queue[next++];await runCase(c);}
    }));
  } catch(e){
    sim.error=e.message;
    for(const c of queue)if(states.get(c.id)?.status==="queued"){
      states.set(c.id,{...states.get(c.id),status:sim.aborting?"cancelled":"failed",error:e.message});
      if(!sim.aborting)failed++;
    }
    ctx.notify(sim.error,true);
  }
  finally {
    clearTimeout(sim.stopTimer);clearInterval(tick);
    for(const c of queue)if(states.get(c.id)?.status==="queued")states.set(c.id,{...states.get(c.id),status:"cancelled"});
    const cancelled=queue.length-completed-failed-stopped-partial;
    sim.summary=`${completed}/${queue.length} completed${partial?" · "+partial+" partial":""}${failed?" · "+failed+" failed":""}${stopped?" · "+stopped+" stopped":""}${cancelled?" · "+cancelled+" cancelled":""}`;
    Object.assign(sim,{ems:null,running:false,aborting:false,stage:"",batch:null,progress:null,active:new Map()});
    publish();
    ctx.notify(sim.summary,failed>0||partial>0);
  }
}
function stop() {
  if (!sim.running || sim.aborting) return;
  sim.aborting=true;
  if(ui?.abortBtn){ui.abortBtn.disabled=true;ui.abortBtn.textContent="Stopping…";}
  for(const job of sim.active.values()){
    if(job.remote){job.remote.abort().catch(e=>{job.warning="Remote cancellation not confirmed: "+e.message;updateProgress();});continue;}
    if(job.ems){const ems=job.ems;if(job.stage==="FDTD"){ems.abort();job.stopTimer=setTimeout(()=>ems.terminate(),1000);}else ems.terminate();}
  }
  const ems=sim.ems;
  if(!ems)return;
  if(sim.stage==="FDTD"){ems.abort();sim.stopTimer=setTimeout(()=>ems.terminate(),1000);}
  else ems.terminate();
}

export function renderResults(box, ctx, run, caseId, stale) {
  box.replaceChildren();
  const current=ctx.getCase();
  const key=current.config?JSON.stringify(current.config):null;
  const logBox=resultLog(caseId,key);
  if (!run || stale) {
    const status=caseRunState(caseId);
    box.append(h("p", { class: status?.status==="failed" ? "note warn" : "hint", text: stale && status?.status!=="failed" ? "This case has changed. Run it again to update its results." : status?.status==="failed" ? "Failed: "+status.error : status?.status==="running" ? "Simulation running…" : status?.status==="queued" ? "Queued for simulation…" : status?.status==="cancelled" || status?.status==="stopped" ? "Simulation stopped before results were available." : "Run this case in the Simulation tab to see its results." }));
    box.append(logBox);updateResultLog();
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
      kpi("Mesh / time", `${(r.mesh_total_cells / 1e6).toFixed(2)} M cells`, `${fmt(r.seconds, 0)} s · ${r.generator==="remote native openEMS"?"remote":"browser"}`)),
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
    ...r.patterns.map(p => patternCards(p)),logBox);
  updateResultLog();
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
  for(const [label,p,unit] of [["Source excitation",d.source,"relative"],["Port voltage",v,"V"],["Port current",i,"A"]]){
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
