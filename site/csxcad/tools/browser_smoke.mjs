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
  // Desktop splitter can resize the dock via pointer and keyboard.
  const dock=page.locator(".dock"),splitter=page.locator("#dockResize");
  const initialDock=(await dock.boundingBox()).height;
  const split=await splitter.boundingBox();
  await page.mouse.move(split.x+split.width/2,split.y+split.height/2);
  await page.mouse.down();
  await page.mouse.move(split.x+split.width/2,split.y+split.height/2-120,{steps:8});
  await page.mouse.up();
  const resized=(await dock.boundingBox()).height;
  assert.ok(resized>initialDock+90,"Desktop dock did not resize");
  await splitter.focus();
  await page.keyboard.press("ArrowDown");
  assert.ok((await dock.boundingBox()).height<resized);
  const savedDock=(await dock.boundingBox()).height;
  const doc=await page.evaluate(()=>structuredClone(window.__csxcad.state.doc));
  doc.parameters={...(doc.parameters||{}), smoke_case:1};
  doc.sweep={enabled:true,mode:"product",parameters:{smoke_case:{values:[1,2]}}};
  await page.locator("#openFile").setInputFiles({name:"sweep-smoke.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(doc))});
  await page.waitForFunction(()=>document.querySelector("#resultCase")?.options.length===2);
  await page.locator('[data-dock="sim"]').click();
  await page.getByRole("spinbutton", { name: "Threads" }).fill("2");
  await page.getByRole("spinbutton", { name: "Threads" }).press("Tab");
  await page.getByRole("button", { name: "Run all (2)", exact: true }).click();
  await page.locator('[data-dock="results"]').click();
  await page.waitForFunction(()=>document.querySelector("#resultCase")?.options[0].textContent.includes("done"),{}, {timeout:240000});
  assert.ok(await page.locator("#resultCharts").getByText("Best S11",{exact:true}).isVisible());
  assert.match(await page.locator("#resultCase option").nth(1).textContent(),/queued|running|done/);
  await page.waitForFunction(()=>[...document.querySelector("#resultCase").options].every(o=>o.textContent.includes("done")),{}, {timeout:240000});
  await page.waitForFunction(()=>document.querySelector("#simBadge")?.textContent==="✓");
  await page.locator("#resultCase").selectOption("1");
  assert.ok(await page.locator("#resultCharts").getByText("Best S11",{exact:true}).isVisible());
  await page.locator("#resultCase").selectOption("0");
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
  // Projected marker radius stays constant across camera dolly and viewport resize.
  const projectedRadius=()=>page.evaluate(()=>{
    const v=window.__csxcad.viewport, o=v.handles.children.find(h=>h.userData.handleKey==="result-probe");
    v.camera.updateMatrixWorld();
    const depth=-o.position.clone().applyMatrix4(v.camera.matrixWorldInverse).z;
    return o.scale.x*v.renderer.domElement.clientHeight*Math.abs(v.camera.projectionMatrix.elements[5])/(2*depth);
  });
  await page.waitForTimeout(150);
  const r0=await projectedRadius();
  await page.evaluate(()=>{const v=window.__csxcad.viewport;v.camera.position.lerp(v.controls.target,0.25);v.markDirty();});
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await projectedRadius()-r0)<0.5);
  assert.ok(r0>=5 && r0<=8);
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
  // Completed sweep cases must restore after a real reload, without running FDTD.
  await page.reload();
  await page.waitForFunction(()=>window.__csxcad?.viewport && [...document.querySelector("#resultCase").options].length===2 && [...document.querySelector("#resultCase").options].every(o=>o.textContent.includes("done")),{}, {timeout:90000});
  assert.ok(Math.abs((await dock.boundingBox()).height-savedDock)<3,"Dock height not restored");
  await page.locator('[data-dock="results"]').click();
  assert.ok(await page.locator("#resultCharts").getByText("Results · cached on this device",{exact:true}).isVisible());
  assert.ok(await page.locator("#resultCharts").getByText("Best S11",{exact:true}).isVisible());
  // Mobile Results selector stays in the header and swipe navigates without
  // requiring a tap on the select. Vertical scrolling does not change cases.
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>matchMedia("(max-width:760px)").matches);
  const toolbar=await page.locator(".view-toolbar.top-left").boundingBox();
  assert.ok(toolbar.height<150,"Mobile toolbar too tall: "+toolbar.height);
  const probe=await page.locator("#probeReadout").boundingBox();
  assert.ok(probe && probe.height<140,"Mobile probe too tall");
  // ResizeObserver and the on-demand renderer may settle on different frames.
  // Wait for the actual projection to converge rather than sampling immediately.
  await page.waitForFunction(expected=>{
    const v=window.__csxcad.viewport,o=v.handles.children.find(h=>h.userData.handleKey==="result-probe");
    if(!o)return false;
    v.camera.updateMatrixWorld();
    const depth=-o.position.clone().applyMatrix4(v.camera.matrixWorldInverse).z;
    const radius=o.scale.x*v.renderer.domElement.clientHeight*Math.abs(v.camera.projectionMatrix.elements[5])/(2*depth);
    return Math.abs(radius-expected)<2;
  },r0,{timeout:10000});
  await page.locator('.mobile-nav [data-sheet="results"]').click();
  await page.waitForFunction(()=>document.body.dataset.sheet==="results");
  const body=page.locator("#resultBody");
  const swipe=async(dx,dy)=>body.evaluate((el,{dx,dy})=>{
    const point=(x,y)=>({clientX:x,clientY:y});
    const a=new Event("touchstart",{bubbles:true});
    Object.defineProperty(a,"touches",{value:[point(200,200)]});
    el.dispatchEvent(a);
    const b=new Event("touchend",{bubbles:true});
    Object.defineProperty(b,"changedTouches",{value:[point(200+dx,200+dy)]});
    el.dispatchEvent(b);
  },{dx,dy});
  await body.evaluate(el=>{el.scrollTop=(el.scrollHeight-el.clientHeight)*0.57;});
  const scrollRatio=()=>body.evaluate(el=>el.scrollTop/Math.max(1,el.scrollHeight-el.clientHeight));
  const ratio=await scrollRatio();
  assert.ok(ratio>0.5);
  await swipe(-100,5);
  assert.equal(await page.locator("#resultCase").inputValue(),"1");
  assert.ok(Math.abs(await scrollRatio()-ratio)<0.04,"Swipe reset the results scroll");
  await swipe(5,100);
  assert.equal(await page.locator("#resultCase").inputValue(),"1");
  await swipe(100,5);
  assert.equal(await page.locator("#resultCase").inputValue(),"0");
  assert.ok(Math.abs(await scrollRatio()-ratio)<0.04);
  await page.locator("#resultCase").selectOption("1");
  assert.ok(Math.abs(await scrollRatio()-ratio)<0.04);
  await page.locator("#resultCase").selectOption("0");
  assert.ok(await page.locator("#resultCase").isVisible());
  await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  assert.ok(await page.locator("#resultCase").isVisible());
  await page.locator('.mobile-nav [data-sheet="params"]').click();
  const sizing=await page.locator("#params .ptable input[type=text]").first().evaluate(el=>({font:parseFloat(getComputedStyle(el).fontSize),height:el.getBoundingClientRect().height}));
  assert.ok(sizing.font>=12 && sizing.font<=14 && sizing.height<=36);
  await page.locator('.mobile-nav [data-sheet="sim"]').click();
  assert.equal(await splitter.isVisible(),false);
  assert.ok(!(await page.locator(".sim-case-hint").textContent()).includes("Local WASM"));
  assert.match(await page.locator(".sim-case-hint").textContent(),/#1.*smoke_case=1.*2 cases/);
  const axis=await page.locator(".sweep-axis").first().boundingBox();
  assert.ok(axis.height<52,"Sweep axis is not compact: "+axis.height);
  assert.deepEqual(errors, []);
  console.log("Browser CSXCAD + streaming sweep + mobile navigation: PASS");
} finally {
  await browser.close();
}
