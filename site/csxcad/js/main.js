// Radiators CSXCAD editor — application shell.
// The document is a radiators schema v2 config *template*: numbers may be
// {"$param"} / {"$expr"} placeholders that scripts/sweep.py resolves per case.
import {
  parameterSets, resolveTemplate, resolveCase, fieldToValue, valueToField, isTemplate,
  validParameterName, renameParameter, parameterUsage, MAX_CASES,
} from "./params.js";
import { SHAPES, MATERIALS, PORTS, BOUNDARIES, STARTER } from "./schema.js";
import { checkCase } from "./checks.js";
import { solverBounds } from "./geometry.js";
import { storage, saveFile, registerServiceWorker, isNative } from "./platform.js";

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
const add = (el, ...kids) => el.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
const DRAFT_KEY = "radiators-csxcad-draft-v1";
const PREFS_KEY = "radiators-csxcad-prefs-v1";
const mobile = () => matchMedia("(max-width: 760px), (max-height: 520px) and (max-width: 1000px)").matches;

// ---------------------------------------------------------------- state
const state = {
  doc: null,
  sel: null,            // {kind:"geometry"|"port"|"material"|"sim", index}
  hidden: new Set(),
  caseIndex: 0,
  jsonMode: "source",
  dock: "params",
  derived: null,
};
const history = { undo: [], redo: [], live: null };
let viewport = null;
let fieldRefreshers = [];

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
function normalizeDoc(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw Error("Not a JSON object");
  if (cfg.schema_version === 1) throw Error("schema_version 1 is not supported by the editor; convert to schema v2");
  if (cfg.schema_version !== 2) throw Error("Requires radiators schema_version 2");
  if (!Array.isArray(cfg.geometry)) throw Error("geometry must be an array");
  if (!Array.isArray(cfg.materials)) throw Error("materials must be an array");
  const doc = clone(cfg);
  doc.units ??= "mm";
  doc.ports ??= [];
  return doc;
}

function loadDoc(cfg, message) {
  state.doc = normalizeDoc(cfg);
  state.sel = state.doc.geometry.length ? { kind: "geometry", index: 0 } : { kind: "sim" };
  state.hidden.clear();
  state.caseIndex = 0;
  history.undo = []; history.redo = [];
  if (viewport) viewport._fitted = false;
  refresh();
  if (message) setStatus(message);
}

function persist() {
  storage.set(DRAFT_KEY, { doc: state.doc, savedAt: new Date().toISOString() });
}

