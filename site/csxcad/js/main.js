// Radiators CSXCAD editor — application shell.
// The document is a radiators schema v2 config *template*: numbers may be
// {"$param"} / {"$expr"} placeholders that scripts/sweep.py resolves per case.
import {
  parameterSets, resolveTemplate, resolveCase, fieldToValue, valueToField, isTemplate,
  validParameterName, renameParameter, parameterUsage, sweepWarnings, MAX_CASES,
  UNIT_GROUPS, normalizeWorkspaceUnits, unitGroup, displayUnit, parseUnitField, formatUnitField, displayedNumber, parseEndCriteria,
} from "./params.js";
import { SHAPES, MATERIALS, PORTS, BOUNDARIES, STARTER } from "./schema.js";
import { currentDirection, currentPlaneAxis, currentPlaneLinked, setCurrentPosition, setCurrentDirection, moveCurrentCorner } from "./current-plane.js";
import { checkCase } from "./checks.js";
import { upgradeTextarea } from "./code-editor.js";
import { renderRunPanel, resultFor, clearResults, renderResults, caseRunState, restoreResults, syncSweepDownload, saveLocalProject, listLocalProjects, deleteLocalProject, importResultArchive, importResultFile, seedExampleResult, clearResultCache, resultCacheUsage } from "./sim/panel.js";
import { ARG_TYPES, SCRIPT_TEMPLATE, SCRIPT_NAME, SCRIPT_LIMITS, BUILTIN_SCRIPTS, isBuiltinScript, scriptSource,
  normalizeSpec, prepareArgs, normalizeObjects, isScriptInstance } from "./scriptcore.js";
import { solverBounds, displayBounds, transformer, rotationMatrix } from "./geometry.js";
import { storage, saveFile, registerServiceWorker, onUpdateReady, isNative, installAppViewport } from "./platform.js";
import { sampleDirection, defaultProbe } from "./sim/radiation.js";
import { buildModel } from "./sim/model.js";
import { meshSegments, meshMinima, nearestLine, planeAxes, validMeshLines } from "./sim/mesh-view.js";

const $ = id => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
};
const clone = v => structuredClone(v);
// Line icons (24x24, stroked) so every control shares one visual language.
const ICONS = {
  enableOn: "M4 4h16v16H4zM7 12l3 3 7-7",
  enableOff: "M4 4h16v16H4z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.5 7.2C3.9 8.9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  bolt: "M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z",
  dot: "M12 12h.01",
  sim: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9",
  x: "M6 6l12 12M18 6 6 18",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  copy: "M8 8h11v11H8zM5 16V5h11",
  edit: "m14 5 5 5M4 20l5-1L21 7l-4-4L5 15z",
  array: "M4 4h5v5H4zM15 4h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  chev: "m9 6 6 6-6 6",
  maximize: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  minimize: "M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7",
  scripts: "m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
};
const iconBtn = (name, label, onclick, { disabled = false, danger = false } = {}) =>
  h("button", { type: "button", class: "icon head-btn" + (danger ? " danger" : ""), title: label, "aria-label": label, disabled, onclick }, icon(name));
// Optional fields that still hold their default live behind "More"; anything set explicitly stays visible.
const isMainField = (f, obj) => !f.optional ||
  (obj?.[f.key] !== undefined && JSON.stringify(obj[f.key]) !== JSON.stringify(f.default));
function moreSection(...kids) {
  const d = h("details", { class: "more", open: state.moreOpen || undefined },
    h("summary", {}, icon("chev", "more-chev"), h("span", { text: "More" })), ...kids);
  d.addEventListener("toggle", () => { state.moreOpen = d.open; });
  return d;
}
const SHORT_SHAPE = { box: "box", cylinder: "cyl", cylindrical_shell: "tube", sphere: "sph", spherical_shell: "sph shell", polyhedron: "mesh",
  hemisphere: "dome", hemispherical_shell: "dome shell", wire: "wire", helix: "helix" };
// "Box", or "Sheet (XY plane)" for a zero-thickness box, else the schema label.
function primitiveLabel(g, rg) {
  if (isScriptInstance(g)) return `Script · ${g.script}`;
  if (g?.shape === "box" && rg && nums3(rg.start) && nums3(rg.stop)) {
    const zero = [0, 1, 2].filter(k => rg.start[k] === rg.stop[k]);
    if (zero.length === 1) return `Sheet (${["YZ", "XZ", "XY"][zero[0]]} plane)`;
    return "Box";
  }
  return SHAPES[g?.shape]?.label || g?.shape || "?";
}
const short = v => typeof v === "number" && Number.isFinite(v) ? String(+v.toPrecision(3)) : "?";
// One-line dimension summary for tree rows (resolved values of the current case).
function summarize(g) {
  if (!g) return "";
  const len = (a, b) => Array.isArray(a) && Array.isArray(b) ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : NaN;
  switch (g.shape) {
    case "box": return Array.isArray(g.start) && Array.isArray(g.stop) ? [0, 1, 2].map(k => short(Math.abs(g.stop[k] - g.start[k]))).join("×") : "";
    case "cylinder": return `r${short(g.radius)} · L${short(len(g.start, g.stop))}`;
    case "cylindrical_shell": return `r${short(g.radius)} · t${short(g.thickness)} · L${short(len(g.start, g.stop))}`;
    case "sphere": case "hemisphere": return `r${short(g.radius)}`;
    case "spherical_shell": case "hemispherical_shell": return `r${short(g.radius)} · t${short(g.thickness)}`;
    case "wire": return `${g.points?.length ?? "?"} pts · Ø${short(g.wire_diameter)}`;
    case "polyhedron": return `${g.vertices?.length ?? "?"} v · ${g.faces?.length ?? "?"} f`;
    case "helix": return `Ø${short(g.diameter)} · h${short(g.height)} · ${short(g.turns)}t`;
  }
  return g.shape;
}
const icon = (name, extra = "") => {
  const s = document.createElement("span");
  s.className = "i " + extra;
  s.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}" fill="none" stroke="currentColor" stroke-width="${name === "dot" ? 4 : 1.8}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return s;
};
const add = (el, ...kids) => el.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
const DRAFT_KEY = "radiators-csxcad-draft-v1";      // legacy single slot (migrated on first save)
const DRAFT_PREFIX = "radiators-csxcad-draft-v2:";  // one slot per tab, so two tabs never overwrite each other
const DRAFT_TAB_KEY = "radiators-csxcad-tab";
const DRAFT_SLOTS = 12;                             // cap on retained tab slots
const DRAFT_STALE_MS = 14 * 864e5;                  // and on their age
const DRAFT_DEBOUNCE = 500;
const UNDO_LIMIT = 200, UNDO_BYTES = 32 << 20;      // cap history by size too: 200 snapshots of a 2 MB model is 400 MB
const PREFS_KEY = "radiators-csxcad-prefs-v1";
const mobile = () => matchMedia("(max-width: 760px), (max-height: 520px) and (max-width: 1000px)").matches;

// ---------------------------------------------------------------- state
const state = {
  doc: null,
  deletedArchiveKey: null, // suppress auto-saving an explicitly deleted active revision
  sel: null,            // {kind:"geometry"|"port"|"material", index}
  hidden: new Set(),
  caseIndex: 0,
  jsonMode: "source",
  dock: "params",
  derived: null,
  handle: null,         // active position handle ("geometry.0.start"), gets the 3-axis gizmo
  scriptSel: null,      // script shown in the Scripts tab
  scriptMax: false,     // Scripts editor maximized
  simMax: false,        // Simulation panel maximized (results charts)
};
const history = { undo: [], redo: [], live: null };
let viewport = null;
// Fields register a refresher so values update without rebuilding (and losing focus).
// The inspector and the Simulation panel render separately, so each keeps its own list.
let fieldRefreshers = [];
let inspectorRefreshers = [], simRefreshers = [];

// ---------------------------------------------------------------- geometry scripts runtime
// Scripts run in a Web Worker (terminated after the time limit); results are cached by
// source + argument values, and finished runs trigger a refresh.
const scriptRT = { worker: null, ready: false, busy: null, queue: [], queued: new Set(), cache: new Map(), seq: 0, timer: 0, frame: 0 };
function scriptResult(source, argsJSON) {
  const key = (argsJSON === null ? "S" : "R" + argsJSON) + "\u0000" + source;
  const hit = scriptRT.cache.get(key);
  if (hit) return hit;
  if (!scriptRT.queued.has(key)) {
    scriptRT.queued.add(key);
    scriptRT.queue.push({ key, source, argsJSON });
    pumpScripts();
  }
  return null;
}
function pumpScripts() {
  if (scriptRT.busy || !scriptRT.queue.length) return;
  if (!scriptRT.worker) {
    scriptRT.ready = false;
    scriptRT.worker = new Worker(new URL("./script-worker.js", import.meta.url), { type: "module" });
    scriptRT.worker.onmessage = e => {
      if (e.data.ready) { scriptRT.ready = true; pumpScripts(); }
      else if (scriptRT.busy && e.data.id === scriptRT.busy.id) finishScript(e.data);
    };
    scriptRT.worker.onerror = e => { // the worker itself failed to load
      e.preventDefault?.();
      scriptRT.worker = null;
      for (const job of scriptRT.queue.splice(0)) { scriptRT.busy = job; finishScript({ ok: false, error: "script runner failed to start: " + (e.message || "error") }); }
    };
  }
  if (!scriptRT.ready) return; // jobs start once the worker has loaded
  const job = scriptRT.queue.pop(); // newest first: during a drag only the latest values matter
  job.id = ++scriptRT.seq;
  scriptRT.busy = job;
  scriptRT.worker.postMessage({ id: job.id, source: job.source, argsJSON: job.argsJSON });
  scriptRT.timer = setTimeout(() => {
    scriptRT.worker.terminate();
    scriptRT.worker = null;
    finishScript({ ok: false, error: `timed out after ${SCRIPT_LIMITS.timeoutMs / 1000} s (endless loop?)` });
  }, SCRIPT_LIMITS.timeoutMs);
}
function finishScript(res) {
  clearTimeout(scriptRT.timer);
  const job = scriptRT.busy;
  scriptRT.busy = null;
  scriptRT.cache.set(job.key, res.ok ? { ok: true, out: res.out } : { ok: false, error: res.error });
  scriptRT.queued.delete(job.key);
  if (scriptRT.cache.size > 400) scriptRT.cache.delete(scriptRT.cache.keys().next().value);
  cancelAnimationFrame(scriptRT.frame);
  scriptRT.frame = requestAnimationFrame(() => {
    const a = document.activeElement;
    const typing = a && (a.closest?.("#inspector") || a.closest?.("#scripts"));
    if (state.doc) refresh({ inspector: !typing, scripts: false, params: false, json: false });
    updateScriptStatus();
  });
  pumpScripts();
}
// Argument declarations of a script in the document: {spec} | {pending} | {error}.
function specFor(name) {
  const source = scriptSource(state.doc.scripts, name);
  if (typeof source !== "string") return { error: `Undefined script: ${name}` };
  const r = scriptResult(source, null);
  if (!r) return { pending: true };
  if (!r.ok) return { error: r.error };
  try { return { spec: normalizeSpec(JSON.parse(r.out).args) }; } catch (e) { return { error: e.message }; }
}
// Expand one resolved instance: {objects, spec} | {pending} | {error}.
function expandInstance(g, materials, scripts) {
  const source = scriptSource(scripts, g.script);
  if (typeof source !== "string") return { error: `Undefined script: ${g.script}` };
  const sres = scriptResult(source, null);
  if (!sres) return { pending: true };
  if (!sres.ok) return { error: `script ${g.script}: ${sres.error}` };
  let spec, values;
  try {
    spec = normalizeSpec(JSON.parse(sres.out).args);
    values = prepareArgs(spec, g.args, materials);
  } catch (e) { return { error: e.message, spec }; }
  const r = scriptResult(source, JSON.stringify(values));
  if (!r) return { pending: true, spec };
  if (!r.ok) return { error: `script ${g.script}: ${r.error}`, spec };
  try { return { objects: normalizeObjects(JSON.parse(r.out).objects, g, spec, values), spec }; }
  catch (e) { return { error: `script ${g.script}: ${e.message}`, spec }; }
}
// A resolved case config with every script instance replaced by its primitives.
function expandResolved(cfg) {
  if (!cfg.scripts && !(cfg.geometry || []).some(isScriptInstance)) return { cfg };
  const geometry = [];
  for (const [i, g] of (cfg.geometry || []).entries()) {
    if (!isScriptInstance(g)) { geometry.push(g); continue; }
    const x = expandInstance(g, cfg.materials, cfg.scripts);
    if (x.pending) return { pending: true };
    if (x.error) return { error: x.error, where: g.name || g.script, ref: { kind: "geometry", index: i } };
    geometry.push(...x.objects);
  }
  const out = { ...cfg, geometry };
  delete out.scripts;
  return { cfg: out };
}

function setStatus(msg, error = false) {
  const s = $("status");
  s.textContent = msg;
  s.classList.toggle("error", error);
  if (mobile() && error) toast(msg);
}
let toastTimer;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = h("div", { class: "toast", role: "status" });
    Object.assign(t.style, { position: "fixed", left: "50%", top: "calc(60px + env(safe-area-inset-top, 0px))", transform: "translateX(-50%)",
      background: "var(--panel)", border: "1px solid var(--line-2)", padding: "8px 14px", borderRadius: "18px", zIndex: 100,
      maxWidth: "calc(100vw - 24px)", fontSize: "13px", boxShadow: "0 6px 18px rgb(0 0 0 / .3)" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------------------------------------------------------------- documents
function checkDocShape(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw Error("Not a JSON object");
  if (cfg.schema_version === 1) throw Error("schema_version 1 is not supported by the editor; convert to schema v2");
  if (cfg.schema_version !== 2) throw Error("Requires radiators schema_version 2");
  if (!Array.isArray(cfg.geometry)) throw Error("geometry must be an array");
  if (!Array.isArray(cfg.materials)) throw Error("materials must be an array");
}
function normalizeDoc(cfg) {
  checkDocShape(cfg);
  const doc = clone(cfg);
  doc.units ??= "mm";
  doc.ports ??= [];
  return doc;
}

function loadDoc(cfg, message, caseIndex = 0) {
  const next=normalizeDoc(cfg);
  if(state.doc)void archiveProject();
  state.doc = next;
  showBundledResultsFor = null;
  criteriaPresentation = null;
  state.deletedArchiveKey = null;
  jsonDraft = jsonBase = null;
  clearResults();
  for (const [k, v] of scriptRT.cache) if (!v.ok && /^timed out/.test(v.error)) scriptRT.cache.delete(k); // retry slow scripts
  state.sel = null; // open showing the whole model; selecting a part fades the rest
  state.hidden.clear();
  state.caseIndex = Math.max(0,Math.trunc(Number(caseIndex)||0));
  history.undo = []; history.redo = [];
  if (viewport) viewport._fitted = false;
  persist({ now: true });
  refresh();
  renderJson(true);
  if (message) setStatus(message);
}

// This tab's own draft slot. sessionStorage is per tab, so two tabs editing
// different models keep separate drafts; a new tab restores the newest one.
function tabId() {
  try {
    let id = sessionStorage.getItem(DRAFT_TAB_KEY);
    if (!id) { id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).slice(0, 8); sessionStorage.setItem(DRAFT_TAB_KEY, id); }
    return id;
  } catch { return "single"; } // storage blocked: behave like the old single slot
}
const draftKey = () => DRAFT_PREFIX + tabId();
function draftSlots() { // newest first, including the legacy single slot
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) { const v = storage.get(key); if (v?.doc) out.push({ key, ...v }); }
    }
  } catch { /* storage blocked */ }
  const legacy = storage.get(DRAFT_KEY);
  if (legacy?.doc) out.push({ key: DRAFT_KEY, ...legacy });
  return out.sort((a, b) => Date.parse(b.savedAt || 0) - Date.parse(a.savedAt || 0));
}
const otherDrafts = () => draftSlots().filter(d => d.key !== draftKey());

// Drop other tabs' slots only when they are stale, or when there are more than
// DRAFT_SLOTS of them: another tab may be open and idle, and its draft is its
// unsaved work. Never on a save — reading every slot back would undo the whole
// point of debouncing the write.
function pruneDrafts({ aggressive = false } = {}) {
  const cutoff = Date.now() - (aggressive ? 864e5 : DRAFT_STALE_MS);
  let dropped = 0;
  otherDrafts().forEach((draft, i) => {
    if (i >= DRAFT_SLOTS || !(Date.parse(draft.savedAt) > cutoff)) { storage.remove(draft.key); dropped++; }
  });
  return dropped;
}

let persistTimer = 0, persistWarned = false;
function writeDraft() {
  persistTimer = 0;
  if (!state.doc) return;
  // skipArchive (from the local-project delete flow) must survive the move to
  // per-tab slots: it tells boot not to re-archive a revision just deleted.
  const entry = { doc: state.doc, caseIndex: state.caseIndex, savedAt: new Date().toISOString(),
    // Only serialize again when a revision was actually deleted; this runs on
    // every debounced save.
    skipArchive: state.deletedArchiveKey !== null && state.deletedArchiveKey === JSON.stringify(state.doc) };
  if (storage.set(draftKey(), entry)) { storage.remove(DRAFT_KEY); persistWarned = false; return; }
  // localStorage is full (~5 MB). Reclaim what is safe to reclaim, then say so:
  // the user must not believe a draft was saved when it was not.
  if (pruneDrafts({ aggressive: true }) && storage.set(draftKey(), entry)) { persistWarned = false; return; }
  storage.remove(draftKey()); // a partial/stale draft is worse than none
  if (!persistWarned) {
    persistWarned = true;
    setStatus("Local draft not saved: this model exceeds the browser's localStorage quota. Use Save locally or export the JSON.", true);
  }
}
function persist({ now = false } = {}) {
  // A loaded/edited example is now the user's draft. Do not let its original
  // example query overwrite that draft on refresh; retain other query flags.
  const url=new URL(location.href);
  if(url.searchParams.has("example")){url.searchParams.delete("example");historyReplaceURL(url);}
  // Serializing a large model into localStorage on every slider frame is the
  // editor's worst hot path; coalesce writes and flush on gesture end/unload.
  if (now) { clearTimeout(persistTimer); persistTimer = 0; writeDraft(); return; }
  if (!persistTimer) persistTimer = setTimeout(writeDraft, DRAFT_DEBOUNCE);
}
function historyReplaceURL(url){ window.history.replaceState(window.history.state,"",url); }

// Structural edit with undo. fn mutates state.doc.
function edit(fn, opts = {}) {
  const live = history.live !== null;
  const before = JSON.stringify(state.doc);
  try { fn(state.doc); }
  catch (e) { state.doc = JSON.parse(before); setStatus(e.message, true); return false; }
  // During a live gesture the snapshot is taken once by beginLive, so the only
  // reason to serialize again would be the no-op test; a drag always redraws.
  if (!live && JSON.stringify(state.doc) === before) return true;
  if (!live) pushUndo(before);
  persist();
  refresh(opts);
  return true;
}
function pushUndo(snapshot) {
  history.undo.push(snapshot);
  // Cap by bytes as well as count: dense polyhedra or scripted arrays make
  // every snapshot megabytes, and 200 of them would exhaust phone memory.
  let bytes = history.undo.reduce((n, s) => n + s.length, 0);
  while (history.undo.length > UNDO_LIMIT || (history.undo.length > 1 && bytes > UNDO_BYTES)) bytes -= history.undo.shift().length;
  history.redo = [];
}
// Live edits (sliders): one undo step per gesture.
function beginLive() { if (history.live === null) history.live = JSON.stringify(state.doc); }
function endLive() {
  if (history.live === null) return;
  if (history.live !== JSON.stringify(state.doc)) pushUndo(history.live);
  history.live = null;
  persist({ now: true });
  refresh({ params: false, inspector: false });
}
function undo() {
  if (!history.undo.length) return;
  history.redo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(history.undo.pop());
  fixSelection();
  persist();
  refresh();
  setStatus("Undone");
}
function redo() {
  if (!history.redo.length) return;
  history.undo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(history.redo.pop());
  fixSelection();
  persist();
  refresh();
  setStatus("Redone");
}
function fixSelection() {
  const s = state.sel;
  if (!s || s.kind === "sim") return;
  const list = { geometry: state.doc.geometry, port: state.doc.ports, material: state.doc.materials, diagnostic:state.doc.probes, refinement:state.doc.mesh?.refinements }[s.kind] || [];
  if (s.index >= list.length) state.sel = list.length ? { kind: s.kind, index: list.length - 1 } : null;
}

// ---------------------------------------------------------------- derived data
function derive() {
  const doc = state.doc;
  const d = { cases: [], caseError: null, params: {}, geometry: [], ports: [], errors: { geometry: {}, port: {}, other: [] }, resolved: {} };
  try { d.cases = parameterSets(doc); }
  catch (e) { d.caseError = e.message; d.cases = [{ id: "default", name: "Default", parameters: { ...(doc.parameters || {}) } }]; }
  state.caseIndex = Math.min(state.caseIndex, d.cases.length - 1);
  d.case = d.cases[state.caseIndex];
  d.params = d.case.parameters;
  const lenient = (v, onErr) => { try { return resolveTemplate(v, d.params); } catch (e) { onErr(e.message); return undefined; } };
  for (const [k, v] of Object.entries(doc)) {
    if (k === "sweep" || k === "parameters" || k === "generator") continue;
    if (k === "geometry") d.geometry = v.map((g, i) => g.enabled===false ? null : lenient(g, m => { d.errors.geometry[i] = m; }));
    else if(k==="probes")d.resolved.probes=v.map((p,i)=>p.enabled===false?{enabled:false}:lenient(p,m=>d.errors.other.push("Diagnostic "+(i+1)+": "+m))??{enabled:false});
    else if(k==="mesh"&&Array.isArray(v?.refinements)){
      const {refinements,...rest}=v;
      const mesh=lenient(rest,m=>d.errors.other.push("mesh: "+m));
      if(mesh)d.resolved.mesh={...mesh,refinements:refinements.map((r,i)=>r?.enabled===false?{enabled:false}:lenient(r,m=>d.errors.other.push("Refinement "+(i+1)+": "+m))??{enabled:false})};
    }
    else if (k === "ports") d.ports = (v || []).map((p, i) => lenient(p, m => { d.errors.port[i] = m; }));
    else d.resolved[k] = lenient(v, m => d.errors.other.push(`${k}: ${m}`));
  }
  d.resolved.geometry = d.geometry;
  d.resolved.ports = d.ports;
  d.expanded = d.geometry.map((g, i) => isScriptInstance(doc.geometry[i]) && g ? expandInstance(g, d.resolved.materials, d.resolved.scripts) : null);
  d.expanded.forEach((x, i) => { if (x?.error && !d.errors.geometry[i]) d.errors.geometry[i] = x.error; });
  d.checks = runChecks(doc, d);
  state.derived = d;
  return d;
}

