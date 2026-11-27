// Parametric layer: a JavaScript port of scripts/sweep.py.
//
// The simulator resolves typed placeholders ({"$param": name} and
// {"$expr": "..."}) and expands `sweep` into cases. The editor must produce
// the same values, so this module mirrors that grammar and its limits exactly:
// literals, parameter names, + - * / % **, unary +/-, parentheses, the
// functions abs/min/max/sqrt/sin/cos/tan/floor/ceil and the constants pi/e.

export const MAX_CASES = 128;
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FUNCTIONS = {
  abs: Math.abs, min: Math.min, max: Math.max, sqrt: Math.sqrt,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, floor: Math.floor, ceil: Math.ceil,
};
export const CONSTANTS = { pi: Math.PI, e: Math.E };
const PY_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async",
  "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);

export function validParameterName(name) {
  return typeof name === "string" && IDENTIFIER.test(name) && !(name in CONSTANTS) &&
    !(name in FUNCTIONS) && !PY_KEYWORDS.has(name);
}

const isNumber = v => typeof v === "number";

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) { out.push({ t: "name", v: name[0] }); i += name[0].length; continue; }
    if (src.startsWith("**", i)) { out.push({ t: "op", v: "**" }); i += 2; continue; }
    if ("+-*/%(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw Error("Invalid expression: " + src);
  }
  return out;
}

// Parse into a tiny AST using Python's precedence:
//   + -  <  * / %  <  unary + -  <  **  (right-assoc, binds its left operand
//   tighter than a leading unary minus: -2**2 == -4, 2**-1 == 0.5)
export function parseExpression(src) {
  if (typeof src !== "string" || src.length > 256) {
    throw Error("Expression must be a string of at most 256 characters");
  }
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = v => toks[p] && toks[p].t === "op" && toks[p].v === v;
  const fail = () => { throw Error("Invalid expression: " + src); };
  function sum() {
    let n = term();
    while (isOp("+") || isOp("-")) { const op = toks[p++].v; n = { k: "bin", op, a: n, b: term() }; }
    return n;
  }
  function term() {
    let n = unary();
    while (isOp("*") || isOp("/") || isOp("%")) { const op = toks[p++].v; n = { k: "bin", op, a: n, b: unary() }; }
    return n;
  }
  function unary() {
    if (isOp("+") || isOp("-")) { const op = toks[p++].v; return { k: "un", op, a: unary() }; }
    return power();
  }
  function power() {
    const base = atom();
    if (isOp("**")) { p++; return { k: "bin", op: "**", a: base, b: unary() }; }
    return base;
  }
  function atom() {
    const t = peek();
    if (!t) fail();
    if (t.t === "num") { p++; return { k: "num", v: t.v }; }
    if (t.t === "name") {
      p++;
      if (isOp("(")) {
        p++;
        const args = [];
        if (!isOp(")")) {
          args.push(sum());
          while (isOp(",")) { p++; if (isOp(")")) break; args.push(sum()); }
        }
        if (!isOp(")")) fail();
        p++;
        return { k: "call", f: t.v, args };
      }
      return { k: "name", v: t.v };
    }
    if (isOp("(")) {
      p++;
      const n = sum();
      if (!isOp(")")) fail();
      p++;
      return n;
    }
    fail();
  }
  if (!toks.length) fail();
  const tree = sum();
  if (p !== toks.length) fail();
  return tree;
}