// Structural edit with undo. fn mutates state.doc.
function edit(fn, opts = {}) {
  const before = JSON.stringify(state.doc);
  try { fn(state.doc); }
  catch (e) { state.doc = JSON.parse(before); setStatus(e.message, true); return false; }
  if (JSON.stringify(state.doc) === before) return true;
  if (history.live === null) pushUndo(before);
  persist();
  refresh(opts);
  return true;
}
function pushUndo(snapshot) {
  history.undo.push(snapshot);
  if (history.undo.length > 200) history.undo.shift();
  history.redo = [];
}
// Live edits (sliders): one undo step per gesture.
function beginLive() { if (history.live === null) history.live = JSON.stringify(state.doc); }
function endLive() {
  if (history.live === null) return;
  if (history.live !== JSON.stringify(state.doc)) pushUndo(history.live);
  history.live = null;
  persist();
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
  const list = { geometry: state.doc.geometry, port: state.doc.ports, material: state.doc.materials }[s.kind] || [];
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
    if (k === "geometry") d.geometry = v.map((g, i) => lenient(g, m => { d.errors.geometry[i] = m; }));
    else if (k === "ports") d.ports = (v || []).map((p, i) => lenient(p, m => { d.errors.port[i] = m; }));
    else d.resolved[k] = lenient(v, m => d.errors.other.push(`${k}: ${m}`));
  }
  d.resolved.geometry = d.geometry;
  d.resolved.ports = d.ports;
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
  if (doc.generator) add({ level: "warn", where: "generator", msg: `Geometry is produced at simulation time by ${doc.generator.path || "a Python generator"}; the preview shows only the base geometry.` }, "all");
  const cases = d.caseError ? [d.case] : d.cases;
  for (const c of cases) {
    let cfg;
    try { cfg = resolveCase(doc, c.parameters); }
    catch (e) { add({ level: "error", where: "parameters", msg: e.message }, c.id); continue; }
    if (doc.generator) continue;
    for (const item of checkCase(cfg)) add(item, c.id);
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
function numField(path, { optional = false, def, int = false, unit, placeholder, onLive, aria } = {}) {
  const wrap = h("div", { class: "field" });
  const input = h("input", { type: "text", inputmode: "text", autocapitalize: "off", autocomplete: "off",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "done", "aria-label": aria || path.join("."),
    placeholder: placeholder ?? (optional && def !== undefined ? String(def) : "") });
  const hint = h("div", { class: "value" });
  wrap.append(input, hint);
  const show = () => {
    const v = getPath(state.doc, path);
    if (document.activeElement !== input) input.value = valueToField(v);
    evaluateHint(v);
  };
  const evaluateHint = v => {
    wrap.classList.toggle("expr", isTemplate(v));
    wrap.classList.remove("invalid");
    hint.replaceChildren();
    if (v === undefined) { if (unit) hint.textContent = unit; return; }
    if (isTemplate(v)) {
      try {
        const r = resolveTemplate(v, state.derived.params);
        hint.textContent = "= " + fmt(r) + (unit ? " " + unit : "");
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
    } else if (unit) hint.textContent = unit;
  };
  const commit = () => {
    const text = input.value.trim();
    let value;
    if (text === "" && optional) value = undefined;
    else {
      try { value = fieldToValue(text); }
      catch (e) { wrap.classList.add("invalid"); hint.textContent = e.message; return; }
      if (int && typeof value === "number" && !Number.isInteger(value)) {
        wrap.classList.add("invalid"); hint.textContent = "Must be an integer"; return;
      }
    }
    edit(doc => setPath(doc, path, value), { inspector: false });
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  if (onLive) input.addEventListener("input", () => onLive(input.value));
  fieldRefreshers.push(show);
  show();
  return wrap;
}
const fmt = v => typeof v === "number" ? String(+v.toPrecision(8)) : JSON.stringify(v);

function vec3Field(path, opts = {}) {
  return h("div", { class: "vec3" }, ["x", "y", "z"].map((axis, i) =>
    numField([...path, i], { ...opts, aria: `${opts.label || path.join(".")} ${axis}`, placeholder: axis })));
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
function selectField(path, options, { optional = false, aria, onCommit } = {}) {
  const sel = h("select", { "aria-label": aria });
  const opts = optional ? [["", "—"], ...options] : options;
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
    case "vec3": return vec3Field(path, { label: def.label });
    case "num": return numField(path, { optional: def.optional, def: def.default, aria: def.label });
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
      onclick: () => edit(doc => getPath(doc, path).splice(i, 1)) }, "✕"))));
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
    const hidden = state.hidden.has(i);
    const m = mats.get(typeof g.material === "string" ? g.material : "");
    return h("li", { class: "tree-row" + (isSel("geometry", i) ? " active" : "") + (d.errors.geometry[i] ? " invalid" : "") + (hidden ? " tree-hidden" : "") },
      h("button", { type: "button", class: "vis", title: hidden ? "Show" : "Hide (preview only)", "aria-label": (hidden ? "Show " : "Hide ") + (g.name || g.shape),
        onclick: () => { hidden ? state.hidden.delete(i) : state.hidden.add(i); refresh({ inspector: false, params: false }); } }, hidden ? "○" : "◉"),
      h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "geometry", index: i }) },
        h("span", { class: "swatch", style: `background:${swatch(m)}` }),
        h("span", { class: "nm", text: g.name || g.shape }),
        h("span", { class: "kind", text: g.shape })));
  });
  const portRows = doc.ports.map((p, i) => h("li", { class: "tree-row" + (isSel("port", i) ? " active" : "") + (d.errors.port[i] ? " invalid" : "") },
    h("span", { class: "vis", style: "display:inline-flex;justify-content:center;color:" + (p.excite ? "#ff4d5e" : "var(--muted)") }, p.excite ? "⚡" : "·"),
    h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "port", index: i }) },
      h("span", { class: "nm", text: `${p.name || "port"} #${p.id ?? i + 1}` }), h("span", { class: "kind", text: p.type }))));
  const matRows = doc.materials.map((m, i) => h("li", { class: "tree-row" + (isSel("material", i) ? " active" : "") },
    h("span", { class: "vis", style: "display:inline-flex;justify-content:center" }, h("span", { class: "swatch", style: `background:${swatch(m)}` })),
    h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "material", index: i }) },
      h("span", { class: "nm", text: m.name }), h("span", { class: "kind", text: m.type }))));
  const simRow = h("li", { class: "tree-row" + (state.sel?.kind === "sim" ? " active" : "") },
    h("span", { class: "vis", style: "display:inline-flex;justify-content:center" }, "⚙"),
    h("button", { type: "button", class: "tree-name", onclick: () => select({ kind: "sim" }) },
      h("span", { class: "nm", text: "Domain, mesh & outputs" })));
  tree.append(
    section(`Geometry (${doc.geometry.length})`, "geometry", geomRows, "geometry"),
    section(`Ports (${doc.ports.length})`, "port", portRows, "port"),
    section(`Materials (${doc.materials.length})`, "material", matRows, "material"),
    section("Simulation", "sim", [simRow]));
}
function swatch(m) {
  return { pec: "#d9a54a", conductive: "#c77b4a", conducting_sheet: "#e8884a", dielectric: "#4fb38a" }[m?.type] || "#8aa0b8";
}

