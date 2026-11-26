// Runs geometry scripts off the main thread. The editor terminates this worker when a
// script exceeds the time limit (e.g. an endless loop) and starts a fresh one.
import { scriptBody } from "./scriptcore.js";

self.onmessage = e => {
  const { id, source, argsJSON } = e.data;
  try {
    const fn = new Function("__args", scriptBody(source));
    const out = fn(argsJSON);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

// Tell the editor the modules are loaded, so its time limit only measures script execution.
self.postMessage({ ready: true });
