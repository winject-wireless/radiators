#!/usr/bin/env node
"use strict";
/* Intersection regression checks: the section must be a single thin,
 * uniform-color contour, without duplicate outlines or tiny loose strokes.
 * No browser is required; exercise the same geometry helpers used by GL3D.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const root=path.resolve(process.argv[2]||"site/dist");
const js=fs.readFileSync(path.join(root,"app.js"),"utf8");
const begin="(function setupControls(){";
assert(js.includes(begin),"Viewer bootstrap not found");
const context=vm.createContext({console});
vm.runInContext(js.slice(0,js.indexOf(begin)),context,{timeout:4000});
// Star-shaped sampled sphere. It has a deliberate row on the XY plane,
// testing the seam and coplanar-vertex cases that previously produced edges.
const theta=Array.from({length:13},(_,i)=>i*15);
const phi=Array.from({length:24},(_,i)=>i*15);
context.fixture={
 theta_deg:theta,phi_deg:phi,
 directivity_dbi:theta.map(()=>phi.map(()=>0)),
 max_directivity_dbi:0
};
const section=(position,angles)=>JSON.parse(vm.runInContext(
 "JSON.stringify(patternPlaneIntersection(patternGrid(fixture),"+
 JSON.stringify(position)+","+JSON.stringify(angles)+"))",context));
function checkTrace(traces,description){
 assert.equal(traces.length,1,description+": expected one contour trace (no underlay)");
 const trace=traces[0];
 assert.equal(trace.name,"Continuous plane intersection");
 assert.equal(trace.type,"scatter3d");
 assert.equal(trace.mode,"lines");
 assert.equal(trace.line.color,"#fff1a1");
 assert.equal(trace.line.width,2,"Line grew thicker than 2px");
 assert.equal(trace.x.length,trace.y.length);
 assert.equal(trace.x.length,trace.z.length);
 const paths=[];
 let current=[];
 for(let i=0;i<trace.x.length;i++){
  const xyz=[trace.x[i],trace.y[i],trace.z[i]];
  if(xyz.every(v=>v===null)){
   if(current.length)paths.push(current);
   current=[];
  }else{
   assert(xyz.every(Number.isFinite),description+": nonfinite point");
   current.push(xyz);
  }
 }
 if(current.length)paths.push(current);
 assert.equal(paths.length,1,description+": broken, duplicate or stray intersection fragment");
 assert(paths[0].length>=12,description+": insufficient contour points");
 const first=paths[0][0],last=paths[0].at(-1);
 assert(Math.hypot(...first.map((v,i)=>v-last[i]))<1e-5,
  description+": intersection should be one closed loop");
 return paths[0];
}
const xy=checkTrace(section([0,0,0],[0,0,0]),"XY cut");
const nominalRadius=16.5*1.0015; // radiatingScale() * radial depth bias
for(const pt of xy){
 assert(Math.abs(pt[2])<1e-8,"XY cut escaped the plane");
 assert(Math.abs(Math.hypot(...pt)-nominalRadius)<1e-6,
  "Contour did not clear the radiation mesh by the required small offset");
}
checkTrace(section([0,0,0],[12*Math.PI/180,17*Math.PI/180,31*Math.PI/180]),
 "tilted cut");
checkTrace(section([0,0,16.5*.3],[0,0,0]),"translated cut");
assert.equal(section([0,0,16.5*2],[0,0,0]).length,0,
 "Nonintersecting plane should not generate strokes");
assert(!js.includes('name:"Section outline"'),"Thick dark outline was reintroduced");
console.log("Intersection checks passed: one 2px color, closed loops, lifted surface, zero strays");
