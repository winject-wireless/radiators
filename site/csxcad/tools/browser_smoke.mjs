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
  // Clicking the already-active projection restores its home pose and framing.
  const cameraPose = () => page.evaluate(() => {
    const { camera, controls } = window.__csxcad.viewport;
    return [...camera.position.toArray(), ...camera.quaternion.toArray(), ...controls.target.toArray(), camera.zoom];
  });
  for (const mode of ["perspective", "iso"]) {
    const preset = page.locator(`[data-view="${mode}"]`);
    await preset.click();
    const home = await cameraPose();
    await page.evaluate(() => {
      const { camera, controls } = window.__csxcad.viewport;
      controls.target.addScalar(12);
      camera.position.set(25, 17, -13);
      camera.zoom *= 2;
      camera.updateProjectionMatrix();
      controls.update();
    });
    await preset.click();
    const restored = await cameraPose();
    assert.ok(restored.every((v, i) => Math.abs(v - home[i]) < 1e-8), mode + " failed to reset the view");
  }
  await page.locator('[data-view="perspective"]').click();
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
  assert.equal(await page.getByLabel("openEMS engine").inputValue(),"cpu");
  // Verify per-document units and non-destructive display changes.
  const initialHz=await page.evaluate(()=>window.__csxcad.state.doc.excitation.center_hz);
  const center=page.getByLabel("Center frequency",{exact:true});
  await page.locator("#menuButton").click();
  await page.getByRole("menuitem",{name:"Workspace units…"}).click();
  await page.getByLabel("Workspace Frequency").selectOption("MHz");
  await page.getByRole("button",{name:"Apply",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__csxcad.state.doc.workspace_units.frequency),"MHz");
  assert.equal(await page.evaluate(()=>window.__csxcad.state.doc.excitation.center_hz),initialHz);
  await page.locator('[data-dock="sim"]').click();
  assert.equal(Number(await center.inputValue()),initialHz/1e6);
  await center.fill("1 GHz");
  await center.press("Tab");
  assert.equal(await page.evaluate(()=>window.__csxcad.state.doc.excitation.center_hz),1e9);
  await center.fill(String(initialHz)+" Hz");
  await center.press("Tab");
  assert.equal(await page.evaluate(()=>window.__csxcad.state.doc.excitation.center_hz),initialHz);
  // Restore GHz display for the remaining simulation smoke test.
  await page.locator("#menuButton").click();
  await page.getByRole("menuitem",{name:"Workspace units…"}).click();
  await page.getByLabel("Workspace Frequency").selectOption("GHz");
  await page.getByRole("button",{name:"Apply",exact:true}).click();
  // Local mesh refinement editor: generate a feed box, edit its resolution,
  // select an XYZ corner and remove it without changing the solver fixture.
  const originalRefinements=await page.evaluate(()=>structuredClone(window.__csxcad.state.doc.mesh.refinements||[]));
  const section=page.locator("#sim .refinement-section");
  await section.getByRole("button",{name:"+ Around feed",exact:true}).click();
  const newIndex=originalRefinements.length;
  const box=section.locator('[data-refinement="'+newIndex+'"]');
  const added=await page.evaluate(i=>window.__csxcad.state.doc.mesh.refinements[i],newIndex);
  assert.equal(added.resolution_mm,.25);
  assert.ok(added.start.every((v,i)=>v<added.stop[i]));
  await box.getByLabel("Refinement "+(newIndex+1)+" resolution",{exact:true}).fill("0.5 mm");
  await box.getByLabel("Refinement "+(newIndex+1)+" resolution",{exact:true}).press("Tab");
  assert.equal(await page.evaluate(i=>window.__csxcad.state.doc.mesh.refinements[i].resolution_mm,newIndex),.5);
  await box.getByRole("button",{name:"Edit in 3D",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__csxcad.viewport.gizmo.object?.userData.handleKey),"mesh.refinements."+newIndex+".start");
  assert.equal(await page.evaluate(i=>window.__csxcad.viewport.overlays.children.find(o=>o.userData.ref?.kind==="refinement"&&o.userData.ref.index===i)?.visible,newIndex),true);
  await box.getByRole("button",{name:"Remove refinement "+(newIndex+1),exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.__csxcad.state.doc.mesh.refinements||[]),originalRefinements);
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
  const assertPlanes = async (point) => {
    const planes = await page.evaluate(() => {
      const v = window.__csxcad.viewport;
      const items = {};
      for (const [name,axis] of [["XY",2],["YZ",0],["XZ",1]]) {
        const square=v.sections.children.find(x=>x.isMesh&&x.userData.section===name);
        const line=v.sections.children.find(x=>x.isLine&&x.userData.section===name);
        const positions=line?.geometry.attributes.position.array||[];
        items[name]={position:square?.position.toArray(),coordinates:Array.from(positions).filter((_,i)=>i%3===axis)};
      }
      return {items,grid:v.grid.position.toArray(),minZ:v.bounds.min.z};
    });
    assert.deepEqual(planes.grid,[0,0,0]);
    assert.ok(planes.minZ<0,"Dipole must extend below global XY");
    for(const [name,axis] of [["XY",2],["YZ",0],["XZ",1]]) {
      const expected=[0,0,0];expected[axis]=point[axis];
      assert.deepEqual(planes.items[name].position,expected,name+" plane origin");
      assert.ok(planes.items[name].coordinates.every(x=>Math.abs(x-point[axis])<1e-5),name+" intersection offset");
    }
  };
  await assertPlanes([0,0,0]);
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
  await assertPlanes([0,0,0]);
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
  await assertPlanes([20,10,15]);
  await page.locator("#probeToggle").click();
  assert.equal(await page.evaluate(() => window.__csxcad.viewport.handles.children.some(x=>x.userData.handleKey==="result-probe")),false);
  assert.equal(await page.locator("#sectionFollow").getAttribute("aria-pressed"),"false");
  assert.ok(await page.locator("#sectionFollow").isDisabled());
  await assertPlanes([0,0,0]);
  await page.locator("#probeToggle").click();
  assert.ok(await page.locator("#probeReadout").isVisible());
  assert.ok(await page.locator("#sectionFollow").isEnabled());
  await assertPlanes([0,0,0]);
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
  const strayOptionalText=await page.locator("#resultCharts").evaluate(el=>[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE&&/^(null|undefined|false)$/.test(n.textContent.trim())).map(n=>n.textContent));
  assert.deepEqual(strayOptionalText,[],"Optional result content rendered as text");
  await page.locator('.mobile-nav [data-sheet="params"]').click();
  await page.locator(".param-help summary").click();
  assert.equal(await page.locator(".param-help code").filter({hasText:"2*gap + 1"}).first().isVisible(),true);
  assert.equal(await page.locator(".param-actions").getByRole("button",{name:"Open sweep"}).isVisible(),true);
  assert.ok(!(await page.locator("#params").textContent()).includes("Swept in Simulation:"));
  const sizing=await page.locator("#params .ptable input[type=text]").first().evaluate(el=>({font:parseFloat(getComputedStyle(el).fontSize),height:el.getBoundingClientRect().height}));
  assert.ok(sizing.font>=12 && sizing.font<=14 && sizing.height<=36);
  await page.locator('.mobile-nav [data-sheet="sim"]').click();
  assert.equal(await splitter.isVisible(),false);
  assert.ok(!(await page.locator(".sim-case-hint").textContent()).includes("Local WASM"));
  assert.match(await page.locator(".sim-case-hint").textContent(),/#1.*smoke_case=1.*2 cases/);
  const axis=await page.locator(".sweep-axis").first().boundingBox();
  assert.ok(axis.height<52,"Sweep axis is not compact: "+axis.height);
  assert.deepEqual(errors, []);
  // Real mobile emulation (touch, DPR, mobile viewport), not just a resized
  // desktop window. Compare computed text sizes across form roles.
  const phone=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  try {
    const mobilePage=await phone.newPage();
    await mobilePage.goto(new URL("?debug=1",base).href);
    await mobilePage.waitForFunction(()=>crossOriginIsolated&&window.__csxcad?.viewport&&document.querySelector("#sim .sim-controls"),{},{timeout:90000});
    await mobilePage.locator('.mobile-nav [data-sheet="sim"]').click();
    await mobilePage.waitForFunction(()=>document.body.dataset.sheet==="sim");
    assert.equal(await mobilePage.getByLabel("openEMS engine").inputValue(),"cpu");
    const fonts=await mobilePage.evaluate(()=>{
      const sim=document.querySelector("#sim");
      const font=sel=>parseFloat(getComputedStyle(sim.querySelector(sel)).fontSize);
      return {label:font(".sim-engine"),select:font(".sim-engine select"),input:font(".sim-threads input"),button:font(".sim-run-actions button"),hint:font(".sim-case-hint"),section:font(".sim-setup-card summary")};
    });
    for(const k of ["label","select","input","button","section"])assert.equal(fonts[k],13,k+" font");
    assert.equal(fonts.hint,12);
    assert.equal(await mobilePage.locator(".sim-run-actions").getByRole("button",{name:"Stop",exact:true}).isVisible(),false);
    assert.match(await mobilePage.locator(".editor-build").textContent(),/^Build [0-9a-f]{12}$/);
    // The example picker contains long multiline names and descriptions.
    // Verify no flex shrink or text spill, even beyond the scroll viewport.
    await mobilePage.locator("#menuButton").click();
    await mobilePage.locator('[data-action="examples"]').click();
    await mobilePage.locator("#dialog .example-list > button").first().waitFor({state:"visible"});
    const picker=mobilePage.locator("#dialog .example-list");
    const layout=await picker.evaluate(el=>{
      const rows=[...el.querySelectorAll(":scope > button")];
      const rects=rows.map(row=>{
        const r=row.getBoundingClientRect(),children=[...row.children].map(c=>c.getBoundingClientRect());
        return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,
          contained:children.every(c=>c.top>=r.top-1&&c.bottom<=r.bottom+1&&c.left>=r.left-1&&c.right<=r.right+1)};
      });
      return {count:rows.length,scrollable:el.scrollHeight>el.clientHeight,
        contained:rects.every(r=>r.contained),
        separated:rects.every((r,i)=>i===0||r.top>=rects[i-1].bottom+2)};
    });
    assert.ok(layout.count>=5);
    assert.ok(layout.scrollable,"Expected example list to scroll");
    assert.ok(layout.contained,"Example text escapes its row");
    assert.ok(layout.separated,"Example rows overlap");
    await picker.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    assert.ok(await picker.evaluate(el=>el.scrollTop>0));
    await mobilePage.locator("#dialogActions").getByRole("button",{name:"Close",exact:true}).click();
    // Reproduce the opposing shell/cap assembly on a mobile WebGL viewport.
    const assembly=await mobilePage.evaluate(()=>structuredClone(window.__csxcad.state.doc));
    assembly.materials=[{name:"pec-metal",type:"pec"}];
    assembly.parameters={L:30,d_diameter:4,g_r:1};
    assembly.sweep={mode:"product",parameters:{g_r:{values:[124,62,31]}}};
    assembly.geometry=[
      {name:"d",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,0],stop:[0,0,{$param:"L"}],radius:{$expr:"d_diameter/2-0.5/2"},thickness:.5,transform:{translate:[0,0,{$expr:"2+d_diameter/2"}]}},
      {name:"g",shape:"cylindrical_shell",material:"pec-metal",start:[0,0,0],stop:[0,0,{$expr:"-L"}],radius:{$expr:"d_diameter/2-0.5/2"},thickness:.5,transform:{translate:[0,0,{$expr:"-d_diameter/2"}]}},
      ...[[4,-1],[-2,1]].map(([z,axis],i)=>({name:i?"g_cap":"d_cap",script:"hemisphere",args:{center:[0,0,z],axis:[0,0,axis],radius:{$expr:"d_diameter/2"},thickness:.5,rings:10,segments:32,material:"pec-metal"}}))
    ];
    assembly.ports=[{id:1,name:"feed",type:"lumped",start:[0,0,-.1],stop:[0,0,2.1],direction:"z",impedance_ohm:50,excite:true}];
    await mobilePage.locator("#openFile").setInputFiles({name:"shell-assembly.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(assembly))});
    await mobilePage.waitForFunction(()=>window.__csxcad.viewport.parts.children.length===4,{}, {timeout:30000});
    const render=await mobilePage.evaluate(()=>{
      const v=window.__csxcad.viewport;
      v.setSelection(null);v.scene.updateMatrixWorld(true);
      return v.parts.children.map((g,i)=>{
        const mesh=g.children[0];mesh.geometry.computeBoundingBox();
        const bb=mesh.geometry.boundingBox;
        const z=[19,-17,3,-1][i];
        v.raycaster.ray.origin.set(10,0,z);v.raycaster.ray.direction.set(-1,0,0);
        const hit=v.raycaster.intersectObject(mesh,false)[0];
        return {z:[bb.min.z,bb.max.z],visible:g.visible,opaque:!mesh.material.transparent&&mesh.material.opacity===1&&mesh.material.depthWrite,
          front:mesh.material.side===0,hit:hit?.point.x??null};
      });
    });
    assert.deepEqual(render.map(r=>r.z.map(z=>Math.round(z*1e6)/1e6)),[[4,34],[-32,-2],[2,4],[-2,0]]);
    assert.ok(render.every(r=>r.visible&&r.opaque&&r.front&&r.hit>0),"Closed metal shells must expose their near faces");
    await mobilePage.evaluate(()=>{
      const v=window.__csxcad.viewport;v.controls.target.set(0,0,1);v.camera.position.set(0,-.25,1);v.controls.update();v.markDirty();
    });
    await mobilePage.waitForFunction(()=>window.__csxcad.viewport.camera.near<.001,{}, {timeout:5000});
  } finally {await phone.close();}
  console.log("Browser CSXCAD + streaming sweep + mobile navigation: PASS");
} finally {
  await browser.close();
}
