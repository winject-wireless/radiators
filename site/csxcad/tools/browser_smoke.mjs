#!/usr/bin/env node
// Real browser regression: service-worker isolation, editor boot, WASM FDTD,
// NF2FF, result charts, 3D pattern toggle and JSON download.
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.argv[2] || "http://localhost:8080/";
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.error(e); });
try {
  // Simulate upgrading an already-installed non-isolating editor worker.
  // The previous worker can be active when navigator.serviceWorker.ready resolves.
  const legacyHtml = new URL("../www/legacy-test.html", import.meta.url);
  const legacyWorker = new URL("../www/sw-legacy.js", import.meta.url);
  await writeFile(legacyHtml, "<!doctype html><title>Legacy editor</title>");
  await writeFile(legacyWorker, 'self.addEventListener("install",e=>e.waitUntil(self.skipWaiting()));self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));self.addEventListener("fetch",e=>e.respondWith(fetch(e.request)));');
  const upgrade = await browser.newPage();
  try {
    await upgrade.goto(new URL("legacy-test.html", base).href);
    await upgrade.evaluate(async () => {
      await navigator.serviceWorker.register("./sw-legacy.js", { scope: "./" });
      await navigator.serviceWorker.ready;
      sessionStorage.setItem("csxcad-coi-reload", "1");
    });
    await upgrade.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw-legacy.js"));
    await upgrade.goto(new URL("?example=examples__dipole_2450.json", base).href);
    await upgrade.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"), {}, { timeout: 90000 });
    console.log("Legacy service worker upgrade: PASS");
  } finally {
    await upgrade.close();
    await Promise.all([unlink(legacyHtml), unlink(legacyWorker)]);
  }
  const blocked = await browser.newContext({ serviceWorkers: "block" });
  try {
    const blockedPage = await blocked.newPage();
    await blockedPage.goto(base);
    await blockedPage.locator('[data-dock="sim"]').click();
    assert.ok(await blockedPage.getByRole("button", { name: "Run in browser", exact: true }).isDisabled());
    assert.ok(await blockedPage.getByRole("link", { name: "Open editor directly (new tab)" }).isVisible());
  } finally { await blocked.close(); }

  await page.goto(new URL("?example=examples__dipole_2450.json&debug=1", base).href);
  await page.waitForFunction(() => crossOriginIsolated && window.__csxcad?.viewport && document.querySelector("#sim .sim-controls"), { }, { timeout: 90000 });
  await page.locator('[data-dock="sim"]').click();
  await page.getByRole("spinbutton", { name: "Threads" }).fill("2");
  await page.getByRole("spinbutton", { name: "Threads" }).press("Tab");
  await page.getByRole("button", { name: "Run in browser", exact: true }).click();
  await page.waitForFunction(() => {
    const error = document.querySelector("#sim .sim-run .note.warn");
    if (error) throw Error(error.textContent);
    return document.querySelector("#simBadge")?.textContent === "✓";
  }, {}, { timeout: 240000 });
  await page.locator('[data-dock="results"]').click();
  assert.ok(await page.locator("#resultCharts").getByText("Best S11", { exact: true }).isVisible());
  assert.ok(await page.locator("#resultCharts svg").count() >= 4);
  assert.ok(await page.locator("#patternSelect").isVisible());
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.radiation.children.length), 1);
  const pattern = page.locator("#patternSelect");
  const selected = await pattern.inputValue();
  await pattern.selectOption("-1");
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.radiation.children.length), 0);
  await pattern.selectOption(selected);
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.radiation.children.length), 1);
  // Three independent cuts; selection uses the real geometry-editor gizmo.
  const sectionCount = name => page.evaluate(n => window.__csxcad.viewport.sections.children.filter(x => x.userData.section === n && x.isLine).length, name);
  for (const name of ["XY","YZ","XZ"]) assert.equal(await sectionCount(name),1);
  await page.locator('[data-section="XY"]').click();
  assert.equal(await sectionCount("XY"),0);
  await page.locator('[data-section="XY"]').click();
  assert.equal(await sectionCount("XY"),1);
  assert.ok(await page.locator("#probeReadout").isVisible());
  assert.match(await page.locator("#probeGain").textContent(), /-?\d+\.\d+ dBi/);
  // Use the same picker callback as a click on the sampling sphere, and verify
  // that the attached translation gizmo exposes every axis.
  await page.evaluate(() => window.__csxcad.viewport.onHandle("result-probe"));
  const probeState = () => page.evaluate(() => {
    const { viewport, state } = window.__csxcad;
    const g = viewport.gizmo;
    return { key: g.object?.userData.handleKey, axes: [g.showX,g.showY,g.showZ],
      point: g.object?.position.toArray(), doc: JSON.stringify(state.doc) };
  });
  const before = await probeState();
  assert.equal(before.key,"result-probe");
  assert.deepEqual(before.axes,[true,true,true]);
  // Exercise the TransformControls drag events used by the XYZ editing handles.
  await page.evaluate(() => {
    const g = window.__csxcad.viewport.gizmo;
    g.dragging = true;
    g.object.position.set(20,10,15);
    g.dispatchEvent({type:"objectChange"});
    g.dragging = false;
  });
  const after = await probeState();
  assert.deepEqual(after.point,[20,10,15]);
  assert.equal(after.doc,before.doc);
  assert.match(await page.locator("#probePosition").textContent(), /X 20.0.*Y 10.0.*Z 15.0/);
  await page.locator("#sectionFollow").click();
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.sections.children.find(x=>x.isMesh && x.userData.section==="XY").position.z),15);
  await page.locator("#probeToggle").click();
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.handles.children.some(x=>x.userData.handleKey==="result-probe")),false);
  await page.locator("#probeToggle").click();
  assert.ok(await page.locator("#probeReadout").isVisible());
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download result.json" }).click(),
  ]);
  const result = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(result.aborted, false);
  assert.ok(result.s11.logmag_db.some(Number.isFinite));
  assert.ok(result.impedance.real_ohm.some(Number.isFinite));
  assert.ok(result.patterns.some(p => p.record.radiation_valid && Number.isFinite(p.max_directivity_dbi)));
  assert.deepEqual(errors, []);
  console.log("Browser CSXCAD + openEMS dipole: PASS");
} finally {
  await browser.close();
}
