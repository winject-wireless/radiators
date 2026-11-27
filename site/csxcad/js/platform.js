// Platform glue so the same web app runs in a browser, as an installed PWA,
// and inside a Capacitor (Android) WebView without code changes.
// Capacitor exposes native plugins on window.Capacitor.Plugins; we use them
// only when present, so no Capacitor import or bundler is required.

const cap = () => globalThis.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();

export const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

function dataUrlToBlob(url) {
  const [head, body] = url.split(",");
  const mime = /data:([^;]+)/.exec(head)[1];
  const bin = atob(body);
  return new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))], { type: mime });
}

// Save text (or a data: URL) as a user-visible file. Returns a short message.
export async function saveFile(filename, content, mime = "application/json") {
  const plugins = cap()?.Plugins;
  const isDataUrl = typeof content === "string" && content.startsWith("data:");
  if (isNative() && plugins?.Filesystem) {
    const data = isDataUrl ? { data: content.split(",")[1] } : { data: content, encoding: "utf8" };
    let uri, where = "Documents/";
    try {
      ({ uri } = await plugins.Filesystem.writeFile({ path: filename, directory: "DOCUMENTS", recursive: true, ...data }));
    } catch {
      // Scoped storage may refuse Documents; the app cache + share sheet always works.
      ({ uri } = await plugins.Filesystem.writeFile({ path: filename, directory: "CACHE", recursive: true, ...data }));
      where = "";
    }
    if (plugins.Share) {
      try { await plugins.Share.share({ title: filename, url: uri }); } catch { /* user cancelled */ }
    }
    return where ? "Saved to " + where + filename : "Shared " + filename;
  }
  const blob = isDataUrl ? dataUrlToBlob(content) : new Blob([content], { type: mime });
  // Android Chrome / installed PWA: offer the share sheet when downloads are awkward.
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return "Shared " + filename; }
      catch (e) { if (e?.name === "AbortError") return "Share cancelled"; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "Downloaded " + filename;
}

// GitHub Pages cannot supply COOP/COEP itself. Reload only after the current
// isolation worker controls this document, not merely after ready resolves
// (ready may resolve for an old active worker before clients.claim).
const COI_RELOAD_KEY = "csxcad-coi-reload-v2";
let isolationSetup = null;

export function isolationUnavailableReason() {
  if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") return null;
  if (window.top !== window.self) return "This editor is embedded in another page. Open it directly in Chrome or another supported browser.";
  if (isNative()) return "This Android WebView does not provide cross-origin isolation. Open the hosted editor in Chrome.";
  if (!globalThis.isSecureContext) return "Use HTTPS or http://localhost to enable the simulation worker.";
  if (!("serviceWorker" in navigator)) return "Service workers are unavailable in this browser. Open the editor directly in Chrome.";
  if (globalThis.crossOriginIsolated) return "This browser does not expose SharedArrayBuffer. Try a supported current browser.";
  return null;
}

async function waitForController(registration) {
  const sw = navigator.serviceWorker;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const active = registration.active;
    if (!registration.installing && !registration.waiting && active?.state === "activated" &&
        sw.controller === active && active.scriptURL === new URL("./sw.js", location.href).href) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("The isolation service worker did not take control. Check browser site permissions and reload.");
}

export function registerServiceWorker({ manual = false } = {}) {
  if (isNative() || !("serviceWorker" in navigator) || !globalThis.isSecureContext ||
      location.protocol === "file:" || window.top !== window.self) return Promise.resolve(isolationUnavailableReason());
  if (isolationSetup) return isolationSetup;
  isolationSetup = (async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      if (globalThis.crossOriginIsolated) {
        try { sessionStorage.removeItem(COI_RELOAD_KEY); } catch { /* storage blocked */ }
        return null;
      }
      // Explicitly check for an updated worker if an older one is already active.
      if (!registration.installing && !registration.waiting && registration.active) {
        try { await registration.update(); } catch { /* offline: use the active worker */ }
      }
      await waitForController(registration);
      let alreadyReloaded = false, canStore = true;
      try {
        alreadyReloaded = !!sessionStorage.getItem(COI_RELOAD_KEY);
        sessionStorage.setItem(COI_RELOAD_KEY, "1");
      } catch { canStore = false; }
      // No automatic reload loop even when isolation is denied by browser policy.
      if (manual || (canStore && !alreadyReloaded)) {
        location.reload();
        return null;
      }
      return "The browser has not enabled cross-origin isolation. Use Retry isolation, or open the editor directly in Chrome.";
    } catch (error) {
      return "Cannot enable the simulation service worker: " + error.message;
    }
  })().finally(() => { isolationSetup = null; });
  return isolationSetup;
}

// Installed Android PWAs and WebViews can report a CSS viewport taller than
// the visible app surface (system navigation bar / keyboard). Use the
// unzoomed visual viewport as an additional upper bound on app height.
export function installAppViewport(){
  const vv=window.visualViewport,root=document.documentElement;
  let frame=0;
  const update=()=>{
    frame=0;
    // Pinch zoom must not relayout the entire editor.
    if(vv&&Math.abs(vv.scale-1)>.01)return;
    const heights=[window.innerHeight,root.clientHeight,vv?.height].filter(v=>Number.isFinite(v)&&v>0);
    if(heights.length)root.style.setProperty("--app-height",Math.floor(Math.min(...heights))+"px");
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
  window.addEventListener("resize",schedule);
  window.addEventListener("orientationchange",schedule);
  window.addEventListener("pageshow",schedule);
  vv?.addEventListener("resize",schedule);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)schedule();});
  update();
}
