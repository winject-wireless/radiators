// Offline cache for the CSXCAD editor (browser / installed PWA only; the
// Capacitor Android build serves files from the APK and skips this).
// CACHE_VERSION is replaced by prepare.py with a content hash of the build.
const CACHE = "csxcad-CACHE_VERSION";
const SHELL = [
  "./", "./index.html", "./help.html", "./app.css", "./manifest.webmanifest", "./icon.svg",
  "./js/main.js", "./js/current-plane.js", "./js/params.js", "./js/schema.js", "./js/geometry.js",
  "./js/checks.js", "./js/viewport.js", "./js/platform.js", "./js/scriptcore.js", "./js/script-worker.js", "./js/code-editor.js",
  "./vendor/codemirror/lib/codemirror.js", "./vendor/codemirror/lib/codemirror.css", "./vendor/codemirror/mode/javascript/javascript.js",
  "./vendor/codemirror/addon/hint/show-hint.js", "./vendor/codemirror/addon/hint/show-hint.css", "./vendor/codemirror/addon/edit/closebrackets.js",
  "./vendor/codemirror/addon/edit/matchbrackets.js", "./vendor/codemirror/addon/comment/comment.js", "./vendor/codemirror/addon/selection/active-line.js",
  "./js/sim/wasm-diagnostics.js", "./js/sim/probe-playback.js", "./js/sim/remote.js", "./js/sim/diagnostics.js", "./js/sim/radiation.js", "./js/sim/mesh.js", "./js/sim/mesh-view.js", "./js/sim/model.js", "./js/sim/run.js", "./js/sim/plot.js", "./js/sim/panel.js", "./js/sim/zip.js",
  "./vendor/openems/openems.js", "./vendor/openems/openems-core.js", "./vendor/openems/openems-post.js",
  "./vendor/openems/openems-worker.js", "./vendor/openems/openems.mjs", "./vendor/openems/openems.wasm",
  "./vendor/three.module.min.js", "./vendor/addons/controls/OrbitControls.js", "./vendor/addons/environments/RoomEnvironment.js", "./vendor/addons/controls/TransformControls.js",
];
const SHELL_PATHS = new Set(SHELL.map(p => p.replace(/^\.\//, "")));
// One missing file must not fail the whole install: this worker also supplies
// cross-origin isolation, without which in-browser simulation is unavailable.
// (site/csxcad/check.mjs verifies every SHELL path exists in the build.)
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    const results = await Promise.allSettled(SHELL.map(p => c.add(new Request(p, { cache: "reload" }))));
    const missing = SHELL.filter((_, i) => results[i].status === "rejected");
    if (missing.length) console.warn("sw: not cached for offline use:", missing.join(" "));
  }));
});
// No skipWaiting: an open session keeps the worker and the cache of the build
// it started with, so it can never mix old and new modules. The page offers a
// reload instead and sends "skip-waiting" when the user accepts.
self.addEventListener("message", e => { if (e.data?.type === "skip-waiting") self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("csxcad-") && k !== CACHE)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Cross-origin isolation: GitHub Pages cannot send headers, so this worker adds
// COOP / COEP / CORP to every response. The page then gets SharedArrayBuffer, which the
// threaded openEMS (vendor/openems) needs. Everything the editor loads is same-origin.
function isolate(r) {
  if (!r || r.status === 0) return r;
  const headers = new Headers(r.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
}
// Write to Cache Storage only when the entry is new or the validators changed:
// openems.wasm alone is 4 MB, and re-writing it on every load is pure cost.
async function store(request, response, cached) {
  const fresh = h => (h.get("etag") || "") + "|" + (h.get("last-modified") || "") + "|" + (h.get("content-length") || "");
  if (cached && fresh(cached.headers) === fresh(response.headers) && fresh(response.headers) !== "||") return;
  try { (await caches.open(CACHE)).put(request, response); } catch { /* quota or opaque response */ }
}
// The versioned shell is served cache-first (consistent build, no repeated
// writes); everything else is network-first with a cache fallback offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  const scope = new URL(self.registration.scope);
  const relative = url.pathname.slice(scope.pathname.length);
  const shell = e.request.mode === "navigate" || SHELL_PATHS.has(relative) || relative === "";
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    if (shell && cached) return isolate(cached);
    try {
      const response = await fetch(shell ? new Request(e.request, { cache: "no-cache" }) : e.request);
      if (response.ok) await store(e.request, response.clone(), cached);
      return isolate(response);
    } catch (error) {
      if (cached) return isolate(cached);
      throw error;
    }
  })());
});
