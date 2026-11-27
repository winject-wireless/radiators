// JavaScript editor for geometry scripts: CodeMirror 5 (vendored, loaded on demand) with
// line numbers, syntax highlighting, bracket matching and script-aware autocomplete.
// Falls back to the plain <textarea> if CodeMirror cannot load.
import { SHAPES } from "./schema.js";
import { ARG_TYPES } from "./scriptcore.js";

const BASE = "./vendor/codemirror/";
const SCRIPTS = ["lib/codemirror.js", "mode/javascript/javascript.js", "addon/hint/show-hint.js",
  "addon/edit/closebrackets.js", "addon/edit/matchbrackets.js", "addon/comment/comment.js", "addon/selection/active-line.js"];
const STYLES = ["lib/codemirror.css", "addon/hint/show-hint.css"];
let loading = null;

export function loadCodeMirror() {
  if (window.CodeMirror?.showHint) return Promise.resolve(window.CodeMirror);
  loading ??= (async () => {
    for (const href of STYLES) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = BASE + href;
      document.head.append(l);
    }
    for (const src of SCRIPTS) { // addons need the CodeMirror global: load in order
      await new Promise((ok, fail) => {
        const s = document.createElement("script");
        s.src = BASE + src;
        s.onload = ok;
        s.onerror = () => fail(Error("cannot load " + src));
        document.head.append(s);
      });
    }
    return window.CodeMirror;
  })();
  return loading;
}

// ---- autocomplete vocabulary
const KEYWORDS = ["const", "let", "function", "return", "for", "of", "in", "if", "else", "while", "break", "continue",
  "new", "throw", "true", "false", "null", "undefined", "typeof", "Error", "Array", "Array.from", "Math", "Number", "JSON", "Object"];
const MATH = ["PI", "E", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "cbrt", "hypot", "abs", "min", "max",
  "floor", "ceil", "round", "trunc", "sign", "pow", "exp", "log", "log10", "log2"];
const MEMBERS = ["length", "map", "forEach", "filter", "reduce", "push", "concat", "slice", "flatMap", "flat", "includes",
  "indexOf", "join", "keys", "entries", "fill", "toFixed"];
const SPEC_KEYS = ["type", "default", "label", "hint", "more", "step", "min", "max", "options", "handle", "from", "dir", "perp", "scale"];
const PRIMITIVE_KEYS = ["name", "shape", "material", "priority", "transform", "rotate_deg", "translate",
  ...new Set(Object.values(SHAPES).flatMap(s => s.fields.map(f => f.key))), "vertices", "faces"];
const LEGACY = new Set(["helix", "hemisphere", "hemispherical_shell"]);

function declaredArgs(text) {
  const out = [];
  const body = /const\s+args\s*=\s*\{([\s\S]*?)\n\s*\}\s*;?/.exec(text)?.[1] ?? "";
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\{\s*type\s*:\s*["'](\w+)/gm)) out.push([m[1], m[2]]);
  return out;
}

function scriptHint(cm) {
  const CM = window.CodeMirror;
  const cur = cm.getCursor(), line = cm.getLine(cur.line);
  let start = cur.ch;
  while (start && /[\w$]/.test(line[start - 1])) start--;
  const word = line.slice(start, cur.ch), before = line.slice(0, start);
  let items;
  if (/(^|[^\w$.])a\.$/.test(before)) items = declaredArgs(cm.getValue()).map(([k, t]) => [k, t]);
  else if (/\bMath\.$/.test(before)) items = MATH.map(k => [k, "Math"]);
  else if (/\.$/.test(before)) items = MEMBERS.map(k => [k, "member"]);
  else if (/\btype\s*:\s*["']$/.test(before)) items = Object.entries(ARG_TYPES).map(([k, v]) => [k, v.label]);
  else if (/\bshape\s*:\s*["']$/.test(before)) items = Object.keys(SHAPES).filter(k => !LEGACY.has(k)).map(k => [k, "primitive"]);
  else {
    const local = new Set(cm.getValue().match(/[A-Za-z_$][\w$]{2,}/g) || []);
    items = [...KEYWORDS.map(k => [k, "js"]), ...PRIMITIVE_KEYS.map(k => [k, "field"]), ...SPEC_KEYS.map(k => [k, "arg spec"]),
      ["args", "declaration"], ["generate", "function"], ...[...local].map(k => [k, "local"])];
  }
  const seen = new Set();
  const low = word.toLowerCase();
  const list = items.filter(([k]) => k.toLowerCase().startsWith(low) && k !== word && !seen.has(k) && seen.add(k))
    .map(([text, kind]) => ({
      text, kind,
      render: (el, _self, data) => {
        const a = document.createElement("span"); a.textContent = data.text;
        const b = document.createElement("small"); b.textContent = data.kind; b.className = "hint-kind";
        el.append(a, b);
      },
    }));
  return { list, from: CM.Pos(cur.line, start), to: CM.Pos(cur.line, cur.ch) };
}

// Turn `textarea` into a code editor. Returns { refresh, focus } (no-ops for the fallback).
export async function upgradeTextarea(textarea, { readOnly = false, onChange, json = false } = {}) {
  let CM;
  try { CM = await loadCodeMirror(); } catch { return { refresh() {}, focus() { textarea.focus(); } }; }
  if (!textarea.isConnected) return { refresh() {}, focus() {} };
  const cm = CM.fromTextArea(textarea, {
    mode: json ? { name: "javascript", json: true } : "javascript", theme: "csx", lineNumbers: true, indentUnit: 2, tabSize: 2, indentWithTabs: false,
    matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, readOnly, lineWrapping: json,
    extraKeys: {
      ...(json ? {} : { "Ctrl-Space": "autocomplete", "Cmd-Space": "autocomplete", "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment" }),
      Tab: c => c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection("  "),
      "Shift-Tab": c => c.indentSelection("subtract"),
    },
    ...(json ? {} : { hintOptions: { hint: scriptHint, completeSingle: false } }),
  });
  if (!json && !readOnly) {
  cm.on("inputRead", (c, change) => {
    if (!c.state.completionActive && /[\w.$"']$/.test(change.text.join(""))) c.showHint({ completeSingle: false });
  });
  // Auto-closed quotes are inserted programmatically (no inputRead): open the list on the key itself.
  cm.on("keyup", (c, e) => {
    if ((e.key === '"' || e.key === "'") && !c.state.completionActive) c.showHint({ completeSingle: false });
  });
  }
  if (onChange) {
    cm.on("change", () => onChange(cm.getValue(), false));
    cm.on("blur", () => onChange(cm.getValue(), true));
  }
  return { cm, refresh: () => cm.refresh(), focus: () => cm.focus() };
}
