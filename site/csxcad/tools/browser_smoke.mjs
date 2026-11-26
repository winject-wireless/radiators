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