function runChecks(doc, d) {
  const merged = new Map();
  const add = (item, caseId) => {
    const key = item.level + "|" + item.where + "|" + item.msg;
    const prev = merged.get(key);
    if (prev) prev.cases.push(caseId);
    else merged.set(key, { ...item, cases: [caseId] });
  };
  if (d.caseError) add({ level: "error", where: "sweep", msg: d.caseError }, "all");
  for(const warning of sweepWarnings(doc))add(warning,"all");
  if (doc.generator) add({ level: "warn", where: "generator", msg: `Geometry is produced at simulation time by ${doc.generator.path || "a Python generator"}; the preview shows only the base geometry.` }, "all");
  const cases = d.caseError ? [d.case] : d.cases;
  for (const c of cases) {
    let cfg;
    try { cfg = resolveCase(doc, c.parameters); }
    catch (e) { add({ level: "error", where: "parameters", msg: e.message }, c.id); continue; }
    if (doc.generator) continue;
    const ex = expandResolved(cfg);
    if (ex.pending) continue; // a script is still running; checks refresh when it finishes
    if (ex.error) { add({ level: "error", where: ex.where, msg: ex.error, ref: ex.ref }, c.id); continue; }
    cfg = ex.cfg;
    for (const item of checkCase(cfg)) {
      // Solver case indices can differ after disabling or expanding objects.
      if(item.ref?.kind==="geometry"){
        const name=cfg.geometry[item.ref.index]?.name;
        const index=doc.geometry.findIndex(g=>typeof name==="string"&&(g.name===name||(isScriptInstance(g)&&name.startsWith(g.name+"/"))));
        if(index>=0)item.ref={...item.ref,index};
      }
      if(item.ref?.kind==="diagnostic"){
        const name=cfg.probes?.[item.ref.index]?.name;
        const index=doc.probes?.findIndex(p=>p.name===name);
        if(index>=0)item.ref={...item.ref,index};
      }
      add(item,c.id);
    }
  }
  return { list: [...merged.values()].sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1)), caseCount: cases.length };
}

// ---------------------------------------------------------------- path helpers
const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] === undefined || o[path[i]] === null) o[path[i]] = typeof path[i + 1] === "number" ? [] : {};
    o = o[path[i]];
  }
  if (value === undefined) {
    if (Array.isArray(o)) o.splice(path[path.length - 1], 1); else delete o[path[path.length - 1]];
  } else o[path[path.length - 1]] = value;
}

// ---------------------------------------------------------------- fields
// A numeric/expression field bound to a document path.
function numField(path, { optional = false, def, int = false, unit, placeholder, onLive, aria, prepare, step, write } = {}) {
  const typed=unitGroup(unit);
  const preferred=typed?displayUnit(unit,state.doc.workspace_units):unit;
  const display=v=>typed?formatUnitField(v,unit,preferred):valueToField(v);
  const displayNumber=v=>typed?displayedNumber(v,unit,preferred):v;
  const parse=text=>typed?parseUnitField(text,unit,preferred):fieldToValue(text);
  const wrap = h("div", { class: "field"+(typed?" unit-field":"") });
  const input = h("input", { type: "text", inputmode: "text", autocapitalize: "off", autocomplete: "off",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "done", "aria-label": aria || path.join("."),
    placeholder: placeholder ?? (optional && def !== undefined ? display(def) : "") });
  const hint = h("div", { class: "value" });
  wrap.append(input, hint);
  const show = () => {
    const v = getPath(state.doc, path);
    if (document.activeElement !== input) input.value = display(v);
    evaluateHint(v);
  };
  const evaluateHint = v => {
    wrap.classList.toggle("expr", isTemplate(v));
    wrap.classList.remove("invalid");
    hint.replaceChildren();
    if (v === undefined) { if (preferred) hint.textContent = preferred; return; }
    if (isTemplate(v)) {
      try {
        const r = resolveTemplate(v, state.derived.params);
        hint.textContent = "= " + fmt(displayNumber(r)) + (preferred ? " " + preferred : "");
      } catch (e) {
        wrap.classList.add("invalid");
        const missing = /Unknown (?:numeric )?parameter: ([A-Za-z_]\w*)/.exec(e.message);
        hint.append(e.message);
        if (missing && validParameterName(missing[1])) {
          hint.append(" ", h("button", { type: "button", class: "small", text: `+ create ${missing[1]}`, onclick: () => {
            edit(doc => { doc.parameters ??= {}; doc.parameters[missing[1]] = 1; });
            setStatus(`Parameter ${missing[1]} = 1 created — adjust it under Parameters`);
          } }));
        }
      }
    } else if (preferred) hint.textContent = preferred;
  };
  const commit = () => {
    const text = input.value.trim();
    let value;
    if (text === "" && optional) value = undefined;
    else {
      try { value = parse(text); }
      catch (e) { wrap.classList.add("invalid"); hint.textContent = e.message; return; }
      if (int && typeof value === "number" && !Number.isInteger(value)) {
        wrap.classList.add("invalid"); hint.textContent = "Must be an integer"; return;
      }
    }
    if(edit(doc => { prepare?.(doc); if(write)write(doc,value); else setPath(doc, path, value); }, { inspector: !!write }))input.value=display(value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); return; }
    // ↑ / ↓ nudge a plain number by `step` (Shift: ×10); parameters and expressions are left alone.
    if (step && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const cur = input.value.trim() === "" && def !== undefined ? displayNumber(def) : Number(input.value);
      if (input.value.trim() !== "" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(input.value.trim())) return;
      if (!Number.isFinite(cur)) return;
      e.preventDefault();
      const displayStep=displayNumber(step);
      const delta = (e.key === "ArrowUp" ? 1 : -1) * displayStep * (e.shiftKey ? 10 : 1);
      input.value = String(+(Math.round((cur + delta) / displayStep) * displayStep).toPrecision(12));
      commit();
    }
  });
  if (onLive) input.addEventListener("input", () => onLive(input.value));
  fieldRefreshers.push(show);
  show();
  return wrap;
}
const fmt = v => typeof v === "number" ? String(+v.toPrecision(8)) : JSON.stringify(v);

// One text field: an explicit dB suffix converts to the canonical linear ratio.
let criteriaPresentation=null;
function endCriteriaField() {
  const path=["solver","end_criteria"], fallback=1e-4;
  const input=h("input",{type:"text",inputmode:"text",autocapitalize:"off",autocomplete:"off",autocorrect:"off",spellcheck:"false",enterkeyhint:"done","aria-label":"End criteria",placeholder:"0.0001 or -40 dB"});
  const hint=h("div",{class:"value"});
  const wrap=h("div",{class:"field"},input,hint);
  const show=()=>{
    const raw=getPath(state.doc,path);
    const ratio=raw===undefined?fallback:getPath(state.derived.resolved,path);
    const valid=typeof ratio==="number"&&Number.isFinite(ratio)&&ratio>0&&ratio<=1;
    if(document.activeElement!==input){
      input.value=criteriaPresentation&&raw===criteriaPresentation.ratio?criteriaPresentation.text:valueToField(raw);
    }
    wrap.classList.toggle("expr",isTemplate(raw));
    wrap.classList.toggle("invalid",!valid);
    if(!valid)hint.textContent="Use a positive linear ratio up to 1, or a nonpositive dB value.";
    else hint.textContent=(raw===undefined?"Default: ":"")+valueToField(ratio)+" = "+valueToField(10*Math.log10(ratio))+" dB";
  };
  input.addEventListener("change",()=>{
    const text=input.value.trim();
    let value;
    try{
      value=parseEndCriteria(text);
      if(isTemplate(value)){
        const ratio=resolveTemplate(value,state.derived.params);
        if(typeof ratio!=="number"||!Number.isFinite(ratio)||ratio<=0||ratio>1)
          throw Error("Resolved ratio must be above 0 and at most 1");
      }
    }catch(e){wrap.classList.add("invalid");hint.textContent=e.message;return;}
    criteriaPresentation=typeof value==="number"&&/dB$/i.test(text)?{ratio:value,text:text.replace(/\s*dB$/i," dB")}:null;
    if(edit(doc=>setPath(doc,path,value),{inspector:false,sim:false})){
      input.value=criteriaPresentation?.text??valueToField(value);
      show();
    }
  });
  input.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();input.blur();}});
  fieldRefreshers.push(show);
  show();
  return wrap;
}

function vec3Field(path, opts = {}) {
  const key = handleKey(path);
  const unit=opts.unit??(path.at(-1)==="axis"?"":path.at(-1)==="rotate_deg"?"°":"mm");
  const preferred=unitGroup(unit)?displayUnit(unit,state.doc.workspace_units):unit;
  const el = h("div", { class: "vec3", "data-handle": key }, ["x", "y", "z"].map((axis, i) =>
    numField([...path, i], { ...opts, unit, aria: `${opts.label || path.join(".")} ${axis}`,
      placeholder: opts.defaults ? (unitGroup(unit)?formatUnitField(opts.defaults[i],unit,preferred):String(opts.defaults[i])) : axis })));
  el.addEventListener("focusin", () => { if (state.handle !== key && currentHandles.has(key)) { state.handle = key; syncHandles(); } });
  return el;
}
function textField(path, { optional = false, aria, onCommit } = {}) {
  const input = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": aria });
  const show = () => { if (document.activeElement !== input) input.value = getPath(state.doc, path) ?? ""; };
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (onCommit) return onCommit(v, input);
    edit(doc => setPath(doc, path, v === "" && optional ? undefined : v), { inspector: false });
  });
  fieldRefreshers.push(show);
  show();
  return h("div", { class: "field" }, input);
}
function selectField(path, options, { optional = false, aria, onCommit, emptyLabel = "—" } = {}) {
  const sel = h("select", { "aria-label": aria });
  const opts = optional ? [["", emptyLabel], ...options] : options;
  for (const o of opts) {
    const [value, label] = Array.isArray(o) ? o : [o, o];
    sel.append(h("option", { value, text: label }));
  }
  const cur = getPath(state.doc, path);
  if (cur !== undefined && !opts.some(o => (Array.isArray(o) ? o[0] : o) === cur)) {
    sel.append(h("option", { value: JSON.stringify(cur), text: isTemplate(cur) ? valueToField(cur) + " (param)" : String(cur) }));
    sel.value = JSON.stringify(cur);
  } else sel.value = cur ?? "";
  sel.addEventListener("change", () => {
    const v = sel.value === "" && optional ? undefined : sel.value;
    if (onCommit) return onCommit(v);
    edit(doc => setPath(doc, path, v));
  });
  return h("div", { class: "field" }, sel);
}
function checkField(path, label, def = false) {
  const box = h("input", { type: "checkbox" });
  box.checked = !!(getPath(state.doc, path) ?? def);
  box.addEventListener("change", () => edit(doc => setPath(doc, path, box.checked), { inspector: false }));
  return h("label", { class: "check-inline" }, box, label);
}
const row = (label, control, cls = "") => h("div", { class: "row " + cls }, h("label", { text: label }), control);

function fieldFor(def, path) {
  switch (def.type) {
    case "vec3": return vec3Field(path, { label: def.label, unit: def.unit });
    case "num": return numField(path, { optional: def.optional, def: def.default, unit: def.unit, aria: def.label });
    case "int": return numField(path, { optional: def.optional, def: def.default, int: true, aria: def.label });
    case "select": return selectField(path, def.options, { optional: def.optional, aria: def.label });
    case "material": {
      const mats = state.doc.materials.filter(m => !def.filter || m.type === def.filter).map(m => m.name);
      return selectField(path, mats, { optional: def.optional, aria: def.label });
    }
    case "points": return pointsField(path);
  }
  return h("span", { text: "?" });
}

function pointsField(path) {
  const pts = getPath(state.doc, path);
  if (!Array.isArray(pts) || isTemplate(pts)) return h("div", { class: "note warn", text: "Points are not a plain list here; edit them in the JSON tab." });
  if (pts.length > 64) {
    const ta = h("textarea", { rows: 8, spellcheck: "false", "aria-label": "Wire points JSON" });
    ta.value = JSON.stringify(pts);
    ta.addEventListener("change", () => {
      try { const v = JSON.parse(ta.value); edit(doc => setPath(doc, path, v)); }
      catch (e) { setStatus("Points: " + e.message, true); }
    });
    return h("div", {}, h("div", { class: "hint", text: `${pts.length} points (JSON)` }), ta);
  }
  const list = h("div", { class: "points" });
  pts.forEach((_, i) => list.append(h("div", { class: "pt" },
    h("span", { text: i + 1 }),
    vec3Field([...path, i], { label: `point ${i + 1}` }),
    h("button", { type: "button", class: "icon", title: "Remove point", "aria-label": `Remove point ${i + 1}`, disabled: pts.length <= 2,
      onclick: () => edit(doc => getPath(doc, path).splice(i, 1)) }, icon("x")))));
  list.append(h("div", { class: "actions" },
    h("button", { type: "button", class: "small", onclick: () => edit(doc => {
      const arr = getPath(doc, path);
      const last = clone(arr[arr.length - 1]);
      last[2] = typeof last[2] === "number" ? last[2] + 5 : { $expr: `(${valueToField(last[2])}) + 5` };
      arr.push(last);
    }) }, "+ point")));
  return list;
}

// ---------------------------------------------------------------- tree
function toggleGeometry(i) {
  edit(doc=>{
    const g=doc.geometry[i];
    if(g.enabled===false)delete g.enabled;
    else g.enabled=false;
  });
}
function objectEnabledRow(g,i) {
  return row("Simulation",h("button",{type:"button",class:"small","aria-pressed":String(g.enabled!==false),onclick:()=>toggleGeometry(i)},g.enabled===false?"Disabled · enable":"Enabled · disable"));
}
function renderTree() {
  const doc = state.doc, d = state.derived;
  const tree = $("tree");
  tree.replaceChildren();
  const mats = new Map(doc.materials.map(m => [m.name, m]));
  const isSel = (kind, i) => state.sel && state.sel.kind === kind && state.sel.index === i;
  const section = (title, kind, items, addKind) => {
    const list = h("ul", { class: "tree-list" });
    items.forEach(it => list.append(it));
    return h("section", { class: "tree-section" },
      h("header", {}, h("h3", { text: title }),
        addKind ? h("button", { type: "button", class: "small", "aria-label": "Add " + title, onclick: e => openAddMenu(e.currentTarget, addKind) }, "+") : null),
      list);
  };
  const geomRows = doc.geometry.map((g, i) => {
    const disabled = g.enabled === false;
    const hidden = state.hidden.has(i);
    const script = isScriptInstance(g);
    const ex = d.expanded[i];
    const m = mats.get(script ? (ex?.objects?.[0]?.material ?? "") : typeof g.material === "string" ? g.material : "");
    return h("li", { class: "tree-row" + (isSel("geometry", i) ? " active" : "") + (d.errors.geometry[i] ? " invalid" : "") + (hidden ? " tree-hidden" : "") + (disabled ? " tree-disabled" : "") },
      h("button", { type: "button", class: "vis", title: hidden ? "Show" : "Hide (preview only)", "aria-label": (hidden ? "Show " : "Hide ") + (g.name || g.shape),
        onclick: () => { hidden ? state.hidden.delete(i) : state.hidden.add(i); refresh({ inspector: false, params: false }); } }, icon(hidden ? "eyeOff" : "eye")),
      h("button",{type:"button",class:"vis object-enable",title:disabled?"Enable in simulation":"Disable in simulation","aria-label":(disabled?"Enable ":"Disable ")+(g.name||g.shape),"aria-pressed":String(!disabled),onclick:()=>toggleGeometry(i)},icon(disabled?"enableOff":"enableOn")),
      h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "geometry", index: i }) },
        h("span", { class: "swatch", style: `background:${swatch(m)}` }),
        h("span", { class: "nm", text: g.name || g.shape }),
        h("span", { class: "kind", title: primitiveLabel(g, d.geometry[i]) },
          h("span", { class: "kind-prim", text: script ? "script" : primitiveLabel(g, d.geometry[i]).startsWith("Sheet") ? "sheet" : SHORT_SHAPE[g.shape] || g.shape }), " ",
          disabled ? "disabled" : script ? `${g.script} · ${ex?.objects ? ex.objects.length + " obj" : ex?.pending ? "…" : "error"}` : summarize(d.geometry[i]))));
  });
  const portRows = doc.ports.map((p, i) => h("li", { class: "tree-row" + (isSel("port", i) ? " active" : "") + (d.errors.port[i] ? " invalid" : "") },
    h("span", { class: "vis" + (p.excite ? " excited" : ""), title: p.excite ? "Excited port" : "Passive port" }, icon(p.excite ? "bolt" : "dot")),
    h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "port", index: i }) },
      h("span", { class: "nm", text: `${p.name || "port"} #${p.id ?? i + 1}` }),
      h("span", { class: "kind", text: p.type + (p.type === "lumped" ? ` · ${short(d.ports?.[i]?.impedance_ohm ?? 50)}Ω` : "") }))));
  const matRows = doc.materials.map((m, i) => h("li", { class: "tree-row" + (isSel("material", i) ? " active" : "") },
    h("span", { class: "vis" }, h("span", { class: "swatch", style: `background:${swatch(m)}` })),
    h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "material", index: i }) },
      h("span", { class: "nm", text: m.name }),
      h("span", { class: "kind", text: m.type === "dielectric" ? `εr ${short(d.resolved.materials?.[i]?.epsilon)}` : m.type }))));
  const diagnostics=doc.probes??[];
  const probeRows=diagnostics.map((p,i)=>h("li",{class:"tree-row"+(isSel("diagnostic",i)?" active":"")+(p.enabled===false?" tree-disabled":"")},
    h("button",{type:"button",class:"vis",title:"Enable or disable",onclick:()=>edit(d=>{d.probes[i].enabled=d.probes[i].enabled===false;})},icon(p.enabled===false?"enableOff":"enableOn")),
    h("button",{type:"button",class:"tree-name",onclick:()=>select({kind:"diagnostic",index:i})},
      h("span",{class:"nm",text:p.name}),h("span",{class:"kind",text:p.type==="current"?"Current · "+"xyz"[currentPlaneAxis(p)].toUpperCase():p.type})),
    iconBtn("edit","Edit "+p.name,()=>select({kind:"diagnostic",index:i}))));
  tree.append(
    section(`Diagnostics (${diagnostics.length})`,"diagnostic",probeRows,"diagnostic"),
    section(`Geometry (${doc.geometry.length})`, "geometry", geomRows, "geometry"),
    section(`Ports (${doc.ports.length})`, "port", portRows, "port"),
    section(`Materials (${doc.materials.length})`, "material", matRows, "material"));
}
function swatch(m) {
  return { pec: "#d9a54a", conductive: "#c77b4a", conducting_sheet: "#e8884a", dielectric: "#4fb38a" }[m?.type] || "#8aa0b8";
}

function select(ref, { fromView = false } = {}) {
  if (ref?.kind === "sim") return openSheet("sim");
  const changed = JSON.stringify(ref) !== JSON.stringify(state.sel);
  state.sel = ref;
  if (changed || state.handle === "result-probe") state.handle = null;
  refresh({ params: false, json: false, viewport: false });
  const shown = ref && ["geometry","port","refinement"].includes(ref.kind) ? ref : null;
  viewport?.setSelection(shown);
  // Focus after any phone sheet has opened, so the framing accounts for the space it covers.
  if (shown && changed) setTimeout(() => viewport?.focus(shown), 60);
  if (mobile()) {
    if (fromView && !ref) { if (document.body.dataset.sheet === "inspect") closeSheet(); }
    else openSheet("inspect", { peek: true });
  }
}
function showChip() {
  const chip = $("selectionChip");
  const s = state.sel;
  if (!s || !mobile() || document.body.dataset.sheet) { chip.hidden = true; return; }
  const item = s.kind === "geometry" ? state.doc.geometry[s.index] : s.kind === "port" ? state.doc.ports[s.index] : s.kind==="diagnostic"?state.doc.probes?.[s.index]:s.kind==="refinement" ? state.doc.mesh?.refinements?.[s.index] : null;
  if (!item) { chip.hidden = true; return; }
  $("chipText").textContent = s.kind==="refinement" ? "Refinement "+(s.index+1) : `${item.name || item.shape || "port"} · ${item.shape || item.type}`;
  chip.hidden = false;
}

// ---------------------------------------------------------------- position handles
// Every position-like vec3 of the selected object (start/stop/center/origin, wire
// points, port corners) gets a point in the 3D view; the active one gets a gizmo.
const handleKey = path => path.join(".");
let currentHandles = new Map();
let dragFrame = 0;

const V = {
  add: (a, b) => a.map((x, i) => x + b[i]), sub: (a, b) => a.map((x, i) => x - b[i]), mul: (a, k) => a.map(x => x * k),
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len: a => Math.hypot(...a),
  unit: a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); },
  perp: a => { const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const d = V.dot(t, a) / (V.dot(a, a) || 1); return V.unit(V.sub(t, V.mul(a, d))); },
};
const nums3 = v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x));
const fmtLen = v => `${+v.toPrecision(5)} mm`;