function select(ref, { fromView = false } = {}) {
  state.sel = ref;
  refresh({ params: false, json: false, viewport: false });
  viewport?.setSelection(ref && (ref.kind === "geometry" || ref.kind === "port") ? ref : null);
  if (mobile()) {
    if (fromView) showChip();
    else openSheet("inspect");
  }
}
function showChip() {
  const chip = $("selectionChip");
  const s = state.sel;
  if (!s || !mobile() || document.body.dataset.sheet) { chip.hidden = true; return; }
  const item = s.kind === "geometry" ? state.doc.geometry[s.index] : s.kind === "port" ? state.doc.ports[s.index] : null;
  if (!item) { chip.hidden = true; return; }
  $("chipText").textContent = `${item.name || item.shape || "port"} · ${item.shape || item.type}`;
  chip.hidden = false;
}

// ---------------------------------------------------------------- inspector
function renderInspector() {
  const box = $("inspector");
  fieldRefreshers = [];
  box.replaceChildren();
  const s = state.sel;
  const title = $("inspectTitle");
  if (!s) {
    title.textContent = "Inspector";
    add(box, h("p", { class: "hint", text: "Select a component in the tree or tap it in the 3D view." }),
      h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => select({ kind: "sim" }) }, "Simulation settings"),
        h("button", { type: "button", onclick: e => openAddMenu(e.currentTarget, "geometry") }, "+ Add geometry")));
    return;
  }
  if (s.kind === "geometry") return inspectGeometry(box, title, s.index);
  if (s.kind === "port") return inspectPort(box, title, s.index);
  if (s.kind === "material") return inspectMaterial(box, title, s.index);
  if (s.kind === "sim") return inspectSim(box, title);
}

function knownKeysNote(obj, known) {
  const extra = Object.keys(obj).filter(k => !known.includes(k));
  return extra.length ? h("p", { class: "hint", text: "Also preserved (edit in JSON): " + extra.join(", ") }) : null;
}

function inspectGeometry(box, title, i) {
  const g = state.doc.geometry[i];
  const def = SHAPES[g.shape];
  title.textContent = g.name || g.shape;
  const base = ["geometry", i];
  const err = state.derived.errors.geometry[i];
  add(box, 
    err ? h("div", { class: "note warn", text: err }) : null,
    h("div", { class: "form-section" },
      row("Name", textField([...base, "name"], { aria: "Component name", onCommit: (v, input) => {
        if (!v) { input.value = g.name || ""; return setStatus("Name is required", true); }
        if (state.doc.geometry.some((o, k) => k !== i && o.name === v)) { input.value = g.name || ""; return setStatus("Component names must be unique", true); }
        edit(doc => { doc.geometry[i].name = v; });
      } })),
      row("Material", selectField([...base, "material"], state.doc.materials.map(m => [m.name, `${m.name} (${m.type})`]), { aria: "Material" })),
      row("Shape", h("div", { class: "lbl", style: "padding-top:7px", text: def ? def.label : `${g.shape} (unsupported)` })),
      def?.hint ? h("p", { class: "hint", text: def.hint }) : null),
  );
  if (!def) { add(box, h("div", { class: "note warn", text: "This shape is not part of schema v2; edit it in JSON." })); return; }
  const shapeSec = h("div", { class: "form-section" }, h("h3", { text: "Dimensions · mm" }));
  for (const f of def.fields) shapeSec.append(row(f.label, fieldFor(f, [...base, f.key]), f.type === "points" ? "wide" : ""));
  add(box, shapeSec);

  const tf = h("details", { class: "form-section", open: !!g.transform || undefined },
    h("summary", { text: "Transform · rotate X→Y→Z, then translate" }),
    row("Rotate (°)", vec3Field([...base, "transform", "rotate_deg"], { optional: true, label: "rotate" })),
    row("Translate", vec3Field([...base, "transform", "translate"], { optional: true, label: "translate" })),
    h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(doc => { delete doc.geometry[i].transform; }) }, "Clear transform")));
  const adv = h("details", { class: "form-section", open: g.priority !== undefined || undefined },
    h("summary", { text: "Advanced" }),
    row("Priority", numField([...base, "priority"], { optional: true, def: 10, int: true, aria: "Priority" })),
    h("p", { class: "hint", text: "Higher priority wins where primitives overlap (CSXCAD). Default 10; ports default 5." }),
    knownKeysNote(g, ["name", "material", "shape", "transform", "priority", "editor_id", ...def.fields.map(f => f.key)]));
  add(box, tf, adv, h("div", { class: "actions" },
    h("button", { type: "button", onclick: () => duplicate("geometry", i) }, "Duplicate"),
    h("button", { type: "button", onclick: () => arrayDialog(i) }, "Array…"),
    h("button", { type: "button", disabled: i === 0, onclick: () => move("geometry", i, -1), "aria-label": "Move up" }, "↑"),
    h("button", { type: "button", disabled: i === state.doc.geometry.length - 1, onclick: () => move("geometry", i, 1), "aria-label": "Move down" }, "↓"),
    h("button", { type: "button", class: "danger", onclick: () => remove("geometry", i) }, "Delete")));
  // Bounds read-out for the current case
  const rg = state.derived.geometry[i];
  if (rg) {
    try {
      const [lo, hi] = solverBounds(rg);
      add(box, h("p", { class: "hint", text: `Bounds (${state.derived.case.id}): [${lo.map(fmt).join(", ")}] → [${hi.map(fmt).join(", ")}] mm` }));
    } catch { /* reported in checks */ }
  }
}

