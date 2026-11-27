// Offline cache for the CSXCAD editor (browser / installed PWA only; the
// Capacitor Android build serves files from the APK and skips this).
// CACHE_VERSION is replaced by prepare.py with a content hash.
const CACHE = "csxcad-CACHE_VERSION";
const SHELL = [
  "./", "./index.html", "./app.css", "./manifest.webmanifest", "./icon.svg",
  "./js/main.js", "./js/current-plane.js", "./js/params.js", "./js/schema.js", "./js/geometry.js",
  "./js/checks.js", "./js/viewport.js", "./js/platform.js", "./js/scriptcore.js", "./js/script-worker.js", "./js/code-editor.js",
  "./vendor/codemirror/lib/codemirror.js", "./vendor/codemirror/lib/codemirror.css", "./vendor/codemirror/mode/javascript/javascript.js",
  "./vendor/codemirror/addon/hint/show-hint.js", "./vendor/codemirror/addon/hint/show-hint.css", "./vendor/codemirror/addon/edit/closebrackets.js",
  "./vendor/codemirror/addon/edit/matchbrackets.js", "./vendor/codemirror/addon/comment/comment.js", "./vendor/codemirror/addon/selection/active-line.js",
  "./js/sim/wasm-diagnostics.js", "./js/sim/probe-playback.js", "./js/sim/remote.js", "./js/sim/diagnostics.js", "./js/sim/radiation.js", "./js/sim/mesh.js", "./js/sim/model.js", "./js/sim/run.js", "./js/sim/plot.js", "./js/sim/panel.js",
  "./vendor/openems/openems.js", "./vendor/openems/openems-core.js", "./vendor/openems/openems-post.js",
  "./vendor/openems/openems-worker.js", "./vendor/openems/openems.mjs", "./vendor/openems/openems.wasm",
  "./vendor/three.module.min.js", "./vendor/addons/controls/OrbitControls.js", "./vendor/addons/environments/RoomEnvironment.js", "./vendor/addons/controls/TransformControls.js",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
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
// Network first (fresh after deploys), cache fallback when offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  // Revalidate the small app shell instead of trusting the browser's HTTP
  // freshness lifetime. Large immutable vendor assets keep normal caching.
  const scope = new URL(self.registration.scope);
  const relative = url.pathname.slice(scope.pathname.length);
  const request = e.request.mode === "navigate" || relative === "app.css" || relative.startsWith("js/")
    ? new Request(e.request, { cache: "no-cache" }) : e.request;
  e.respondWith(fetch(request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return isolate(r);
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(isolate)));
});