export function evaluate(src, parameters) {
  const tree = parseExpression(src);
  const check = r => {
    if (!isNumber(r) || !Number.isFinite(r) || Math.abs(r) > 1e15) {
      throw Error("Non-finite or excessive expression result: " + src);
    }
    return r;
  };
  function visit(n, depth) {
    if (depth > 20) throw Error("Expression exceeds maximum depth");
    let r;
    switch (n.k) {
      case "num": r = n.v; break;
      case "name":
        if (n.v in CONSTANTS) r = CONSTANTS[n.v];
        else if (Object.hasOwn(parameters, n.v) && isNumber(parameters[n.v])) r = parameters[n.v];
        else throw Error("Unknown numeric parameter: " + n.v);
        break;
      case "un": { const x = visit(n.a, depth + 1); r = n.op === "-" ? -x : x; break; }
      case "bin": {
        const a = visit(n.a, depth + 1), b = visit(n.b, depth + 1);
        if ((n.op === "/" || n.op === "%") && b === 0) throw Error("Invalid expression result: " + src);
        if (n.op === "+") r = a + b;
        else if (n.op === "-") r = a - b;
        else if (n.op === "*") r = a * b;
        else if (n.op === "/") r = a / b;
        else if (n.op === "%") r = a - b * Math.floor(a / b); // Python modulo
        else {
          if (Math.abs(b) > 12 || Math.abs(a) > 1e12) throw Error("Expression exponent is too large");
          if (a === 0 && b < 0) throw Error("Invalid expression result: " + src);
          r = a ** b;
        }
        break;
      }
      case "call": {
        if (!Object.hasOwn(FUNCTIONS, n.f)) throw Error("Unsupported expression: " + src);
        const args = n.args.map(x => visit(x, depth + 1));
        const arity = { abs: 1, sqrt: 1, sin: 1, cos: 1, tan: 1, floor: 1, ceil: 1 }[n.f];
        // Python: max(1) raises TypeError (int is not iterable) -> invalid.
        if ((arity && args.length !== arity) || (!arity && args.length < 2)) {
          throw Error("Invalid expression result: " + src);
        }
        if (n.f === "sqrt" && args[0] < 0) throw Error("Invalid expression result: " + src);
        r = FUNCTIONS[n.f](...args);
        break;
      }
    }
    return check(r);
  }
  return visit(tree, 0);
}

// Names referenced by an expression (excluding constants and functions).
export function expressionNames(src) {
  try {
    return [...new Set(tokenize(src).filter((t, i, all) => t.t === "name" &&
      !(t.v in CONSTANTS) && !(all[i + 1]?.t === "op" && all[i + 1].v === "("))
      .map(t => t.v))];
  } catch { return []; }
}

export function renameInExpression(src, from, to) {
  return src.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m, offset) => {
    const prev = src[offset - 1];
    if (prev && /[0-9.]/.test(prev)) return m; // exponent suffix like 1e3
    return m === from ? to : m;
  });
}

export const isTemplate = v => !!v && typeof v === "object" && !Array.isArray(v) &&
  ("$param" in v || "$expr" in v);

export function resolveTemplate(value, parameters) {
  if (Array.isArray(value)) return value.map(v => resolveTemplate(v, parameters));
  if (value && typeof value === "object") {
    if ("$param" in value || "$expr" in value) {
      if (Object.keys(value).length !== 1) {
        throw Error("Parameter/expression objects must have exactly one key");
      }
      if ("$param" in value) {
        if (!Object.hasOwn(parameters, value.$param)) throw Error("Unknown parameter: " + value.$param);
        return structuredClone(parameters[value.$param]);
      }
      return evaluate(value.$expr, parameters);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, parameters)]));
  }
  return value;
}

function scalar(value, name) {
  if (!["string", "number", "boolean"].includes(typeof value) ||
      (isNumber(value) && !Number.isFinite(value))) {
    throw Error(name + ": parameters must be finite JSON scalars");
  }
  return value;
}

// Exact decimal arithmetic for ranges, as sweep.py uses Decimal(str(x)).
function decimal(x) {
  const s = typeof x === "number" ? numberToDecimalString(x) : String(x);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m || (!m[2] && !m[3])) throw Error("invalid range");
  let digits = (m[2] || "") + (m[3] || "");
  let scale = (m[3] || "").length - Number(m[4] || 0);
  let n = BigInt(digits || "0");
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n: m[1] === "-" ? -n : n, scale };
}
function numberToDecimalString(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) throw Error("Range must be finite");
  return String(x);
}
const align = (a, s) => a.n * 10n ** BigInt(s - a.scale);
function decToNumber(n, scale) {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString().padStart(scale + 1, "0");
  if (scale) s = s.slice(0, -scale) + "." + s.slice(-scale);
  return Number((neg ? "-" : "") + s);
}

