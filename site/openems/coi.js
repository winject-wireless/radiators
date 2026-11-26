// Makes the page cross-origin isolated on hosts that cannot send COOP/COEP
// headers: registers a service worker that adds them (coi-sw.js by default,
// which must sit in the page's directory or above it) and reloads once.
// Resolves true when the page is isolated, false if it cannot be.
export async function ensureIsolated({ swUrl = new URL('coi-sw.js', import.meta.url), scope } = {}) {
  if (globalThis.crossOriginIsolated) return true;
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return false;
  const key = 'openems-coi-reload';
  try {
    const reg = await navigator.serviceWorker.register(swUrl, scope ? { scope } : undefined);
    await navigator.serviceWorker.ready;
    // the worker serves the next load; reload once, never loop
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
      return new Promise(() => {});
    }
    return Boolean(reg && globalThis.crossOriginIsolated);
  } catch (e) {
    return false;
  } finally {
    try { if (globalThis.crossOriginIsolated) sessionStorage.removeItem(key); } catch (e) { /* storage blocked */ }
  }
}
