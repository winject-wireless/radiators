// "Run in browser" section of the Simulation panel: builds the openEMS model for the current
// case, runs it in the openEMS wasm build (Web Worker), shows progress and the results.
import { OpenEMS } from "../../vendor/openems/openems.js";
import { buildModel } from "./model.js";
import { runSimulation, summarize, hasValidS11 } from "./run.js";
import { lineChart, polarChart, smithChart } from "./plot.js";
import { makeZip, openZip } from "./zip.js";
import { resolveCase } from "../params.js";
import { diagnosticFrame } from "./probe-playback.js";
import { updateSolverDiagnostics } from "./diagnostics.js";
import { registerServiceWorker, isolationUnavailableReason, storage } from "../platform.js";
import { RemoteRunner, remoteEndpoint } from "./remote.js";
import { ProgressParser } from "../../vendor/openems/openems-core.js";

const TOKEN_KEY="radiators.runner.session-token";
function readToken(url){
  try{const stored=JSON.parse(sessionStorage.getItem(TOKEN_KEY));return stored?.url===remoteEndpoint(url)?stored.token||"":"";}catch{return "";}
}
function writeToken(url,token){
  try{
    if(token.trim())sessionStorage.setItem(TOKEN_KEY,JSON.stringify({url:remoteEndpoint(url),token:token.trim()}));
    else sessionStorage.removeItem(TOKEN_KEY);
  }catch{/* storage unavailable or URL incomplete */}
}
let healthTimer,nextHealthPoll=0;
const sim = {
  engine: "cpu", threads: 0, active:new Map(), runner:storage.get("radiators.runner")==="remote"?"remote":"browser", remoteUrl:storage.get("radiators.runner.url")||"", remoteToken:readToken(storage.get("radiators.runner.url")||""), remoteHealth:null, remote:null, running: false, stage: "", progress: null, log: [], error: null,
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
  const diagnosticNodes=Math.max(0,...(model.diagnosticObjects??[]).filter(p=>p.type==="field_dump").map(p=>model.counts.reduce((n,c,k)=>n*(p.stop[k]===p.start[k]?1:Math.ceil((c+1)/p.sub[k])),1)));
  const dumpHelpers = Math.max(0, Math.min(threads, Math.floor(Math.max(a*b,diagnosticNodes) / 1024)) - 1);
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
const CACHE_DB = "radiators-csxcad-results", CACHE_STORE = "resolved-v1", PROJECT_STORE = "projects-v1";
const INDEX_STORE = "cache-index-v1", DB_VERSION = 3;
// Every stored result is keyed by this model version, so any change to the
// mesher, the model builder or the wasm solver invalidates results by itself,
// without hand-written per-change key prefixes. Bump it when browser results
// are no longer comparable with the previous build's.
const MODEL_VERSION = "m3";
// Keep the store bounded: patterns are megabytes each and the origin's quota
// is shared with drafts and projects. Least-recently-used entries go first.
const CACHE_MAX_ENTRIES = 120, CACHE_MAX_BYTES = 192 << 20;
let dbPromise;
function resultDB() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject)=>{
    if (!globalThis.indexedDB) { reject(Error("IndexedDB unavailable")); return; }
    const req=indexedDB.open(CACHE_DB,DB_VERSION);
    req.onupgradeneeded=e=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(CACHE_STORE))db.createObjectStore(CACHE_STORE);
      if(!db.objectStoreNames.contains(PROJECT_STORE))db.createObjectStore(PROJECT_STORE);
      if(!db.objectStoreNames.contains(INDEX_STORE))db.createObjectStore(INDEX_STORE);
      // Results written before version 3 use the old unversioned keys and can
      // never be read again; drop them instead of leaving them in the quota.
      if(e.oldVersion<3)req.transaction.objectStore(CACHE_STORE).clear();
    };
    req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{db.close();dbPromise=null;};resolve(db);};
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(Error("Result cache blocked by another tab"));
  }).catch(e=>{dbPromise=null;throw e;});
  return dbPromise;
}
// The openEMS wasm build identifies itself in BUILD-INFO.txt; a rebuilt solver
// must not return results recorded by the previous one.
let solverTagPromise;
function solverTag() {
  // Never memoize a failure: a single offline moment would otherwise key every
  // result of the session as "solver-unknown" and strand them. BUILD-INFO.txt
  // is in the service worker's precached shell, so this works offline too.
  if(!solverTagPromise)solverTagPromise=(async()=>{
    const r=await fetch(new URL("../../vendor/openems/BUILD-INFO.txt",import.meta.url),{cache:"no-cache"});
    if(!r.ok)throw Error("BUILD-INFO.txt HTTP "+r.status);
    const commits=(await r.text()).split("\n").map(l=>l.trim().split(/\s+/).pop()).filter(v=>/^[0-9a-f]{40}$/.test(v));
    if(!commits.length)throw Error("BUILD-INFO.txt has no build commits");
    return commits.join("").slice(0,16);
  })().catch(e=>{solverTagPromise=null;throw e;});
  return solverTagPromise;
}
async function digest(text) {
  const bytes=new TextEncoder().encode(text);
  if(globalThis.crypto?.subtle?.digest){
    const hash=await crypto.subtle.digest("SHA-256",bytes);
    return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
  }
  // Insecure contexts have no WebCrypto: a non-cryptographic 64-bit digest
  // with the length still separates distinct configs within one browser.
  let a=0x811c9dc5,b=0x01000193;
  for(const byte of bytes){a=(a^byte)*16777619>>>0;b=(b+byte+(b<<3))>>>0;}
  return a.toString(16).padStart(8,"0")+b.toString(16).padStart(8,"0")+"-"+bytes.length;
}
// A short, bounded key: the full resolved config lives in the value, so a
// polyhedron-heavy model no longer becomes a multi-megabyte primary key.
async function cacheStorageKey(key) {
  return MODEL_VERSION+":"+await solverTag()+":"+await digest(key);
}
async function touchIndex(db,id,patch) {
  await new Promise(resolve=>{
    const tx=db.transaction(INDEX_STORE,"readwrite"),store=tx.objectStore(INDEX_STORE);
    const req=store.get(id);
    // Always record the entry: one whose index write was lost would otherwise
    // be invisible to eviction and to the reported cache size forever.
    req.onsuccess=()=>store.put({bytes:0,...req.result,...patch,id},id);
    tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();
  });
}
function indexEntries(db) {
  return new Promise((resolve,reject)=>{
    const req=db.transaction(INDEX_STORE,"readonly").objectStore(INDEX_STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function evictOldest(db) {
  const entries=(await indexEntries(db)).sort((a,b)=>(b.usedAt||0)-(a.usedAt||0));
  let bytes=0,drop=[];
  for(const [i,entry] of entries.entries()){
    bytes+=entry.bytes||0;
    if(i>=CACHE_MAX_ENTRIES||(i>0&&bytes>CACHE_MAX_BYTES))drop.push(entry.id);
  }
  if(!drop.length)return 0;
  await new Promise(resolve=>{
    const tx=db.transaction([CACHE_STORE,INDEX_STORE],"readwrite");
    for(const id of drop){tx.objectStore(CACHE_STORE).delete(id);tx.objectStore(INDEX_STORE).delete(id);}
    tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();
  });
  return drop.length;
}
// Cached results and their index, for the "Clear cached results" action.
export async function resultCacheUsage() {
  const entries=await indexEntries(await resultDB());
  return {count:entries.length,bytes:entries.reduce((n,e)=>n+(e.bytes||0),0)};
}
export async function clearResultCache() {
  // start() holds a reference to `runs`; replacing it mid-sweep cancels the
  // run and orphans results that were already computed.
  if(sim.running)throw Error("A simulation is running. Stop it before clearing cached results.");
  const db=await resultDB();
  const {count,bytes}=await resultCacheUsage();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction([CACHE_STORE,INDEX_STORE],"readwrite");
    tx.objectStore(CACHE_STORE).clear();tx.objectStore(INDEX_STORE).clear();
    tx.oncomplete=()=>resolve();
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Clearing the result cache was aborted"));
  });
  runs=new Map();cacheAttempts=new Map();
  return {count,bytes};
}
async function cacheGet(key) {
  const db=await resultDB(),id=await cacheStorageKey(key);
  const entry=await new Promise((resolve,reject)=>{
    const req=db.transaction(CACHE_STORE,"readonly").objectStore(CACHE_STORE).get(id);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  if(entry)await touchIndex(db,id,{usedAt:Date.now()}); // least-recently-used order
  return entry;
}
async function cachePut(key, run, { overwrite=true }={}) {
  const db=await resultDB(),id=await cacheStorageKey(key);
  const value={result:run.result,frequency:run.frequency,log:run.log,remoteJobId:run.remoteJobId,config:JSON.parse(key),savedAt:Date.now()};
  const bytes=JSON.stringify(value).length;
  const written=await new Promise((resolve,reject)=>{
    const tx=db.transaction(CACHE_STORE,"readwrite");
    let done=false;
    tx.oncomplete=()=>resolve(done);
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Result cache write aborted"));
    const store=tx.objectStore(CACHE_STORE);
    const put=()=>{store.put(value,id);done=true;};
    if(overwrite)put();else{const request=store.getKey(id);request.onsuccess=()=>{if(request.result===undefined)put();};}
  });
  if(written){
    await touchIndex(db,id,{bytes,usedAt:Date.now()});
    await evictOldest(db);
  }
  return written;
}
// Each distinct template is a locally saved revision; saving the same template
// updates its timestamp and selected case, never deletes another revision.
export async function saveLocalProject(doc, caseIndex=0, label="") {
  const serialized=JSON.stringify(doc), key=label?JSON.stringify([label,serialized]):serialized, db=await resultDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(PROJECT_STORE,"readwrite");
    tx.oncomplete=()=>resolve();
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Project save aborted"));
    tx.objectStore(PROJECT_STORE).put({doc:JSON.parse(serialized),caseIndex,label,savedAt:Date.now()},key);
  });
}
export async function listLocalProjects() {
  const db=await resultDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(PROJECT_STORE,"readonly");
    const projects=[];
    const req=tx.objectStore(PROJECT_STORE).openCursor();
    req.onsuccess=()=>{
      const cursor=req.result;
      if(cursor){projects.push({...cursor.value,key:cursor.primaryKey});cursor.continue();}
    };
    tx.oncomplete=()=>resolve(projects.sort((a,b)=>b.savedAt-a.savedAt));
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Project list read aborted"));
  });
}
// Delete exactly one saved revision (including labeled imports). Results use a
// separate, shared resolved-input cache and must not be deleted with a snapshot.
export async function deleteLocalProject(key) {
  if(typeof key!=="string"||!key)throw Error("Invalid local project key");
  const db=await resultDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(PROJECT_STORE,"readwrite");
    tx.oncomplete=()=>resolve();
    tx.onerror=tx.onabort=()=>reject(tx.error||Error("Project deletion aborted"));
    tx.objectStore(PROJECT_STORE).delete(key);
  });
}
// Imported results are stored under their own exact resolved input, never
// attached to whichever unrelated project happens to be open.
function importedConfig(cfg){
  if(cfg?.schema_version!==2||!Array.isArray(cfg.geometry)||!Array.isArray(cfg.materials)||!Number.isFinite(cfg.excitation?.center_hz))
    throw Error("Result does not contain a supported schema v2 input configuration");
  const doc=structuredClone(cfg);doc.units??="mm";doc.ports??=[];
  return doc;
}
async function importOneResult(data,{overwrite=false}={}){
  const {editor_resolved_config,...result}=data??{};
  const doc=importedConfig(editor_resolved_config??result.input_config);
  if(!hasValidS11(result)||!Array.isArray(result.patterns)||!Array.isArray(result.s11.frequency_hz)||
      !["real","imag","phase_deg","vswr"].every(k=>Array.isArray(result.s11[k])&&result.s11[k].length===result.s11.frequency_hz.length))
    throw Error("Result has incomplete or invalid frequency response");
  importedConfig(result.input_config);
  const key=JSON.stringify(resolveCase(doc,{}));
  const run={result,frequency:result.patterns.findIndex(p=>p?.record?.radiation_valid),log:[]};
  const written=await cachePut(key,run,{overwrite});
  return {doc,written};
}
export async function importResultArchive(file,{overwrite=false}={}){
  const files=await openZip(file);
  const manifestFile=[...files.keys()].find(n=>n.split("/").pop()==="manifest.json");
  const manifest=manifestFile?await files.get(manifestFile)():null;
  const folder=manifestFile?.slice(0,manifestFile.lastIndexOf("/")+1)??"";
  const templateFile=folder+"project.json";
  const project=files.has(templateFile)?await files.get(templateFile)():null;
  const entries=Array.isArray(manifest?.cases)
    ?manifest.cases.filter(c=>c?.file).map(c=>({name:files.has(folder+c.file)?folder+c.file:c.file,label:c.label||c.id||c.file}))
    :[...files.keys()].filter(n=>n.endsWith(".result.json")).map(name=>({name,label:name.split("/").pop()}));
  if(!entries.length)throw Error("No simulation result JSON files found in ZIP");
  // A source template may contain parameter expressions in excitation and geometry.
  if(project&&(project.schema_version!==2||!Array.isArray(project.geometry)||!Array.isArray(project.materials)))
    throw Error("ZIP project.json is not a supported schema v2 template");
  let imported=0,kept=0,first=null;
  const errors=[];
  for(const entry of entries){
    try{
      const read=files.get(entry.name);if(!read)throw Error("Result file missing");
      const {doc,written}=await importOneResult(await read(),{overwrite});
      if(written)imported++;else kept++;
      if(!first)first=doc;
      // Legacy exports lack a source template. Save each resolved case as
      // its own project with an archive/case label for later review.
      if(!project)await saveLocalProject(doc,0,(manifest?.simulation||file.name||"Sweep")+" · "+entry.label);
    }catch(e){errors.push(entry.name+": "+e.message);}
  }
  if(!first)throw Error(errors[0]||"No valid results in ZIP");
  if(project)await saveLocalProject(project);
  return {doc:project??first,imported,kept,errors,grouped:!!project};
}
// Bundled results use the same exact resolved-input cache key and never replace local runs.
export async function seedExampleResult(data){
  return importOneResult(data,{overwrite:false});
}
export async function importResultFile(data, options={}){
  const {doc,written}=await importOneResult(data,options);
  await saveLocalProject(doc);
  return {doc,imported:written?1:0,kept:written?0:1,errors:[],grouped:false};
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
    target.set(id,{result:entry.result,key,frequency:entry.frequency,log:entry.log,remoteJobId:entry.remoteJobId,cached:true});
    states.set(id,{status:entry.result.postprocessing_incomplete?"partial":"done",key});changed=true;
  }
  if(changed)ctx.refresh();
}