export function sweepValues(spec, label) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) ||
      ("values" in spec) === ("range" in spec)) {
    throw Error(label + ": use exactly one of values or range");
  }
  let values;
  if ("values" in spec) {
    values = spec.values;
    if (!Array.isArray(values) || !values.length) throw Error(label + ".values must be a nonempty array");
  } else {
    const b = spec.range;
    const keys = b && typeof b === "object" ? Object.keys(b).sort().join(",") : "";
    if (keys !== "start,step,stop") throw Error(label + ".range must have start, stop, step");
    let start, stop, step;
    try { [start, stop, step] = [b.start, b.stop, b.step].map(decimal); }
    catch { throw Error(label + ": invalid range"); }
    const s = Math.max(start.scale, stop.scale, step.scale);
    const A = align(start, s), B = align(stop, s), C = align(step, s);
    if (C === 0n || (B - A) * C < 0n) throw Error("Range step must advance toward stop");
    let q = (B - A) / C; // BigInt division truncates toward zero; (B-A)/C >= 0 here
    const count = Number(q) + 1;
    if (!(count >= 1 && count <= MAX_CASES)) throw Error(`Range must contain 1–${MAX_CASES} values`);
    values = Array.from({ length: count }, (_, i) => decToNumber(A + BigInt(i) * C, s));
  }
  if (values.length > MAX_CASES) throw Error(`${label}: exceeds ${MAX_CASES} values`);
  const seen = new Set();
  for (const v of values) {
    scalar(v, label);
    const key = JSON.stringify(v);
    if (seen.has(key)) throw Error(`${label}: duplicate value ${key}`);
    seen.add(key);
  }
  return values;
}

// Returns [{id, name, parameters}] exactly like sweep._parameter_sets.
export function parameterSets(config) {
  const defaults = config.parameters ?? {};
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw Error("parameters must be an object");
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (!validParameterName(k)) throw Error("Invalid parameter name: " + k);
    scalar(v, k);
  }
  const sweep = config.sweep;
  if (sweep === undefined || sweep === null) {
    return [{ id: "default", name: "Default", parameters: { ...defaults } }];
  }
  if (typeof sweep !== "object" || Array.isArray(sweep)) throw Error("sweep must be an object");
  const axes = sweep.parameters;
  if (!axes || typeof axes !== "object" || Array.isArray(axes) || !Object.keys(axes).length) {
    throw Error("sweep.parameters must be a nonempty object");
  }
  const names = Object.keys(axes);
  for (const k of names) if (!validParameterName(k)) throw Error("Invalid sweep parameter name: " + k);
  const values = names.map(k => sweepValues(axes[k], "sweep.parameters." + k));
  const floatAxis = names.map(k => "range" in axes[k]); // Python range values are floats
  const mode = sweep.mode ?? "product";
  let combos;
  if (mode === "product") {
    const count = values.reduce((n, v) => n * v.length, 1);
    if (count > MAX_CASES) throw Error(`Sweep expands to ${count} cases, maximum ${MAX_CASES}`);
    combos = [[]];
    for (const axis of values) combos = combos.flatMap(c => axis.map(v => [...c, v]));
  } else if (mode === "zip") {
    if (new Set(values.map(v => v.length)).size !== 1) {
      throw Error("zip sweep requires equal-length parameter axes");
    }
    combos = values[0].map((_, i) => values.map(v => v[i]));
    if (combos.length > MAX_CASES) throw Error(`Sweep expands to ${combos.length} cases, maximum ${MAX_CASES}`);
  } else throw Error("sweep.mode must be product or zip");
  return combos.map((combo, i) => {
    const parameters = { ...defaults, ...Object.fromEntries(names.map((k, j) => [k, combo[j]])) };
    const floats = new Set(names.filter((_, j) => floatAxis[j]));
    return {
      id: "case-" + String(i + 1).padStart(4, "0"),
      name: Object.entries(parameters).map(([k, v]) => `${k}=${pyRepr(v, floats.has(k))}`).join(", "),
      parameters,
    };
  });
}

// Python's str() of a JSON scalar, for case names matching sweep.py.
function pyRepr(v, isFloat = false) {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number" && isFloat && Number.isInteger(v) && Math.abs(v) < 1e16) return v + ".0";
  return String(v);
}

