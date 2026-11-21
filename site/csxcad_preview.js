/* Lightweight visualization of the native CSXCAD schema-v2 primitives.
 * No CAD kernel, CSG translation, or geometry substitution is involved.
 * OpenEMS/CSXCAD builds the authoritative geometry from the same JSON.
 */
(function (root) {
 "use strict";
 const finite = n => typeof n === "number" && Number.isFinite(n);
 const vec3 = (a, label) => {
   if (!Array.isArray(a) || a.length !== 3 || !a.every(finite))
     throw Error(label + " requires three finite coordinates");
   return a;
 };
 const positive = (a, label) => {
   if (!finite(a) || a <= 0) throw Error(label + " must be positive");
   return a;
 };
 const add = (a,b) => a.map((n,i)=>n+b[i]);
 const sub = (a,b) => a.map((n,i)=>n-b[i]);
 const mul = (a,s) => a.map(n=>n*s);
 const dot = (a,b) => a.reduce((s,n,i)=>s+n*b[i],0);
 const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const unit = a => { const n=Math.hypot(...a); if (!n) throw Error("Zero-length axis"); return mul(a,1/n); };
 const rotate = (point, degrees) => {
   const [roll,pitch,yaw]=vec3(degrees,"rotate_deg").map(v=>v*Math.PI/180);
   let [x,y,z]=point;
   [y,z]=[y*Math.cos(roll)-z*Math.sin(roll),y*Math.sin(roll)+z*Math.cos(roll)];
   [x,z]=[x*Math.cos(pitch)+z*Math.sin(pitch),-x*Math.sin(pitch)+z*Math.cos(pitch)];
   [x,y]=[x*Math.cos(yaw)-y*Math.sin(yaw),x*Math.sin(yaw)+y*Math.cos(yaw)];
   return [x,y,z];
 };
 function transform(point,g) {
   const t=g.transform||{};
   return add(rotate(point,t.rotate_deg||[0,0,0]),vec3(t.translate||[0,0,0],"translate"));
 }
 function helixPoints(g) {
   const origin=vec3(g.origin,"helix.origin"),axis=unit(vec3(g.axis||[0,0,1],"helix.axis"));
   const trial=Math.abs(axis[0])<.9?[1,0,0]:[0,1,0];
   const u=unit(sub(trial,mul(axis,dot(axis,trial)))),v=cross(axis,u);
   const turns=positive(g.turns,"helix.turns"),height=positive(g.height,"helix.height");
   const diameter=positive(g.diameter,"helix.diameter"),steps=g.segments_per_turn??24;
   if (!Number.isInteger(steps)||steps<8||steps>80||turns*steps>8000)
     throw Error("helix segments_per_turn must be 8..80 (<= 8000 total)");
   const n=Math.ceil(turns*steps),phase=(g.phase_deg||0)*Math.PI/180;
   return Array.from({length:n+1},(_,i)=>{
     const t=i/n,a=2*Math.PI*turns*t+phase;
     return add(add(add(origin,mul(axis,t*height)),
       mul(u,diameter/2*Math.cos(a))),mul(v,diameter/2*Math.sin(a)));
   });
 }
 function validate(g) {
   if (!g || typeof g!=="object" || Array.isArray(g)) throw Error("Component must be an object");
   const shape=g.shape||g.type;
   if (!["box","cylinder","cylindrical_shell","sphere","spherical_shell",
     "hemisphere","hemispherical_shell","wire","helix"].includes(shape))
     throw Error("Unsupported native CSXCAD shape: "+shape);
   const t=g.transform||{};
   vec3(t.rotate_deg||[0,0,0],"rotate_deg");vec3(t.translate||[0,0,0],"translate");
   if (shape==="box") {
     const a=vec3(g.start,"box.start"),b=vec3(g.stop,"box.stop");
     if (a.some((n,i)=>n>b[i])) throw Error("box.start must be <= box.stop");
     if (a.some((n,i)=>n===b[i])&&(t.rotate_deg||[]).some(n=>n!==0))
       throw Error("Native CSXCAD cannot rotate zero-thickness boxes");
   } else if (shape==="cylinder"||shape==="cylindrical_shell") {
     positive(g.radius,"radius");
     if (Math.hypot(...sub(vec3(g.start,"start"),vec3(g.stop,"stop")))===0)
       throw Error("Cylinder start and stop must differ");
     if (shape==="cylindrical_shell") {
       positive(g.thickness,"thickness");
       if (g.thickness>=2*g.radius) throw Error("Shell thickness must be < diameter");
     }
   } else if (["sphere","spherical_shell","hemisphere","hemispherical_shell"].includes(shape)) {
     vec3(g.center,"center");positive(g.radius,"radius");
     if (shape.endsWith("_shell")) {
       positive(g.thickness,"thickness");
       if (g.thickness>=g.radius) throw Error("Shell thickness must be < radius");
     }
   } else if (shape==="wire") {
     if (!Array.isArray(g.points)||g.points.length<2||g.points.length>8001)
       throw Error("wire.points must have 2..8001 positions");
     for (const p of g.points) vec3(p,"wire point");
     positive(g.wire_diameter,"wire_diameter");
   } else if (shape==="helix") {
     positive(g.wire_diameter,"wire_diameter");helixPoints(g);
   }
   return shape;
 }
 function mesh(points,faces) {return {points,faces};}
 function boxMesh(g){
   const [x0,y0,z0]=g.start,[x1,y1,z1]=g.stop;
   const pts=[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
     [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
   const faces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
     [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
   return mesh(pts,faces);
 }
 function cylinderMesh(a,b,r,thickness=0){
   const axis=unit(sub(b,a)),trial=Math.abs(axis[2])<.9?[0,0,1]:[1,0,0];
   const u=unit(cross(axis,trial)),v=cross(axis,u),n=20,pts=[],faces=[];
   const radii=thickness?[r+thickness/2,Math.max(.001,r-thickness/2)]:[r];
   for (const radius of radii) {
     const offset=pts.length;
     for (const center of [a,b])for(let i=0;i<n;i++){
       const alpha=2*Math.PI*i/n;
       pts.push(add(center,add(mul(u,radius*Math.cos(alpha)),mul(v,radius*Math.sin(alpha)))));
     }
     for(let i=0;i<n;i++){
       const j=(i+1)%n;
       faces.push([offset+i,offset+j,offset+n+j],[offset+i,offset+n+j,offset+n+i]);
     }
   }
   if (!thickness) {
     pts.push(a,b);const ca=pts.length-2,cb=ca+1;
     for(let i=0;i<n;i++) {
       const j=(i+1)%n;
       faces.push([ca,j,i],[cb,n+i,n+j]);
     }
   }
   return mesh(pts,faces);
 }
 function sphereMesh(center,r,hemisphere=false,thickness=0) {
   const pts=[],faces=[],n=24,layers=hemisphere?9:16;
   const radii=thickness?[r,r-thickness]:[r];
   for (const radius of radii){
     const offset=pts.length;
     for(let i=0;i<=layers;i++) {
       const theta=Math.PI*i/(hemisphere?2*layers:layers);
       for(let j=0;j<n;j++) {
         const phi=2*Math.PI*j/n;
         pts.push([center[0]+radius*Math.sin(theta)*Math.cos(phi),
           center[1]+radius*Math.sin(theta)*Math.sin(phi),
           center[2]+radius*Math.cos(theta)]);
       }
     }
     for(let i=0;i<layers;i++)for(let j=0;j<n;j++){
       const jp=(j+1)%n,a=offset+i*n+j,b=offset+i*n+jp,
         c=offset+(i+1)*n+j,d=offset+(i+1)*n+jp;
       faces.push([a,c,d],[a,d,b]);
     }
   }
   return mesh(pts,faces);
 }
 function wireMesh(points,r) {
   const samples=points.length>300?points.filter((_,i)=>i%Math.ceil(points.length/300)===0):points.slice();
   if (samples[samples.length-1]!==points[points.length-1])samples.push(points[points.length-1]);
   const verts=[],faces=[],n=9;
   for(let i=0;i<samples.length;i++){
     const tangent=i===0?sub(samples[1],samples[0]):
       i===samples.length-1?sub(samples[i],samples[i-1]):sub(samples[i+1],samples[i-1]);
     const axis=unit(tangent),trial=Math.abs(axis[2])<.9?[0,0,1]:[0,1,0];
     const u=unit(cross(axis,trial)),v=cross(axis,u);
     for(let j=0;j<n;j++){
       const alpha=2*Math.PI*j/n;
       verts.push(add(samples[i],add(mul(u,r*Math.cos(alpha)),mul(v,r*Math.sin(alpha)))));
     }
     if(i>0)for(let j=0;j<n;j++) {
       const jp=(j+1)%n,a=(i-1)*n+j,b=(i-1)*n+jp,c=i*n+j,d=i*n+jp;
       faces.push([a,b,d],[a,d,c]);
     }
   }
   return mesh(verts,faces);
 }
 function buildMesh(g) {
   const type=validate(g);
   let built;
   if(type==="box")built=boxMesh(g);
   else if(type==="cylinder"||type==="cylindrical_shell")
     built=cylinderMesh(g.start,g.stop,g.radius,type==="cylindrical_shell"?g.thickness:0);
   else if(type==="sphere"||type==="spherical_shell")
     built=sphereMesh(g.center,g.radius,false,type==="spherical_shell"?g.thickness:0);
   else if(type==="hemisphere"||type==="hemispherical_shell")
     built=sphereMesh(g.center,g.radius,true,type==="hemispherical_shell"?g.thickness:0);
   else built=wireMesh(type==="helix"?helixPoints(g):g.points,g.wire_diameter/2);
   built.points=built.points.map(p=>transform(p,g));
   return built;
 }
 function traces(g,color,selected=false) {
   const data=buildMesh(g);
   const xs=data.points.map(p=>p[0]),ys=data.points.map(p=>p[1]),zs=data.points.map(p=>p[2]);
   const common={name:g.name||g.shape,meta:{partId:g.editor_id},
     hovertemplate:(g.name||g.shape)+"<extra></extra>"};
   return [{...common,type:"mesh3d",x:xs,y:ys,z:zs,
     i:data.faces.map(f=>f[0]),j:data.faces.map(f=>f[1]),k:data.faces.map(f=>f[2]),
     color,opacity:selected?1:.84,flatshading:true,showlegend:true,
     lighting:{ambient:.65,diffuse:.6,specular:.12}}];
 }
 const api=Object.freeze({validate,helixPoints,buildMesh,traces,rotate,transform});
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
 if(root)root.CSXCADPreview=api;
})(typeof window!=="undefined"?window:null);