// Handles for the selected object. Points move with the 3-axis gizmo; scalar handles
// (amber diamonds) slide along one line and edit a single dimension of the primitive.
function computeHandles() {
  const out = new Map();
  const s = state.sel, d = state.derived;
  if (!s || !d || (s.kind==="geometry" && state.doc.geometry[s.index]?.enabled===false)) return out;
  const identity = { fwd: p => p, inv: p => p, dir: p => p, rotated: false };
  const point = (path, local, raw, xf) => {
    if (!nums3(local)) return;
    const numeric = Array.isArray(raw) && raw.length === 3 ? raw.map(v => typeof v === "number") : [false, false, false];
    // A rotated part moves along world axes, which mixes local coordinates: all three must be plain numbers.
    const axes = xf.rotated ? (numeric.every(Boolean) ? [true, true, true] : [false, false, false]) : numeric;
    const key = handleKey(path);
    out.set(key, { key, kind: "point", path, pos: xf.fwd(local), axes, xf });
  };
  // scalar: dimension `field` = set(t) where t is the distance from baseLocal along dirLocal.
  // set(t) returns a number for `field`, or [[path, value], …] to write several fields, or null to refuse.
  const scalar = (name, field, raw, xf, baseLocal, dirLocal, dist, set, label, enabled = typeof raw === "number") => {
    if (!nums3(baseLocal) || !Number.isFinite(dist)) return;
    const key = `dim:${handleKey(field)}:${name}`;
    out.set(key, { key, kind: "scalar", field, base: xf.fwd(baseLocal), dir: xf.dir(V.unit(dirLocal)), dist, enabled, set, label });
  };
  if(s.kind==="diagnostic"){
    const raw=state.doc.probes?.[s.index],p=d.resolved.probes?.[s.index];
    if(!raw||!p||raw.enabled===false)return out;
    try{
      const fwd=transformer(p),m=rotationMatrix(p.transform?.rotate_deg??[0,0,0]),t=p.transform?.translate??[0,0,0];
      const xf={fwd,rotated:(p.transform?.rotate_deg??[0,0,0]).some(v=>v!==0),inv:w=>[0,1,2].map(k=>m.reduce((sum,row,j)=>sum+row[k]*(w[j]-t[j]),0))};
      for(const k of ["start","stop"]){
        const path=["probes",s.index,k];
        point(path,p[k],raw[k],xf);
        const hd=out.get(handleKey(path));
        if(hd&&raw.type==="current"){
          const n=currentPlaneAxis(raw);
          if(typeof raw.start[n]!=="number"||typeof raw.stop[n]!=="number"){
            if(xf.rotated)hd.axes=[false,false,false];else hd.axes[n]=false;
          }
        }
      }
    }catch{}
    return out;
  }
  if(s.kind==="refinement"){
    const raw=state.doc.mesh?.refinements?.[s.index],resolved=d.resolved.mesh?.refinements?.[s.index];
    if(raw&&resolved&&raw.enabled!==false&&resolved.enabled!==false)for(const k of ["start","stop"])point(["mesh","refinements",s.index,k],resolved[k],raw[k],identity);
    return out;
  }
  if (s.kind === "geometry" && isScriptInstance(state.doc.geometry[s.index])) {
    // Point arguments of a script instance get the same 3-axis handles as primitive positions.
    const g = state.doc.geometry[s.index], rg = d.geometry[s.index];
    const sp = specFor(g.script);
    if (!rg || state.hidden.has(s.index)) return out;
    let xf;
    try {
      const fwd = transformer(rg);
      const m = rotationMatrix(rg.transform?.rotate_deg || [0,0,0]);
      const t = rg.transform?.translate || [0,0,0];
      const inv = w => { const q=V.sub(w,t); return [0,1,2].map(c=>m[0][c]*q[0]+m[1][c]*q[1]+m[2][c]*q[2]); };
      const dir = v => m.map(row=>V.dot(row,v));
      xf = {fwd,inv,dir,rotated:(rg.transform?.rotate_deg || []).some(Boolean)};
      const path = ["geometry",s.index,"transform","translate"];
      point(path,t,g.transform?.translate ?? [0,0,0],identity);
      if(!g.transform?.translate) out.get(handleKey(path)).init=[0,0,0];
    } catch { return out; }
    if (!sp.spec) return out;
    const val = k => rg?.args?.[k] ?? sp.spec[k]?.default;
    for (const [key, dd] of Object.entries(sp.spec)) {
      const path = ["geometry", s.index, "args", key];
      const raw = g.args?.[key];
      if (dd.type === "point") {
        point(path, val(key), raw === undefined ? [0, 0, 0] : raw, xf);
        const hd = out.get(handleKey(path));
        if (hd && raw === undefined) hd.init = dd.default;
        if (hd && dd.step) hd.snap = dd.step;
      } else if (dd.handle && typeof val(key) === "number") {
        const from = val(dd.handle.from);
        const dirArg = typeof dd.handle.dir === "string" ? sp.spec[dd.handle.dir] : null;
        // dir: a vector argument, a literal [x,y,z], or a point argument (towards that point).
        const dir0 = !dirArg ? dd.handle.dir : dirArg.type === "point" ? (nums3(val(dd.handle.dir)) && nums3(from) ? V.sub(val(dd.handle.dir), from) : null) : val(dd.handle.dir);
        if (!nums3(from) || !nums3(dir0) || !V.len(dir0)) continue;
        const dir = dd.handle.perp ? V.perp(dir0) : V.unit(dir0), k = dd.handle.scale;
        const snapV = t => dd.step ? Math.round(t * k / dd.step) * dd.step : t * k;
        const fmtV = t => dd.type === "length" ? fmtLen(snapV(t)) : String(+snapV(t).toPrecision(5));
        scalar(key, path, raw === undefined ? 0 : raw, xf, from, dir, val(key) / k,
          t => { const v = snapV(t); return (dd.min === undefined ? v > 0 : v >= dd.min) && (dd.max === undefined || v <= dd.max) ? v : null; },
          t => `${dd.label} ${fmtV(t)}`);
      }
    }
    return out;
  }
  if (s.kind === "geometry") {
    const g = state.doc.geometry[s.index], rg = d.geometry[s.index];
    const def = SHAPES[g?.shape];
    if (!rg || !def || state.hidden.has(s.index)) return out;
    let xf;
    try {
      const fwd = transformer(rg);
      const m = rotationMatrix(rg.transform?.rotate_deg || [0, 0, 0]);
      const t = rg.transform?.translate || [0, 0, 0];
      const inv = w => { const q = V.sub(w, t); return [0, 1, 2].map(c => m[0][c] * q[0] + m[1][c] * q[1] + m[2][c] * q[2]); };
      const dir = v => [0, 1, 2].map(r => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
      xf = { fwd, inv, dir, rotated: (rg.transform?.rotate_deg || []).some(v => v) };
    } catch { return out; }
    const base = ["geometry", s.index];
    for (const f of def.fields) {
      if (f.type === "vec3" && f.key !== "axis") point([...base, f.key], rg[f.key], g[f.key], xf);
      if (f.type === "points" && Array.isArray(rg[f.key]) && rg[f.key].length <= 64) {
        rg[f.key].forEach((pt, k) => point([...base, f.key, k], pt, Array.isArray(g[f.key]) ? g[f.key][k] : null, xf));
      }
    }
    const pos = v => v > 0;
    switch (g.shape) {
      case "box": {
        if (!nums3(rg.start) || !nums3(rg.stop)) break;
        // The simulator needs start <= stop per axis, so faces never cross. A zero-thickness
        // axis (sheet) gets one two-way handle; conducting sheets must stay zero-thickness.
        const c = V.mul(V.add(rg.start, rg.stop), 0.5);
        const sheetMat = state.doc.materials.find(m => m.name === g.material)?.type === "conducting_sheet";
        for (let k = 0; k < 3; k++) {
          const lo = Math.min(rg.start[k], rg.stop[k]), hi = Math.max(rg.start[k], rg.stop[k]);
          const loF = rg.start[k] <= rg.stop[k] ? "start" : "stop", hiF = loF === "start" ? "stop" : "start";
          const loPath = [...base, loF, k], hiPath = [...base, hiF, k];
          const free = typeof g[loF]?.[k] === "number" && typeof g[hiF]?.[k] === "number";
          const at = v => { const q = [...c]; q[k] = v; return q; };
          const ax = d => { const q = [0, 0, 0]; q[k] = d; return q; };
          if (hi === lo) {
            scalar(`face${k}`, hiPath, g[hiF]?.[k], xf, at(lo), ax(1), 0,
              t => t >= 0 ? [[hiPath, lo + t], [loPath, lo]] : [[loPath, lo + t], [hiPath, lo]],
              t => `${"xyz"[k]} thickness ${fmtLen(Math.abs(t))}`, free && !sheetMat);
          } else {
            // Opposite faces of a thin box would overlap on screen: shift the pair apart across the face.
            const size = [0, 1, 2].map(j => Math.abs(rg.stop[j] - rg.start[j]));
            const side = size[(k + 1) % 3] > 0 ? (k + 1) % 3 : (k + 2) % 3;
            const off = [0, 0, 0]; off[side] = size[side] / 4;
            scalar(`face${k}`, hiPath, g[hiF]?.[k], xf, V.add(at(lo), off), ax(1), hi - lo,
              t => t >= 0 ? lo + t : null, t => `${"xyz"[k]} size ${fmtLen(t)}`);
            scalar(`face${k}lo`, loPath, g[loF]?.[k], xf, V.sub(at(hi), off), ax(-1), hi - lo,
              t => t >= 0 ? hi - t : null, t => `${"xyz"[k]} size ${fmtLen(t)}`);
          }
        }
        break;
      }
      case "cylinder": case "cylindrical_shell": {
        if (!nums3(rg.start) || !nums3(rg.stop)) break;
        const mid = V.mul(V.add(rg.start, rg.stop), 0.5), p = V.perp(V.sub(rg.stop, rg.start));
        scalar("r", [...base, "radius"], g.radius, xf, mid, p, rg.radius,
          t => pos(t) && (g.shape === "cylinder" || rg.thickness < 2 * t) ? t : null, t => `r ${fmtLen(t)}`);
        if (g.shape === "cylindrical_shell") {
          scalar("t", [...base, "thickness"], g.thickness, xf, mid, V.mul(p, -1), rg.radius + rg.thickness / 2,
            t => { const w = 2 * (t - rg.radius); return pos(w) && w < 2 * rg.radius ? w : null; }, t => `wall ${fmtLen(2 * (t - rg.radius))}`);
        }
        break;
      }
      case "sphere": case "spherical_shell": {
        scalar("r", [...base, "radius"], g.radius, xf, rg.center, [1, 0, 0], rg.radius,
          t => pos(t) && (g.shape === "sphere" || rg.thickness < t) ? t : null, t => `r ${fmtLen(t)}`);
        if (g.shape === "spherical_shell") {
          scalar("t", [...base, "thickness"], g.thickness, xf, rg.center, [-1, 0, 0], rg.radius + rg.thickness / 2,
            t => { const w = 2 * (t - rg.radius); return pos(w) && w < rg.radius ? w : null; }, t => `wall ${fmtLen(2 * (t - rg.radius))}`);
        }
        break;
      }
      case "hemisphere": case "hemispherical_shell": {
        scalar("r", [...base, "radius"], g.radius, xf, rg.center, [0, 0, 1], rg.radius,
          t => pos(t) && (g.shape === "hemisphere" || rg.thickness < t) ? t : null, t => `r ${fmtLen(t)}`);
        if (g.shape === "hemispherical_shell") {
          scalar("t", [...base, "thickness"], g.thickness, xf, rg.center, [1, 0, 0], rg.radius - rg.thickness,
            t => { const w = rg.radius - t; return pos(w) && w < rg.radius ? w : null; }, t => `wall ${fmtLen(rg.radius - t)}`);
        }
        break;
      }
      case "helix": {
        if (!nums3(rg.origin)) break;
        const axis = V.unit(nums3(rg.axis) ? rg.axis : [0, 0, 1]);
        scalar("d", [...base, "diameter"], g.diameter, xf, rg.origin, V.perp(axis), rg.diameter / 2,
          t => pos(t) ? 2 * t : null, t => `Ø ${fmtLen(2 * t)}`);
        scalar("h", [...base, "height"], g.height, xf, rg.origin, axis, rg.height,
          t => pos(t) ? t : null, t => `height ${fmtLen(t)} · pitch ${fmtLen(t / rg.turns)}`);
        break;
      }
      case "wire": {
        const pts = rg.points, raw = g.points;
        const plain = Array.isArray(raw) && raw.every(q => Array.isArray(q) && q.every(v => typeof v === "number"));
        if (!plain || !Array.isArray(pts) || pts.length > 64 || pts.length >= 8001) break;
        for (let k = 0; k + 1 < pts.length; k++) {
          const key = `insert:${handleKey([...base, "points", k])}`;
          out.set(key, { key, kind: "action", pos: xf.fwd(V.mul(V.add(pts[k], pts[k + 1]), 0.5)), path: [...base, "points"], index: k + 1 });
        }
        break;
      }
    }
  } else if (s.kind === "port") {
    const p = state.doc.ports[s.index], rp = d.ports?.[s.index];
    if (!rp) return out;
    for (const k of ["start", "stop"]) point(["ports", s.index, k], rp[k], p[k], identity);
  }
  return out;
}
let dragDef = null; // handle definition frozen at drag start (geometry changes while dragging)
function onScalarMove(key, t) {
  const hd = dragDef?.key === key ? dragDef : currentHandles.get(key);
  if (!hd || !hd.enabled) return null;
  const v = hd.set(t);
  if (v === null || v === undefined) return null;
  const writes = Array.isArray(v) ? v : [[hd.field, v]];
  if (writes.some(([, x]) => !Number.isFinite(x))) return null;
  for (const [path, x] of writes) {
    const parent = getPath(state.doc, path.slice(0, -1));
    if (!parent) return null;
    parent[path[path.length - 1]] = +x.toFixed(6);
  }
  cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(() => refresh({ inspector: false, params: false, json: false }));
  return hd.label(t);
}
function onHandleTap(key) {
  const hd = currentHandles.get(key);
  if (hd?.kind === "action") {
    // Insert a wire vertex at the segment midpoint and grab it.
    const pts = getPath(state.doc, hd.path);
    const mid = pts[hd.index - 1].map((v, i) => +((v + pts[hd.index][i]) / 2).toFixed(6));
    edit(doc => getPath(doc, hd.path).splice(hd.index, 0, mid));
    state.handle = handleKey([...hd.path, hd.index]);
    syncHandles();
    return;
  }
  state.handle = key;
  syncHandles();
}

function syncHandles() {
  currentHandles = computeHandles();
  if (activeProbe?.run.probeVisible && activeProbe.run.probePosition) currentHandles.set("result-probe", { key: "result-probe", kind: "point", pos: activeProbe.run.probePosition, axes: [true, true, true] });
  if (state.handle && !currentHandles.has(state.handle)) state.handle = null;
  for (const el of document.querySelectorAll("[data-handle]")) el.classList.toggle("handle-active", el.dataset.handle === state.handle);
  if (!viewport) return;
  const dom = state.derived?.resolved?.domain;
  const span = dom && Array.isArray(dom.start) && Array.isArray(dom.stop) ? Math.max(...[0, 1, 2].map(k => Math.abs(dom.stop[k] - dom.start[k]))) : 100;
  viewport.setHandles([...currentHandles.values()], state.handle, Number.isFinite(span) && span > 0 ? niceStep(span / 1000) : 0.1);
}
function onHandleMove(key, world) {
  if (key === "result-probe") {
    if (activeProbe && world.every(Number.isFinite)) { activeProbe.run.probePosition = [...world]; updateProbe(); }
    return;
  }
  const hd = currentHandles.get(key);
  if (!hd) return;
  const local = hd.xf.inv(world);
  if (!Array.isArray(getPath(state.doc, hd.path)) && hd.init) setPath(state.doc, hd.path, clone(hd.init));
  const target = getPath(state.doc, hd.path);
  if (!Array.isArray(target)) return;
  // Refinement corners must remain strictly ordered while dragging.
  if(state.sel?.kind==="refinement"&&hd.path?.[0]==="mesh"){
    const r=state.derived.resolved.mesh?.refinements?.[state.sel.index],dom=state.derived.resolved.domain;
    if(r){
      const start=hd.path.at(-1)==="start",other=start?r.stop:r.start;
      for(let k=0;k<3;k++)if(hd.axes[k]){
        const lo=start?(dom?.start?.[k]??-Infinity):other[k]+.001;
        const hi=start?other[k]-.001:(dom?.stop?.[k]??Infinity);
        if(lo<=hi)local[k]=Math.max(lo,Math.min(hi,local[k]));
      }
    }
  }
  if(hd.path[0]==="probes"&&state.doc.probes[hd.path[1]]?.type==="current"){
    const p=state.doc.probes[hd.path[1]],corner=hd.path[2];
    moveCurrentCorner(p,corner,local,hd.axes);
  }else hd.axes.forEach((ok, k) => { if (ok) target[k] = +local[k].toFixed(6); });
  cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(() => refresh({ inspector: false, params: false, json: false }));
}
function onHandleDrag(on, key) {
  if (key === "result-probe") { if (!on) syncHandles(); return; }
  if (on) { dragDef = currentHandles.get(key) || null; beginLive(); }
  else { dragDef = null; cancelAnimationFrame(dragFrame); endLive(); refresh({ params: false }); } // e.g. sheet ↔ box label
}

// ---------------------------------------------------------------- inspector
function renderInspector() {
  const box = $("inspector");
  fieldRefreshers = inspectorRefreshers = [];
  box.replaceChildren();
  $("inspectActions").replaceChildren();
  const s = state.sel;
  const title = $("inspectTitle");
  if (!s) {
    title.textContent = "Inspector";
    add(box, h("p", { class: "hint", text: "Select a component in the tree or tap it in the 3D view." }),
      h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => openSheet("sim") }, "Simulation settings"),
        h("button", { type: "button", onclick: e => openAddMenu(e.currentTarget, "geometry") }, "+ Add geometry")));
    return;
  }
  if (s.kind === "geometry" && isScriptInstance(state.doc.geometry[s.index])) return inspectScriptInstance(box, title, s.index);
  if (s.kind === "geometry") return inspectGeometry(box, title, s.index);
  if (s.kind === "port") return inspectPort(box, title, s.index);
  if (s.kind === "diagnostic") return inspectDiagnostic(box,title,s.index);
  if (s.kind === "material") return inspectMaterial(box, title, s.index);
  if (s.kind === "refinement") {
    title.textContent="Refinement "+(s.index+1);
    add(box,refinementFields(s.index),h("p",{class:"hint",text:"Select either corner to drag it in XYZ. Close this sheet for a full 3D view."}));
  }
}

// Simulation controls are followed by the sweep and grouped setup cards.
const simDisclosure = new Map();
function renderSim() {
  const box = $("sim");
  const scroll = box.scrollTop;
  for(const el of box.querySelectorAll("details[data-sim-section]"))simDisclosure.set(el.dataset.simSection,el.open);
  fieldRefreshers = simRefreshers = [];
  box.replaceChildren();
  const d = state.derived;
  const runArea=h("div",{class:"sim-run-area"});
  renderRunPanel(runArea,simContext);
  const max=h("button", {type:"button",class:"icon head-btn sim-max-btn",title:"Maximize (Esc to restore)","aria-label":"Maximize simulation panel",
    onclick:()=>setSimMax(!state.simMax)},icon(state.simMax?"minimize":"maximize"));
  runArea.querySelector(".sim-run-head")?.append(max);
  const settings=h("div",{class:"sim-settings"});
  inspectSim(settings,h("span"));
  const grid=h("div",{class:"sim-layout"});
  const sweep=renderSweep(d,new Set(Object.keys(state.doc.sweep?.parameters||{})));
  sweep.classList.add("sim-setup-card","sim-sweep-card");
  grid.append(sweep);
  for(const el of [...settings.children]){
    if(el.matches("details")){
      const key=el.querySelector("summary").textContent;
      el.dataset.simSection=key;
      el.open=simDisclosure.get(key)??(key.startsWith("Excitation")||key.startsWith("Refinements"));
      el.classList.add("sim-setup-card");
      grid.append(el);
    }else if(el.matches(".form-section")){
      const description=h("details",{class:"form-section sim-setup-card", "data-sim-section":"Description"},h("summary",{text:"Description"}),...el.children);
      description.open=simDisclosure.get("Description")??false;
      grid.append(description);
    }else {el.classList.add("sim-setup-notice");grid.prepend(el);}
  }
  add(box,runArea,grid);
  box.scrollTop=scroll;
}
// What the run panel needs from the editor.
const simContext = {
  getCase(c = state.derived.case) {
    const d = state.derived;
    const base = { id: c.id, name: c.name, label: shortCaseLabel(c), index: d.cases.indexOf(c)+1 };
    if (d.caseError) return { ...base, error: d.caseError };
    if (state.doc.generator) return { ...base, error: "configs with a Python generator can only run in the radiators scripts" };
    try {
      const ex = expandResolved(resolveCase(state.doc, c.parameters));
      if (ex.pending) return { ...base, pending: true };
      if (ex.error) return { ...base, error: ex.error };
      return { ...base, config: ex.cfg };
    } catch (e) { return { ...base, error: e.message }; }
  },
  getCases() { return state.derived.cases.map(c=>this.getCase(c)); },
  slug: () => slug(),
  getTemplate: () => structuredClone(state.doc),
  archiveProject: () => { void archiveProject(); },
  onBadge(text) {
    const description = text === "✓" ? "Results available" : text === "!" ? "Failed or partial result" : text ? `Progress ${text}` : "Not running";
    for (const id of ["simBadge", "simBadgeMobile"]) {
      const b = $(id);
      if (!b) continue;
      b.textContent = text;
      b.dataset.status = text === "✓" ? "ok" : text === "!" ? "warn" : text ? "running" : "idle";
      if (id === "simBadgeMobile") {
        b.closest("button").setAttribute("aria-label", text ? `Simulation: ${description}` : "Simulation");
        b.closest("button").title = `Simulation: ${description}`;
      }
    }
  },
  notify: (msg, error = false) => setStatus(msg, error),
  refresh: () => { renderSim(); syncResults(); },
  setDiagnosticFrame: arrows=>viewport?.setDiagnosticFrame(arrows),
};
let displayedRun, displayedStale, displayedCase, displayedCaseStatus, activeProbe = null;
const sectionNames = ["XY", "YZ", "XZ"];
const probeFmt = (v, n = 2) => Number.isFinite(v) ? v.toFixed(n) : "—";
function updateProbe() {
  const controls = $("radiationTools");
  controls.hidden = !activeProbe;
  $("probeReadout").hidden = !activeProbe || !activeProbe.run.probeVisible;
  if (!activeProbe) { viewport?.setSections([]); return; }
  const { run, record } = activeProbe;
  const pos = run.probePosition;
  for (const b of controls.querySelectorAll("[data-section]")) b.setAttribute("aria-pressed", String(run.sections.includes(b.dataset.section)));
  $("probeToggle").setAttribute("aria-pressed", String(run.probeVisible));
  // A hidden probe must never leave the principal planes offset.
  const canFollow = !!run.probeVisible && Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite);
  if (!canFollow) run.followProbe = false;
  $("sectionFollow").disabled = !canFollow;
  $("sectionFollow").setAttribute("aria-pressed", String(!!run.followProbe));
  viewport?.setSections(run.sections, canFollow && run.followProbe ? pos : [0,0,0]);
  if (!pos || !run.probeVisible) return;
  const s = sampleDirection(record, pos);
  if (!s) return;
  $("probePosition").textContent = pos.map((v,i) => `${"XYZ"[i]} ${probeFmt(v,1)}`).join(" · ") + " mm";
  $("probeAngles").textContent = `θ ${probeFmt(s.theta,1)}° · φ ${probeFmt(s.phi,1)}°`;
  $("probeDirectivity").textContent = `${probeFmt(s.directivity)} dBi`;
  $("probeGain").textContent = `${probeFmt(s.gain)} dBi`;
  $("probeRealized").textContent = `${probeFmt(s.realizedGain)} dBi`;
  $("probeField").textContent = probeFmt(s.relativeField === null ? null : s.relativeField * 100,1) + "%";
  $("probeFrequency").textContent = `${probeFmt(record.frequency_hz / 1e9,4)} GHz · Radiated power (global) ${Number.isFinite(s.radiatedPower)?s.radiatedPower.toPrecision(3)+" W":"—"}`;
  $("probeEfficiency").textContent = `Radiation η ${probeFmt(s.radiationEfficiency === null ? null : s.radiationEfficiency * 100,1)}% · Mismatch η ${probeFmt(s.mismatchEfficiency === null ? null : s.mismatchEfficiency * 100,1)}%`;
}
// Mesh preview is lazy and independent of the ground grid and radiation cuts.
let meshPreviewKey=null,meshPreview=null,meshPreviewError=null,meshViewKey=null,meshDisplayedLines=null;
function syncMeshView({resetSlice=false,jump=false}={}){
  const enabled=$("meshToggle").getAttribute("aria-pressed")==="true";
  $("meshTools").hidden=!enabled;
  if(!viewport)return;
  if(!enabled){if(meshViewKey!==null)viewport.setMeshView(null);meshViewKey=null;return;}
  const current=simContext.getCase(),cfg=current.config,run=resultFor(current.id),key=cfg?JSON.stringify(cfg):null;
  let lines=null,label="";
  if(key&&run?.key===key&&validMeshLines(run.result.mesh_lines_mm)){
    lines=run.result.mesh_lines_mm;label="Recorded solver mesh";
  }else if(cfg){
    if(key!==meshPreviewKey){
      meshPreviewKey=key;meshPreview=null;meshPreviewError=null;
      try{meshPreview=buildModel(cfg,{meshOnly:true}).meshLines;}catch(e){meshPreviewError=e.message;}
    }
    lines=meshPreview;label="Generated mesh preview";
  }
  const readout=$("meshReadout"),slider=$("meshSlice"),selector=$("meshPlane");
  if(!validMeshLines(lines)){
    viewport.setMeshView(null);meshViewKey=null;meshDisplayedLines=null;
    slider.disabled=true;$("meshSmallest").disabled=true;
    readout.textContent=meshPreviewError||current.error||"Mesh unavailable until geometry resolves";return;
  }
  $("meshSmallest").disabled=false;
  const minima=meshMinima(lines),worst=minima.reduce((a,b)=>a.min<=b.min?a:b);
  if(jump){
    selector.value=["XY","XY","XZ"][worst.axis];
    $("meshHighlight").checked=true;
  }
  const plane=selector.value,normal=planeAxes[plane]?.[2];
  slider.disabled=normal===undefined;
  if(normal!==undefined){
    slider.max=String(lines[normal].length-1);
    if(resetSlice||lines!==meshDisplayedLines||jump)slider.value=String(nearestLine(lines[normal],0));
  }
  meshDisplayedLines=lines;
  const options={plane,index:Number(slider.value),highlight:$("meshHighlight").checked,pml:$("meshPml").checked,boundary:cfg.domain?.boundary??Array(6).fill("PML_8")};
  const opacity=Number($("meshOpacity").value);
  const renderKey=JSON.stringify([lines,options,opacity]);
  if(renderKey!==meshViewKey){viewport.setMeshView(meshSegments(lines,options),opacity);meshViewKey=renderKey;}
  const dims=lines.map(a=>a.length-1);
  const pos=normal===undefined?"3D (decimated)":"XYZ"[normal]+" = "+Number(lines[normal][Number(slider.value)].toPrecision(7))+" mm";
  readout.textContent=label+" · "+dims.join(" × ")+" · "+pos+" · Min "+"XYZ"[worst.axis]+" "+worst.min.toPrecision(4)+" mm ("+worst.start.toPrecision(6)+" → "+worst.stop.toPrecision(6)+")";
}