// Full case expansion of a config (without running Python generators).
export function resolveCase(config, parameters) {
  const base = structuredClone(config);
  delete base.sweep;
  delete base.parameters;
  delete base.generator;
  delete base.workspace_units; // editor metadata, not a solver input
  // Disabled editor objects remain in the source, but do not resolve parameters or scripts.
  if(Array.isArray(base.geometry))base.geometry=base.geometry.filter(g=>g?.enabled!==false);
  if(Array.isArray(base.probes))base.probes=base.probes.filter(p=>p?.enabled!==false);
  if(Array.isArray(base.mesh?.refinements))base.mesh.refinements=base.mesh.refinements.filter(r=>r?.enabled!==false);
  const resolved=resolveTemplate(base, parameters);
  if(Array.isArray(resolved.mesh?.refinements))resolved.mesh.refinements=resolved.mesh.refinements.filter(r=>r?.enabled!==false);
  if(Array.isArray(resolved.geometry))resolved.geometry=resolved.geometry.filter(g=>g?.enabled!==false);
  return resolved;
}

// Editor field text <-> JSON value.
//   "12.5"        -> 12.5
//   "wire_mm"     -> {"$param": "wire_mm"}
//   "turns * 6"   -> {"$expr": "turns * 6"}
export function fieldToValue(text) {
  const s = String(text).trim();
  if (s === "") throw Error("Value required");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (IDENTIFIER.test(s) && !(s in CONSTANTS)) return { $param: s };
  parseExpression(s);
  return { $expr: s };
}
export function valueToField(v) {
  if (isTemplate(v)) return "$param" in v ? String(v.$param) : String(v.$expr);
  if (v === undefined || v === null) return "";
  return typeof v === "number" ? String(+v.toPrecision(12)) : String(v);
}

// Workspace preferences are presentation-only. Canonical units match the
// schema fields (geometry mm, frequencies Hz, angles degrees, etc.).
export const UNIT_GROUPS = {
  length: { mm:1, cm:10, m:1000, "µm":0.001, nm:1e-6, in:25.4, mil:0.0254, ft:304.8 },
  frequency: { Hz:1, kHz:1e3, MHz:1e6, GHz:1e9 },
  angle: { "°":1, rad:180/Math.PI },
  resistance: { "Ω":1, "kΩ":1e3, "MΩ":1e6, "mΩ":1e-3 },
  conductivity: { "S/m":1, "mS/m":1e-3, "kS/m":1e3, "MS/m":1e6 },
  memory: { GiB:1, MiB:1/1024, KiB:1/(1024**2) }
};
export const DEFAULT_WORKSPACE_UNITS = {length:"mm",frequency:"GHz",angle:"°",resistance:"Ω",conductivity:"S/m",memory:"GiB"};
const ALIASES = {um:"µm","μm":"µm",inch:"in",inches:"in",deg:"°",degree:"°",degrees:"°",ohm:"Ω",Ohm:"Ω",ohms:"Ω",kohm:"kΩ",kOhm:"kΩ",Mohm:"MΩ",mohm:"mΩ"};
export function normalizeWorkspaceUnits(settings) {
  return Object.fromEntries(Object.entries(DEFAULT_WORKSPACE_UNITS).map(([group,def])=>[
    group,Object.hasOwn(UNIT_GROUPS[group],settings?.[group])?settings[group]:def
  ]));
}
export function unitGroup(unit) {
  return Object.keys(UNIT_GROUPS).find(g=>Object.hasOwn(UNIT_GROUPS[g],unit));
}
export function displayUnit(canonical, settings) {
  const g=unitGroup(canonical);
  return g ? normalizeWorkspaceUnits(settings)[g] : canonical;
}
const unitRatio=(from,to)=>{
  const g=unitGroup(to);
  if(!g || !Object.hasOwn(UNIT_GROUPS[g],from))throw Error("Expected "+(g||"compatible")+" units, got "+from);
  return UNIT_GROUPS[g][from]/UNIT_GROUPS[g][to];
};
const unitNames=[...new Set([...Object.values(UNIT_GROUPS).flatMap(g=>Object.keys(g)),...Object.keys(ALIASES)])].sort((a,b)=>b.length-a.length);
const suffix=new RegExp("^(.*?)(?:\\s+)("+unitNames.join("|")+")$");
export function parseUnitField(text, canonical, preferred=canonical) {
  let s=String(text).trim(),from=preferred;
  const match=s.match(suffix);
  if(match){s=match[1].trim();from=Object.hasOwn(ALIASES,match[2])?ALIASES[match[2]]:match[2];}
  else {
    // Also allow the common compact literal "2.45GHz", without treating
    // variable names such as f_ghz as unit suffixes.
    const compact=s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([^\d\s].*)$/);
    if(compact&&unitNames.includes(compact[2])){s=compact[1];from=Object.hasOwn(ALIASES,compact[2])?ALIASES[compact[2]]:compact[2];}
  }
  if(s.startsWith("{")&&s.endsWith("}"))s=s.slice(1,-1).trim();
  const factor=unitRatio(from,canonical);
  const value=fieldToValue(s);
  if(typeof value==="number"){
    const converted=value*factor;
    if(!Number.isFinite(converted))throw Error("Unit conversion is not finite");
    return +converted.toPrecision(15);
  }
  if(factor===1)return value;
  const expr="("+valueToField(value)+") * "+factor;
  parseExpression(expr); // enforce the shared grammar/length before saving
  return {$expr:expr};
}
// Numeric values are displayed in the default unit; existing parametric
// expressions are rendered with their explicit canonical unit, preserving
// their meaning when a workspace default changes.
export function formatUnitField(value,canonical,preferred=canonical) {
  if(typeof value==="number")return valueToField(value/unitRatio(preferred,canonical));
  if(isTemplate(value)){
    const src=valueToField(value);
    const scaled=src.match(/^\((.*)\) \* ([\d.eE+-]+)$/);
    if(scaled){
      const g=unitGroup(canonical);
      const u=Object.keys(UNIT_GROUPS[g]).find(u=>unitRatio(u,canonical)===Number(scaled[2]));
      if(u&&u!==canonical)return "{"+scaled[1]+"} "+u;
    }
    return preferred===canonical?src:"{"+src+"} "+canonical;
  }
  return valueToField(value);
}
export function displayedNumber(value,canonical,preferred=canonical) {
  return typeof value==="number"?value/unitRatio(preferred,canonical):value;
}

