// Offline cache for the CSXCAD editor (browser / installed PWA only; the
// Capacitor Android build serves files from the APK and skips this).
// CACHE_VERSION is replaced by prepare.py with a content hash.
const CACHE = "csxcad-CACHE_VERSION";
const SHELL = [
  "./", "./index.html", "./app.css", "./manifest.webmanifest", "./icon.svg",
  "./js/main.js", "./js/params.js", "./js/schema.js", "./js/geometry.js",
  "./js/checks.js", "./js/viewport.js", "./js/platform.js",
  "./vendor/three.module.min.js", "./vendor/addons/controls/OrbitControls.js",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("csxcad-") && k !== CACHE)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (fresh after deploys), cache fallback when offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
