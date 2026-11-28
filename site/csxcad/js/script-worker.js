// Runs geometry scripts off the main thread. The editor terminates this worker when a
// script exceeds the time limit (e.g. an endless loop) and starts a fresh one.
//
// A geometry script is code from a JSON document, which may have come from
// anyone. The worker runs on the editor's own origin, so before any script
// runs it drops everything that could reach data or the network: scripts only
// need arithmetic to return geometry. (The editor also asks before it runs
// scripts from a file the user did not write here; see openFile in main.js.)
import { scriptBody } from "./scriptcore.js";

const BLOCKED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches",
  "Worker", "SharedWorker", "BroadcastChannel", "importScripts", "navigator", "FileReaderSync",
  "createImageBitmap", "Notification", "reportError"];
for (const name of BLOCKED) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); }
  catch { /* not present in this engine, or not redefinable */ }
}
// Dynamic import would pull a module in with the worker's own privileges, and
// no geometry script needs it. Refuse rather than silently allow it.
const IMPORTS = /\bimport\s*[(.]/;

self.onmessage = e => {
  const { id, source, argsJSON } = e.data;
  try {
    if (IMPORTS.test(source)) throw Error("import() is not available in geometry scripts");
    const fn = new Function("__args", scriptBody(source));
    const out = fn(argsJSON);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

// Tell the editor the modules are loaded, so its time limit only measures script execution.
self.postMessage({ ready: true });