// Only an explicit example open requests the Results panel; never reopen it after the user closes it.
let showBundledResultsFor = null;
function syncResults() {
  void restoreResults(simContext);
  syncSweepDownload($("resultBody"),simContext);
  const caseId = state.derived.case.id;
  const run = resultFor(caseId);
  const stale = !!run && JSON.stringify(simContext.getCase().config) !== run.key;
  const caseStatus = caseRunState(caseId);
  if(showBundledResultsFor===state.doc && run && !stale){
    showBundledResultsFor=null;
    if(!mobile() || document.body.dataset.sheet!=="results")openSheet("results");
  }
  syncCaseSelectors();
  if (run !== displayedRun || stale !== displayedStale || displayedCase !== caseId || displayedCaseStatus !== caseStatus) {
    displayedCase = caseId;
    displayedCaseStatus = caseStatus;
    displayedRun = run;
    displayedStale = stale;
    viewport?.setDiagnosticFrame([]);
    renderResults($("resultCharts"), simContext, run, caseId, stale);
    const patterns = stale ? [] : run?.result.patterns || [];
    $("patternWrap").hidden = !patterns.some(p => p.record.radiation_valid);
    $("patternSelect").replaceChildren(new Option("Off", "-1"), ...patterns.map((p, i) => {
      const option = new Option(`${p.frequency_hz / 1e9} GHz · ${p.record.radiation_valid ? p.max_directivity_dbi.toFixed(1) + " dBi peak" : "unavailable"}`, String(i));
      option.disabled = !p.record.radiation_valid;
      return option;
    }));
  }
  $("patternSelect").value = String(run?.frequency ?? -1);
  const record = stale ? null : run?.result.patterns[run.frequency]?.record ?? null;
  viewport?.setRadiation(record);
  if (run && record?.radiation_valid) {
    if (activeProbe?.run !== run && state.handle === "result-probe") state.handle = null;
    run.sections ??= [...sectionNames];
    run.probeVisible ??= true;
    run.followProbe ??= false;
    run.probePosition ??= defaultProbe(record, viewport?.radiationRadius || 50);
    activeProbe = { run, record };
  } else { activeProbe = null; if (state.handle === "result-probe") state.handle = null; }
  updateProbe();
  syncMeshView();
  syncHandles();
}

function setSimMax(on) {
  state.simMax = on;
  document.body.classList.toggle("sim-max", on);
  if (on) {
    if (mobile()) { if (document.body.dataset.sheet !== "sim") openSheet("sim"); document.body.classList.add("sheet-tall"); }
    else setDock("sim");
  } else if (mobile()) document.body.classList.remove("sheet-tall");
  for (const b of document.querySelectorAll(".sim-max-btn")) b.replaceChildren(icon(on ? "minimize" : "maximize"));
  requestAnimationFrame(syncViewInset);
}

// Scripts: JavaScript generators generate(args) → [primitives]; each use is one Model object
// whose editor is generated from the script's `args` declaration.
let scriptStatusEl = null, scriptCommitTimer = 0, scriptEditor = null;
// Maximize: the Scripts panel fills the window (desktop) or the full-height sheet (phone).
function setScriptMax(on) {
  state.scriptMax = on;
  document.body.classList.toggle("script-max", on);
  if (on) {
    if (mobile()) { if (document.body.dataset.sheet !== "scripts") openSheet("scripts"); document.body.classList.add("sheet-tall"); }
    else setDock("scripts");
  } else if (mobile()) document.body.classList.remove("sheet-tall");
  for (const b of document.querySelectorAll(".script-max-btn")) b.replaceChildren(icon(on ? "minimize" : "maximize"));
  requestAnimationFrame(() => { scriptEditor?.refresh(); syncViewInset(); });
}
const maxButton = () => h("button", { type: "button", class: "icon head-btn script-max-btn", title: "Maximize editor (Esc to restore)",
  "aria-label": "Maximize editor", onclick: () => setScriptMax(!state.scriptMax) }, icon(state.scriptMax ? "minimize" : "maximize"));
function renderScripts() {
  const box = $("scripts");
  if (!box || !state.doc) return;
  box.replaceChildren();
  const defs = state.doc.scripts || {};
  const names = Object.keys(defs);
  if (state.scriptSel && !(state.scriptSel in defs) && !isBuiltinScript(state.scriptSel)) state.scriptSel = null;
  if (!state.scriptSel && names.length) state.scriptSel = names[0];
  const pill = (n, builtin) => h("button", { type: "button", class: "script-pill" + (builtin ? " builtin" : "") + (n === state.scriptSel ? " active" : ""),
    title: builtin ? BUILTIN_SCRIPTS[n].description : "", onclick: () => { state.scriptSel = n; renderScripts(); } }, n);
  add(box, h("div", { class: "script-bar" },
    names.map(n => pill(n, false)),
    h("button", { type: "button", class: "small", onclick: newScript }, "+ New script"),
    h("span", { class: "script-bar-sep", text: "Built-in" }),
    Object.keys(BUILTIN_SCRIPTS).map(n => pill(n, true))));
  if (state.scriptSel && isBuiltinScript(state.scriptSel)) { renderBuiltinScript(box, state.scriptSel); return; }
  if (!names.length) {
    add(box, h("div", { class: "empty-state" }, icon("scripts", "empty-ico"), h("h3", { text: "Geometry scripts" }),
      h("p", { class: "hint", text: "A script is a JavaScript function, generate(a) → [primitives], for geometry that is tedious to place by hand: element arrays, radials, tapered directors, meander lines. It declares its arguments (point, length, material…); each use is one object in Model with those arguments as its editor fields, and they can be parameters or expressions." }),
      h("button", { type: "button", class: "primary", onclick: newScript }, "+ New script")));
    scriptStatusEl = null;
    return;
  }
  const name = state.scriptSel;
  const uses = state.doc.geometry.filter(g => g.script === name).length;
  const nameIn = h("input", { type: "text", class: "pname", value: name, spellcheck: "false", autocapitalize: "off", "aria-label": "Script name" });
  nameIn.addEventListener("change", () => renameScript(name, nameIn.value.trim(), nameIn));
  const ta = h("textarea", { class: "code", spellcheck: "false", autocapitalize: "off", autocomplete: "off", "aria-label": `Source of script ${name}` });
  ta.value = defs[name]?.source ?? "";
  let text = () => ta.value;
  const commit = () => {
    clearTimeout(scriptCommitTimer);
    const v = text();
    if (state.doc.scripts?.[name] && state.doc.scripts[name].source !== v) {
      edit(doc => { doc.scripts[name].source = v; }, { scripts: false, inspector: false });
    }
  };
  upgradeTextarea(ta, { onChange: (v, now) => {
    text = () => v;
    clearTimeout(scriptCommitTimer);
    if (now) commit(); else scriptCommitTimer = setTimeout(commit, 500);
  } }).then(ed => { scriptEditor = ed; });
  ta.addEventListener("input", () => { clearTimeout(scriptCommitTimer); scriptCommitTimer = setTimeout(commit, 500); });
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", e => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  });
  scriptStatusEl = h("div", { class: "script-status" });
  add(box, h("div", { class: "script-editor" },
    h("div", { class: "script-code" },
      h("div", { class: "script-head" }, h("label", { class: "lbl", text: "Name" }), nameIn,
        h("span", { class: "unit", text: `${uses} use${uses === 1 ? "" : "s"}` }), maxButton()),
      ta),
    h("div", { class: "script-side" }, scriptStatusEl,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => addScriptInstance(name) }, "Add to model"),
        h("button", { type: "button", class: "danger", disabled: uses > 0, title: uses ? "Used by objects in Model" : "",
          onclick: () => edit(doc => { delete doc.scripts[name]; if (!Object.keys(doc.scripts).length) delete doc.scripts; }) }, "Delete")))));
  updateScriptStatus();
}
// Built-in scripts are read-only; copy one to make an editable variant.
function renderBuiltinScript(box, name) {
  const b = BUILTIN_SCRIPTS[name];
  const uses = state.doc.geometry.filter(g => g.script === name).length;
  const ta = h("textarea", { class: "code", readonly: true, spellcheck: "false", "aria-label": `Source of built-in script ${name}` });
  ta.value = b.source;
  upgradeTextarea(ta, { readOnly: true }).then(ed => { scriptEditor = ed; });
  scriptStatusEl = h("div", { class: "script-status" });
  add(box, h("div", { class: "script-editor" },
    h("div", { class: "script-code" },
      h("div", { class: "script-head" }, h("span", { class: "prim-chip", text: `Built-in · ${name}` }),
        h("span", { class: "unit", text: `${b.description} ${uses} use${uses === 1 ? "" : "s"}.` }), maxButton()),
      ta),
    h("div", { class: "script-side" }, scriptStatusEl,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => addScriptInstance(name) }, "Add to model"),
        h("button", { type: "button", onclick: () => newScript(b.source, `my_${name}`) }, "Copy as new script")))));
  updateScriptStatus();
}
function updateScriptStatus() {
  const el = scriptStatusEl;
  if (!el?.isConnected || !state.scriptSel) return;
  const sp = specFor(state.scriptSel);
  if (sp.pending) return el.replaceChildren(h("p", { class: "hint", text: "Checking script…" }));
  if (sp.error) return el.replaceChildren(h("div", { class: "note warn", text: sp.error }));
  const rows = Object.entries(sp.spec).map(([k, d]) => h("tr", {},
    h("td", { class: "pname", text: k }), h("td", { text: d.type }),
    h("td", { class: "uses", text: d.default === undefined ? "first material" : JSON.stringify(d.default) })));
  el.replaceChildren(h("h3", { class: "side-title", text: "Arguments" }),
    rows.length ? h("table", { class: "ptable" }, h("tbody", {}, rows)) : h("p", { class: "hint", text: "No arguments declared (const args = {…})." }),
    h("p", { class: "hint", text: "generate(a) returns primitives written like geometry entries; a missing material uses the first material argument." }));
}
function newScript(source = SCRIPT_TEMPLATE, base = "script") {
  if (typeof source !== "string") source = SCRIPT_TEMPLATE; // called as a click handler
  const used = new Set([...Object.keys(state.doc.scripts || {}), ...Object.keys(BUILTIN_SCRIPTS)]);
  let n = base, k = 1;
  if (base === "script") n = "script1";
  while (used.has(n)) n = `${base}${++k}`; // identifiers only (no "-")
  edit(doc => { doc.scripts ??= {}; doc.scripts[n] = { source }; });
  state.scriptSel = n;
  renderScripts();
}
function renameScript(from, to, input) {
  if (to === from) return;
  if (!SCRIPT_NAME.test(to)) { input.value = from; return setStatus("Script names are identifiers (letters, digits, _)", true); }
  if (to in (state.doc.scripts || {}) || isBuiltinScript(to)) { input.value = from; return setStatus(`Script name ${to} is taken`, true); }
  edit(doc => {
    doc.scripts = Object.fromEntries(Object.entries(doc.scripts).map(([k, v]) => [k === from ? to : k, v]));
    doc.geometry.forEach(g => { if (g.script === from) g.script = to; });
  });
  state.scriptSel = to;
  renderScripts();
}
async function addScriptInstance(name) {
  closeMenus();
  let sp = specFor(name);
  // Wait (briefly) for the script's argument list so the new object gets explicit defaults.
  for (let k = 0; sp.pending && k < 60; k++) { await new Promise(r => setTimeout(r, 100)); sp = specFor(name); }
  const args = {};
  for (const [k, d] of Object.entries(sp.spec || {})) {
    if (d.default !== undefined) args[k] = clone(d.default);
    else if (d.type === "material" && state.doc.materials[0]) args[k] = state.doc.materials[0].name;
  }
  edit(doc => {
    if (!doc.materials.length) doc.materials.push({ name: "pec-metal", type: "pec" });
    doc.geometry.push({ name: uniqueName(doc.geometry.map(g => g.name), name), script: name, args });
    state.sel = { kind: "geometry", index: doc.geometry.length - 1 };
  });
  closeMenus();
  setStatus(`Added ${name}; its arguments are in the object editor`);
  if (mobile()) openSheet("inspect", { peek: true });
}

function knownKeysNote(obj, known) {
  const extra = Object.keys(obj).filter(k => !known.includes(k));
  return extra.length ? h("p", { class: "hint", text: "Also preserved (edit in JSON): " + extra.join(", ") }) : null;
}

function inspectGeometry(box, title, i) {
  const g = state.doc.geometry[i];
  const def = SHAPES[g.shape];
  title.replaceChildren(g.name || g.shape);
  add(box,objectEnabledRow(g,i));
  $("inspectActions").append(
    iconBtn("copy", "Duplicate (Ctrl+D)", () => duplicate("geometry", i)),
    iconBtn("array", "Array…", () => arrayDialog(i)),
    iconBtn("up", "Move up", () => move("geometry", i, -1), { disabled: i === 0 }),
    iconBtn("down", "Move down", () => move("geometry", i, 1), { disabled: i === state.doc.geometry.length - 1 }),
    iconBtn("trash", "Delete", () => remove("geometry", i), { danger: true }));
  const base = ["geometry", i];
  const err = state.derived.errors.geometry[i];
  add(box,
    err ? h("div", { class: "note warn", text: err }) : null,
    row("Name", textField([...base, "name"], { aria: "Component name", onCommit: (v, input) => {
      if (!v) { input.value = g.name || ""; return setStatus("Name is required", true); }
      if (state.doc.geometry.some((o, k) => k !== i && o.name === v)) { input.value = g.name || ""; return setStatus("Component names must be unique", true); }
      edit(doc => { doc.geometry[i].name = v; });
    } })),
    row("Material", selectField([...base, "material"], state.doc.materials.map(m => [m.name, `${m.name} (${m.type})`]), { aria: "Material" })),
    h("div", { class: "row" }, h("span", { class: "lbl", text: "Primitive" }),
      h("div", { class: "prim-row" }, h("span", { class: "prim-chip", text: primitiveLabel(g, state.derived.geometry[i]) }),
        def?.hint ? h("span", { class: "unit", text: def.hint }) : null)));
  if (!def) { add(box, h("div", { class: "note warn", text: "This shape is not part of schema v2; edit it in JSON." })); return; }
  if (g.shape === "helix") {
    add(box, h("div", { class: "note" }, "Helix is not a CSXCAD primitive; it is now the built-in helix script (one Wire). ",
      h("button", { type: "button", class: "small", onclick: () => convertHelix(i) }, "Convert to built-in script")));
  }
  if (/^hemispher/.test(g.shape)) {
    add(box, h("div", { class: "note" }, "Hemisphere is not a CSXCAD primitive; it is now the built-in hemisphere script (one Polyhedron). ",
      h("button", { type: "button", class: "small", onclick: () => convertHemisphere(i) }, "Convert to built-in script")));
  }
  if (g.shape === "polyhedron") {
    const n = Array.isArray(g.vertices) ? g.vertices.length : "?", m = Array.isArray(g.faces) ? g.faces.length : "?";
    add(box, h("p", { class: "hint", text: `${n} vertices, ${m} faces. Edit the lists in the JSON view.` }));
  }
  for (const f of def.fields.filter(f => isMainField(f, g))) add(box, row(f.label, fieldFor(f, [...base, f.key]), f.type === "points" ? "wide" : ""));
  if (g.transform) {
    if (g.transform.rotate_deg) add(box, row("Rotate", vec3Field([...base, "transform", "rotate_deg"], { optional: true, label: "rotate" })));
    if (g.transform.translate) add(box, row("Translate", vec3Field([...base, "transform", "translate"], { optional: true, label: "translate" })));
  }
  const rg = state.derived.geometry[i];
  let bounds = null;
  if (rg) {
    try {
      bounds = worldBoundsNote(rg);
    } catch { /* reported in checks */ }
  }
  add(box, moreSection(
    ...def.fields.filter(f => !isMainField(f, g)).map(f => row(f.label, fieldFor(f, [...base, f.key]))),
    !g.transform?.rotate_deg ? row("Rotate", vec3Field([...base, "transform", "rotate_deg"], { optional: true, label: "rotate" })) : null,
    !g.transform?.translate ? row("Translate", vec3Field([...base, "transform", "translate"], { optional: true, label: "translate" })) : null,
    row("Priority", numField([...base, "priority"], { optional: true, def: 10, int: true, aria: "Priority" })),
    bounds,
    h("p", { class: "hint", text: (def.hint ? def.hint + " " : "") + "Transform: rotate X→Y→Z, then translate. Higher priority wins where primitives overlap (default 10; ports 5)." }),
    g.transform ? h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(doc => { delete doc.geometry[i].transform; }) }, "Clear transform")) : null,
    knownKeysNote(g, ["name", "material", "shape", "transform", "priority", "editor_id", "enabled", ...def.fields.map(f => f.key)])));
}

const LEGACY_SHAPES = new Set(["helix", "hemisphere", "hemispherical_shell"]);
function convertHemisphere(i) {
  edit(doc => {
    const g = doc.geometry[i];
    const args = { center:g.center, radius: g.radius, material: g.material };
    if (g.shape === "hemispherical_shell") args.thickness = g.thickness;
    const out = { name: g.name, script: "hemisphere", args };
    if (g.priority !== undefined) out.priority = g.priority;
    if (g.transform) out.transform = clone(g.transform);
    doc.geometry[i] = out;
  });
}
function convertHelix(i) {
  edit(doc => {
    const g = doc.geometry[i];
    const args = { origin: g.origin, diameter: g.diameter, height: g.height, turns: g.turns, wire_diameter: g.wire_diameter, material: g.material };
    if (g.axis !== undefined) args.axis = g.axis;
    if (g.phase_deg !== undefined) args.phase = g.phase_deg;
    if (g.segments_per_turn !== undefined) args.segments_per_turn = g.segments_per_turn;
    const out = { name: g.name, script: "helix", args };
    if (g.priority !== undefined) out.priority = g.priority;
    if (g.transform) out.transform = clone(g.transform);
    doc.geometry[i] = out;
  });
}

function worldBoundsNote(parts) {
  try {
    const [lo,hi]=displayBounds(parts);
    return h("p",{class:"hint world-bounds",text:`World bounds: [${lo.map(fmt).join(", ")}] → [${hi.map(fmt).join(", ")}] mm`});
  }catch{return null;}
}

// Script instance: the object editor is generated from the script's argument declarations.
function inspectScriptInstance(box, title, i) {
  const g = state.doc.geometry[i];
  const base = ["geometry", i];
  title.replaceChildren(g.name || g.script);
  add(box,objectEnabledRow(g,i));
  $("inspectActions").append(
    iconBtn("copy", "Duplicate (Ctrl+D)", () => duplicate("geometry", i)),
    iconBtn("array", "Array…", () => arrayDialog(i)),
    iconBtn("up", "Move up", () => move("geometry", i, -1), { disabled: i === 0 }),
    iconBtn("down", "Move down", () => move("geometry", i, 1), { disabled: i === state.doc.geometry.length - 1 }),
    iconBtn("trash", "Delete", () => remove("geometry", i), { danger: true }));
  const err = state.derived.errors.geometry[i];
  const sp = specFor(g.script);
  const ex = state.derived.expanded[i];
  add(box,
    err ? h("div", { class: "note warn", text: err }) : null,
    row("Name", textField([...base, "name"], { aria: "Object name", onCommit: (v, input) => {
      if (!v) { input.value = g.name || ""; return setStatus("Name is required", true); }
      if (state.doc.geometry.some((o, k) => k !== i && o.name === v)) { input.value = g.name || ""; return setStatus("Names must be unique", true); }
      edit(doc => { doc.geometry[i].name = v; });
    } })),
    h("div", { class: "row" }, h("span", { class: "lbl", text: "Primitive" }),
      h("div", { class: "prim-row" }, h("span", { class: "prim-chip", text: `Script · ${g.script}` }),
        h("button", { type: "button", class: "small", onclick: () => { state.scriptSel = g.script; renderScripts(); openSheet("scripts"); } }, "Edit script"))));
  // Placement belongs to the instance, not to its script-defined arguments.
  const transformField = (key,label,unit) => {
    const path=[...base,"transform",key];
    return row(label,vec3Field(path,{label,unit,defaults:[0,0,0],prepare:doc=>{
      if(!Array.isArray(getPath(doc,path)))setPath(doc,path,[0,0,0]);
    }}));
  };
  add(box,transformField("translate","Translate","mm"),transformField("rotate_deg","Rotate","°"),
    h("p",{class:"hint",text:"Group transform: rotate X → Y → Z about the local origin, then translate."}),
    g.transform ? h("div",{class:"actions"},h("button",{type:"button",class:"small",onclick:()=>edit(doc=>{delete doc.geometry[i].transform;})},"Clear transform")):null);
  if (sp.pending) { add(box, h("p", { class: "hint", text: "Loading script…" })); return; }
  if (sp.error) { add(box, h("div", { class: "note warn", text: `Script ${g.script}: ${sp.error}` })); return; }
  // `more: true` arguments sit under "More" unless the object sets a non-default value.
  const isMainArg = (key, d) => !d.more || (g.args?.[key] !== undefined && JSON.stringify(g.args[key]) !== JSON.stringify(d.default));
  const entries = Object.entries(sp.spec);
  for (const [key, d] of entries.filter(([k, d]) => isMainArg(k, d))) add(box, argRow(i, key, d));
  const extra = Object.keys(g.args || {}).filter(k => !(k in sp.spec));
  add(box, moreSection(
    ...entries.filter(([k, d]) => !isMainArg(k, d)).map(([k, d]) => argRow(i, k, d)),
    row("Priority", numField([...base, "priority"], { optional: true, def: 10, int: true, aria: "Priority" })),
    ex?.objects?.length ? worldBoundsNote(ex.objects) : null,
    ex?.objects ? h("p", { class: "hint", text: `Generates ${ex.objects.length} object${ex.objects.length === 1 ? "" : "s"}: ` +
      ex.objects.slice(0, 16).map(o => `${o.name.slice(o.name.indexOf("/") + 1)} (${o.shape})`).join(", ") + (ex.objects.length > 16 ? " …" : "") }) : null,
    extra.length ? h("div", { class: "note warn" }, `Not declared by the script: ${extra.join(", ")} `,
      h("button", { type: "button", class: "small", onclick: () => edit(doc => { for (const k of extra) delete doc.geometry[i].args[k]; }) }, "Remove")) : null,
    h("p", { class: "hint", text: "Script objects act as one part: clicking any piece selects this object. Values may be parameters or expressions." })));
}
function argRow(i, key, d) {
  const control = argControl(i, key, d);
  if (!d.hint) return row(d.label, control);
  return h("div", { class: "row" }, h("label", { text: d.label }),
    h("div", { class: "arg-field" }, control, h("div", { class: "field-hint", text: d.hint })));
}
// One input per declared argument, typed like the matching primitive field.
function argControl(i, key, d) {
  const path = ["geometry", i, "args", key];
  const t = ARG_TYPES[d.type];
  switch (t.control) {
    case "vec3": return vec3Field(path, { label: d.label, unit:d.type==="point"?"mm":"", optional: true, defaults: d.default, step: d.step,
      prepare: doc => { if (!Array.isArray(getPath(doc, path))) setPath(doc, path, clone(d.default)); } });
    case "num": return numField(path, { optional: true, def: d.default, unit: t.unit, aria: d.label, step: d.step });
    case "int": return numField(path, { optional: true, def: d.default, int: true, aria: d.label, step: d.step ?? 1 });
    case "material": return selectField(path, state.doc.materials.map(m => [m.name, `${m.name} (${m.type})`]),
      { optional: true, aria: d.label, emptyLabel: state.doc.materials[0] ? `First material (${state.doc.materials[0].name})` : "—" });
    case "select": return selectField(path, d.options, { optional: true, aria: d.label });
    case "bool": return checkField(path, d.label, d.default);
  }
  return h("span", { text: "?" });
}

