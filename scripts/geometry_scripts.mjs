#!/usr/bin/env node
// Expand geometry-script instances of a resolved radiators config (stdin JSON -> stdout JSON).
// Called by scripts/sweep.py. Scripts run in a fresh vm context with a time limit; only
// JSON text crosses the boundary, so the script never touches a host object. A vm context
// is not a security sandbox: untrusted pull-request code runs on GitHub-hosted runners only.
import vm from "node:vm";
import { expandScripts, scriptBody, SCRIPT_LIMITS } from "../site/csxcad/js/scriptcore.js";

export function runScript(source, argsJSON) {
  const code = `(function (__args) {\n${scriptBody(source)}\n})(${JSON.stringify(argsJSON)})`;
  const out = vm.runInNewContext(code, vm.createContext(Object.create(null)), {
    timeout: SCRIPT_LIMITS.timeoutMs, filename: "geometry-script.js",
  });
  if (typeof out !== "string") throw Error("script did not return a result");
  return out;
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    process.stdout.write(JSON.stringify(expandScripts(JSON.parse(text), runScript)));
  } catch (e) {
    process.stderr.write(String(e.message || e) + "\n");
    process.exit(1);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