const canStartCase = id => (sim.runner!=="remote" || (sim.remoteHealth?.free_cpu??0)>=cpuSettings().perJob) && (!sim.running || (!sim.aborting && !!sim.batch?.canAdd?.(id)));
const fraction = () => sim.batch ? (sim.batch.finished + [...sim.active.values()].reduce((n,j)=>n+(j.progress?.fraction??0),0)) / sim.batch.total : sim.progress?.fraction ?? 0;
const cpuSettings=()=>{
  const remote=sim.runner==="remote",cap=remote?(sim.remoteHealth?.ncpu??Number.MAX_SAFE_INTEGER):Math.min(navigator.hardwareConcurrency||4,64);
  const saved=storage.get("radiators.cpu."+sim.runner)||{};
  const pool=remote?cap:Math.max(1,Math.min(cap,Math.trunc(saved.pool)||hc()));
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
  clearTimeout(healthTimer);
  const remote=sim.runner==="remote",cpu=cpuSettings();
  sim.threads=cpu.perJob;
  const engine = h("select", { "aria-label": "openEMS engine", disabled: sim.running },
    h("option", { value: "cpu", text: "CPU (experimental)" }), h("option", { value: "basic", text: "Basic" }));
  engine.value = sim.engine;
  engine.addEventListener("change", () => { sim.engine = engine.value; });
  const pool=h("input",{type:"number",min:1,max:cpu.cap,value:cpu.pool,"aria-label":"CPU pool",disabled:sim.running});
  const threads=h("input",{type:"number",min:1,max:cpu.pool,value:cpu.perJob,"aria-label":"Threads",disabled:sim.running});
  const saveCPU=()=>{
    const current=cpuSettings();
    const n=remote?current.pool:Math.max(1,Math.min(cpu.cap,Math.trunc(Number(pool.value))||1));
    const t=Math.max(1,Math.min(n,Math.trunc(Number(threads.value))||1));
    storage.set("radiators.cpu."+sim.runner,remote?{perJob:t}:{pool:n,perJob:t});
    sim.threads=t;pool.value=n;threads.value=t;threads.max=n;
    showCapacity();
    updateProgress();
  };
  const parallel=h("span",{class:"hint"});
  function showCapacity(){
    const current=cpuSettings(),info=sim.remoteHealth;
    if(remote){
      threads.max=info?info.ncpu:Number.MAX_SAFE_INTEGER;
      if(document.activeElement!==threads)threads.value=current.perJob;
      parallel.textContent=info?"ncpu: "+info.ncpu+" · free CPU: "+info.free_cpu+" · "+Math.floor(info.free_cpu/current.perJob)+" job(s) available":"CPU capacity unavailable";
    }else parallel.textContent=Math.min(cases.length,Math.floor(current.pool/current.perJob))+" concurrent case(s) maximum";
  }
  showCapacity();
  pool.addEventListener("change",saveCPU);threads.addEventListener("change",saveCPU);
  const runnerSelect=h("select",{"aria-label":"Simulation runner",disabled:sim.running},h("option",{value:"browser",text:"Browser"}),h("option",{value:"remote",text:"Remote"}));
  runnerSelect.value=sim.runner;
  runnerSelect.addEventListener("change",()=>{sim.runner=runnerSelect.value;storage.set("radiators.runner",sim.runner);sim.error=null;ctx.refresh();});
  const url=h("input",{type:"url",value:sim.remoteUrl,placeholder:"https://runner.example.com","aria-label":"Remote runner URL",disabled:sim.running});
  const token=h("input",{type:"password",value:sim.remoteToken,placeholder:"Runner token",autocomplete:"off","aria-label":"Remote runner token",disabled:sim.running});
  const connection=h("span",{class:"hint",text:sim.remoteHealth?"Connected · Detached jobs":"Token retained across refreshes in this tab."});
  const save=()=>{
    const next=url.value.trim();
    if(next!==sim.remoteUrl){
      sim.remoteUrl=next;sim.remoteHealth=null;nextHealthPoll=0;
      connection.textContent="Enter runner token";
      token.value=readToken(next);sim.remoteToken=token.value;
      storage.set("radiators.runner.url",next);
      writeToken(next,sim.remoteToken);
    }else if(token.value!==sim.remoteToken){
      sim.remoteToken=token.value;sim.remoteHealth=null;nextHealthPoll=0;
      connection.textContent="Checking runner capacity…";
      writeToken(next,sim.remoteToken);
    }
    showCapacity();updateProgress();
  };
  url.addEventListener("input",()=>{save();clearTimeout(healthTimer);healthTimer=setTimeout(poll,500);});
  token.addEventListener("input",()=>{save();clearTimeout(healthTimer);healthTimer=setTimeout(poll,500);});
  const refreshHealth=async(recover=false)=>{
    const endpoint=sim.remoteUrl,credential=sim.remoteToken;
    if(!endpoint||!credential.trim()){connection.textContent="Enter runner URL and token";return;}
    try{
      const client=new RemoteRunner(endpoint,credential),info=await client.health();
      if(info.api_version!==1||!info.detached_jobs||!info.batch_submission||
        !Number.isInteger(info.ncpu)||info.ncpu<1||!Number.isInteger(info.free_cpu)||info.free_cpu<0||info.free_cpu>info.ncpu)
        throw Error("Update remote runner for CPU capacity reporting");
      if(endpoint!==sim.remoteUrl||credential!==sim.remoteToken||!connection.isConnected)return;
      sim.remoteHealth=info;connection.textContent="Connected · Detached jobs";
      if(recover)await recoverRemote(ctx,client);
    }catch(e){
      if(endpoint!==sim.remoteUrl||credential!==sim.remoteToken||!connection.isConnected)return;
      sim.remoteHealth=null;connection.textContent=e.message;
    }finally{if(connection.isConnected){showCapacity();updateProgress();}}
  };
  const poll=async()=>{
    if(!connection.isConnected||sim.runner!=="remote")return;
    nextHealthPoll=Date.now()+3000;
    await refreshHealth();
    if(connection.isConnected)healthTimer=setTimeout(poll,Math.max(0,nextHealthPoll-Date.now()));
  };
  const test=h("button",{type:"button",disabled:sim.running,onclick:async()=>{
    save();test.disabled=true;
    try{await refreshHealth(true);}finally{test.disabled=false;}
  }},"Test connection");
  const serverJobs=h("div",{class:"sim-case-list"});
  const manage=h("details",{class:"result-case-log"},h("summary",{text:"Server jobs / recovery"}),serverJobs);
  const refreshJobs=async()=>{
    serverJobs.replaceChildren(h("p",{class:"hint",text:"Loading server jobs…"}));
    try{
      save();
      const client=new RemoteRunner(sim.remoteUrl,sim.remoteToken);
      const data=await client.jobs();
      serverJobs.replaceChildren();
      if(!data.jobs.length)serverJobs.append(h("p",{class:"hint",text:"No retained server jobs."}));
      for(const job of data.jobs){
        const terminal=["done","failed","cancelled"].includes(job.state);
        const cancel=h("button",{type:"button",class:"small danger",disabled:!terminal&&job.cancel_requested,onclick:async()=>{
          if(terminal&&!confirm("Delete this server job and its stored results?"))return;
          cancel.disabled=true;
          try{if(terminal)await client.purgeJob(job.id);else await client.cancelJob(job.id);await refreshJobs();}
          catch(e){cancel.disabled=false;ctx.notify(e.message,true);}
        }},terminal?"Delete":job.cancel_requested?"Cancelling…":"Cancel");
        const download=job.state==="done"?h("button",{type:"button",class:"small",onclick:async()=>{
          try{
            const result=await client.request("/v1/jobs/"+job.id+"/result","GET",undefined,{timeout:600000});
            const url=URL.createObjectURL(new Blob([JSON.stringify(result)],{type:"application/json"}));
            const a=h("a",{href:url,download:job.id+".result.json"});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);
          }catch(e){ctx.notify(e.message,true);}
        }},"Download raw result"):null;
        serverJobs.append(h("div",{class:"sim-case-row"},
          h("div",{class:"sim-case-top"},h("strong",{class:"sim-case-name",text:job.name||job.id.slice(0,8)}),h("span",{text:job.state}),download,cancel),
          h("div",{class:"hint",text:job.id.slice(0,8)+" · "+job.cpus+" CPUs · last poll "+job.last_contact_seconds+" s ago"})));
      }
    }catch(e){serverJobs.replaceChildren(h("p",{class:"note warn",text:e.message+" — update runner if job listing is unsupported."}));}
  };
  manage.append(h("button",{type:"button",class:"small",onclick:refreshJobs},"Refresh jobs"),
    h("button",{type:"button",class:"small",onclick:async()=>{try{save();await recoverRemote(ctx,new RemoteRunner(sim.remoteUrl,sim.remoteToken));}catch(e){ctx.notify(e.message,true);}}},"Recover matching jobs"));
  manage.addEventListener("toggle",()=>{if(manage.open)void refreshJobs();});
  const unavailable = remote ? null : OpenEMS.unsupportedReason();
  const isolationBlocked = remote ? null : isolationUnavailableReason();
  const runBtn = h("button", { type: "button", class: "primary", disabled: !canStartCase(c.id) || !c.config || !!unavailable, onclick: () => start(ctx, false, c.id) }, sweep ? "Run case" : remote?"Run remotely":"Run in browser");
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
    const startBtn=h("button",{type:"button",class:"sim-case-start small","aria-label":"Start "+c.id,disabled:!c.config||!!unavailable,onclick:()=>start(ctx,false,c.id)},"Start");
    const row=h("div",{class:"sim-case-row","data-case-id":c.id},h("div",{class:"sim-case-top"},h("strong",{class:"sim-case-name",text:label,title:c.id}),state,percent,startBtn),track,detail);
    caseList.append(row);
    return {id:c.id,key:c.config?JSON.stringify(c.config):null,row,state,percent,fill,track,detail,startBtn,available:!!c.config&&!unavailable};
  });
  ui = { bar, stats, runBtn, abortBtn, warningBox, caseRows, countRefs, counts, caseList, allBtn, allAvailable:!pending&&!unavailable&&cases.some(x=>x.config), caseId:c.id };

  const caseLine = c.config
    ? sweep ? `${c.label} · ${cases.length} cases` : "Single case"
    : c.pending ? "Geometry scripts are still running…" : `Cannot simulate: ${c.error}`;
  box.append(h("div", { class: "form-section sim-run" },
    h("div",{class:"sim-run-head"},h("h3",{text:"Simulation runner"}),h("span",{class:"hint sim-case-hint",title:c.name||"",text:`${caseLine}${pending&&!c.pending?" · preparing cases":""}`})),
    h("div", { class: "sim-controls" }, h("div",{class:"sim-run-actions"},allBtn,runBtn,validateBtn,abortBtn),
      h("div",{class:"sim-run-options"},h("label",{},"Runner",runnerSelect),!remote?h("label", { class: "sim-engine" }, "Engine", engine):null,!remote?h("label",{class:"sim-threads"},"ncpu_pool",pool):null,h("label",{class:"sim-threads"},"ncpu_per_job",threads),parallel)),
    remote?h("div",{class:"sim-remote-settings"},h("label",{},"Runner URL",url),h("label",{},"Access token",token),h("div",{class:"sim-remote-actions"},test,connection),h("p",{class:"hint",text:"Remote jobs continue when this page closes. Token survives refresh in this tab; test the connection to recover matching jobs. No per-job RAM cap."})):null,
    remote?manage:null,
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
  if(remote)healthTimer=setTimeout(poll,Math.max(0,nextHealthPoll-Date.now()));
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
  ref.copy.disabled=!log.length&&!(state?.key===ref.key&&state?.error);
  if(ref.pre.textContent!==content){
    const follow=ref.pre.scrollHeight-ref.pre.scrollTop-ref.pre.clientHeight<24;
    ref.pre.textContent=content;
    if(follow)ref.pre.scrollTop=ref.pre.scrollHeight;
  }
}
function resultLog(caseId,key) {
  const pre=h("pre",{class:"sim-log","aria-label":"openEMS log for "+caseId});
  const copy=h("button",{type:"button",class:"icon log-copy","aria-label":"Copy openEMS log",title:"Copy openEMS log",disabled:true});
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");
  const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d","M8 8h12v12H8zM5 16H4V4h12v1");path.setAttribute("fill","none");path.setAttribute("stroke","currentColor");path.setAttribute("stroke-width","1.8");path.setAttribute("stroke-linejoin","round");svg.append(path);copy.append(svg);
  const feedback=h("span",{class:"log-copy-status",role:"status"});
  copy.addEventListener("click",async e=>{
    e.preventDefault();e.stopPropagation();
    const value=pre.textContent;
    try{
      if(navigator.clipboard?.writeText){
        try{await navigator.clipboard.writeText(value);}catch{legacyCopy(value);}
      }else legacyCopy(value);
      feedback.textContent="Copied";
    }catch{feedback.textContent="Copy failed";}
  });
  function legacyCopy(value){
    const field=h("textarea",{"aria-hidden":"true"});field.value=value;
    field.style.cssText="position:fixed;left:-9999px;top:0";document.body.append(field);
    try{field.select();if(!document.execCommand("copy"))throw Error("Clipboard unavailable");}
    finally{field.remove();copy.focus({preventScroll:true});}
  }
  const box=h("details",{class:"sim-log-box result-case-log",open:logExpanded.get(caseId)??false},
    h("summary",{},h("span",{text:"openEMS log · "+caseId}),h("span",{class:"log-copy-actions"},feedback,copy)),pre);
  box.addEventListener("toggle",()=>logExpanded.set(caseId,box.open));
  resultLogUI={id:caseId,key,pre,copy};
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
    ref.startBtn.disabled=!ref.available||!canStartCase(ref.id);
    ref.startBtn.textContent=v.status==="done"||v.status==="partial"?"Rerun":"Start";
    ref.startBtn.title=ref.startBtn.disabled?"Case unavailable, already submitted, or CPU pool full":"Start this case if CPU capacity is available";
  }
  for(const k of Object.keys(counts))ui.countRefs[k].textContent=counts[k];
  const selectedRow=ui.caseRows.find(r=>r.id===ui.caseId);
  ui.runBtn.disabled=!selectedRow?.available||!canStartCase(ui.caseId);
  if(ui.allBtn)ui.allBtn.disabled=sim.running||!ui.allAvailable||(sim.runner==="remote"&&!sim.remoteHealth);
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
// The server is the authoritative job registry. A digest of the unmodified
// resolved input plus the case ID permits reattachment after reload without
// relying on browser storage for job IDs.
let recovering=false;
async function recoverRemote(ctx,client){
  if(sim.running||recovering||sim.runner!=="remote")return;
  recovering=true;
  try{
    const {jobs}=await client.jobs();
    const matches=[];
    for(const c of ctx.getCases()){
      if(!c.config||c.pending)continue;
      const key=JSON.stringify(c.config),hash=await digest(key);
      const job=jobs.filter(j=>j.case_id===c.id&&j.case_key===hash)
        .sort((a,b)=>b.created_at-a.created_at)[0];
      if(!job)continue;
      if(job.state==="done"){
        const cached=await cacheGet(key).catch(()=>null);
        if(cached?.remoteJobId===job.id)continue;
      }
      matches.push({...c,remoteId:job.id});
    }
    if(matches.length&&!sim.running&&sim.runner==="remote"&&remoteEndpoint(sim.remoteUrl)===client.url&&sim.remoteToken.trim()===client.token){
      const current=new Map(ctx.getCases().filter(c=>c.config).map(c=>[c.id,JSON.stringify(c.config)]));
      const valid=matches.filter(c=>current.get(c.id)===JSON.stringify(c.config));
      if(valid.length)void start(ctx,false,valid[0].id,valid);
    }
  }finally{recovering=false;}
}
async function start(ctx, all = false, id = ctx.getCase().id, recovery=null) {
  const chosen=ctx.getCases().find(c=>c.id===id);
  if(sim.running){
    if(!all&&chosen?.config&&!chosen.pending&&sim.batch?.canAdd?.(id))sim.batch.add(chosen);
    return;
  }
  const cases = recovery??(all ? ctx.getCases() : chosen?[chosen]:[]);
  if (!cases.some(c=>c.config) || cases.some(c=>c.pending)) return;
  const remote=sim.runner==="remote";
  const why = remote ? null : OpenEMS.unsupportedReason();
  if(remote){try{remoteEndpoint(sim.remoteUrl);if(!sim.remoteToken)throw Error("Enter runner token");}catch(e){sim.error=e.message;ctx.refresh();return;}}
  if (why) { sim.error = isolationUnavailableReason() || why; ctx.refresh(); return; }
  // Capture immutable resolved configs; selecting another case or editing the document
  // during the sweep cannot change the queued simulation inputs.
  ctx.archiveProject?.();
  const snapshot=(c,immediate)=>({...c,immediate,config:c.config?structuredClone(c.config):null});
  const queue = cases.map(c=>snapshot(c,!all&&!recovery));
  const runCases = runs, states = caseStates;
  const previous=new Map();
  const markQueued=c=>{previous.set(c.id,states.get(c.id));states.set(c.id,{status:"queued",key:c.config?JSON.stringify(c.config):null});};
  for(const c of queue)markQueued(c);
  const cpu=cpuSettings(),engine=sim.engine;
  const endpoint=sim.remoteUrl,token=sim.remoteToken;
  Object.assign(sim,{running:true,aborting:false,error:null,warning:null,cacheWarning:null,summary:"",log:[],progress:null,model:null,active:new Map(),
    batch:{total:queue.length,finished:0,remoteIds:new Set()},stage:"preparing",startedAt:Date.now()});
  let completed=0, failed=0, stopped=0, partial=0, notStarted=0;
  const publish=()=>{ctx.onBadge(simStatus());ctx.refresh();};
  publish();
  const tick=setInterval(updateProgress,1000);
  const runCase=async c=>{
      const key=c.config ? JSON.stringify(c.config) : null;
      const job={id:c.id,progress:null,model:null,stage:"preparing",log:[],warning:null,ems:null,remote:null,stopTimer:null};
      sim.active.set(c.id,job);
      states.set(c.id,{status:"running",key});
      let partialRun=null;
      let retained=runCases.get(c.id);
      if(retained?.key!==key)retained=null;
      publish();
      try {
        if (!c.config) throw Error(c.error || "Case configuration unavailable");
        if(!retained){
          try{const cached=await cacheGet(key);if(cached?.result&&hasValidS11(cached.result))retained={...cached,key,cached:true};}catch{}
          if(retained)runCases.set(c.id,retained);
        }
        if(sim.aborting)throw Error("Stopped");
        let result;
        if(remote){
          job.remote=new RemoteRunner(endpoint,token);
          job.stage="connecting to remote job";updateProgress();
          result=await job.remote.attach(c.remoteId,{onStatus:status=>{
            // "unreachable" is a client-side network report, not a job state:
            // keep the last solver log and progress, and say what is happening.
            if(status.state==="unreachable"){
              job.warning=status.message;job.stage="Connection lost — retrying";
              ctx.onBadge(simStatus());updateProgress();return;
            }
            if(/^(Connection lost|Result download failed)/.test(job.warning||""))job.warning=null;
            job.remoteState=status.state;
            job.stage=status.state==="queued"?"Waiting for server resources":status.state==="starting"?"Starting native solver":status.state==="done"?"Retrieving result":"Native solver · "+status.state;
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
            if(!retained)runCases.set(c.id,partialRun);
            publish();
          }
        });
        }
        if(remote&&c.config.probes?.some(p=>p.enabled!==false)&&!Array.isArray(result.diagnostic_probes))throw Error("Runner did not return diagnostic data; update the native runner checkout");
        result.aborted=!!(result.aborted||(!remote&&sim.aborting));
        const firstValid=result.patterns.findIndex(p=>p.record.radiation_valid);
        const run={...partialRun,result,key,remoteJobId:c.remoteId,log:job.log.slice(-2000),frequency:partialRun?.frequency>=0?partialRun.frequency:firstValid};
        const keepPrevious=!!retained&&(result.aborted||result.postprocessing_incomplete);
        if(!keepPrevious){runCases.set(c.id,run);publish();}
        job.stage="saving result";updateProgress();
        // Commit the cache before publishing completion, so an immediate reload
        // after the completion badge cannot race the persistent write.
        if(!keepPrevious&&!result.aborted)try{await cachePut(key,run);}catch(e){sim.cacheWarning="Result cache unavailable: "+e.message;}
        runCases.set(c.id,keepPrevious?retained:run);
        states.set(c.id,{status:result.aborted?"stopped":result.postprocessing_incomplete?"partial":"done",key});
        if(result.aborted)stopped++;else if(result.postprocessing_incomplete)partial++;else completed++;
        const s=summarize(result,c.config.excitation.center_hz);
        ctx.notify(`${c.id}: ${result.aborted?"Stopped":result.postprocessing_incomplete?"Partial result":"Done"} · S11 ${fmt(s.bestDb,1)} dB at ${ghz(s.bestHz)}`);
      } catch(e) {
        if(c.immediate&&/CPU capacity unavailable/.test(e.message)){
          const old=previous.get(c.id);if(old)states.set(c.id,old);else states.delete(c.id);
          job.notStarted=true;notStarted++;sim.error=e.message;ctx.notify(sim.error,true);
        } else if(e.jobState==="cancelled"){
          if(retained)runCases.set(c.id,retained);
          states.set(c.id,{status:sim.aborting?"stopped":"cancelled",key,error:e.message});
          if(sim.aborting)stopped++;
        } else if(retained){
          runCases.set(c.id,retained);
          states.set(c.id,{status:sim.aborting?"stopped":"failed",key,error:e.message});
          if(sim.aborting)stopped++;else {failed++;sim.error=c.id+": "+e.message;ctx.notify(sim.error,true);}
        } else if(partialRun){
          const result={...partialRun.result,postprocessing_pending:false,postprocessing_incomplete:true,aborted:sim.aborting,solver_warnings:[...(partialRun.result.solver_warnings??[]),"Post-processing interrupted: "+e.message]};
          runCases.set(c.id,{...partialRun,result});
          states.set(c.id,{status:sim.aborting?"stopped":"partial",key,error:e.message});
          if(sim.aborting)stopped++;else {partial++;sim.error=c.id+": "+e.message;ctx.notify(sim.error,true);}
        } else if(sim.aborting){states.set(c.id,{status:"stopped",key});stopped++;}
        else {states.set(c.id,{status:"failed",key,error:e.message});sim.error=c.id+": "+e.message;failed++;ctx.notify(sim.error,true);}
      } finally {
        clearTimeout(job.stopTimer);
        job.ems?.terminate();
        job.ems=null;job.remote=null;
        const last=states.get(c.id);
        if(last&&!job.notStarted)states.set(c.id,{...last,log:job.log.slice(-2000),progress:job.progress?.fraction??0});
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
      const client=new RemoteRunner(endpoint,token);
      const info=await client.health();
      if(info.api_version!==1||!info.detached_jobs||!info.batch_submission||!Number.isInteger(info.ncpu)||!Number.isInteger(info.free_cpu))throw Error("Update remote runner for CPU capacity reporting");
      limit=info.ncpu;
      sim.remoteHealth=info;
      if(!recovery&&cpu.perJob>limit)throw Error("ncpu_per_job exceeds remote CPU limit");
      const batchId=crypto.randomUUID().replaceAll("-","");
      const submit=async cases=>{
        const payloads=await Promise.all(cases.map(async c=>{
          c.remoteId=crypto.randomUUID().replaceAll("-","");
          const config=structuredClone(c.config);config.solver??={};config.solver.resources??={};config.solver.resources.cpus=cpu.perJob;
          return {id:c.remoteId,config,case_id:c.id,case_key:await digest(JSON.stringify(c.config)),require_capacity:c.immediate};
        }));
        if(sim.aborting)throw Error("Stopped");
        for(const c of cases)sim.batch.remoteIds.add(c.remoteId);
        await client.submitBatch(batchId,null,payloads);
        if(sim.aborting){await Promise.allSettled(cases.map(c=>client.cancelJob(c.remoteId)));throw Error("Stopped");}
      };
      const tasks=new Set();
      const track=task=>{tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));};
      if(recovery){for(const c of queue)sim.batch.remoteIds.add(c.remoteId);}
      else await submit(queue);
      if(sim.aborting){await Promise.allSettled(queue.map(c=>client.cancelJob(c.remoteId)));throw Error("Stopped");}
      for(const c of queue)track(runCase(c));
      const submitting=new Set();
      sim.batch.canAdd=id=>!recovery&&!sim.aborting&&runs===runCases&&(sim.remoteHealth?.free_cpu??0)>=cpu.perJob&&!sim.active.has(id)&&!submitting.has(id);
      sim.batch.add=c=>{
        if(!sim.batch.canAdd(c.id))return;
        ctx.archiveProject?.();
        const copy=snapshot(c,true);queue.push(copy);markQueued(copy);sim.batch.total++;submitting.add(copy.id);
        track((async()=>{
          try{await submit([copy]);await runCase(copy);}
          catch(e){
            const old=previous.get(copy.id);if(old)states.set(copy.id,old);else states.delete(copy.id);
            notStarted++;sim.error=e.message;ctx.notify(e.message,true);publish();
          }finally{submitting.delete(copy.id);}
        })());publish();
      };
      publish();
      while(tasks.size){await Promise.race(tasks);updateProgress();}
    }else{
      const slots=Math.max(1,Math.floor(limit/cpu.perJob));
      let next=0;
      const tasks=new Set();
      const pump=()=>{
        while(!sim.aborting&&runs===runCases&&tasks.size<slots&&next<queue.length){
          const c=queue[next++],task=runCase(c);
          tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));
        }
      };
      sim.batch.canAdd=id=>!sim.aborting&&runs===runCases&&next===queue.length&&tasks.size<slots&&!sim.active.has(id);
      sim.batch.add=c=>{
        if(!sim.batch.canAdd(c.id))return;
        ctx.archiveProject?.();
        const copy=snapshot(c,true);queue.push(copy);markQueued(copy);
        sim.batch.total++;pump();publish();
      };
      pump();publish();
      while(tasks.size){await Promise.race(tasks);pump();updateProgress();}
    }
    sim.batch.canAdd=()=>false;
  } catch(e){
    sim.error=e.message;
    for(const c of queue)if(states.get(c.id)?.status==="queued"){
      if(c.immediate&&/Update remote runner|CPU capacity unavailable/.test(e.message)){
        const old=previous.get(c.id);if(old)states.set(c.id,old);else states.delete(c.id);notStarted++;
      }else{
        states.set(c.id,{...states.get(c.id),status:sim.aborting?"cancelled":"failed",error:e.message});
        if(!sim.aborting)failed++;
      }
    }
    ctx.notify(sim.error,true);
  }
  finally {
    clearTimeout(sim.stopTimer);clearInterval(tick);
    for(const c of queue)if(states.get(c.id)?.status==="queued")states.set(c.id,{...states.get(c.id),status:"cancelled"});
    const cancelled=queue.length-completed-failed-stopped-partial-notStarted;
    sim.summary=`${completed}/${queue.length} completed${partial?" · "+partial+" partial":""}${failed?" · "+failed+" failed":""}${stopped?" · "+stopped+" stopped":""}${cancelled?" · "+cancelled+" cancelled":""}${notStarted?" · "+notStarted+" not started":""}`;
    Object.assign(sim,{ems:null,running:false,aborting:false,stage:"",batch:null,progress:null,active:new Map()});
    publish();
    ctx.notify(sim.summary,failed>0||partial>0);
  }
}
function stop() {
  if (!sim.running || sim.aborting) return;
  sim.aborting=true;
  if(ui?.abortBtn){ui.abortBtn.disabled=true;ui.abortBtn.textContent="Stopping…";}
  if(sim.runner==="remote"&&sim.batch?.remoteIds?.size){
    const client=new RemoteRunner(sim.remoteUrl,sim.remoteToken);
    for(const id of sim.batch.remoteIds)client.cancelJob(id).catch(()=>{});
  }
  for(const job of sim.active.values()){
    if(job.remote){job.remote.abort().catch(e=>{job.warning="Remote cancellation not confirmed: "+e.message;updateProgress();});continue;}
    if(job.ems){const ems=job.ems;if(job.stage==="FDTD"){ems.abort();job.stopTimer=setTimeout(()=>ems.terminate(),1000);}else ems.terminate();}
  }
  const ems=sim.ems;
  if(!ems)return;
  if(sim.stage==="FDTD"){ems.abort();sim.stopTimer=setTimeout(()=>ems.terminate(),1000);}
  else ems.terminate();
}


