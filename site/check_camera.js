#!/usr/bin/env node
"use strict";
/* Camera regression checks: run in CI before deploying Pages.
 * Zoom must never change the world-space sampling point or camera pivot.
 * Pan guides must remain 1px and inside a cube with equal axis scales.
 */
const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const root=path.resolve(process.argv[2]||"site/dist");
const js=fs.readFileSync(path.join(root,"app.js"),"utf8");
const graph={_fullLayout:{scene:{camera:{
 eye:{x:1.55,y:1.55,z:1.1},
 center:{x:.91,y:.77,z:-.66}, // Simulate drift from the graph library.
 up:{x:0,y:0,z:1}}}}};
const fields={panStatus:{hidden:true}};
const cameraUpdates=[];
const context=vm.createContext({
 console,
 document:{getElementById(id){
  if(id==="farfield")return graph;
  if(id==="viewAxes")return null;
  return fields[id]||null;
 }},
 Plotly:{async relayout(element,changes){
  assert(element===graph);
  cameraUpdates.push(changes);
  // A zoom must *only* modify the eye. Updating the whole camera reintroduces
  // the center movement during zoom.
  if(changes["scene.camera.eye"]){
   assert.equal(Object.keys(changes).length,1,"Zoom should update eye only");
   graph._fullLayout.scene.camera.eye=changes["scene.camera.eye"];
  }
  if(changes["scene.camera"]){
   throw Error("Regression: full-camera relayout can move the sample point");
  }
 }},
 setTimeout,clearTimeout
});
const begin="(function setupControls(){";
assert(js.includes(begin),"Viewer setupControls bootstrap not found");
vm.runInContext(js.slice(0,js.indexOf(begin)),context,{timeout:4000});

function snapshot(expr){return JSON.parse(vm.runInContext("JSON.stringify("+expr+")",context));}
(async()=>{
 vm.runInContext("orbitCenter={x:.25,y:-.35,z:.1};sceneCamera=null;activePanAxis=null;",context);
 const center0=snapshot("cameraTargetMm()"),pivot0=snapshot("orbitCenter");
 // Two zoom commands without waiting for either promise must accumulate;
 // the old serialized full-camera relayout stalled under rapid input.
 const firstZoom=vm.runInContext("zoomCamera(.75)",context);
 const secondZoom=vm.runInContext("zoomCamera(1.25)",context);
 await Promise.all([firstZoom,secondZoom]);
 assert.equal(cameraUpdates.length,2,"Both zoom actions must execute");
 assert(cameraUpdates.every(update=>Object.keys(update).length===1 &&
   update["scene.camera.eye"]),"Zoom must not overwrite camera center");
 let camera=snapshot("sceneCamera");
 assert.deepEqual(camera.center,pivot0,"Zoom changed the orbit target");
 assert.deepEqual(snapshot("cameraTargetMm()"),center0,"Zoom shifted the sample point");
 let d=Math.hypot(...Object.values(camera.eye));
 const zoomedFirst=d;
 // Starting eye distance multiplied by .75 then 1.25.
 const baseDistance=Math.hypot(1.55,1.55,1.1);
 assert(Math.abs(d-baseDistance*.75*1.25)<1e-7,"Rapid zoom commands did not accumulate");
 await vm.runInContext("zoomCamera(.8)",context);
 camera=snapshot("sceneCamera");
 d=Math.hypot(...Object.values(camera.eye));
 assert(Math.abs(d-zoomedFirst*.8)<1e-7,"Further zoom did not accumulate");
 assert.deepEqual(camera.center,pivot0);
 assert.deepEqual(snapshot("cameraTargetMm()"),center0);
 vm.runInContext("activePanAxis='z';",context);
 const extents=snapshot("sceneHalfExtent()");
 const guides=snapshot("panAxisTraces()");
 const axis=guides.filter(x=>x.name==="Axis fade"||x.name==="Pan Z axis");
 assert(axis.length>0,"Missing active pan guide");
 assert(axis.every(x=>x.line.width===1),"Pan guide is not 1px");
 assert(axis.every(x=>x.x.every(n=>Math.abs(n)<=extents+1e-6) &&
                         x.y.every(n=>Math.abs(n)<=extents+1e-6) &&
                         x.z.every(n=>Math.abs(n)<=extents+1e-6)),
  "Pan guide extends outside the fixed scene cube");
 // All axes share one half-extent: never let guides affect scale independently.
 assert(js.includes('aspectmode:"cube"')&&js.includes("aspectratio:{x:1,y:1,z:1}"),
   "3D scene does not use an isotropic cube");
 assert(js.includes("scrollZoom:false"),"Uncontrolled Plotly native zoom is enabled");
 assert(js.includes('graph.addEventListener("wheel"'),"Custom center-preserving wheel zoom missing");
 const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
 const css=fs.readFileSync(path.join(root,"style.css"),"utf8");
 assert(html.includes('id="viewCenter"'),"Fixed center reticle is missing");
 assert(css.includes("left:50%;top:50%"),"Center reticle is no longer centered");
 // The Plotly canvas and its full-screen error/interaction layers must not
 // intercept the in-plot zoom/reset/export buttons.
 assert(/\.scene-stage\s+\.scene\s*\{[^}]*z-index\s*:\s*0\b/.test(css),
   "Plotly canvas must be in its own stacking layer beneath toolbar");
 assert(/\.scene-toolbar\s*\{[^}]*z-index\s*:\s*[1-9]/.test(css),
   "Toolbar must render above the Plotly interaction layer");
 assert(!js.includes("centerPointTrace()"),"World-space marker was reintroduced at a different screen point");
 assert(js.includes('const millimetresPerDomainUnit=2*sceneHalfExtent()'),
   "Camera target values must be converted from domain coordinates to physical units");
 console.log("Camera invariant checks passed: eye-only rapid zoom, fixed center reticle, physical domain conversion, equal XYZ aspect, bounded 1px fading guides");
})().catch(error=>{console.error(error);process.exitCode=1;});
