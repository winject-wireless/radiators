// Cross-origin isolation for static hosting (GitHub Pages cannot set headers).
// Adds COOP / COEP / CORP to every same-origin response in this worker's scope,
// so pages there get SharedArrayBuffer, which the threaded openEMS module needs.
// Register it from a page in the same directory (see ensureIsolated() in
// coi.js); a page that already has a service worker (the CSXCAD editor) adds
// the same headers in its own worker instead.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  e.respondWith(fetch(req).then((r) => {
    if (r.status === 0) return r;
    const headers = new Headers(r.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  }));
});