// Walk a config and apply fn to every template object (for renames / usage).
export function walkTemplates(value, fn) {
  if (Array.isArray(value)) return value.map(v => walkTemplates(v, fn));
  if (value && typeof value === "object") {
    if (isTemplate(value)) return fn(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkTemplates(v, fn)]));
  }
  return value;
}

export function renameParameter(config, from, to) {
  const out = walkTemplates(config, t => "$param" in t
    ? (t.$param === from ? { $param: to } : t)
    : { $expr: renameInExpression(t.$expr, from, to) });
  const rekey = obj => obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));
  if (out.parameters) out.parameters = rekey(out.parameters);
  if (out.sweep?.parameters) out.sweep.parameters = rekey(out.sweep.parameters);
  return out;
}

export function parameterUsage(config) {
  const used = new Map();
  const add = n => used.set(n, (used.get(n) || 0) + 1);
  const { parameters, sweep, ...rest } = config;
  walkTemplates(rest, t => { ("$param" in t ? [t.$param] : expressionNames(t.$expr)).forEach(add); return t; });
  return used;
}


// A sweep can introduce its own parameter, so missing defaults are advisory.
// Only count references in active simulation inputs, not the sweep's own
// declaration, display metadata, disabled objects or uninstantiated scripts.
export function sweepWarnings(config) {
  const axes=config.sweep?.parameters;
  if(!axes||typeof axes!=="object"||Array.isArray(axes))return [];
  const defaults=config.parameters??{};
  const {parameters,sweep,workspace_units,simulation,name,description,generator,scripts,...inputs}=config;
  for(const k of ["geometry","probes"]){
    if(Array.isArray(inputs[k]))inputs[k]=inputs[k].filter(p=>p?.enabled!==false);
  }
  if(Array.isArray(inputs.mesh?.refinements))inputs.mesh={...inputs.mesh,refinements:inputs.mesh.refinements.filter(r=>r?.enabled!==false)};
  const usage=parameterUsage(inputs),out=[];
  for(const axis of Object.keys(axes)){
    if(!Object.hasOwn(defaults,axis))out.push({axis,code:"undefined",level:"warn",where:"sweep "+axis,msg:"Parameter '"+axis+"' is not defined in Variables. The sweep supplies its value, but no default exists."});
    // Python generators receive the parameter map directly; references in
    // arbitrary generator code cannot be determined by this static check.
    if(!generator&&!usage.has(axis))out.push({axis,code:"unused",level:"warn",where:"sweep "+axis,msg:"Parameter '"+axis+"' is not referenced by active simulation inputs. Sweeping it may repeat identical simulations."});
  }
  return out;
}