// The current sweep may have more results than the selected case. Snapshot only
// exact resolved-config matches; never export results from a prior edit.
function sweepSnapshot(ctx){
  return ctx.getCases().map(c=>{
    const key=c.config?JSON.stringify(c.config):null;
    const run=key&&runs.get(c.id)?.key===key?runs.get(c.id):null;
    const state=caseStates.get(c.id);
    const status=state?.key===key?state.status:"not-run";
    const available=!!run?.result&&!run.result.postprocessing_pending&&
      !["queued","running"].includes(status);
    return {id:c.id,label:c.label||c.id,status,run:available?run:null};
  });
}
let exportingSweep=false;
export function syncSweepDownload(box,ctx){
  let bar=box.querySelector("#sweepDownloadBar");
  if(!bar){
    bar=h("div",{id:"sweepDownloadBar",class:"result-summary-head"});
    bar.append(h("span",{class:"hint"}),h("button",{type:"button",class:"small result-download"}));
    bar.lastChild.addEventListener("click",async()=>{
      if(exportingSweep)return;
      const snapshot=sweepSnapshot(ctx),slug=ctx.slug(),project=ctx.getTemplate?.();
      const available=snapshot.filter(c=>c.run);
      if(!available.length)return;
      exportingSweep=true;syncSweepDownload(box,ctx);
      try{
        const manifest={schema_version:1,simulation:slug,exported_at_utc:new Date().toISOString(),
          total_cases:snapshot.length,exported_cases:available.length,
          cases:snapshot.map(c=>({id:c.id,label:c.label,status:c.status,
            file:c.run?slug+"__"+c.id+".result.json":null}))};
        // Serialize lazily per entry to avoid keeping all JSON strings in memory.
        function* entries(){
          yield {name:"manifest.json",text:JSON.stringify(manifest,null,1)};
          if(project)yield {name:"project.json",text:JSON.stringify(project)};
          for(const c of available)yield {name:slug+"__"+c.id+".result.json",text:JSON.stringify({...c.run.result,editor_resolved_config:JSON.parse(c.run.key)})};
        }
        const blob=await makeZip(entries(),available.length+1+(project?1:0));
        const url=URL.createObjectURL(blob);
        const a=h("a",{href:url,download:slug+"__sweep.zip"});
        document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        ctx.notify("Exported "+available.length+"/"+snapshot.length+" sweep results");
      }catch(e){ctx.notify("Sweep export failed: "+e.message,true);}
      finally{exportingSweep=false;syncSweepDownload(box,ctx);}
    });
    box.prepend(bar);
  }
  const cases=sweepSnapshot(ctx),count=cases.filter(c=>c.run).length;
  bar.hidden=cases.length<2;
  bar.style.display=bar.hidden?"none":"";
  bar.firstChild.textContent=count+"/"+cases.length+" results available";
  bar.lastChild.disabled=exportingSweep||!count;
  bar.lastChild.textContent=exportingSweep?"Preparing ZIP…":"Download sweep ZIP";
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
  const latest=caseRunState(caseId);
  const diagnostic = r.diagnostics?.solver ?? {};
  const earlyExcitation = (Number.isFinite(diagnostic.executed_timesteps) &&
    diagnostic.excitation_timesteps > diagnostic.executed_timesteps) ||
    (r.solver_warnings ?? []).some(message => /before excitation finished/i.test(message));
  const oldCriteria = Number(r.input_config?.solver?.end_criteria ?? 0.0001);
  const tighterCriteria = Number.isFinite(oldCriteria) && oldCriteria > 0
    ? Math.min(1e-6, oldCriteria / 10) : 1e-6;
  const tighterDb = 10 * Math.log10(tighterCriteria);
  const recommendation = diagnostic.termination === "aborted" || r.aborted
    ? "Recommendation: rerun without stopping the solver and allow the excitation and energy decay to complete."
    : diagnostic.termination === "max_timesteps" || (diagnostic.max_timesteps > 0 && diagnostic.max_timesteps < diagnostic.excitation_timesteps)
      ? "Recommendation: increase Max timesteps in Simulation → Solver settings; allow enough time for the full excitation and subsequent energy decay, then rerun."
      : "Recommendation: in Simulation → Solver settings, reduce End criteria to " + tighterCriteria.toExponential(1) + " (" + fmt(tighterDb, 1) + " dB), then rerun. Keep the mesh and excitation unchanged initially. Increase Max timesteps only if the new run reaches its timestep limit. Confirm excitation completion, convergence and radiation results before trusting S11.";
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
    latest?.status==="failed"||latest?.status==="stopped"?h("div",{class:"note warn",text:"Latest run "+latest.status+". Showing retained results when available."}):null,
    ["queued","running"].includes(latest?.status)&&!r.postprocessing_pending?h("div",{class:"note",text:"New run in progress. Showing previous results until a replacement is ready."}):null,
    r.postprocessing_pending ? h("div",{class:"note",text:"Port results available. Radiation post-processing is still running."}) : null,
    r.postprocessing_incomplete ? h("div",{class:"note warn",text:"Partial result: S11 and impedance are available, but some radiation results are unavailable."}) : null,
    r.aborted ? h("div", { class: "note warn", text: "Stopped early: the results use the time steps computed so far." }) : null,
    ...(r.solver_warnings ?? []).map(message=>h("div",{class:"note warn",text:message})),
    earlyExcitation ? h("div",{class:"note warn",text:recommendation}) : null,
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
    r.diagnostic_probes?.length ? playbackPanel(r.diagnostic_probes, ctx) : null,
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
  // Directivity still stands when the efficiency is non-physical; say so next
  // to the cuts instead of quietly showing an inflated realized gain.
  const efficiencyNote = rec.efficiency_valid === false
    ? h("div", { class: "note warn", text: `${ghz(p.frequency_hz)}: ${rec.radiation_warning}` }) : null;
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
    efficiencyNote,
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

function playbackPanel(records,ctx){
  const root=h("details",{class:"sim-pattern",open:true},h("summary",{text:"Diagnostic probes and fields"}));
  const valid=records.filter(r=>r.time_s?.length||r.frequency_hz?.length||r.td||r.fd);
  for(const r of records)if(r.warning)root.append(h("p",{class:"note warn",text:r.name+": "+r.warning}));
  if(!valid.length)return root;
  const times=valid.flatMap(r=>[r.time_s,r.td?.time_s].filter(a=>a?.length));
  const frequencies=[...new Set(valid.flatMap(r=>[...(r.frequency_hz??[]),...(r.fd?.frequency_hz??[])]))].sort((a,b)=>a-b);
  const lo=times.length?Math.min(...times.map(a=>a[0])):0,hi=times.length?Math.max(...times.map(a=>a.at(-1))):0;
  let mode=times.length?"td":"fd",pos=0,playing=false,last=0,raf=0;
  const visible=new Set(valid.map(r=>r.id));
  const modeSelect=h("select",{"aria-label":"Playback mode"},times.length?h("option",{value:"td",text:"Recorded time domain"}):null,
    frequencies.length?h("option",{value:"fd",text:"Frequency-domain phase"}):null);
  const frequency=h("select",{"aria-label":"Frequency"},frequencies.map(f=>h("option",{value:f,text:ghz(f)})));
  const slider=h("input",{type:"range",min:0,max:1000,step:1,value:0,"aria-label":"Playback position",style:"width:100%"});
  const scale=h("input",{type:"range",min:1,max:50,value:10,step:1,"aria-label":"Arrow length (mm)"});
  const density=h("input",{type:"range",min:1,max:16,value:1,step:1,"aria-label":"Spatial display stride"});
  const speed=h("select",{"aria-label":"Playback speed"},[.25,.5,1,2,4].map(x=>h("option",{value:x,text:x+"×"})));speed.value="1";
  const readout=h("span",{class:"hint"}),charts=h("div",{class:"sim-charts"}),cursors=[];
  const play=h("button",{type:"button",class:"small"},"Play");
  function stop(){playing=false;cancelAnimationFrame(raf);play.textContent="Play";}
  function renderGraphs(){
    charts.replaceChildren();cursors.length=0;
    for(const r of valid.filter(r=>r.type!=="field_dump")){
      let x,y,unit=r.unit,xLabel;
      if(mode==="td"&&r.time_s?.length){x=r.time_s.map(t=>t*1e9);y=r.values;xLabel="ns";}
      else if(mode==="fd"&&r.frequency_hz?.length){x=r.frequency_hz.map(f=>f/1e9);y=r.real.map((a,i)=>a.map((v,j)=>Math.hypot(v,r.imag[i][j])));xLabel="GHz";}
      else continue;
      // Limit plotted points (not playback data) to keep SVG and spread operations bounded.
      const step=Math.max(1,Math.ceil(x.length/6000));
      const indices=x.map((_,i)=>i).filter(i=>i%step===0||i===x.length-1);
      const sx=indices.map(i=>x[i]);
      const chart=lineChart({series:Array.from({length:r.components},(_,j)=>({x:sx,y:indices.map(i=>y[i][j]),label:r.components===1?r.name:"XYZ"[j]})),xLabel,yLabel:unit});
      const cursor=document.createElementNS("http://www.w3.org/2000/svg","line");
      cursor.setAttribute("y1","10");cursor.setAttribute("y2","160");cursor.setAttribute("stroke","#f59e0b");cursor.setAttribute("stroke-width","1");
      chart.append(cursor);cursors.push({cursor,min:x[0],max:x.at(-1)});
      charts.append(chartCard(r.name+" ("+unit+")",chart));
      if(mode==="fd"){
        const phaseChart=lineChart({series:Array.from({length:r.components},(_,j)=>({x:sx,y:indices.map(i=>Math.atan2(r.imag[i][j],r.real[i][j])*180/Math.PI),label:r.components===1?r.name:"XYZ"[j]})),xLabel,yLabel:"Degrees",yMin:-180,yMax:180});
        charts.append(chartCard(r.name+" phase",phaseChart));
      }
    }
  }
  function update(){
    if(!root.isConnected)return;
    slider.value=String(Math.round(pos*1000));
    const time=lo+(hi-lo)*pos,f=Number(frequency.value),phase=360*pos;
    readout.textContent=mode==="td"?(time*1e9).toPrecision(5)+" ns":phase.toFixed(1)+"° · "+ghz(f);
    for(const {cursor,min,max} of cursors){
      const x=mode==="td"?time*1e9:f/1e9;
      cursor.style.display=x<min||x>max?"none":"";
      const p=46+(x-min)/(max-min||1)*504;cursor.setAttribute("x1",p);cursor.setAttribute("x2",p);
    }
    ctx.setDiagnosticFrame?.(diagnosticFrame(valid,{mode,time,frequency:f,phase,visible,scale:Number(scale.value),density:Number(density.value)}));
  }
  function tick(now){
    if(!root.isConnected||!playing){stop();return;}
    if(last)pos=(pos+(now-last)*Number(speed.value)/8000)%1;
    last=now;update();raf=requestAnimationFrame(tick);
  }
  play.onclick=()=>{if(playing)stop();else{playing=true;last=0;play.textContent="Pause";raf=requestAnimationFrame(tick);}};
  slider.oninput=()=>{pos=Number(slider.value)/1000;update();};
  modeSelect.onchange=()=>{stop();mode=modeSelect.value;pos=0;frequency.hidden=mode!=="fd";renderGraphs();update();};
  frequency.hidden=mode!=="fd";frequency.onchange=update;scale.oninput=update;density.oninput=update;
  root.append(h("div",{class:"actions"},modeSelect,frequency,play,speed,readout),
    slider,h("div",{class:"row"},h("label",{text:"Arrow length (mm)"}),scale),
    h("div",{class:"row"},h("label",{text:"Spatial stride"}),density),
    h("div",{class:"hint",text:"Arrows use fixed peak scaling per physical unit. Recorded field frames use nearest recorded time; probe samples are interpolated. Phase playback is not recorded time."}));
  for(const r of valid){
    const check=h("input",{type:"checkbox",checked:true});
    check.onchange=()=>{check.checked?visible.add(r.id):visible.delete(r.id);update();};
    root.append(h("label",{class:"check-inline"},check,r.name+" · "+r.unit));
  }
  root.append(charts);renderGraphs();requestAnimationFrame(update);
  return root;
}