function inspectPort(box, title, i) {
  const p = state.doc.ports[i];
  const def = PORTS[p.type === "lumped_port" ? "lumped" : p.type];
  title.replaceChildren(`${p.name || "Port"} #${p.id ?? i + 1}`, h("span", { class: "title-tag", text: def ? def.label : p.type }));
  $("inspectActions").append(
    iconBtn("copy", "Duplicate", () => duplicate("port", i)),
    iconBtn("trash", "Delete", () => remove("port", i), { danger: true }));
  const base = ["ports", i];
  const excite = h("input", { type: "checkbox" });
  excite.checked = !!p.excite;
  excite.addEventListener("change", () => edit(doc => {
    doc.ports.forEach((q, k) => { if (k === i) q.excite = excite.checked; else if (excite.checked && q.excite) q.excite = false; });
  }));
  const err = state.derived.errors.port[i];
  add(box, err ? h("div", { class: "note warn", text: err }) : null,
    h("div", { class: "row" }, h("label", { text: "Name · ID" }),
      h("div", { class: "pair" }, textField([...base, "name"], { optional: true, aria: "Port name" }), numField([...base, "id"], { int: true, aria: "Port ID" }))),
    row("Type", selectField([...base, "type"], Object.entries(PORTS).map(([k, v]) => [k, v.label]), { aria: "Port type", onCommit: v => edit(doc => {
      const old = doc.ports[i];
      doc.ports[i] = { id: old.id, name: old.name, type: v, ...clone(PORTS[v].template), start: old.start, stop: old.stop, excite: old.excite };
      const pec = doc.materials.find(m => m.type === "pec");
      if (v !== "lumped" && pec) doc.ports[i].metal_material = pec.name;
    }) })),
    h("div", { class: "row" }, h("span", { class: "lbl" }), h("label", { class: "check-inline" }, excite, "Excited (one per run)")));
  if (def) {
    for (const f of def.fields.filter(f => isMainField(f, p))) add(box, row(f.label, fieldFor(f, [...base, f.key])));
    if (p.type !== "lumped" && !state.doc.materials.some(m => m.type === "pec")) {
      add(box, h("div", { class: "note warn", text: "This port type needs a PEC material." }));
    }
  }
  add(box, moreSection(
    ...(def?.fields.filter(f => !isMainField(f, p)) || []).map(f => row(f.label, fieldFor(f, [...base, f.key]))),
    row("Priority", numField([...base, "priority"], { optional: true, def: 5, int: true, aria: "Port priority" })),
    h("p", { class: "hint", text: "One excited port per FDTD run; the simulator exports S11 of that port only." }),
    knownKeysNote(p, ["id", "name", "type", "excite", "priority", ...(def?.fields.map(f => f.key) || [])])));
}

function currentPlaneFields(p,base,i){
  const direction=currentDirection(p),k=currentPlaneAxis(p),axis="XYZ"[k],tangent=[0,1,2].filter(j=>j!==k);
  const select=h("select",{"aria-label":"Current plane normal"});
  for(const d of ["x","y","z","-x","-y","-z"]){
    const n="xyz".indexOf(d.replace("-",""));
    select.append(h("option",{value:d,text:(d.startsWith("-")?"−":"+")+"XYZ"[n]+" · "+["YZ","XZ","XY"][n]+" plane"}));
  }
  select.value=direction;
  select.onchange=()=>edit(doc=>setCurrentDirection(doc.probes[i],select.value));
  const corner=which=>{
    const path=[...base,which],control=h("div",{class:"pair","data-handle":handleKey(path)},
      ...tangent.map(j=>numField([...path,j],{unit:"mm",aria:"Current "+which+" "+"XYZ"[j]})));
    control.addEventListener("focusin",()=>{const key=handleKey(path);if(currentHandles.has(key)){state.handle=key;syncHandles();}});
    return row(which==="start"?"Start "+tangent.map(j=>"XYZ"[j]).join("/"):"Stop "+tangent.map(j=>"XYZ"[j]).join("/"),control);
  };
  return [
    row("Plane normal",select),
    row(axis+" position",numField([...base,"start",k],{unit:"mm",aria:"Current plane "+axis+" position",
      write:(doc,v)=>{const q=doc.probes[i];q.direction=direction;setCurrentPosition(q,v);}})),
    ...(!currentPlaneLinked(p)?[h("div",{class:"note warn",text:"This current probe has thickness along "+axis+". Flatten it at the start coordinate before running."}),
      h("button",{type:"button",class:"small",onclick:()=>edit(doc=>setCurrentDirection(doc.probes[i],direction))},"Flatten to "+["YZ","XZ","XY"][k]+" plane")]:[]),
    corner("start"),corner("stop"),
    h("p",{class:"hint",text:"Zero thickness along the normal. The shared plane position moves both corners; expressions are supported."})
  ];
}

function inspectDiagnostic(box,title,i){
  const p=state.doc.probes[i],base=["probes",i];
  title.textContent=p.name;
  $("inspectActions").append(iconBtn("copy","Duplicate",()=>duplicate("diagnostic",i)),
    iconBtn("trash","Delete",()=>remove("diagnostic",i),{danger:true}));
  add(box,row("Name",textField([...base,"name"],{aria:"Diagnostic name"})),
    checkField([...base,"enabled"],"Enabled",true),
    ...(p.type==="current"?currentPlaneFields(p,base,i):[row("Start",vec3Field([...base,"start"],{unit:"mm"})),
    row("Stop",vec3Field([...base,"stop"],{unit:"mm"}))]),
    ...["translate","rotate_deg"].map(k=>row(k==="translate"?"Translate":"Rotate (90° steps)",vec3Field([...base,"transform",k],{unit:k==="translate"?"mm":"°",placeholder:"0",prepare:d=>{const p=d.probes[i];p.transform??={};p.transform[k]??=[0,0,0];}}))),
    p.type==="voltage"?row("Direction (local)",selectField([...base,"direction"],["x","y","z","-x","-y","-z"],{optional:true,emptyLabel:"Automatic"})):null,
    p.type==="field_dump"?row("Field",selectField([...base,"field"],["E","H","J","J_total","D","B"])):null,
    p.type==="field_dump"?row("Spatial subsampling",vec3Field([...base,"sub_sampling"],{int:true,unit:"",placeholder:"2",prepare:d=>{d.probes[i].sub_sampling??=[2,2,2];}})):null,
    p.type==="field_dump"?row("Field interpolation",selectField([...base,"dump_mode"],[["node","Node"],["cell","Cell"]],{optional:true,emptyLabel:"Node (default)"})):null,
    checkField([...base,"time_domain","enabled"],"Record time domain",true),
    row("Time oversampling",numField([...base,"time_domain","oversampling"],{optional:true,int:true,placeholder:"Native default"})),
    checkField([...base,"frequency_domain","enabled"],"Record frequency domain",false),
    ...(p.frequency_domain?.frequencies_hz??[]).map((_,j)=>h("div",{class:"row"},h("label",{text:"Frequency "+(j+1)}),
      numField([...base,"frequency_domain","frequencies_hz",j],{unit:"Hz"}),
      h("button",{type:"button",class:"small",onclick:()=>edit(d=>d.probes[i].frequency_domain.frequencies_hz.splice(j,1))},"Remove"))),
    h("button",{type:"button",class:"small",onclick:()=>edit(d=>{
      const p=d.probes[i];p.frequency_domain??={enabled:true};p.frequency_domain.frequencies_hz??=[];
      if(p.frequency_domain.frequencies_hz.length<12)p.frequency_domain.frequencies_hz.push(state.derived.resolved.excitation?.center_hz??2.45e9);
    })},"+ Frequency"),
    h("p",{class:"hint",text:"Passive measurement. Current requires a plane, voltage a line, point E/H a point, and dumps a plane or volume. Supported by both local WASM and remote native solvers."}));
}

function inspectMaterial(box, title, i) {
  const m = state.doc.materials[i];
  title.replaceChildren(m.name, h("span", { class: "title-tag", text: "material" }));
  const base = ["materials", i];
  const uses = state.doc.geometry.filter(g => g.material === m.name).length +
    state.doc.ports.filter(p => p.metal_material === m.name || p.dielectric_material === m.name).length;
  const def = MATERIALS[m.type];
  $("inspectActions").append(
    iconBtn("copy", "Duplicate", () => duplicate("material", i)),
    iconBtn("trash", uses ? "In use; cannot delete" : "Delete", () => remove("material", i), { disabled: uses > 0, danger: true }));
  add(box, h("div", {},
    row("Name", textField([...base, "name"], { aria: "Material name", onCommit: (v, input) => {
      if (!v) { input.value = m.name; return setStatus("Name is required", true); }
      if (state.doc.materials.some((o, k) => k !== i && o.name === v)) { input.value = m.name; return setStatus("Duplicate material name", true); }
      const old = m.name;
      edit(doc => {
        doc.materials[i].name = v;
        doc.geometry.forEach(g => { if (g.material === old) g.material = v; });
        doc.ports.forEach(p => { if (p.metal_material === old) p.metal_material = v; if (p.dielectric_material === old) p.dielectric_material = v; });
      });
    } })),
    row("Type", selectField([...base, "type"], Object.entries(MATERIALS).map(([k, v]) => [k, v.label]), { aria: "Material type", onCommit: v => edit(doc => {
      const next = { name: m.name, type: v };
      for (const f of MATERIALS[v].fields) if (!f.optional) next[f.key] = m[f.key] ?? f.default;
      doc.materials[i] = next;
    }) })),
    ...(def?.fields || []).map(f => row(f.label, numField([...base, f.key], { optional: f.optional, def: f.default, unit:f.unit, aria: f.label })))),
  h("p", { class: "hint", text: `Used by ${uses} item${uses === 1 ? "" : "s"}.` + (m.type === "conducting_sheet" ? " Conducting sheets apply only to zero-thickness boxes; thickness is in metres." : "") }));
}

// Refinements are regular saved mesh entries. Presets use the currently
// resolved case, leaving the coordinates editable and expression-capable.
function feedRegion(){
  const ports=state.derived?.ports||[],p=ports.find(p=>p&&(p.excite??p.enabled))||ports.find(p=>p);
  if(!p||!nums3(p.start)||!nums3(p.stop))return null;
  return {start:p.start.map((v,i)=>Math.min(v,p.stop[i])-5),stop:p.start.map((v,i)=>Math.max(v,p.stop[i])+5),resolution_mm:.25};
}
function addRefinement(aroundFeed){
  const r=aroundFeed?feedRegion():{start:[-10,-10,-10],stop:[10,10,10],resolution_mm:.5};
  if(!r)return;
  const dom=state.derived?.resolved?.domain;
  if(nums3(dom?.start)&&nums3(dom?.stop)){
    r.start=r.start.map((v,i)=>Math.max(v,dom.start[i]));
    r.stop=r.stop.map((v,i)=>Math.min(v,dom.stop[i]));
    if(!r.stop.every((v,i)=>v>r.start[i])){
      if(aroundFeed)return setStatus("Feed refinement is outside the domain",true);
      r.start=dom.start.map((v,i)=>v+(dom.stop[i]-v)*.25);
      r.stop=dom.start.map((v,i)=>v+(dom.stop[i]-v)*.75);
    }
  }
  edit(doc=>{
    doc.mesh??={};doc.mesh.refinements??=[];
    doc.mesh.refinements.push({...r,enabled:true});
    state.sel={kind:"refinement",index:doc.mesh.refinements.length-1};
    state.handle=null;
  });
}
function selectRefinement(k,corner,view=false){
  if(!state.doc.mesh?.refinements?.[k])return;
  const changed=state.sel?.kind!=="refinement"||state.sel.index!==k;
  state.sel={kind:"refinement",index:k};
  state.handle=corner?handleKey(["mesh","refinements",k,corner]):null;
  if(changed)renderInspector();
  viewport?.setSelection(state.sel);
  showChip();
  syncHandles();
  for(const el of document.querySelectorAll("[data-refinement]"))el.classList.toggle("selected",Number(el.dataset.refinement)===k);
  if(view){
    if(state.simMax)setSimMax(false);
    if(mobile())closeSheet();
    viewport?.focus(state.sel);
  }
}
function refinementFields(k){
  const r=state.doc.mesh?.refinements?.[k];
  if(!r)return null;
  const enabled=r.enabled!==false;
  const toggle=h("input",{type:"checkbox","aria-label":"Enable refinement "+(k+1)});
  toggle.checked=enabled;
  toggle.addEventListener("change",()=>edit(doc=>{doc.mesh.refinements[k].enabled=toggle.checked;if(!toggle.checked&&state.sel?.kind==="refinement"&&state.sel.index===k)state.handle=null;}));
  return h("div",{class:"refinement-box"+(!enabled?" refinement-disabled":"")+(state.sel?.kind==="refinement"&&state.sel.index===k?" selected":""),"data-refinement":k},
    h("div",{class:"refinement-head"},
      h("button",{type:"button",class:"refinement-name",onclick:()=>selectRefinement(k)},h("span",{class:"swatch",style:"background:#9d7bff"}),"Box "+(k+1)),
      h("button",{type:"button",class:"small",disabled:!enabled,onclick:()=>selectRefinement(k,"start",true)},"Edit in 3D"),
      h("button",{type:"button",class:"small danger","aria-label":"Remove refinement "+(k+1),onclick:()=>remove("refinement",k)},"×")),
    h("label",{class:"check-inline"},toggle,"Enabled"),
    ...["start","stop"].map(key=>{
      const field=vec3Field(["mesh","refinements",k,key],{label:"refinement "+(k+1)+" "+key});
      field.addEventListener("focusin",()=>selectRefinement(k,key));
      return row(key==="start"?"Start":"Stop",field);
    }),
    row("Resolution",numField(["mesh","refinements",k,"resolution_mm"],{unit:"mm",aria:"Refinement "+(k+1)+" resolution"})));
}
function inspectSim(box, title) {
  title.textContent = "Simulation settings";
  const doc = state.doc;
  const boundary = doc.domain?.boundary;
  const bSel = (k, label) => selectField(["domain", "boundary", k], BOUNDARIES.includes(boundary?.[k]) || !boundary ? BOUNDARIES : [...BOUNDARIES, boundary[k]], {
    aria: "Boundary " + label, onCommit: v => edit(d => { d.domain ??= {}; d.domain.boundary ??= Array(6).fill("PML_8"); d.domain.boundary[k] = v; }) });
  const refinements = doc.mesh?.refinements || [];
  const s11 = doc.outputs?.s11 || [];
  const pats = doc.outputs?.radiation_frequencies_hz || [];
  add(box, 
    doc.generator ? h("div", { class: "note warn", text: `Python generator ${doc.generator.path}: geometry and ports are generated when the radiators scripts run. The editor preview shows the base config only.` }) : null,
    h("div", { class: "form-section" },
      row("Description", (() => { const t = h("textarea", { rows: 3, "aria-label": "Description" }); t.value = doc.description || "";
        t.addEventListener("change", () => edit(d => { d.description = t.value || undefined; }, { inspector: false })); return t; })())),
    h("details", { class: "form-section", open: true }, h("summary", { text: "Excitation · Gaussian pulse" }),
      row("Center", numField(["excitation", "center_hz"], { unit: "Hz", aria: "Center frequency" })),
      row("Bandwidth (fc)", numField(["excitation", "bandwidth_hz"], { unit: "Hz", aria: "Bandwidth" })),
      h("p", { class: "hint" }, "Band = center ± fc. Example: ", h("code", {text:"{f_ghz} GHz"}), ".")),
    h("details", { class: "form-section", open: true }, h("summary", { text: "Domain · "+displayUnit("mm",doc.workspace_units) }),
      row("Start", vec3Field(["domain", "start"], { label: "domain start" })),
      row("Stop", vec3Field(["domain", "stop"], { label: "domain stop" })),
      h("div", { class: "row" }, h("span", { class: "lbl", text: "Boundaries" }),
        h("div", { class: "vec3" }, ["x−", "y−", "z−"].map((l, k) => bSel([0, 2, 4][k], l)))),
      h("div", { class: "row" }, h("span", { class: "lbl", text: "" }),
        h("div", { class: "vec3" }, ["x+", "y+", "z+"].map((l, k) => bSel([1, 3, 5][k], l)))),
      h("p", { class: "hint", text: "Order: x−, x+, y−, y+, z−, z+. Leave ≥ λ/4 between radiators and PML for far-field accuracy." }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: fitDomain }, "Fit domain to geometry (+λ/4)"))),
    h("details", { class: "form-section", open: true }, h("summary", { text: "Mesh" }),
      row("Max cell", numField(["mesh", "max_cell_mm"], { unit: "mm", aria: "Max cell" })),
      row("Growth ratio", numField(["mesh", "growth_ratio"], { optional: true, def: 1.4, aria: "Growth ratio" })),
      row("Max cells", numField(["mesh", "max_cells"], { optional: true, def: 5000000, int: true, aria: "Max cells" })),
      row("Local min cell", numField(["mesh", "local_min_cell_mm"], { optional: true, unit: "mm", aria: "Local min cell" })),
      row("Auto-refine span", numField(["mesh", "auto_refine_max_span_mm"], { optional: true, def: 40, unit: "mm", aria: "Auto refine span" })),
      row("Grid mode", selectField(["mesh", "grid_mode"], ["feature", "uniform"], { optional: true, aria: "Grid mode" })),
      doc.mesh?.grid_mode === "uniform" ? row("Uniform step", numField(["mesh", "uniform_step_mm"], { optional: true, unit: "mm", aria: "Uniform step" })) : null),
    h("details", {class:"form-section refinement-section",open:true},h("summary",{text:"Refinements ("+refinements.length+")"}),
      doc.mesh?.grid_mode==="uniform" ? h("p",{class:"note warn",text:"Uniform grid ignores local refinements. Select Feature grid in Mesh."}):null,
      h("div",{class:"refinement-actions"},h("button",{type:"button",onclick:()=>addRefinement(false)},"+ Box"),
        h("button",{type:"button",disabled:!feedRegion(),onclick:()=>addRefinement(true)},"+ Around feed")),
      h("p",{class:"hint",text:"Enabled boxes override the global spacing where finer. The finest overlapping box wins; equal or coarser spacing adds no lines. Box boundaries snap outwards to existing mesh cells. Select an enabled box to drag its corners. Around feed uses 5 mm padding and 0.25 mm spacing in the current case."}),
      ...refinements.map((r,k)=>refinementFields(k))),
    h("details", { class: "form-section", open: true }, h("summary", { text: "Outputs" }),
      ...s11.map((s, k) => h("div", { class: "note" },
        h("div", { class: "hint", text: `S11 sweep ${k + 1}` }),
        row("Start", numField(["outputs", "s11", k, "start"], { unit: "Hz", aria: "S11 start" })),
        row("Step", numField(["outputs", "s11", k, "step"], { unit: "Hz", aria: "S11 step" })),
        row("End", numField(["outputs", "s11", k, "end"], { unit: "Hz", aria: "S11 end" })),
        h("button", { type: "button", class: "small danger", disabled: s11.length <= 1, onclick: () => edit(d => d.outputs.s11.splice(k, 1)) }, "Remove"))),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(d => {
        d.outputs ??= {}; d.outputs.s11 ??= [];
        const c = state.derived.resolved.excitation?.center_hz || 2.45e9, w = state.derived.resolved.excitation?.bandwidth_hz || 3e8;
        d.outputs.s11.push({ start: c - w * 0.8, step: 1e7, end: c + w * 0.8 });
      }) }, "+ S11 sweep")),
      h("div", { class: "hint", text: "Far-field (NF2FF) frequencies, 1–12:" }),
      ...pats.map((_, k) => h("div", { class: "pt", style: "display:grid;grid-template-columns:1fr 34px;gap:4px;margin-bottom:4px" },
        numField(["outputs", "radiation_frequencies_hz", k], { unit: "Hz", aria: `Far-field frequency ${k + 1}` }),
        h("button", { type: "button", class: "icon", "aria-label": "Remove frequency", onclick: () => edit(d => d.outputs.radiation_frequencies_hz.splice(k, 1)) }, icon("x")))),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", disabled: pats.length >= 12, onclick: () => edit(d => {
        d.outputs ??= {}; d.outputs.radiation_frequencies_hz ??= [];
        d.outputs.radiation_frequencies_hz.push(state.derived.resolved.excitation?.center_hz || 2.45e9);
      }) }, "+ Far-field frequency")),
      row("θ step", numField(["outputs", "radiation_grid", "theta_step_deg"], { optional: true, unit: "°", aria: "Theta step" })),
      row("φ step", numField(["outputs", "radiation_grid", "phi_step_deg"], { optional: true, unit: "°", aria: "Phi step" })),
      checkField(["outputs", "include_realized_gain"], "Realized gain"),
      checkField(["outputs", "include_polarization"], "E_θ / E_φ polarization"),
      checkField(["outputs", "include_impedance"], "Input impedance")),
    h("details", { class: "form-section" }, h("summary", { text: "Solver settings" }),
      row("Max timesteps", numField(["solver", "max_timesteps"], { optional: true, def: 20000, int: true, aria: "Max timesteps" })),
      row("End criteria", endCriteriaField()),
      h("p", { class: "hint", text: "Enter a linear ratio (0.0001) or append dB (−40 dB). JSON stores the linear ratio; lower is stricter." })),
    h("details", { class: "form-section" }, h("summary", { text: "Advanced · native CI resources" }),
      h("p", { class: "hint", text: "Native CI / exported JSON only. Browser and remote execution use the CPU controls above; the updated remote runner has no RAM cap." }),
      row("CPUs", numField(["solver", "resources", "cpus"], { optional: true, aria: "CPUs" })),
      row("Memory", numField(["solver", "resources", "memory_gib"], { optional: true, unit: "GiB", aria: "Memory" }))));
}

