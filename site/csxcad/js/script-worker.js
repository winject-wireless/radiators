// Runs geometry scripts off the main thread. The editor terminates this worker when a
// script exceeds the time limit (e.g. an endless loop) and starts a fresh one.
//
// A geometry script is code from a JSON document, which may have come from
// anyone, and this worker runs on the editor's own origin. Before any script
// runs, every capability that could read stored data or talk to the network is
// removed from the realm — not shadowed: fetch, indexedDB, caches and navigator
// live on WorkerGlobalScope.prototype, so an own undefined property on `self`
// leaves them reachable through the prototype chain. Deleting them affects the
// whole realm, so code reached through a dynamic import() cannot get them back
// either (a dynamic import still issues a request for its own URL; there is no
// stored data left for it to carry). The editor also asks before it runs
// scripts from a file the user did not write here; see openFromText in main.js.
import { scriptBody } from "./scriptcore.js";

const BLOCKED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches",
  "Worker", "SharedWorker", "BroadcastChannel", "importScripts", "navigator", "FileReaderSync",
  "createImageBitmap", "Notification", "reportError", "WebAssembly"];
function revoke(name) {
  for (let object = self; object; object = Object.getPrototypeOf(object)) {
    if (Object.prototype.hasOwnProperty.call(object, name)) {
      try { delete object[name]; } catch { /* non-configurable */ }
    }
  }
  if (name in self) { // could not be deleted: shadow it and report it as present
    try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); }
    catch { return name; }
    return name;
  }
  return null;
}
// Fail closed: if the realm cannot be stripped, no script runs at all.
const leaked = BLOCKED.map(revoke).filter(name => name && ["fetch", "indexedDB", "caches", "navigator",
  "XMLHttpRequest", "WebSocket", "Worker", "BroadcastChannel"].includes(name));

self.onmessage = e => {
  const { id, source, argsJSON } = e.data;
  try {
    if (leaked.length) throw Error("geometry scripts are disabled: this browser kept " + leaked.join(", ") + " reachable in the worker");
    const fn = new Function("__args", scriptBody(source));
    const out = fn(argsJSON);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

// Tell the editor the modules are loaded, so its time limit only measures script execution.
self.postMessage({ ready: true });