function inspectPort(box, title, i) {
  const p = state.doc.ports[i];
  const def = PORTS[p.type === "lumped_port" ? "lumped" : p.type];
  title.textContent = `Port ${p.name || ""} #${p.id ?? i + 1}`;
  const base = ["ports", i];
  const excite = h("input", { type: "checkbox" });
  excite.checked = !!p.excite;
  excite.addEventListener("change", () => edit(doc => {
    doc.ports.forEach((q, k) => { if (k === i) q.excite = excite.checked; else if (excite.checked && q.excite) q.excite = false; });
  }));
  const err = state.derived.errors.port[i];
  add(box, err ? h("div", { class: "note warn", text: err }) : null,
    h("div", { class: "form-section" },
      row("Name", textField([...base, "name"], { optional: true, aria: "Port name" })),
      row("Port ID", numField([...base, "id"], { int: true, aria: "Port ID" })),
      row("Type", selectField([...base, "type"], Object.entries(PORTS).map(([k, v]) => [k, v.label]), { aria: "Port type", onCommit: v => edit(doc => {
        const old = doc.ports[i];
        doc.ports[i] = { id: old.id, name: old.name, type: v, ...clone(PORTS[v].template), start: old.start, stop: old.stop, excite: old.excite };
        const pec = doc.materials.find(m => m.type === "pec");
        if (v !== "lumped" && pec) doc.ports[i].metal_material = pec.name;
      }) })),
      h("label", { class: "check-inline" }, excite, "Excited port (exactly one per run)")));
  if (def) {
    const sec = h("div", { class: "form-section" }, h("h3", { text: "Feed geometry · mm" }));
    for (const f of def.fields) sec.append(row(f.label, fieldFor(f, [...base, f.key])));
    add(box, sec);
    if (p.type !== "lumped" && !state.doc.materials.some(m => m.type === "pec")) {
      add(box, h("div", { class: "note warn", text: "This port type needs a PEC material." }));
    }
  }
  add(box, h("details", { class: "form-section" }, h("summary", { text: "Advanced" }),
    row("Priority", numField([...base, "priority"], { optional: true, def: 5, int: true, aria: "Port priority" })),
    knownKeysNote(p, ["id", "name", "type", "excite", "priority", ...(def?.fields.map(f => f.key) || [])])),
  h("div", { class: "actions" },
    h("button", { type: "button", onclick: () => duplicate("port", i) }, "Duplicate"),
    h("button", { type: "button", class: "danger", onclick: () => remove("port", i) }, "Delete")),
  h("p", { class: "hint", text: "One excited port per FDTD run; the simulator exports S11 of that port only." }));
}