function fitDomain() {
  const d = state.derived;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const g of d.geometry) {
    if (!g) continue;
    try { const [a, b] = solverBounds(g); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], b[k]); } }
    catch { /* skip */ }
  }
  if (!Number.isFinite(lo[0])) return setStatus("No valid geometry to fit", true);
  const ex = d.resolved.excitation || {};
  const fmin = (ex.center_hz || 2.45e9) - (ex.bandwidth_hz || 0);
  const margin = Math.ceil(299792458 / Math.max(fmin, 1e8) * 1000 / 4);
  edit(doc => {
    doc.domain ??= { boundary: Array(6).fill("PML_8") };
    doc.domain.start = lo.map(v => Math.floor(v - margin));
    doc.domain.stop = hi.map(v => Math.ceil(v + margin));
  });
  setStatus(`Domain fitted with ${margin} mm margin (λ/4 at ${(fmin / 1e9).toFixed(3)} GHz, current case)`);
}

// ---------------------------------------------------------------- structure ops
const listOf = (doc, kind) => ({ geometry: doc.geometry, port: doc.ports, material: doc.materials, diagnostic:doc.probes, refinement:doc.mesh?.refinements })[kind] || [];
function uniqueName(names, base) {
  let n = base, k = 2;
  while (names.includes(n)) n = `${base}-${k++}`;
  return n;
}
function duplicate(kind, i) {
  edit(doc => {
    const list = listOf(doc, kind);
    const item = clone(list[i]);
    delete item.editor_id;
    if (kind === "port") { item.id = Math.max(0, ...doc.ports.map(p => +p.id || 0)) + 1; item.excite = false; }
    if(kind!=="refinement")item.name = uniqueName(list.map(x => x.name), (item.name || item.shape || "item") + "-copy");
    list.splice(i + 1, 0, item);
    state.sel = { kind, index: i + 1 };
  });
}
function remove(kind, i) {
  const item = listOf(state.doc, kind)[i];
  edit(doc => {
    listOf(doc, kind).splice(i, 1);
    if (kind === "geometry") state.hidden = new Set([...state.hidden].filter(k => k !== i).map(k => k > i ? k - 1 : k));
    if(state.sel?.kind===kind&&state.sel.index>i)state.sel.index--;
    state.handle=null;
    fixSelection();
    if (!listOf(doc, kind).length) state.sel = null;
  });
  setStatus(`Deleted ${item?.name || kind} — Undo to restore`);
}
function move(kind, i, delta) {
  edit(doc => {
    const list = listOf(doc, kind);
    const [x] = list.splice(i, 1);
    list.splice(i + delta, 0, x);
    state.sel = { kind, index: i + delta };
  });
}
function addItem(kind, type) {
  edit(doc => {
    if (kind === "geometry") {
      const metal = doc.materials.find(m => m.type === "pec") || doc.materials[0];
      if (!metal) doc.materials.push({ name: "pec-metal", type: "pec" });
      const item = { name: uniqueName(doc.geometry.map(g => g.name), type), shape: type,
        material: (metal || doc.materials[0]).name, ...clone(SHAPES[type].template) };
      doc.geometry.push(item);
      state.sel = { kind, index: doc.geometry.length - 1 };
    } else if (kind === "port") {
      const id = Math.max(0, ...doc.ports.map(p => +p.id || 0)) + 1;
      const item = { id, name: id === 1 ? "feed" : `port-${id}`, type, ...clone(PORTS[type].template), excite: !doc.ports.some(p => p.excite) };
      if (type !== "lumped") {
        let pec = doc.materials.find(m => m.type === "pec");
        if (!pec) { pec = { name: "pec-metal", type: "pec" }; doc.materials.push(pec); }
        item.metal_material = pec.name;
      }
      doc.ports.push(item);
      state.sel = { kind, index: doc.ports.length - 1 };
    } else if (kind === "diagnostic") {
      doc.probes??=[];
      const bounds={current:[[-5,-5,5],[5,5,5]],voltage:[[0,0,-2],[0,0,2]],electric_field:[[5,0,0],[5,0,0]],magnetic_field:[[5,0,0],[5,0,0]],field_dump:[[0,-50,-50],[0,50,50]]};
      const [start,stop]=bounds[type];
      doc.probes.push({name:uniqueName(doc.probes.map(p=>p.name),type),type,enabled:true,start,stop,
        ...(type==="field_dump"?{field:"E",sub_sampling:[2,2,2]}:type==="current"?{direction:"z"}:{}),
        time_domain:{enabled:true},frequency_domain:{enabled:false,frequencies_hz:[state.derived.resolved.excitation?.center_hz??2.45e9]}});
      state.sel={kind,index:doc.probes.length-1};
    } else if (kind === "material") {
      const m = { name: uniqueName(doc.materials.map(x => x.name), type === "dielectric" ? "substrate" : type.replace("_", "-")), type };
      for (const f of MATERIALS[type].fields) if (!f.optional) m[f.key] = f.default;
      doc.materials.push(m);
      state.sel = { kind, index: doc.materials.length - 1 };
    }
  });
  closeMenus();
  if (mobile()) openSheet("inspect");
}

// Linear array: N copies offset by k * step, written as expressions so the
// pitch stays parametric (e.g. step "pitch" -> translate x = "2*(pitch)").
function arrayDialog(i) {
  const g = state.doc.geometry[i];
  const count = h("input", { type: "text", value: "3", inputmode: "numeric", "aria-label": "Copies" });
  const lengthUnit=displayUnit("mm",state.doc.workspace_units);
  const step = ["x", "y", "z"].map((a, k) => h("input", { type: "text", value: formatUnitField(k===0?10:0,"mm",lengthUnit), "aria-label": "Step " + a, spellcheck: "false", autocapitalize: "off" }));
  openDialog("Linear array of " + (g.name || g.shape), h("div", {},
    h("p", { class: "hint", text: "Adds copies translated by k × step. Step components may be parameters or expressions (e.g. pitch, lambda/2)." }),
    row("Copies", count), row("Step ("+lengthUnit+")", h("div", { class: "vec3" }, step))), [
    ["Create", () => {
      const n = Math.trunc(Number(count.value));
      if (!(n >= 1 && n <= 200)) return setStatus("Copies must be 1–200", true);
      let steps;
      try { steps = step.map(s => parseUnitField(s.value,"mm",lengthUnit)); } catch (e) { return setStatus(e.message, true); }
      edit(doc => {
        const src = doc.geometry[i];
        const baseT = src.transform?.translate || [0, 0, 0];
        const names = doc.geometry.map(x => x.name);
        const copies = [];
        for (let k = 1; k <= n; k++) {
          const c = clone(src);
          delete c.editor_id;
          c.name = uniqueName([...names, ...copies.map(x => x.name)], `${src.name || src.shape}-${k + 1}`);
          const t = baseT.map((b, a) => {
            const s = steps[a];
            if (typeof s === "number" && typeof b === "number") return +(b + k * s).toPrecision(12);
            if (typeof s === "number" && s === 0) return b;
            const sv = valueToField(s), bv = valueToField(b);
            return { $expr: (bv === "0" ? "" : `${bv} + `) + `${k} * (${sv})` };
          });
          c.transform = { ...(c.transform || {}), translate: t };
          copies.push(c);
        }
        doc.geometry.splice(i + 1, 0, ...copies);
      });
      setStatus(`Added ${n} array copies`);
    }],
  ]);
}

// ---------------------------------------------------------------- parameters panel
function renderParams() {
  const box = $("params");
  box.replaceChildren();
  const doc = state.doc, d = state.derived;
  const params = doc.parameters || {};
  const swept = new Set(Object.keys(doc.sweep?.parameters || {}));
  const usage = parameterUsage(doc);
  const table = h("table", { class: "ptable" },
    h("thead", {}, h("tr", {}, h("th", { text: "Name" }), h("th", { text: "Value" }), h("th", { text: "Adjust" }), h("th", { text: "" }))));
  const body = h("tbody");
  for (const [name, value] of Object.entries(params)) body.append(paramRow(name, value, swept.has(name), usage.get(name) || 0));
  table.append(body);
  const unknown = [...usage.keys()].filter(n => !(n in params) && !swept.has(n));
  const left = h("div", {},
    h("div", { class: "form-section" }, h("h3", { text: "Variables" }),
      Object.keys(params).length ? table : h("p", { class: "hint", text: "No parameters yet. Add one, then type its name (or an expression like 2*gap + 1) into any numeric field." }),
      unknown.length ? h("div", { class: "note warn" }, "Referenced but undefined: ", unknown.join(", "), " ",
        h("button", { type: "button", class: "small", onclick: () => edit(dd => { dd.parameters ??= {}; unknown.forEach(n => { dd.parameters[n] = 1; }); }) }, "Define all = 1")) : null,
      h("div", { class: "actions param-actions" },
        h("button", { type: "button", onclick: () => edit(dd => { dd.parameters ??= {}; dd.parameters[uniqueParam(dd, "p")] = 1; }) }, "+ Parameter"),
        swept.size ? h("button", { type: "button", title: "Edit swept parameters in Simulation", onclick: () => {
          openSheet("sim");
          requestAnimationFrame(() => document.querySelector("#sim .sim-sweep-card")?.scrollIntoView({block:"nearest"}));
        } }, "Open sweep") : null),
      h("details", { class: "param-help" }, h("summary", { text: "Expression syntax" }),
        h("p", { class: "hint" }, "Enter a number ", h("code",{text:"2.45"}), ", parameter ", h("code",{text:"gap"}), ", or expression ", h("code",{text:"2*gap + 1"}), "."),
        h("p", { class: "hint" }, "Operators: ", h("code",{text:"+ - * / % **"})),
        h("p", { class: "hint" }, "Functions: ", ...["abs","min","max","sqrt","sin","cos","tan","floor","ceil"].flatMap((name,i)=>[i?" ":"",h("code",{text:name})])),
        h("p", { class: "hint" }, "Constants: ", h("code",{text:"pi"}), ", ", h("code",{text:"e"})),
        h("p", { class: "hint" }, "JSON: ", h("code",{text:'{"$param":"gap"}'}), " or ", h("code",{text:'{"$expr":"2*gap + 1"}'}), "."))));
  add(box, left);
}
function uniqueParam(doc, base) {
  const used = new Set([...Object.keys(doc.parameters || {}), ...Object.keys(doc.sweep?.parameters || {})]);
  let k = 1;
  while (used.has(base + k)) k++;
  return base + k;
}
function parseScalar(text) {
  const t = text.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}
function paramRow(name, value, isSwept, uses) {
  const nameIn = h("input", { type: "text", class: "pname", value: name, spellcheck: "false", autocapitalize: "off", "aria-label": "Parameter name" });
  nameIn.addEventListener("change", () => {
    const to = nameIn.value.trim();
    if (to === name) return;
    if (!validParameterName(to)) { nameIn.value = name; return setStatus(`Invalid parameter name: ${to}`, true); }
    if (to in (state.doc.parameters || {}) || to in (state.doc.sweep?.parameters || {})) { nameIn.value = name; return setStatus(`${to} already exists`, true); }
    const renamed = renameParameter(state.doc, name, to);
    edit(doc => { Object.keys(doc).forEach(k => delete doc[k]); Object.assign(doc, renamed); });
    setStatus(`Renamed ${name} → ${to} in all expressions`);
  });
  const valIn = h("input", { type: "text", value: typeof value === "string" ? value : JSON.stringify(value), spellcheck: "false", autocapitalize: "off", "aria-label": `Value of ${name}` });
  const slider = h("input", { type: "range", class: "slider", "aria-label": `Adjust ${name}` });
  const setRange = v => {
    if (typeof v !== "number") { slider.disabled = true; return; }
    const span = Number.isInteger(v) ? Math.max(5, Math.abs(v)) : Math.max(Math.abs(v) * 0.5, 0.1);
    const step = Number.isInteger(v) ? 1 : niceStep(span / 100);
    slider.min = v - span; slider.max = v + span; slider.step = step; slider.value = v;
    slider.disabled = isSwept;
  };
  setRange(value);
  let raf = 0;
  slider.addEventListener("pointerdown", beginLive);
  slider.addEventListener("input", () => {
    beginLive();
    const v = +(+slider.value).toPrecision(10);
    state.doc.parameters[name] = v;
    valIn.value = String(v);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => refresh({ params: false, inspector: false, tree: false, json: false }));
  });
  slider.addEventListener("change", () => { endLive(); setRange(state.doc.parameters[name]); });
  valIn.addEventListener("change", () => edit(doc => { doc.parameters[name] = parseScalar(valIn.value); }, { params: false }));
  valIn.addEventListener("keydown", e => { if (e.key === "Enter") valIn.blur(); });
  return h("tr", {},
    h("td", {}, nameIn),
    h("td", {}, valIn),
    h("td", {}, isSwept ? h("span", { class: "tag swept", title: "The sweep overrides this default", text: "swept" }) : slider,
      h("div", { class: "uses", text: uses ? `${uses} use${uses > 1 ? "s" : ""}` : "unused" })),
    h("td", {}, h("button", { type: "button", class: "icon", "aria-label": `Delete ${name}`, onclick: () => edit(doc => { delete doc.parameters[name]; if (!Object.keys(doc.parameters).length) delete doc.parameters; }) }, icon("x"))));
}
const niceStep = x => { const p = Math.pow(10, Math.floor(Math.log10(x))); return [1, 2, 5, 10].map(m => m * p).find(s => s >= x); };

function renderSweep(d, swept) {
  const doc = state.doc;
  const sec = h("div", { class: "form-section" }, h("h3", { text: "Sweep" }));
  const on = h("input", { type: "checkbox" });
  on.checked = !!doc.sweep;
  on.addEventListener("change", () => edit(dd => {
    if (on.checked) {
      const first = Object.entries(dd.parameters || {}).find(([, v]) => typeof v === "number");
      const name = first ? first[0] : uniqueParam(dd, "p");
      const v = first ? first[1] : 1;
      dd.sweep = { mode: "product", parameters: { [name]: { values: [v, +(v * 1.1).toPrecision(6)] } } };
    } else delete dd.sweep;
    state.caseIndex = 0;
  }));
  sec.append(h("label", { class: "check-inline" }, on, "Enable sweep (max " + MAX_CASES + " cases)"));
  if (!doc.sweep) return sec;
  const mode = h("select", { "aria-label": "Sweep mode" },
    h("option", { value: "product", text: "All combinations" }), h("option", { value: "zip", text: "Pair by index" }));
  mode.value = doc.sweep.mode || "product";
  mode.addEventListener("change", () => edit(dd => { dd.sweep.mode = mode.value; }));
  sec.append(row("Mode", mode));
  const warnings=sweepWarnings(doc);
  for (const [name, spec] of Object.entries(doc.sweep.parameters || {})) {
    const axis=sweepAxis(name,spec);
    const items=warnings.filter(w=>w.axis===name);
    if(items.length){
      const input=axis.querySelector('input[aria-label="Swept parameter"]');
      const id="sweep-warning-"+name;
      input.setAttribute("aria-describedby",id);
      input.classList.add("sweep-axis-warning");
      input.title=items.map(w=>w.msg).join("\n");
      sec.append(axis,h("div",{class:"note warn sweep-axis-notice",id,role:"status"},
        ...items.map(w=>h("div",{text:"⚠ "+w.msg}))));
    }else sec.append(axis);
  }
  sec.append(h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(dd => {
    dd.sweep.parameters ??= {};
    const cand = Object.entries(dd.parameters || {}).find(([k, v]) => typeof v === "number" && !(k in dd.sweep.parameters));
    const name = cand ? cand[0] : uniqueParam(dd, "s");
    dd.sweep.parameters[name] = { values: cand ? [cand[1]] : [1, 2] };
  }) }, "+ Sweep axis")));
  if (d.caseError) sec.append(h("div", { class: "note warn", text: d.caseError }));
  else {
    sec.append(h("div", { class: "hint", text: `${d.cases.length} case${d.cases.length > 1 ? "s" : ""}` }));
    const list = h("div", { class: "case-list", role: "listbox", "aria-label": "Cases" });
    d.cases.forEach((c, k) => list.append(h("div", { role: "option", class: k === state.caseIndex ? "active" : "", "aria-selected": String(k === state.caseIndex),
      onclick: () => changeCase(k), title: c.name, text: shortCaseLabel(c) })));
    sec.append(list);
  }
  return sec;
}
function sweepAxis(name, spec) {
  const nameIn = h("input", { type: "text", class: "pname", value: name, "aria-label": "Swept parameter", spellcheck: "false", autocapitalize: "off" });
  nameIn.addEventListener("change", () => {
    const to = nameIn.value.trim();
    if (!validParameterName(to)) { nameIn.value = name; return setStatus("Invalid parameter name", true); }
    edit(dd => { dd.sweep.parameters = Object.fromEntries(Object.entries(dd.sweep.parameters).map(([k, v]) => [k === name ? to : k, v])); });
  });
  const kind = h("select", { "aria-label": "Axis kind" }, h("option", { value: "values", text: "values" }), h("option", { value: "range", text: "range" }));
  kind.value = "range" in spec ? "range" : "values";
  kind.addEventListener("change", () => edit(dd => {
    const cur = dd.sweep.parameters[name];
    if (kind.value === "range") {
      const vals = (cur.values || []).filter(v => typeof v === "number");
      const a = vals.length ? Math.min(...vals) : 0, b = vals.length > 1 ? Math.max(...vals) : a + 1;
      dd.sweep.parameters[name] = { range: { start: a, stop: b, step: vals.length > 1 ? +((b - a) / (vals.length - 1)).toPrecision(6) : 1 } };
    } else {
      const r = cur.range || { start: 0, stop: 1, step: 1 };
      dd.sweep.parameters[name] = { values: [r.start, r.stop] };
    }
  }));
  let values;
  if ("range" in spec) {
    values = h("div", { class: "range axis-values" }, ["start", "stop", "step"].map(k => {
      const inp = h("input", { type: "text", value: String(spec.range?.[k] ?? ""), placeholder: k, "aria-label": `${name} ${k}`, inputmode: "decimal" });
      inp.addEventListener("change", () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v) || inp.value.trim() === "") return setStatus("Range values must be numbers", true);
        edit(dd => { dd.sweep.parameters[name].range[k] = v; });
      });
      return inp;
    }));
  } else {
    const inp = h("input", { type: "text", class: "axis-values", value: (spec.values || []).map(v => typeof v === "string" ? v : JSON.stringify(v)).join(", "),
      "aria-label": `${name} values`, placeholder: "1, 2, 3", spellcheck: "false", autocapitalize: "off" });
    inp.addEventListener("change", () => edit(dd => {
      dd.sweep.parameters[name] = { values: inp.value.split(",").map(s => s.trim()).filter(Boolean).map(parseScalar) };
    }));
    values = inp;
  }
  return h("div", { class: "sweep-axis" }, nameIn, kind, values,
    h("button", { type: "button", class: "icon", "aria-label": `Remove axis ${name}`, onclick: () => edit(dd => {
      delete dd.sweep.parameters[name];
      if (!Object.keys(dd.sweep.parameters).length) delete dd.sweep;
      state.caseIndex = 0;
    }) }, icon("x")));
}

// ---------------------------------------------------------------- checks panel
function renderChecks() {
  const { list, caseCount } = state.derived.checks;
  const errors = list.filter(c => c.level === "error").length, warns = list.length - errors;
  const status = errors ? "error" : warns ? "warn" : "ok";
  const description = errors || warns ? `${errors} error${errors === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}` : "No errors or warnings";
  for (const id of ["checkBadge", "checkBadgeMobile"]) {
    const shield = $(id);
    shield.dataset.status = status;
    const button = shield.closest("button");
    button.title = `Checks: ${description}`;
    button.setAttribute("aria-label", `Checks: ${description}`);
  }
  const box = $("checks");
  box.replaceChildren(
    h("div", { class: "check-summary" },
      h("strong", { text: errors ? `${errors} error${errors > 1 ? "s" : ""}` : "No blocking errors" }),
      warns ? h("span", { class: "muted", text: `${warns} warning${warns > 1 ? "s" : ""}` }) : null,
      h("span", { class: "muted", text: `· ${caseCount} case${caseCount > 1 ? "s" : ""} checked` })),
    h("p", { class: "hint", text: "Input validation and advisory sweep, feed-contact, mesh and boundary checks. Passing them does not prove electrical connectivity on the FDTD grid or mesh convergence." }));
  const ul = h("ul", { class: "checks-list" });
  for (const c of list) {
    const li = h("li", { "data-ref": c.ref ? "1" : undefined },
      h("span", { class: "lvl " + c.level, text: c.level === "error" ? "✖" : "▲" }),
      h("span", { class: "where", text: c.where }),
      h("span", { class: "msg", text: c.msg + (c.cases.length < caseCount && c.cases[0] !== "all" ? ` (${c.cases.length}/${caseCount} cases: ${c.cases.slice(0, 3).join(", ")}${c.cases.length > 3 ? "…" : ""})` : "") }));
    if (c.ref) li.addEventListener("click", () => {
      const caseIdx = state.derived.cases.findIndex(x => x.id === c.cases[0]);
      if (caseIdx >= 0 && caseIdx !== state.caseIndex) state.caseIndex = caseIdx;
      select({ kind: c.ref.kind, index: c.ref.index });
      refresh();
    });
    ul.append(li);
  }
  add(box, ul);
}

