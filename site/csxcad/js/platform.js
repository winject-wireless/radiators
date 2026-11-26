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

// The worker also makes the page cross-origin isolated (needed by the in-browser openEMS).
// Headers only apply to pages it serves, so reload once after it first takes control.
export function registerServiceWorker() {
  if (isNative() || !("serviceWorker" in navigator) || location.protocol === "file:") return;
  const key = "csxcad-coi-reload";
  navigator.serviceWorker.register("./sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    if (globalThis.crossOriginIsolated) { try { sessionStorage.removeItem(key); } catch { /* storage blocked */ } return; }
    let reloaded = true;
    try { reloaded = !!sessionStorage.getItem(key); if (!reloaded) sessionStorage.setItem(key, "1"); } catch { /* no storage: never reload */ }
    if (!reloaded) location.reload();
  }).catch(() => { /* offline cache is optional */ });
}