function inspectMaterial(box, title, i) {
  const m = state.doc.materials[i];
  title.textContent = "Material " + m.name;
  const base = ["materials", i];
  const uses = state.doc.geometry.filter(g => g.material === m.name).length +
    state.doc.ports.filter(p => p.metal_material === m.name || p.dielectric_material === m.name).length;
  const def = MATERIALS[m.type];
  add(box, h("div", { class: "form-section" },
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
    ...(def?.fields || []).map(f => row(f.label, numField([...base, f.key], { optional: f.optional, def: f.default, aria: f.label })))),
  h("p", { class: "hint", text: `Used by ${uses} item${uses === 1 ? "" : "s"}.` + (m.type === "conducting_sheet" ? " Conducting sheets apply only to zero-thickness boxes; thickness is in metres." : "") }),
  h("div", { class: "actions" },
    h("button", { type: "button", onclick: () => duplicate("material", i) }, "Duplicate"),
    h("button", { type: "button", class: "danger", disabled: uses > 0, title: uses ? "In use" : "", onclick: () => remove("material", i) }, "Delete")));
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
      h("p", { class: "hint", text: "Band = center ± fc. Expressions work here too, e.g. f_ghz * 1e9." })),
    h("details", { class: "form-section", open: true }, h("summary", { text: "Domain · mm" }),
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
      doc.mesh?.grid_mode === "uniform" ? row("Uniform step", numField(["mesh", "uniform_step_mm"], { optional: true, unit: "mm", aria: "Uniform step" })) : null,
      h("h3", { class: "muted", style: "font-size:11px;margin:10px 0 4px", text: `REFINEMENT BOXES (${refinements.length})` }),
      ...refinements.map((r, k) => h("div", { class: "note" },
        row("Start", vec3Field(["mesh", "refinements", k, "start"], { label: `refinement ${k + 1} start` })),
        row("Stop", vec3Field(["mesh", "refinements", k, "stop"], { label: `refinement ${k + 1} stop` })),
        row("Resolution", numField(["mesh", "refinements", k, "resolution_mm"], { unit: "mm", aria: "Refinement resolution" })),
        h("button", { type: "button", class: "small danger", onclick: () => edit(d => d.mesh.refinements.splice(k, 1)) }, "Remove"))),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(d => {
        d.mesh ??= {}; d.mesh.refinements ??= [];
        const sel = state.sel?.kind === "geometry" ? state.derived.geometry[state.sel.index] : null;
        d.mesh.refinements.push({ start: [-10, -10, -10], stop: [10, 10, 10], resolution_mm: 0.5 });
        void sel;
      }) }, "+ Refinement box"))),
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
        h("button", { type: "button", class: "icon", "aria-label": "Remove frequency", onclick: () => edit(d => d.outputs.radiation_frequencies_hz.splice(k, 1)) }, "✕"))),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", disabled: pats.length >= 12, onclick: () => edit(d => {
        d.outputs ??= {}; d.outputs.radiation_frequencies_hz ??= [];
        d.outputs.radiation_frequencies_hz.push(state.derived.resolved.excitation?.center_hz || 2.45e9);
      }) }, "+ Far-field frequency")),
      row("θ step", numField(["outputs", "radiation_grid", "theta_step_deg"], { optional: true, unit: "°", aria: "Theta step" })),
      row("φ step", numField(["outputs", "radiation_grid", "phi_step_deg"], { optional: true, unit: "°", aria: "Phi step" })),
      checkField(["outputs", "include_realized_gain"], "Realized gain"),
      checkField(["outputs", "include_polarization"], "E_θ / E_φ polarization"),
      checkField(["outputs", "include_impedance"], "Input impedance")),
    h("details", { class: "form-section" }, h("summary", { text: "Solver & CI resources" }),
      row("Max timesteps", numField(["solver", "max_timesteps"], { optional: true, def: 20000, int: true, aria: "Max timesteps" })),
      row("End criteria", numField(["solver", "end_criteria"], { optional: true, def: 0.0001, aria: "End criteria" })),
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
const listOf = (doc, kind) => ({ geometry: doc.geometry, port: doc.ports, material: doc.materials })[kind];
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
    item.name = uniqueName(list.map(x => x.name), (item.name || item.shape || "item") + "-copy");
    list.splice(i + 1, 0, item);
    state.sel = { kind, index: i + 1 };
  });
}
function remove(kind, i) {
  const item = listOf(state.doc, kind)[i];
  edit(doc => {
    listOf(doc, kind).splice(i, 1);
    if (kind === "geometry") state.hidden = new Set([...state.hidden].filter(k => k !== i).map(k => k > i ? k - 1 : k));
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
  const step = ["x", "y", "z"].map((a, k) => h("input", { type: "text", value: k === 0 ? "10" : "0", "aria-label": "Step " + a, spellcheck: "false", autocapitalize: "off" }));
  openDialog("Linear array of " + (g.name || g.shape), h("div", {},
    h("p", { class: "hint", text: "Adds copies translated by k × step. Step components may be parameters or expressions (e.g. pitch, lambda/2)." }),
    row("Copies", count), row("Step (mm)", h("div", { class: "vec3" }, step))), [
    ["Create", () => {
      const n = Math.trunc(Number(count.value));
      if (!(n >= 1 && n <= 200)) return setStatus("Copies must be 1–200", true);
      let steps;
      try { steps = step.map(s => fieldToValue(s.value)); } catch (e) { return setStatus(e.message, true); }
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
    h("div", { class: "form-section" }, h("h3", { text: "Parameters" }),
      Object.keys(params).length ? table : h("p", { class: "hint", text: "No parameters yet. Add one, then type its name (or an expression like 2*gap + 1) into any numeric field." }),
      unknown.length ? h("div", { class: "note warn" }, "Referenced but undefined: ", unknown.join(", "), " ",
        h("button", { type: "button", class: "small", onclick: () => edit(dd => { dd.parameters ??= {}; unknown.forEach(n => { dd.parameters[n] = 1; }); }) }, "Define all = 1")) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => edit(dd => { dd.parameters ??= {}; dd.parameters[uniqueParam(dd, "p")] = 1; }) }, "+ Parameter")),
      h("p", { class: "hint", text: "Fields accept numbers, a parameter name ({\"$param\"}) or an expression ({\"$expr\"}) with + − * / % **, abs min max sqrt sin cos tan floor ceil, pi, e — the same grammar the radiators sweep runner evaluates." })));
  add(box, h("div", { class: "params-layout" }, left, renderSweep(d, swept)));
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
    h("td", {}, h("button", { type: "button", class: "icon", "aria-label": `Delete ${name}`, onclick: () => edit(doc => { delete doc.parameters[name]; if (!Object.keys(doc.parameters).length) delete doc.parameters; }) }, "✕")));
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
  sec.append(h("label", { class: "check-inline" }, on, "Expand into independent simulation cases (max " + MAX_CASES + ")"));
  if (!doc.sweep) return sec;
  const mode = h("select", { "aria-label": "Sweep mode" },
    h("option", { value: "product", text: "product — every combination" }), h("option", { value: "zip", text: "zip — pair equal-length axes" }));
  mode.value = doc.sweep.mode || "product";
  mode.addEventListener("change", () => edit(dd => { dd.sweep.mode = mode.value; }));
  sec.append(row("Mode", mode));
  for (const [name, spec] of Object.entries(doc.sweep.parameters || {})) sec.append(sweepAxis(name, spec));
  sec.append(h("div", { class: "actions" }, h("button", { type: "button", class: "small", onclick: () => edit(dd => {
    dd.sweep.parameters ??= {};
    const cand = Object.entries(dd.parameters || {}).find(([k, v]) => typeof v === "number" && !(k in dd.sweep.parameters));
    const name = cand ? cand[0] : uniqueParam(dd, "s");
    dd.sweep.parameters[name] = { values: cand ? [cand[1]] : [1, 2] };
  }) }, "+ Sweep axis")));
  if (d.caseError) sec.append(h("div", { class: "note warn", text: d.caseError }));
  else {
    sec.append(h("div", { class: "hint", text: `${d.cases.length} case${d.cases.length > 1 ? "s" : ""} → results/${slug()}__case-0001 … each runs as its own FDTD job.` }));
    const list = h("div", { class: "case-list", role: "listbox", "aria-label": "Cases" });
    d.cases.forEach((c, k) => list.append(h("div", { role: "option", class: k === state.caseIndex ? "active" : "", "aria-selected": String(k === state.caseIndex),
      onclick: () => { state.caseIndex = k; refresh(); }, text: `${c.id}  ${c.name}` })));
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
    }) }, "✕"));
}