// ---------------------------------------------------------------- JSON panel
let jsonEditor = null, jsonLoading = null, jsonSync = false;
let jsonResizeObserver = null, jsonResizeFrame = 0, jsonLastSize = "", jsonComposing = false;
let jsonDraft = null, jsonBase = null, jsonClean = "", jsonValidationTimer = 0;
const jsonValue = () => jsonEditor?.cm ? jsonEditor.cm.getValue() : $("jsonText").value;
function validateJson() {
  clearTimeout(jsonValidationTimer);
  const status = $("jsonStatus"), source = state.jsonMode === "source";
  let error = "";
  try {
    const parsed = JSON.parse(jsonValue());
    if (source) checkDocShape(parsed);
  } catch (e) { error = e.message; }
  status.classList.toggle("error", !!error);
  const message = error ? error : source ? (jsonDraft !== null ? "Valid configuration · unapplied edits" : "Valid configuration") : "Resolved case · read-only";
  if (status.textContent !== message) status.textContent = message;
  status.title = message;
  $("jsonApply").disabled = !!error || jsonDraft === null;
  $("jsonFormat").disabled = !source || !!error;
  $("jsonDiscard").hidden = !source;
  $("jsonDiscard").disabled = jsonDraft === null;
}
function jsonChanged(value) {
  if (jsonSync || state.jsonMode !== "source") return;
  if (jsonDraft === null) jsonBase = JSON.stringify(state.doc);
  jsonDraft = value === jsonClean ? null : value;
  clearTimeout(jsonValidationTimer);
  if (!jsonComposing) jsonValidationTimer = setTimeout(validateJson, 350);
}
function ensureJsonEditor() {
  // Native textarea editing on touch devices: Android/iOS own the keyboard,
  // caret, long-press selection handles and clipboard. CodeMirror's virtual
  // document/IME bridge is not needed here.
  if (jsonLoading || jsonEditor) return;
  if (navigator.maxTouchPoints > 0 && (mobile() || matchMedia("(pointer: coarse)").matches)) {
    jsonEditor = { refresh() {}, focus() { $("jsonText").focus(); } };
    return;
  }
  jsonLoading = upgradeTextarea($("jsonText"), { json: true, readOnly: state.jsonMode !== "source",
    onChange: (value, blur) => { if (!blur) jsonChanged(value); }
  }).then(editor => {
    jsonEditor = editor;
    const cm = editor.cm;
    if (cm) {
      const input = cm.getInputField();
      for (const [name, value] of Object.entries({ "aria-label": "Configuration JSON", spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off" })) input.setAttribute(name, value);
      input.addEventListener("compositionstart", () => { jsonComposing = true; });
      input.addEventListener("compositionend", () => { jsonComposing = false; refreshJsonEditor(); });
      input.addEventListener("blur", () => { jsonComposing = false; refreshJsonEditor(); });
      if (window.ResizeObserver) {
        jsonResizeObserver = new ResizeObserver(refreshJsonEditor);
        jsonResizeObserver.observe(cm.getWrapperElement());
      }
    }
    renderJson(true);
    refreshJsonEditor();
  });
}
function refreshJsonEditor() {
  if (jsonResizeFrame) return;
  jsonResizeFrame = requestAnimationFrame(() => {
    jsonResizeFrame = 0;
    const cm = jsonEditor?.cm;
    if (!cm || jsonComposing) return;
    const el = cm.getWrapperElement();
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height || getComputedStyle(el).visibility === "hidden") { jsonLastSize = ""; return; }
    const size = width + ":" + height;
    if (size === jsonLastSize) return;
    jsonLastSize = size;
    cm.refresh();
  });
}
function setJsonMax(on) {
  document.body.classList.toggle("json-max", on);
  $("jsonMax").setAttribute("aria-pressed", String(on));
  $("jsonMax").textContent = on ? "Restore" : "Expand";
  if (mobile()) document.body.classList.toggle("sheet-tall", on);
  refreshJsonEditor();
  syncViewInset();
}
function renderJson(force = false) {
  const ta = $("jsonText"), cm = jsonEditor?.cm, source = state.jsonMode === "source";
  if (!force && ((source && jsonDraft !== null) || cm?.hasFocus() || document.activeElement === ta)) return;
  const d = state.derived;
  if (!d) return;
  $("jsonSource").setAttribute("aria-pressed", String(source));
  $("jsonResolved").setAttribute("aria-pressed", String(!source));
  $("jsonApply").hidden = !source;
  $("jsonFormat").hidden = !source;
  ta.readOnly = !source;
  let value;
  if (source) {
    if (jsonDraft === null) jsonClean = JSON.stringify(state.doc, null, 2);
    value = jsonDraft ?? jsonClean;
  }
  else {
    try {
      const ex = expandResolved(resolveCase(state.doc, d.case.parameters));
      value = ex.cfg ? JSON.stringify(ex.cfg, null, 2) : "// " + (ex.error || "Geometry scripts are still running…");
    }
    catch (e) { value = "// " + e.message; }
  }
  jsonSync = true;
  try {
    if (cm) {
      cm.setOption("readOnly", !source);
      cm.setOption("lineWrapping", $("jsonWrap").getAttribute("aria-pressed") === "true");
      if (cm.getValue() !== value) { cm.setValue(value); cm.clearHistory(); }
    }
    if (ta.value !== value) ta.value = value;
  } finally { jsonSync = false; }
  validateJson();
}
function applyJson() {
  if (state.jsonMode !== "source") return;
  try {
    const next = normalizeDoc(JSON.parse(jsonValue()));
    if (jsonDraft !== null && jsonBase !== JSON.stringify(state.doc) &&
        !window.confirm("The model changed after you started editing JSON. Replace it with your JSON draft?")) return;
    if (!edit(doc => { Object.keys(doc).forEach(k => delete doc[k]); Object.assign(doc, next); fixSelection(); })) return;
    jsonDraft = jsonBase = null;
    renderJson(true);
    setStatus("JSON applied");
  } catch (e) { validateJson(); setStatus("Invalid JSON: " + e.message, true); }
}

// Case names show only swept values; the full parameter set is available in
// the option title and the exported configuration.
function shortCaseLabel(c) {
  if(c.id==="default")return "Default";
  const n=Number(c.id.match(/\d+$/)?.[0]);
  const values=Object.keys(state.doc.sweep?.parameters||{}).filter(k=>k in c.parameters).map(k=>k+"="+String(c.parameters[k]));
  return (Number.isFinite(n)?"#"+n:c.id)+(values.length?" · "+values.join(", "):"");
}
// Keep the frozen Results selector and viewport selector in sync, without
// rebuilding an unchanged select while the user is choosing a case.
function syncCaseSelectors() {
  const d=state.derived;
  if(!d)return;
  for(const id of ["caseSelect","resultCase"]){
    const select=$(id);
    const labels=d.cases.map(c=>{
      const label=shortCaseLabel(c);
      const s=caseRunState(c.id)?.status;
      return id==="resultCase" && s ? `${s==="done"?"✓":s==="running"?"▶":s==="failed"?"!":s==="queued"?"…":s==="stopped"?"■":"–"} ${label} · ${s}` : label;
    });
    const key=JSON.stringify(labels);
    if(select.dataset.optionsKey!==key){
      select.replaceChildren(...labels.map((text,k)=>h("option",{value:k,text,title:d.cases[k].name})));
      select.dataset.optionsKey=key;
    }
    select.value=state.caseIndex;
  }
  $("caseWrap").hidden=d.cases.length<=1;
  $("resultCaseCount").textContent=`${state.caseIndex+1}/${d.cases.length}`;
}
// Preserve the relative vertical position when comparing cases. If a target
// has no results yet, keep the prior fraction until a completed case returns.
let resultScrollFraction=0;
function changeCase(index) {
  const next=Math.max(0,Math.min(state.derived.cases.length-1,index));
  if(next===state.caseIndex)return;
  const area=$("resultBody");
  const before=area.scrollHeight-area.clientHeight;
  if(area.clientHeight>0 && before>1)resultScrollFraction=area.scrollTop/before;
  state.caseIndex=next;
  persist();
  refresh();
  if(area.clientHeight>0)area.scrollTop=resultScrollFraction*Math.max(0,area.scrollHeight-area.clientHeight);
}
function stepResultCase(delta) { changeCase(state.caseIndex+delta); }
function installResultSwipe(){
  const area=$("resultBody");
  let start=null;
  area.addEventListener("touchstart",e=>{
    if(!mobile()||e.touches.length!==1||e.target.closest("button,select,input,a,[data-smith-drag]")){start=null;return;}
    start={x:e.touches[0].clientX,y:e.touches[0].clientY};
  },{passive:true});
  area.addEventListener("touchcancel",()=>{start=null;},{passive:true});
  area.addEventListener("touchend",e=>{
    if(!start)return;
    const t=e.changedTouches[0], dx=t.clientX-start.x,dy=t.clientY-start.y;start=null;
    if(Math.abs(dx)>45 && Math.abs(dx)>1.5*Math.abs(dy))stepResultCase(dx<0?1:-1);
  },{passive:true});
}

// ---------------------------------------------------------------- refresh
function refresh(opts = {}) {
  const o = { tree: true, inspector: true, params: true, json: true, viewport: true, ...opts };
  const d = derive();
  document.title = `${state.doc.name || "Untitled"} · CSXCAD Editor`;
  if (document.activeElement !== $("docName")) $("docName").value = state.doc.name || "";
  $("docMeta").textContent = `schema v2 · mm · ${state.doc.geometry.length} parts` + (d.cases.length > 1 ? ` · ${d.cases.length} cases` : "");
  $("caseBadge").textContent = d.cases.length > 1 ? String(d.cases.length) : "";
  $("undo").disabled = !history.undo.length;
  $("redo").disabled = !history.redo.length;
  syncCaseSelectors();
  if (o.tree) renderTree();
  if (o.inspector) renderInspector();
  else inspectorRefreshers.forEach(f => f());
  if (o.sim ?? o.inspector) renderSim();
  else simRefreshers.forEach(f => f());
  if (o.params) renderParams();
  if (o.scripts ?? true) renderScripts();
  else updateScriptStatus();
  renderChecks();
  if (o.json) renderJson();
  if (o.viewport && viewport) {
    const geometry = d.geometry.map((g, i) => d.expanded[i] ? (d.expanded[i].objects ? { __parts: d.expanded[i].objects } : null) : g);
    viewport.setSelection(state.sel);
    const errs = viewport.update({ geometry, ports: d.ports, materials: d.resolved.materials || [],
      domain: d.resolved.domain, mesh: d.resolved.mesh, hidden: state.hidden });
    const ve = $("viewError");
    const unresolved = Object.keys(d.errors.geometry).filter(i => !d.expanded[i]).length;
    const msgs = [...errs.map(e => `${state.doc.geometry[e.index]?.name || "#" + (e.index + 1)}: ${e.message}`),
      ...(unresolved ? [`${unresolved} part(s) not shown: unresolved parameters`] : [])];
    ve.hidden = !msgs.length;
    ve.textContent = msgs.slice(0, 3).join(" · ") + (msgs.length > 3 ? ` (+${msgs.length - 3})` : "");
  }
  viewport?.setDiagnosticObjects(d.resolved.probes??[]);
  syncResults();
  showChip();
  syncHandles();
  const errors = d.checks.list.filter(c => c.level === "error").length;
  setStatus(`${state.doc.geometry.length} parts · ${state.doc.ports.length} ports · ${d.case.id}` +
    (errors ? ` · ${errors} check error${errors > 1 ? "s" : ""}` : " · checks pass"));
}

// ---------------------------------------------------------------- menus & dialogs
function closeMenus() {
  for (const id of ["menu", "addMenu"]) $(id).hidden = true;
  $("menuButton").setAttribute("aria-expanded", "false");
  $("addButton").setAttribute("aria-expanded", "false");
}
function openAddMenu(anchor, only) {
  const menu = $("addMenu");
  menu.replaceChildren();
  const heading = t => h("div", { class: "menu-heading", text: t });
  if (!only || only === "geometry") {
    menu.append(heading("Geometry"));
    // Helix and hemisphere are not CSXCAD primitives: they are offered as built-in scripts below.
    for (const [k, v] of Object.entries(SHAPES)) if (!LEGACY_SHAPES.has(k)) menu.append(h("button", { role: "menuitem", onclick: () => addItem("geometry", k) }, v.label));
  }
  const scriptNames = [...Object.keys(BUILTIN_SCRIPTS), ...Object.keys(state.doc.scripts || {})];
  if (!only || only === "geometry") {
    menu.append(heading("Scripts"));
    for (const n of scriptNames) menu.append(h("button", { role: "menuitem", onclick: () => addScriptInstance(n) },
      isBuiltinScript(n) ? `${BUILTIN_SCRIPTS[n].label} (built-in script)` : `Script · ${n}`));
  }
  if (!only || only === "port") {
    menu.append(heading("Ports"));
    for (const [k, v] of Object.entries(PORTS)) menu.append(h("button", { role: "menuitem", onclick: () => addItem("port", k) }, v.label));
  }
  if (!only || only === "diagnostic") {
    menu.append(heading("Diagnostics"));
    for(const [k,label] of Object.entries({current:"Current probe",voltage:"Voltage probe",electric_field:"E-field point",magnetic_field:"H-field point",field_dump:"Field dump"}))
      menu.append(h("button",{role:"menuitem",onclick:()=>addItem("diagnostic",k)},label));
  }
  if (!only || only === "material") {
    menu.append(heading("Materials"));
    for (const [k, v] of Object.entries(MATERIALS)) menu.append(h("button", { role: "menuitem", onclick: () => addItem("material", k) }, v.label));
  }
  if (only) {
    // Tree "+" buttons: show the menu as a dialog on any screen size.
    const items = [...menu.querySelectorAll("button")];
    openDialog("Add " + only, h("div", { class: "example-list" }, items.map(b => {
      const c = b.cloneNode(true);
      c.type = "button";
      c.addEventListener("click", () => { $("dialog").close(); b.click(); });
      return c;
    })));
    return;
  }
  menu.hidden = !menu.hidden;
  $("addButton").setAttribute("aria-expanded", String(!menu.hidden));
}
function openDialog(title, body, actions = []) {
  const dlg = $("dialog");
  $("dialogTitle").textContent = title;
  $("dialogBody").replaceChildren(body);
  const acts = $("dialogActions");
  acts.replaceChildren(h("button", { value: "close" }, "Close"));
  for (const [label, fn] of actions) {
    acts.append(h("button", { type: "button", class: "primary", onclick: () => { dlg.close(); fn(); } }, label));
  }
  dlg.showModal();
}

async function fetchExample(file, entry) {
  const r=await fetch("./examples/"+encodeURIComponent(file),{cache:"no-cache"});
  if(!r.ok)throw Error("Example HTTP "+r.status);
  const doc=normalizeDoc(await r.json());
  let resultMessage="", hasResult=false;
  if(entry?.result){
    try{
      const response=await fetch("./examples/"+encodeURIComponent(entry.result),{cache:"no-cache"});
      if(!response.ok)throw Error("Result HTTP "+response.status);
      await seedExampleResult(await response.json());
      hasResult=true;
      resultMessage=" · bundled simulation available";
    }catch(error){resultMessage=" · bundled result unavailable: "+error.message;}
  }
  return {doc,resultMessage,hasResult};
}

// An unchanged example restored as a local draft may predate its bundled result.
// Never seed a different or edited project merely because it has the same title.
async function seedMatchingExample(doc){
  try {
    const response=await fetch("./examples/index.json",{cache:"no-cache"});
    if(!response.ok)return;
    const entry=(await response.json()).find(e=>e.result&&e.name===doc.name);
    if(!entry)return;
    const source=await fetch("./examples/"+encodeURIComponent(entry.file),{cache:"no-cache"});
    if(!source.ok||JSON.stringify(normalizeDoc(await source.json()))!==JSON.stringify(doc))return;
    const result=await fetch("./examples/"+encodeURIComponent(entry.result),{cache:"no-cache"});
    if(result.ok)await seedExampleResult(await result.json());
  }catch { /* normal drafts remain usable offline */ }
}

async function showExamples() {
  let index;
  try {
    const r = await fetch("./examples/index.json", { cache: "no-cache" });
    if (!r.ok) throw Error(r.status);
    index = await r.json();
  } catch {
    return openDialog("Open example", h("div", { class: "example-list" },
      h("button", { type: "button", onclick: () => { $("dialog").close(); loadDoc(STARTER, "Loaded example"); } },
        h("strong", { text: STARTER.name }), h("small", { text: "Built-in offline fallback" }))));
  }
  openDialog("Open example", h("div", { class: "example-list" },
    index.map(e => h("button", { type: "button", onclick: async () => {
      $("dialog").close();
      try {
        const {doc,resultMessage,hasResult}=await fetchExample(e.file,e);
        loadDoc(doc, `Loaded ${e.source}${resultMessage}`);
        if(hasResult){ showBundledResultsFor=state.doc; syncResults(); }
      } catch (err) { setStatus("Could not load example: " + err.message, true); }
    } }, h("strong", { text: e.name }), h("small", { text: `${e.source}${e.sweep ? " · sweep" : ""}${e.generator ? " · Python generator" : ""}${e.result ? " · simulation included" : ""}${e.description ? " — " + e.description : ""}` })))));
}

const slug = () => (state.doc?.name || "antenna").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "antenna";

async function archiveProject({explicit=false}={}) {
  if(!state.doc)return false;
  const key=JSON.stringify(state.doc);
  if(!explicit&&state.deletedArchiveKey===key)return false;
  try{
    await saveLocalProject(state.doc,state.caseIndex);
    if(explicit){
      if(state.deletedArchiveKey===key){state.deletedArchiveKey=null;persist();}
      try{await navigator.storage?.persist?.();}catch{}
      setStatus("Saved to local projects");
    }
    return true;
  }catch(e){setStatus("Local project save failed: "+e.message,true);return false;}
}
async function showLocalProjects() {
  try{
    const projects=await listLocalProjects();
    const list=h("div",{class:"example-list project-list"},projects.map(project=>{
      const name=project.label||project.doc.name||"Untitled antenna";
      const details=new Date(project.savedAt).toLocaleString()+" · "+(project.doc.geometry?.length??0)+" parts";
      const open=h("button",{type:"button",class:"project-open",onclick:()=>{
        $("dialog").close();
        loadDoc(project.doc,"Opened local project",project.caseIndex);
        void restoreResults(simContext);
      }},h("strong",{text:name}),h("small",{text:details}));
      const remove=iconBtn("trash","Delete "+name,async()=>{
        if(!window.confirm("Delete saved project revision '"+name+"'?\n"+details+"\n\nThe current workspace and shared cached simulation results will be retained."))return;
        remove.disabled=true;open.disabled=true;
        try{
          await deleteLocalProject(project.key);
          if(state.doc&&project.key===JSON.stringify(state.doc)){
            state.deletedArchiveKey=project.key;
            persist();
          }
          $("dialog").close();
          await showLocalProjects();
          setStatus("Deleted local project");
        }catch(e){
          remove.disabled=false;open.disabled=false;
          setStatus("Local project deletion failed: "+e.message,true);
        }
      },{danger:true});
      return h("div",{class:"project-row"},open,remove);
    }));
    openDialog("Local projects",h("div",{},h("p",{class:"hint",text:"Saved project revisions and matching simulation results are stored on this device. Delete removes the selected saved revision, not the current workspace or shared result cache. Export important files for backup."}),projects.length?list:h("p",{class:"hint",text:"No saved projects yet. Use Save locally or run a simulation."})),[["Save current project",()=>void archiveProject({explicit:true})]]);
  }catch(e){setStatus("Local projects unavailable: "+e.message,true);}
}
async function save() {
  const doc=JSON.stringify(state.doc,null,2)+"\n", filename=slug()+".json";
  const saved=await archiveProject({explicit:true});
  try { setStatus((await saveFile(filename,doc))+(saved?" · saved locally":" · local save failed"),!saved); }
  catch (e) { setStatus("Save failed: " + e.message, true); }
}

async function openResultFile(file) {
  try{
    setStatus("Importing "+file.name+"…");
    // Preserve existing results by default. Only an affirmative overwrite
    // choice permits replacing a stored result for the same resolved input.
    const overwrite=confirm("Replace existing matching results? Choose Cancel to keep existing results and import only missing ones.");
    const out=/\.zip$/i.test(file.name)?await importResultArchive(file,{overwrite}):await importResultFile(JSON.parse(await file.text()),{overwrite});
    loadDoc(out.doc,"Imported "+out.imported+" results · "+out.kept+" existing kept"+(out.errors.length?" · "+out.errors.length+" skipped":""));
    openSheet("results");
    if(out.errors.length)openDialog("Some ZIP entries could not be imported",h("div",{},...out.errors.map(error=>h("p",{class:"hint",text:error}))));
    else if(!out.grouped&&/\.zip$/i.test(file.name))setStatus("Imported "+out.imported+" results · "+out.kept+" kept · remaining cases in Local projects");
  }catch(e){setStatus("Result import failed: "+e.message,true);}
}
async function openFile(file){
  if(/\.zip$|\.result\.json$/i.test(file.name))return openResultFile(file);
  try{
    const text=await file.text(), data=JSON.parse(text);
    if(data?.input_config&&data?.s11)return openResultFile(file);
    openFromText(text,file.name);
  }catch(e){setStatus("Open failed: "+e.message,true);}
}
// Geometry scripts in a document are code, and opening a file is not consent
// to run someone else's code. Ask once per opened document; scripts written in
// this editor go through the Scripts tab and never reach here.
function openFromText(text, label) {
  let cfg;
  try { cfg = JSON.parse(text); }
  catch (e) { setStatus("Open failed: " + e.message, true); return; }
  const scripts = Object.keys(cfg?.scripts && typeof cfg.scripts === "object" && !Array.isArray(cfg.scripts) ? cfg.scripts : {})
    .filter(name => typeof cfg.scripts[name]?.source === "string");
  if (scripts.length && !window.confirm(
      `${label} contains ${scripts.length} geometry script(s): ${scripts.join(", ")}.\n\n` +
      "Geometry scripts run as code in this editor. Open and run them?")) {
    setStatus("Open cancelled — " + label + " contains geometry scripts", true);
    return;
  }
  try { loadDoc(cfg, "Opened " + label); }
  catch (e) { setStatus("Open failed: " + e.message, true); }
}

function showWorkspaceUnits() {
  const current=normalizeWorkspaceUnits(state.doc.workspace_units),fields={};
  const labels={length:"Length",frequency:"Frequency",angle:"Angle",resistance:"Resistance",conductivity:"Conductivity",memory:"Memory"};
  const content=h("div",{class:"workspace-unit-settings"},
    h("p",{class:"hint",text:"Defaults for bare values and expressions in dimensional fields. Explicit units override them. Saved with this antenna; existing physical values do not change."}),
    ...Object.entries(UNIT_GROUPS).map(([group,units])=>{
      const select=h("select",{"aria-label":"Workspace "+labels[group]},...Object.keys(units).map(u=>h("option",{value:u,text:u})));
      select.value=current[group];fields[group]=select;
      return row(labels[group],select);
    }),
    h("p",{class:"hint"},"Examples: ",h("code",{text:"1 GHz"}),", ",h("code",{text:"1000 MHz"}),", ",h("code",{text:"{f_ghz * 1000} MHz"}),". Parameters remain scalar; units are applied in dimensional fields."));
  openDialog("Workspace units",content,[["Apply",()=>edit(doc=>{doc.workspace_units=Object.fromEntries(Object.entries(fields).map(([k,el])=>[k,el.value]));})]]);
}

async function menuAction(action) {
  closeMenus();
  const d = state.derived;
  switch (action) {
    case "new": loadDoc(STARTER, "New parametric starter"); break;
    case "examples": showExamples(); break;
    case "local-projects": await showLocalProjects(); break;
    case "save-local": await archiveProject({explicit:true}); break;
    case "clear-result-cache":
      try {
        const { count, bytes } = await resultCacheUsage();
        if (!count) { setStatus("No cached simulation results on this device"); break; }
        if (!window.confirm(`Delete ${count} cached simulation result(s) (${(bytes / (1 << 20)).toFixed(1)} MB) from this device? Saved local projects are kept.`)) break;
        const gone = await clearResultCache();
        clearResults();
        refresh();
        setStatus(`Cleared ${gone.count} cached result(s) · ${(gone.bytes / (1 << 20)).toFixed(1)} MB freed`);
      } catch (e) { setStatus("Result cache unavailable: " + e.message, true); }
      break;
    case "json": openSheet("json"); break;
    case "export-case":
      try {
        const ex = expandResolved(resolveCase(state.doc, d.case.parameters));
        if (!ex.cfg) throw Error(ex.error || "Geometry scripts are still running; try again");
        const cfg = ex.cfg;
        setStatus(await saveFile(`${slug()}${d.cases.length > 1 ? "__" + d.case.id : ""}.resolved.json`, JSON.stringify(cfg, null, 2) + "\n"));
      } catch (e) { setStatus(e.message, true); }
      break;
    case "copy":
      try { await navigator.clipboard.writeText(JSON.stringify(state.doc, null, 2)); setStatus("JSON copied"); }
      catch { setStatus("Clipboard unavailable — use the JSON tab", true); }
      break;
    case "paste":
      try { openFromText(await navigator.clipboard.readText(), "clipboard"); }
      catch { setStatus("Clipboard unavailable — paste into the JSON tab", true); }
      break;
    case "screenshot":
      try { setStatus(await saveFile(slug() + ".png", viewport.screenshot(), "image/png")); }
      catch (e) { setStatus(e.message, true); }
      break;
    case "workspace-units": showWorkspaceUnits(); break;
    case "theme": {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      storage.set(PREFS_KEY, { ...(storage.get(PREFS_KEY) || {}), theme: root.dataset.theme });
      viewport?.applyTheme();
      refresh({ tree: false, inspector: false, params: false, json: false });
      break;
    }
    case "about":
      openDialog("About the CSXCAD editor", h("div", {},
        h("p", { text: "A parametric geometry editor for radiators schema v2 antenna configs (CSXCAD primitives, materials, ports, domain, mesh and outputs)." }),
        h("p", { text: "Run the current lumped-port case in your browser with openEMS WebAssembly, or save the JSON into antennas/ for the native simulator (CI)." }),
        h("p", { class: "hint", text: "Touch: one finger orbits, two fingers zoom and pan, tap selects. Desktop: left-drag orbit, right-drag pan, wheel zoom; Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Ctrl+D duplicate, Delete removes, F fits." })));
      break;
  }
}

// ---------------------------------------------------------------- mobile sheets
function openSheet(name, { peek = false } = {}) {
  if (!mobile()) {
    if (["params", "scripts", "checks", "sim", "results", "json"].includes(name)) setDock(name);
    return;
  }
  const cur = document.body.dataset.sheet;
  if (cur === name && peek) { document.body.classList.add("sheet-peek"); syncViewInset(); return; }
  if (cur === name) return closeSheet();
  if (!cur) window.history.pushState({ sheet: name }, "");
  else window.history.replaceState({ sheet: name }, "");
  document.body.dataset.sheet = name;
  document.body.classList.remove("sheet-tall");
  document.body.classList.toggle("sheet-peek", peek);
  if (name === "scripts") setTimeout(() => scriptEditor?.refresh(), 280); // after the sheet slides in
  if (name === "json") { renderJson(true); ensureJsonEditor(); setJsonMax(true); }
  else if (document.body.classList.contains("json-max")) setJsonMax(false);
  for (const b of document.querySelectorAll(".mobile-nav button")) b.classList.toggle("active", b.dataset.sheet === name);
  for (const p of document.querySelectorAll(".dock-panel")) p.hidden = false;
  showChip();
  syncViewInset();
}
// Keep the model centred in the part of the 3D view a bottom sheet leaves visible.
function syncViewInset() {
  if (!viewport) return;
  const name = document.body.dataset.sheet;
  const panel = name && document.querySelector(`[data-sheet-name="${name}"]`);
  requestAnimationFrame(() => viewport.setBottomInset(panel && mobile() ? panel.getBoundingClientRect().height : 0));
}
function closeSheet(fromPop = false) {
  if (!document.body.dataset.sheet) return;
  if (document.body.classList.contains("json-max")) setJsonMax(false);
  if (state.scriptMax) { state.scriptMax = false; document.body.classList.remove("script-max"); }
  if (state.simMax) { state.simMax = false; document.body.classList.remove("sim-max"); }
  document.body.dataset.sheet = "";
  document.body.classList.remove("sheet-tall", "sheet-peek");
  for (const b of document.querySelectorAll(".mobile-nav button")) b.classList.remove("active");
  if (!fromPop && window.history.state?.sheet) window.history.back();
  showChip();
  syncViewInset();
}
function setDock(name) {
  if (name !== "scripts" && state.scriptMax) setScriptMax(false);
  if (name !== "sim" && state.simMax) setSimMax(false);
  state.dock = name;
  document.body.classList.remove("dock-collapsed");
  for (const t of document.querySelectorAll(".dock-tabs [role=tab]")) t.setAttribute("aria-selected", String(t.dataset.dock === name));
  for (const p of document.querySelectorAll(".dock-panel")) p.hidden = p.dataset.dockName !== name;
  if (name === "scripts") requestAnimationFrame(() => scriptEditor?.refresh()); // CodeMirror measures 0 while hidden
  if (name === "json") { renderJson(true); ensureJsonEditor(); refreshJsonEditor(); }
  else if (document.body.classList.contains("json-max")) setJsonMax(false);
}
// Desktop-only splitter. Store requested height separately from the current
// viewport clamp, so changing window size does not destroy the user's preference.
function installDockResize(prefs) {
  const el=$("dockResize"),dock=el.closest(".dock"),workspace=dock.closest(".workspace");
  let preferred=Number.isFinite(prefs.dockHeight)?prefs.dockHeight:270, drag=null;
  const bounds=()=>{const max=Math.max(150,workspace.clientHeight-140);return [Math.min(150,max),max];};
  const apply=(value,save=false)=>{
    if(!Number.isFinite(value))return;
    const [min,max]=bounds();
    preferred=Math.max(min,Math.min(1600,value));
    const height=Math.round(Math.min(max,preferred));
    document.documentElement.style.setProperty("--dock-h",height+"px");
    el.setAttribute("aria-valuemin",String(min));
    el.setAttribute("aria-valuemax",String(max));
    el.setAttribute("aria-valuenow",String(height));
    if(save)storage.set(PREFS_KEY,{...(storage.get(PREFS_KEY)||{}),dockHeight:preferred});
  };
  const expanded=()=>!document.body.classList.contains("dock-collapsed");
  const expand=()=>{document.body.classList.remove("dock-collapsed");storage.set(PREFS_KEY,{...(storage.get(PREFS_KEY)||{}),dockCollapsed:false});};
  const finish=()=>{if(!drag)return;drag=null;document.body.classList.remove("dock-resizing");apply(preferred,true);scriptEditor?.refresh();};
  el.addEventListener("pointerdown",e=>{
    if(mobile()||e.button!==0)return;
    e.preventDefault();el.setPointerCapture(e.pointerId);
    drag={y:e.clientY,height:dock.getBoundingClientRect().height,pointer:e.pointerId};
    if(!expanded())expand();
    document.body.classList.add("dock-resizing");
  });
  el.addEventListener("pointermove",e=>{if(drag?.pointer===e.pointerId){const [,max]=bounds();apply(Math.min(max,drag.height+drag.y-e.clientY));}});
  el.addEventListener("pointerup",finish);el.addEventListener("pointercancel",finish);el.addEventListener("lostpointercapture",finish);
  el.addEventListener("dblclick",()=>{expand();apply(270,true);scriptEditor?.refresh();});
  el.addEventListener("keydown",e=>{
    if(mobile()||!["ArrowUp","ArrowDown","Home","End"].includes(e.key))return;
    e.preventDefault();expand();
    const [min,max]=bounds(),current=Number(el.getAttribute("aria-valuenow"));
    apply(e.key==="Home"?min:e.key==="End"?max:Math.min(max,current+(e.key==="ArrowUp"?24:-24)),true);
    scriptEditor?.refresh();
  });
  const observer=new ResizeObserver(()=>{if(!mobile()&&!drag)apply(preferred);});
  observer.observe(workspace);
  if(!mobile())apply(preferred);
}
function installSheetDrag() {
  for (const head of document.querySelectorAll(".panel .panel-head")) {
    let y0 = null;
    head.addEventListener("pointerdown", e => { if (!mobile() || e.target.closest("button,select,input,label")) return; y0 = e.clientY; head.setPointerCapture(e.pointerId); });
    head.addEventListener("pointerup", e => {
      if (y0 === null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (dy < -30) {
        if (document.body.classList.contains("sheet-peek")) document.body.classList.remove("sheet-peek");
        else document.body.classList.add("sheet-tall");
      } else if (dy > 50) {
        if (document.body.classList.contains("sheet-tall")) document.body.classList.remove("sheet-tall");
        else closeSheet();
      }
      setTimeout(syncViewInset, 250);
    });
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  installAppViewport();
  const prefs = storage.get(PREFS_KEY) || {};
  if (isNative()) {
    // Inside the Android app there is no ../ results viewer next to us.
    for (const a of document.querySelectorAll('a[href="../"]')) { a.href = "https://winject-wireless.github.io/radiators/"; a.target = "_blank"; }
  }
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  if (prefs.dockCollapsed) document.body.classList.add("dock-collapsed");

  // UI wiring
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("save").addEventListener("click", save);
  $("openFile").addEventListener("change", async e => {
    const f = e.target.files?.[0];
    if (f) await openFile(f);
    e.target.value = "";
  });
  $("docName").addEventListener("change", () => edit(doc => { doc.name = $("docName").value.trim() || "Untitled antenna"; }, { inspector: false }));
  $("menuButton").addEventListener("click", e => {
    e.stopPropagation();
    const m = $("menu");
    const open = m.hidden;
    closeMenus();
    m.hidden = !open;
    $("menuButton").setAttribute("aria-expanded", String(open));
  });
  $("menu").addEventListener("click", e => { const a = e.target.closest("[data-action]"); if (a) menuAction(a.dataset.action); });
  $("addButton").addEventListener("click", e => { e.stopPropagation(); const wasOpen = !$("addMenu").hidden; closeMenus(); if (!wasOpen) openAddMenu(e.currentTarget); });
  document.addEventListener("click", e => { if (!e.target.closest(".menu, .menu-wrap, .add-wrap")) closeMenus(); });
  const facePairs = {
    top: ["top", "bottom", "z", 1],
    front: ["front", "back", "y", -1],
    right: ["right", "left", "x", 1],
  };
  const viewButtons = [...document.querySelectorAll("[data-view]")];
  const label = face => face[0].toUpperCase() + face.slice(1);
  let activeFace = null;
  function syncFaceButtons() {
    const direction = viewport.camera.position.clone().sub(viewport.controls.target).normalize();
    let face = null;
    for (const [first, opposite, axis, sign] of Object.values(facePairs)) {
      const alignment = direction[axis] * sign;
      if (Math.abs(alignment) > 0.999999) face = alignment > 0 ? first : opposite;
    }
    if (face === activeFace) return;
    activeFace = face;
    for (const button of viewButtons) {
      const pair = facePairs[button.dataset.view];
      if (!pair) continue;
      const [first, opposite] = pair;
      const selected = face === first || face === opposite;
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = label(selected ? face : first);
      button.title = "Show " + (face === first ? opposite : first) + " view";
    }
  }
  for (const button of viewButtons) button.addEventListener("click", () => {
    const preset = button.dataset.view;
    viewport?.view(facePairs[preset] && activeFace === preset ? facePairs[preset][1] : preset);
  });
  for (const b of document.querySelectorAll("[data-toggle]")) {
    const key = b.dataset.toggle;
    if (prefs.view && key in prefs.view) b.setAttribute("aria-pressed", String(prefs.view[key]));
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      viewport?.setOption(key, on);
      const p = storage.get(PREFS_KEY) || {};
      storage.set(PREFS_KEY, { ...p, view: { ...(p.view || {}), [key]: on } });
      if (key === "xray") refresh({ tree: false, inspector: false, params: false, json: false });
    });
  }
  for (const id of ["caseSelect", "resultCase"]) {
    $(id).addEventListener("change", e => changeCase(Number(e.target.value)));
  }
  $("meshToggle").addEventListener("click",()=>{
    const b=$("meshToggle");b.setAttribute("aria-pressed",String(b.getAttribute("aria-pressed")!=="true"));syncMeshView();
  });
  $("meshPlane").addEventListener("change",()=>syncMeshView({resetSlice:true}));
  for(const id of ["meshSlice","meshOpacity","meshHighlight","meshPml"])$(id).addEventListener("input",()=>syncMeshView());
  $("meshSmallest").addEventListener("click",()=>syncMeshView({jump:true}));
  $("patternSelect").addEventListener("change", e => {
    const run = resultFor(state.derived.case.id);
    if (run) { run.frequency = Number(e.target.value); syncResults(); }
  });
  for (const b of document.querySelectorAll("[data-section]")) b.addEventListener("click", () => {
    if (!activeProbe) return;
    const run = activeProbe.run, name = b.dataset.section;
    run.sections = run.sections.includes(name) ? run.sections.filter(x => x !== name) : [...run.sections, name];
    updateProbe();
  });
  $("probeToggle").addEventListener("click", () => {
    if (!activeProbe) return;
    const run = activeProbe.run; run.probeVisible = !run.probeVisible;
    if (!run.probeVisible) {
      run.followProbe = false;
      if (state.handle === "result-probe") state.handle = null;
    }
    updateProbe(); syncHandles();
  });
  $("sectionFollow").addEventListener("click", () => {
    if (!activeProbe?.run.probeVisible) return;
    activeProbe.run.followProbe = !activeProbe.run.followProbe; updateProbe();
  });
  $("probeSelect").addEventListener("click", () => {
    if (!activeProbe) return;
    activeProbe.run.probeVisible = true; state.handle = "result-probe";
    updateProbe(); syncHandles();
  });
  $("probeReset").addEventListener("click", () => {
    if (!activeProbe) return;
    activeProbe.run.probePosition = defaultProbe(activeProbe.record, viewport?.radiationRadius || 50);
    updateProbe(); syncHandles();
  });
  for (const t of document.querySelectorAll(".dock-tabs [role=tab]")) t.addEventListener("click", () => setDock(t.dataset.dock));
  $("dockToggle").addEventListener("click", () => {
    document.body.classList.toggle("dock-collapsed");
    storage.set(PREFS_KEY, { ...(storage.get(PREFS_KEY) || {}), dockCollapsed: document.body.classList.contains("dock-collapsed") });
  });
  for (const b of document.querySelectorAll(".mobile-nav button")) b.addEventListener("click", () => openSheet(b.dataset.sheet));
  for (const b of document.querySelectorAll(".sheet-close")) b.addEventListener("click", () => closeSheet());
  $("chipEdit").addEventListener("click", () => openSheet("inspect"));
  window.addEventListener("popstate", () => closeSheet(true));
  installDockResize(prefs);
  installSheetDrag();
  installResultSwipe();
  $("jsonSource").addEventListener("click", () => { state.jsonMode = "source"; renderJson(true); });
  $("jsonResolved").addEventListener("click", () => { state.jsonMode = "resolved"; renderJson(true); });
  $("jsonText").addEventListener("input", () => jsonChanged($("jsonText").value));
  $("jsonText").addEventListener("compositionstart", () => { jsonComposing = true; clearTimeout(jsonValidationTimer); });
  $("jsonText").addEventListener("compositionend", () => { jsonComposing = false; jsonChanged($("jsonText").value); });
  $("jsonText").addEventListener("blur", () => { jsonComposing = false; });
  $("jsonApply").addEventListener("click", applyJson);
  $("jsonDiscard").addEventListener("click", () => { jsonDraft = jsonBase = null; renderJson(true); });
  $("jsonWrap").addEventListener("click", () => {
    const wrap = $("jsonWrap").getAttribute("aria-pressed") !== "true";
    $("jsonWrap").setAttribute("aria-pressed", String(wrap));
    jsonEditor?.cm?.setOption("lineWrapping", wrap);
    $("jsonText").wrap = wrap ? "soft" : "off";
    $("jsonText").style.whiteSpace = wrap ? "pre-wrap" : "pre";
  });
  $("jsonMax").addEventListener("click", () => setJsonMax(!document.body.classList.contains("json-max")));
  $("jsonFormat").addEventListener("click", () => {
    if (state.jsonMode !== "source") return;
    try {
      const formatted = JSON.stringify(JSON.parse(jsonValue()), null, 2);
      const cm = jsonEditor?.cm;
      if (cm) cm.replaceRange(formatted, { line: 0, ch: 0 }, cm.posFromIndex(cm.getValue().length), "+format");
      else { $("jsonText").value = formatted; jsonChanged(formatted); }
      validateJson();
    } catch (e) { validateJson(); }
  });
  document.addEventListener("keydown", e => {
    const typing = e.target.closest("input, textarea, select, [contenteditable], .CodeMirror");
    // JSON editing owns its keystrokes, including Android IME composition.
    if (e.isComposing || jsonComposing) return;
    if (typing && e.target.closest("#panelJson") && !((e.ctrlKey || e.metaKey) && e.key === "Enter")) return;
    if (e.key === "Escape" && document.body.classList.contains("json-max") && !e.defaultPrevented) { setJsonMax(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && e.target.closest("#panelJson") && state.jsonMode === "source") {
      e.preventDefault(); applyJson(); return;
    }
    // Esc leaves the maximized editor, unless the editor used it (e.g. to close the autocomplete list).
    if (e.key === "Escape" && state.scriptMax && !e.defaultPrevented) { setScriptMax(false); return; }
    if (e.key === "Escape" && state.simMax && !e.defaultPrevented) { setSimMax(false); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "d" && state.sel && state.sel.kind !== "sim") { e.preventDefault(); duplicate(state.sel.kind, state.sel.index); }
    else if ((e.key === "Delete" || e.key === "Backspace") && state.sel && state.sel.kind !== "sim") { e.preventDefault(); remove(state.sel.kind, state.sel.index); }
    else if (e.key === "Escape") { if (state.handle) { state.handle = null; syncHandles(); } else { closeMenus(); closeSheet(); } }
    else if (e.key === "f" || e.key === "F") viewport?.view("fit");
  });
  // A debounced draft must still reach localStorage when the tab goes away.
  const flushDraft = () => { if (state.doc) persist({ now: true }); };
  window.addEventListener("pagehide", flushDraft);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushDraft(); });

  // Drag & drop a JSON file anywhere.
  document.addEventListener("dragover", e => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", async e => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return; // Leave ordinary text/selection drag and drop to CodeMirror.
    e.preventDefault();
    await openFile(f);
  });

  // Initial document: ?example=<file>, else local draft, else starter.
  const draft = storage.get(draftKey()) ?? draftSlots()[0];
  pruneDrafts();
  const params = new URLSearchParams(location.search);
  let initial = STARTER, message = "Parametric Yagi starter loaded", showInitialResult=false;
  if (params.get("example")) {
    // A shared example link must not quietly discard the draft it replaces:
    // keep it as a local project revision the user can reopen.
    let kept = "";
    if (draft?.doc) {
      try { await saveLocalProject(draft.doc, draft.caseIndex || 0, (draft.doc.name || "Untitled") + " · draft replaced by example"); kept = " · previous draft kept in Local projects"; }
      catch { kept = " · previous draft could not be kept (local storage unavailable)"; }
    }
    try {
      let entry;
      try { const index=await fetch("./examples/index.json"); if(index.ok)entry=(await index.json()).find(e=>e.file===params.get("example")); } catch {}
      const loaded=await fetchExample(params.get("example"),entry);
      initial=loaded.doc;
      showInitialResult=loaded.hasResult;
      message = "Loaded example " + params.get("example") + loaded.resultMessage + kept;
    } catch { message = "Example not found; starter loaded" + kept; }
  } else if (draft?.doc) {
    initial = draft.doc;
    state.caseIndex = Math.max(0,Math.trunc(Number(draft.caseIndex)||0));
    message = `Restored local draft (${new Date(draft.savedAt).toLocaleString()})`;
  }
  try { state.doc = normalizeDoc(initial); } catch { state.doc = normalizeDoc(STARTER); }
  if(!params.get("example"))await seedMatchingExample(state.doc);
  if(showInitialResult)showBundledResultsFor=state.doc;
  if(!params.get("example")&&draft?.skipArchive&&JSON.stringify(draft.doc)===JSON.stringify(state.doc))state.deletedArchiveKey=JSON.stringify(state.doc);
  state.sel = null; // open showing the whole model; selecting a part fades the rest

  // 3D (WebGL may be unavailable in some WebViews; the editor still works).
  try {
    const { Viewport } = await import("./viewport.js");
    viewport = new Viewport($("viewport"), {
      onPick: ref => select(ref, { fromView: true }),
      onHandle: onHandleTap,
      onHandleMove, onHandleDrag, onScalarMove,
    });
    viewport.controls.addEventListener("change", syncFaceButtons);
    // ?debug exposes internals for automated UI tests.
    if (new URLSearchParams(location.search).has("debug")) window.__csxcad = { state, viewport, scriptRT };
    for (const b of document.querySelectorAll("[data-toggle]")) viewport.setOption(b.dataset.toggle, b.getAttribute("aria-pressed") === "true");
  } catch (e) {
    $("viewError").hidden = false;
    $("viewError").textContent = "3D view unavailable: " + e.message;
  }
  for (const b of Object.values(BUILTIN_SCRIPTS)) scriptResult(b.source, null); // warm built-in argument lists
  renderScripts();
  refresh();
  setStatus(message);
  matchMedia("(max-width: 760px)").addEventListener("change", () => { closeSheet(); setDock(state.dock); refresh({ params: false }); });
}

// Start isolation before the editor loads its examples and WebGL viewport.
registerServiceWorker();
// A new build is live: this session keeps running its own, consistent build
// until the user reloads, so offer the reload rather than switching under it.
onUpdateReady(reload => {
  // One banner per session: offer() can fire for a waiting worker at load and
  // again on a later updatefound. Not class "toast" either — toast() reuses the
  // first .toast element it finds and would overwrite this.
  if (document.querySelector(".update-bar")) return;
  const bar = h("div", { class: "update-bar", role: "status" },
    "A new editor build is available.",
    h("button", { type: "button", class: "primary", onclick: reload }, "Reload"),
    h("button", { type: "button", "aria-label": "Dismiss", onclick: () => bar.remove() }, "Later"));
  Object.assign(bar.style, { position: "fixed", left: "50%", bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", background: "var(--panel)", border: "1px solid var(--line-2)",
    padding: "8px 12px", borderRadius: "18px", zIndex: 101, display: "flex", gap: "10px", alignItems: "center",
    fontSize: "13px", boxShadow: "0 6px 18px rgb(0 0 0 / .3)" });
  document.body.append(bar);
});
boot();
