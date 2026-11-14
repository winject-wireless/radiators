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
const context=vm.createContext({
 console,
 document:{getElementById(id){
  if(id==="farfield")return graph;
  if(id==="viewAxes")return null;
  return fields[id]||null;
 }},
 Plotly:{async relayout(element,changes){
  assert(element===graph);
  if(changes["scene.camera"])graph._fullLayout.scene.camera=changes["scene.camera"];
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
 await vm.runInContext("zoomCamera(.75)",context);
 let camera=snapshot("sceneCamera");
 assert.deepEqual(camera.center,pivot0,"Zoom changed the orbit target");
 assert.deepEqual(snapshot("cameraTargetMm()"),center0,"Zoom shifted the sample point");
 let d=Math.hypot(...Object.values(camera.eye));
 const zoomedFirst=d;
 await vm.runInContext("zoomCamera(1.25)",context);
 camera=snapshot("sceneCamera");
 d=Math.hypot(...Object.values(camera.eye));
 assert(Math.abs(d-zoomedFirst*1.25)<1e-7,"Consecutive zoom did not accumulate");
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
 console.log("Camera invariant checks passed: invariant pivot under zoom, equal XYZ aspect, bounded 1px fading guides");
})().catch(error=>{console.error(error);process.exitCode=1;});