// ---------------------------------------------------------------- checks panel
function renderChecks() {
  const { list, caseCount } = state.derived.checks;
  const errors = list.filter(c => c.level === "error").length, warns = list.length - errors;
  for (const id of ["checkBadge", "checkBadgeMobile"]) {
    const b = $(id);
    b.textContent = errors ? errors : warns ? warns : "✓";
    b.className = "badge " + (errors ? "error" : warns ? "warn" : "ok");
  }
  const box = $("checks");
  box.replaceChildren(
    h("div", { class: "check-summary" },
      h("strong", { text: errors ? `${errors} error${errors > 1 ? "s" : ""}` : "No blocking errors" }),
      warns ? h("span", { class: "muted", text: `${warns} warning${warns > 1 ? "s" : ""}` }) : null,
      h("span", { class: "muted", text: `· ${caseCount} case${caseCount > 1 ? "s" : ""} checked` })),
    h("p", { class: "hint", text: "These mirror the input validation in antennas/simulate_v2.py. Passing them does not validate the feed model or mesh convergence." }));
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
function renderJson(force = false) {
  const ta = $("jsonText");
  if (!force && document.activeElement === ta) return;
  if (!force && ta.dataset.dirty === "1") return;
  const d = state.derived;
  $("jsonSource").setAttribute("aria-pressed", String(state.jsonMode === "source"));
  $("jsonResolved").setAttribute("aria-pressed", String(state.jsonMode === "resolved"));
  $("jsonApply").hidden = state.jsonMode !== "source";
  ta.readOnly = state.jsonMode !== "source";
  if (state.jsonMode === "source") ta.value = JSON.stringify(state.doc, null, 2);
  else {
    try { ta.value = JSON.stringify(resolveCase(state.doc, d.case.parameters), null, 2); }
    catch (e) { ta.value = "// " + e.message; }
  }
  ta.dataset.dirty = "0";
}

// ---------------------------------------------------------------- refresh
function refresh(opts = {}) {
  const o = { tree: true, inspector: true, params: true, json: true, viewport: true, ...opts };
  const d = derive();
  document.title = `${state.doc.name || "Untitled"} · CSXCAD Editor`;
  if (document.activeElement !== $("docName")) $("docName").value = state.doc.name || "";
  $("docMeta").textContent = `schema v2 · mm · ${state.doc.geometry.length} parts` + (d.cases.length > 1 ? ` · ${d.cases.length} cases` : "");
  $("undo").disabled = !history.undo.length;
  $("redo").disabled = !history.redo.length;
  const caseSel = $("caseSelect");
  $("caseWrap").hidden = d.cases.length < 2;
  if (d.cases.length > 1) {
    caseSel.replaceChildren(...d.cases.map((c, k) => h("option", { value: k, text: `${c.id} · ${c.name}` })));
    caseSel.value = state.caseIndex;
  }
  if (o.tree) renderTree();
  if (o.inspector) renderInspector();
  else fieldRefreshers.forEach(f => f());
  if (o.params) renderParams();
  renderChecks();
  if (o.json) renderJson();
  if (o.viewport && viewport) {
    const errs = viewport.update({ geometry: d.geometry, ports: d.ports, materials: d.resolved.materials || [],
      domain: d.resolved.domain, mesh: d.resolved.mesh, hidden: state.hidden });
    const ve = $("viewError");
    const unresolved = Object.keys(d.errors.geometry).length;
    const msgs = [...errs.map(e => `${state.doc.geometry[e.index]?.name || "#" + (e.index + 1)}: ${e.message}`),
      ...(unresolved ? [`${unresolved} part(s) not shown: unresolved parameters`] : [])];
    ve.hidden = !msgs.length;
    ve.textContent = msgs.slice(0, 3).join(" · ") + (msgs.length > 3 ? ` (+${msgs.length - 3})` : "");
  }
  showChip();
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
    for (const [k, v] of Object.entries(SHAPES)) menu.append(h("button", { role: "menuitem", onclick: () => addItem("geometry", k) }, v.label));
  }
  if (!only || only === "port") {
    menu.append(heading("Ports"));
    for (const [k, v] of Object.entries(PORTS)) menu.append(h("button", { role: "menuitem", onclick: () => addItem("port", k) }, v.label));
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

async function showExamples() {
  let index;
  try {
    const r = await fetch("./examples/index.json", { cache: "no-cache" });
    if (!r.ok) throw Error(r.status);
    index = await r.json();
  } catch {
    return openDialog("Examples", h("p", { class: "hint", text: "No bundled examples found. Run python3 site/csxcad/prepare.py (the Pages build does this) or open a file from antennas/." }));
  }
  openDialog("Open example", h("div", { class: "example-list" },
    h("button", { type: "button", onclick: () => { $("dialog").close(); loadDoc(STARTER, "Loaded parametric starter"); } },
      h("strong", { text: "Parametric monopole (starter)" }), h("small", { text: "Built-in · parameters + expressions" })),
    index.map(e => h("button", { type: "button", onclick: async () => {
      $("dialog").close();
      try {
        const r = await fetch("./examples/" + e.file);
        loadDoc(await r.json(), `Loaded ${e.source}`);
      } catch (err) { setStatus("Could not load example: " + err.message, true); }
    } }, h("strong", { text: e.name }), h("small", { text: `${e.source}${e.sweep ? " · sweep" : ""}${e.generator ? " · Python generator" : ""}${e.description ? " — " + e.description : ""}` })))));
}

const slug = () => (state.doc?.name || "antenna").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "antenna";

async function save() {
  try { setStatus(await saveFile(slug() + ".json", JSON.stringify(state.doc, null, 2) + "\n")); }
  catch (e) { setStatus("Save failed: " + e.message, true); }
}

function openFromText(text, label) {
  try { loadDoc(JSON.parse(text), "Opened " + label); }
  catch (e) { setStatus("Open failed: " + e.message, true); }
}

async function menuAction(action) {
  closeMenus();
  const d = state.derived;
  switch (action) {
    case "new": loadDoc(STARTER, "New parametric starter"); break;
    case "examples": showExamples(); break;
    case "export-case":
      try {
        const cfg = resolveCase(state.doc, d.case.parameters);
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
        h("p", { text: "It does not simulate. Save the JSON into antennas/ and the radiators openEMS scripts (scripts/run_simulations.py, CI) resolve parameters, expand sweeps and run each case." }),
        h("p", { class: "hint", text: "Touch: one finger orbits, two fingers zoom and pan, tap selects. Desktop: left-drag orbit, right-drag pan, wheel zoom; Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Ctrl+D duplicate, Delete removes, F fits." })));
      break;
  }
}

// ---------------------------------------------------------------- mobile sheets
function openSheet(name) {
  if (!mobile()) {
    if (["params", "checks", "json"].includes(name)) setDock(name);
    return;
  }
  const cur = document.body.dataset.sheet;
  if (cur === name) return closeSheet();
  if (!cur) window.history.pushState({ sheet: name }, "");
  else window.history.replaceState({ sheet: name }, "");
  document.body.dataset.sheet = name;
  document.body.classList.remove("sheet-tall");
  if (name === "json") renderJson(true);
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
  document.body.dataset.sheet = "";
  document.body.classList.remove("sheet-tall");
  for (const b of document.querySelectorAll(".mobile-nav button")) b.classList.remove("active");
  if (!fromPop && window.history.state?.sheet) window.history.back();
  showChip();
  syncViewInset();
}
function setDock(name) {
  state.dock = name;
  document.body.classList.remove("dock-collapsed");
  for (const t of document.querySelectorAll(".dock-tabs [role=tab]")) t.setAttribute("aria-selected", String(t.dataset.dock === name));
  for (const p of document.querySelectorAll(".dock-panel")) p.hidden = p.dataset.dockName !== name;
  if (name === "json") renderJson(true);
}
function installSheetDrag() {
  for (const head of document.querySelectorAll(".panel .panel-head")) {
    let y0 = null;
    head.addEventListener("pointerdown", e => { if (!mobile() || e.target.closest("button")) return; y0 = e.clientY; head.setPointerCapture(e.pointerId); });
    head.addEventListener("pointerup", e => {
      if (y0 === null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (dy < -30) document.body.classList.add("sheet-tall");
      else if (dy > 50) {
        if (document.body.classList.contains("sheet-tall")) document.body.classList.remove("sheet-tall");
        else closeSheet();
      }
      setTimeout(syncViewInset, 250);
    });
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
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
    if (f) openFromText(await f.text(), f.name);
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
  for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => viewport?.view(b.dataset.view));
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
  $("caseSelect").addEventListener("change", () => { state.caseIndex = +$("caseSelect").value; refresh(); });
  for (const t of document.querySelectorAll(".dock-tabs [role=tab]")) t.addEventListener("click", () => setDock(t.dataset.dock));
  $("dockToggle").addEventListener("click", () => {
    document.body.classList.toggle("dock-collapsed");
    storage.set(PREFS_KEY, { ...(storage.get(PREFS_KEY) || {}), dockCollapsed: document.body.classList.contains("dock-collapsed") });
  });
  for (const b of document.querySelectorAll(".mobile-nav button")) b.addEventListener("click", () => openSheet(b.dataset.sheet));
  for (const b of document.querySelectorAll(".sheet-close")) b.addEventListener("click", () => closeSheet());
  $("chipEdit").addEventListener("click", () => openSheet("inspect"));
  window.addEventListener("popstate", () => closeSheet(true));
  installSheetDrag();
  $("jsonSource").addEventListener("click", () => { state.jsonMode = "source"; renderJson(true); });
  $("jsonResolved").addEventListener("click", () => { state.jsonMode = "resolved"; renderJson(true); });
  $("jsonText").addEventListener("input", () => { $("jsonText").dataset.dirty = "1"; });
  $("jsonApply").addEventListener("click", () => {
    try {
      const next = normalizeDoc(JSON.parse($("jsonText").value));
      edit(doc => { Object.keys(doc).forEach(k => delete doc[k]); Object.assign(doc, next); fixSelection(); });
      $("jsonText").dataset.dirty = "0";
      renderJson(true);
      setStatus("JSON applied");
    } catch (e) { setStatus("Invalid JSON: " + e.message, true); }
  });
  document.addEventListener("keydown", e => {
    const typing = e.target.closest("input, textarea, select");
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "d" && state.sel && state.sel.kind !== "sim") { e.preventDefault(); duplicate(state.sel.kind, state.sel.index); }
    else if ((e.key === "Delete" || e.key === "Backspace") && state.sel && state.sel.kind !== "sim") { e.preventDefault(); remove(state.sel.kind, state.sel.index); }
    else if (e.key === "Escape") { closeMenus(); closeSheet(); }
    else if (e.key === "f" || e.key === "F") viewport?.view("iso");
  });
  // Drag & drop a JSON file anywhere.
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", async e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) openFromText(await f.text(), f.name);
  });

  // Initial document: ?example=<file>, else local draft, else starter.
  const draft = storage.get(DRAFT_KEY);
  const params = new URLSearchParams(location.search);
  let initial = STARTER, message = "Parametric starter loaded";
  if (params.get("example")) {
    try {
      const r = await fetch("./examples/" + encodeURIComponent(params.get("example")));
      initial = await r.json();
      message = "Loaded example " + params.get("example");
    } catch { message = "Example not found; starter loaded"; }
  } else if (draft?.doc) {
    initial = draft.doc;
    message = `Restored local draft (${new Date(draft.savedAt).toLocaleString()})`;
  }
  try { state.doc = normalizeDoc(initial); } catch { state.doc = normalizeDoc(STARTER); }
  state.sel = state.doc.geometry.length ? { kind: "geometry", index: 0 } : { kind: "sim" };

  // 3D (WebGL may be unavailable in some WebViews; the editor still works).
  try {
    const { Viewport } = await import("./viewport.js");
    viewport = new Viewport($("viewport"), { onPick: ref => select(ref, { fromView: true }) });
    for (const b of document.querySelectorAll("[data-toggle]")) viewport.setOption(b.dataset.toggle, b.getAttribute("aria-pressed") === "true");
  } catch (e) {
    $("viewError").hidden = false;
    $("viewError").textContent = "3D view unavailable: " + e.message;
  }
  refresh();
  setStatus(message);
  matchMedia("(max-width: 760px)").addEventListener("change", () => { closeSheet(); setDock(state.dock); refresh({ params: false }); });
  registerServiceWorker();
}

boot();
