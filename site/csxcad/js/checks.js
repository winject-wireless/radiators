// Pre-flight checks for a resolved case, mirroring the requirements that
// antennas/simulate_v2.py enforces before it starts openEMS. Passing these
// does not mean the model is electrically sound (feed, mesh convergence).

import { solverBounds, vec3, transformer, rotationMatrix, helixPoints, tessellate } from "./geometry.js";
import { installGeometry } from "./sim/model.js";
import { setupMesh } from "./sim/mesh.js";

const fin = v => typeof v === "number" && Number.isFinite(v);

// Geometric preflight, not a substitute for discrete Yee-grid connectivity.
const EPS=1e-5;
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const norm=a=>Math.hypot(...a);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const segDist=(p,a,b)=>{const d=sub(b,a),t=clamp(dot(sub(p,a),d)/(dot(d,d)||1),0,1);return norm(sub(p,a.map((x,i)=>x+t*d[i])));};
function triangleDistance(p,a,b,c){
  const ab=sub(b,a),ac=sub(c,a),n=cross(ab,ac),nn=dot(n,n);
  if(nn>1e-24){
    const ap=sub(p,a),h=dot(ap,n)/nn,q=ap.map((v,i)=>v-h*n[i]);
    const aa=dot(ab,ab),bb=dot(ab,ac),cc=dot(ac,ac),den=aa*cc-bb*bb;
    const u=(cc*dot(q,ab)-bb*dot(q,ac))/den,v=(aa*dot(q,ac)-bb*dot(q,ab))/den;
    if(u>=0&&v>=0&&u+v<=1)return Math.abs(h)*Math.sqrt(nn);
  }
  return Math.min(segDist(p,a,b),segDist(p,b,c),segDist(p,c,a));
}
function meshContact(g){
  const {positions,indices}=tessellate(g),verts=[];
  for(let i=0;i<positions.length;i+=3)verts.push(Array.from(positions.slice(i,i+3)));
  const edges=new Map();
  for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
    const a=indices[i+j],b=indices[i+(j+1)%3],k=Math.min(a,b)+","+Math.max(a,b);
    const e=edges.get(k)||[0,0];e[0]++;e[1]+=a<b?1:-1;edges.set(k,e);
  }
  const winding=[...edges.values()].some(([count,orientation])=>count===2&&orientation!==0);
  const open=[...edges.values()].some(([count])=>count!==2);
  return {winding,open,distance(p){
    let nearest=Infinity,angle=0;
    for(let i=0;i<indices.length;i+=3){
      const [a,b,c]=[verts[indices[i]],verts[indices[i+1]],verts[indices[i+2]]];
      nearest=Math.min(nearest,triangleDistance(p,a,b,c));
      if(nearest<=EPS)return 0;
      const [u,v,w]=[sub(a,p),sub(b,p),sub(c,p)],lu=norm(u),lv=norm(v),lw=norm(w);
      angle+=2*Math.atan2(dot(u,cross(v,w)),lu*lv*lw+dot(u,v)*lw+dot(v,w)*lu+dot(w,u)*lv);
    }
    // For invalid/open meshes do not claim that a point is inside material.
    return !open&&!winding&&Math.abs(angle)>2*Math.PI?-nearest:nearest;
  }};
}
function contactShape(g,bounds){
  const shape=g.shape??g.type,T=transformer(g);
  let distance,curved=false,feature=null,mesh=null;
  if(shape==="box"){
    const R=rotationMatrix(g.transform?.rotate_deg||[0,0,0]),shift=g.transform?.translate||[0,0,0];
    distance=p=>{
      const v=sub(p,shift),q=g.start.map((a,i)=>Math.max(a-dot(R.map(row=>row[i]),v),dot(R.map(row=>row[i]),v)-g.stop[i]));
      return norm(q.map(x=>Math.max(0,x)))+Math.min(0,Math.max(...q));
    };
  }else if(shape==="cylinder"||shape==="cylindrical_shell"){
    const a=T(g.start),b=T(g.stop),d=sub(b,a),l=norm(d),u=d.map(x=>x/l);
    const outer=g.radius+(shape==="cylindrical_shell"?g.thickness/2:0),inner=shape==="cylindrical_shell"?g.radius-g.thickness/2:0;
    if(!(l>0&&outer>0&&inner>=0))return null;
    feature=inner>0?g.thickness:outer*2;
    distance=p=>{const v=sub(p,a),z=dot(v,u),r=norm(v.map((x,i)=>x-z*u[i]));
      const q=Math.max(r-outer,inner>0?inner-r:-Infinity),h=Math.max(-z,z-l);
      return Math.hypot(Math.max(q,0),Math.max(h,0))+Math.min(0,Math.max(q,h));};
    // Exact oriented cylinder AABB, unlike the conservative solver bound.
    const e=u.map(x=>outer*Math.sqrt(Math.max(0,1-x*x)));
    bounds=[a.map((x,i)=>Math.min(x,b[i])-e[i]),a.map((x,i)=>Math.max(x,b[i])+e[i])];
  }else if(shape==="sphere"||shape==="spherical_shell"){
    const c=T(g.center),outer=g.radius+(shape==="spherical_shell"?g.thickness/2:0),inner=shape==="spherical_shell"?g.radius-g.thickness/2:0;
    curved=true;feature=inner>0?g.thickness:outer*2;
    distance=p=>{const r=norm(sub(p,c));return Math.max(r-outer,inner>0?inner-r:-Infinity);};
    bounds=[c.map(x=>x-outer),c.map(x=>x+outer)];
  }else if(shape==="wire"||shape==="helix"){
    const pts=(shape==="wire"?g.points:helixPoints(g)).map(T),r=g.wire_diameter/2;
    curved=true;feature=2*r;
    distance=p=>{let d=Infinity;for(let i=1;i<pts.length;i++)d=Math.min(d,segDist(p,pts[i-1],pts[i]));return d-r;};
  }else if(["polyhedron","hemisphere","hemispherical_shell"].includes(shape)){
    mesh=meshContact(g);distance=mesh.distance;curved=true;
    if(g.thickness>0)feature=g.thickness;
  }else return null;
  return {name:g.name||shape,bounds,distance,curved,feature,mesh};
}
const boundDistance=(p,[lo,hi])=>norm(p.map((v,i)=>Math.max(lo[i]-v,v-hi[i],0)));
const SPEED=299792458;
// Cell size the configuration asks for inside a box, as the mesher applies it:
// a refinement counts only where it covers the whole box.
function localSpacing(mesh,lo,hi){
  const resolution=mesh?.resolution_mm??mesh?.max_cell_mm??5;
  if((mesh?.grid_mode??"feature")==="uniform")return mesh?.uniform_step_mm>0?mesh.uniform_step_mm:resolution;
  let spacing=resolution;
  if(mesh?.local_min_cell_mm>0&&Math.max(...hi.map((v,i)=>v-lo[i]))<=(mesh.auto_refine_max_span_mm??40))
    spacing=Math.min(spacing,mesh.local_min_cell_mm);
  for(const r of mesh?.refinements||[]){
    if(r?.enabled===false||!(r.resolution_mm>0)||!Array.isArray(r.start)||!Array.isArray(r.stop))continue;
    if(lo.every((v,i)=>v>=Math.min(r.start[i],r.stop[i])-EPS&&hi[i]<=Math.max(r.start[i],r.stop[i])+EPS))
      spacing=Math.min(spacing,r.resolution_mm);
  }
  return spacing;
}
// Uniform mode fills the domain with linspace, so the actual spacing is the
// domain span divided by the interval count, not exactly uniform_step_mm.
function uniformPitch(mesh,ds,de){
  const step=(mesh?.uniform_step_mm>0?mesh.uniform_step_mm:mesh?.resolution_mm??mesh?.max_cell_mm??5);
  return ds.map((v,i)=>{
    const n=Math.max(1,Math.ceil((de[i]-v)/step));
    return (de[i]-v)/n;
  });
}
// How far a coordinate sits from the nearest grid line. CSXCAD snaps every
// primitive to the nearest line, so this is how much the part can move.
const offGrid=(value,origin,pitch)=>{const k=(value-origin)/pitch;return Math.abs(k-Math.round(k))*pitch;};
function endSamples(a,b,k,end){
  const axes=[0,1,2].filter(i=>i!==k),values=i=>a[i]===b[i]?[a[i]]:[a[i],(a[i]+b[i])/2,b[i]];
  return values(axes[0]).flatMap(x=>values(axes[1]).map(y=>{const q=[...end];q[axes[0]]=x;q[axes[1]]=y;return q;}));
}
// Inspect the real generated grid around an axial point terminal. A nearby
// transverse half-cell sample is a resolution heuristic, not a reproduction
// of openEMS's material assignment on its staggered Yee grid.
function transverseSamples(grid,p,k){
  const samples=[];
  for(let i=0;i<3;i++){
    if(i===k)continue;
    const lines=grid.lines[i];
    let j=lines.findIndex(v=>v>=p[i]-EPS);
    if(j<0)continue;
    if(Math.abs(lines[j]-p[i])<=EPS){
      for(const n of [j-1,j+1])if(n>=0&&n<lines.length){
        const q=[...p];q[i]=(p[i]+lines[n])/2;
        samples.push({q,axis:i,spacing:Math.abs(lines[n]-p[i])});
      }
    }else if(j>0){
      const q=[...p];q[i]=(lines[j-1]+lines[j])/2;
      samples.push({q,axis:i,spacing:lines[j]-lines[j-1]});
    }
  }
  return samples;
}
function checkFeed(p,a,b,k,conductors,mesh,warn,getGrid){
  if(!conductors.length){warn("No supported conductive geometry found for lumped-port terminals; check the feed model.");return;}
  const nominal=mesh?.uniform_step_mm&&mesh.grid_mode==="uniform"?mesh.uniform_step_mm:mesh?.resolution_mm??mesh?.max_cell_mm??5;
  const length=Math.abs(a[k]-b[k]);
  for(const [name,end] of [["start",a],["stop",b]]){
    let best=Infinity,hit=null,sample=null;
    const points=endSamples(a,b,k,end);
    for(const q of points)for(const c of conductors){
      if(boundDistance(q,c.bounds)>Math.max(EPS,best))continue;
      const d=c.distance(q);
      if(d<best){best=d;hit=c;sample=q;}
    }
    if(!hit||best>EPS){
      warn("Lumped-port "+name+" terminal: no conductor contact detected"+(points.length===1&&Number.isFinite(best)?" (nearest "+hit.name+", "+Number(best.toPrecision(3))+" mm away)":" at sampled face points")+". Check for an unintended air gap; open or capacitively coupled feeds may be intentional.");
      continue;
    }
    // Even a penetrating terminal may be too narrow on the actual grid.
    // A closed curved surface can pass CAD contact but miss nearby Yee samples.
    if(points.length===1&&best < -EPS&&hit.curved){
      const grid=getGrid?.();
      if(grid){
        const nearby=transverseSamples(grid,sample,k);
        const missed=nearby.filter(({q})=>hit.distance(q)>EPS);
        if(missed.length){
          const spacing=Math.max(...missed.map(s=>s.spacing));
          warn("Lumped-port "+name+" terminal has shallow/narrow contact with "+hit.name+
            " ("+Number((-best).toPrecision(3))+" mm inside conductor). Nearby transverse half-cell samples lie outside the metal; mesh spacing up to "+
            Number(spacing.toPrecision(3))+" mm. Refine the feed and thin shell or use a finite contact pad. Geometric contact alone does not guarantee FDTD connectivity.");
        }
      }
    }
    // An ordinary planar boundary contact is valid. Flag a tangential
    // point contact on a curved/mesh surface, not every flush port endpoint.
    if(points.length===1&&best>=-EPS&&hit.curved){
      const other=[0,1,2].filter(i=>i!==k),delta=Math.max(1e-3,Math.min(.05,length/20));
      const neighbors=other.flatMap(i=>[-1,1].map(sign=>sample.map((v,j)=>v+(j===i?sign*delta:0))));
      if(neighbors.every(q=>hit.distance(q)>EPS)){
        warn("Lumped-port "+name+" terminal touches "+hit.name+" only at a point/tip; contact may disappear on the FDTD grid. Consider a finite contact face.");
        let spacing=nominal;
        if(mesh?.grid_mode!=="uniform"){
          if(mesh?.local_min_cell_mm>0&&Math.max(...hit.bounds[1].map((v,i)=>v-hit.bounds[0][i]))<=(mesh.auto_refine_max_span_mm??40))spacing=Math.min(spacing,mesh.local_min_cell_mm);
          for(const r of mesh?.refinements||[])if(r?.enabled!==false&&r.resolution_mm>0&&r.start?.every((v,i)=>sample[i]>=v&&sample[i]<=r.stop[i]))spacing=Math.min(spacing,r.resolution_mm);
        }
        if(spacing>Math.min(length/4,hit.feature?hit.feature/2:0.5))
          warn("Feed-tip mesh near "+hit.name+": requested local spacing "+Number(spacing.toPrecision(3))+" mm may be too coarse for the contact. Refine around the terminal and check convergence.");
      }
    }
  }
}

export function checkCase(cfg) {
  const out = [];
  const err = (where, msg, ref) => out.push({ level: "error", where, msg, ref });
  const warn = (where, msg, ref) => out.push({ level: "warn", where, msg, ref });
  const tryv = (fn, where, ref) => { try { return fn(); } catch (e) { err(where, e.message, ref); return null; } };

  if (cfg.schema_version !== 2) err("document", "schema_version must be 2");
  if (cfg.units !== "mm") err("document", "units must be \"mm\"");
  if (!cfg.name) err("document", "Simulation needs a nonempty name");

  // Excitation and outputs
  const ex = cfg.excitation || {};
  const f0 = ex.center_hz, fc = ex.bandwidth_hz;
  if (!(fin(f0) && f0 > 0)) err("excitation", "center_hz must be positive");
  if (!(fin(fc) && fc > 0)) err("excitation", "bandwidth_hz must be positive");
  else if (fin(f0) && !(f0 > fc)) err("excitation", "Excitation bandwidth must be < center frequency");
  const outputs = cfg.outputs || {};
  const s11 = outputs.s11 ?? cfg.s11;
  if (!Array.isArray(s11) || !s11.length) err("outputs", "At least one S11 sweep is required");
  else s11.forEach((s, i) => {
    if (!(fin(s.start) && fin(s.end) && fin(s.step) && s.step > 0 && s.start > 0 && s.end >= s.start)) {
      err("outputs", `S11 sweep ${i + 1}: start/end/step invalid`);
    } else {
      if ((s.end - s.start) / s.step + 1 > 20001) err("outputs", `S11 sweep ${i + 1} exceeds 20001 points`);
      if (fin(f0) && fin(fc) && (s.start < f0 - fc || s.end > f0 + fc)) {
        err("outputs", `S11 sweep ${i + 1} is outside the excitation band ${((f0 - fc) / 1e9).toFixed(3)}–${((f0 + fc) / 1e9).toFixed(3)} GHz`);
      }
    }
  });
  const pats = outputs.radiation_frequencies_hz ?? cfg.radiation_pattern_frequencies_hz ?? [];
  if (!Array.isArray(pats) || pats.length < 1 || pats.length > 12) err("outputs", "Must request 1..12 far-field frequencies");
  else if (fin(f0) && fin(fc) && pats.some(f => !(f >= f0 - fc && f <= f0 + fc))) {
    err("outputs", "Far-field frequencies outside excitation bandwidth");
  }

  // Domain
  const dom = cfg.domain || {};
  const ds = tryv(() => vec3(dom.start, "domain.start"), "domain");
  const de = tryv(() => vec3(dom.stop, "domain.stop"), "domain");
  if (ds && de && !ds.every((v, i) => de[i] > v)) err("domain", "Invalid simulation domain (stop must exceed start)");
  const boundary = dom.boundary ?? Array(6).fill("PML_8");
  if (!Array.isArray(boundary) || boundary.length !== 6) err("domain", "Require six boundary conditions");

  // Mesh
  const mesh = cfg.mesh;
  if (!mesh) err("mesh", "mesh section is required");
  else {
    const res = mesh.resolution_mm ?? mesh.max_cell_mm ?? 5;
    if (!(fin(res) && res > 0)) err("mesh", "mesh max_cell_mm must be positive");
    const gr = mesh.growth_ratio ?? 1.4;
    if (!(gr >= 1.01 && gr <= 2)) err("mesh", "mesh.growth_ratio must be 1.01..2");
    if (fin(f0) && fin(fc) && fin(res)) {
      const lambda = 299792458 / (f0 + fc) * 1000;
      // Free-space floor only; the per-material limit below is stricter
      // wherever a dielectric actually has geometry.
      if (res > lambda / 10) warn("mesh", `max_cell_mm ${res} > free-space λmin/10 (${(lambda / 10).toFixed(2)} mm)`);
    }
    for (const [i, r] of (mesh.refinements || []).entries()) {
      if(r?.enabled===false)continue;
      try {
        const a = vec3(r.start, "refinement.start"), b = vec3(r.stop, "refinement.stop");
        if (!a.every((v, k) => b[k] > v)) err("mesh", `refinement ${i + 1}: stop <= start`);
        if (!(r.resolution_mm > 0)) err("mesh", `refinement ${i + 1}: resolution_mm must be positive`);
      } catch (e) { err("mesh", `refinement ${i + 1}: ${e.message}`); }
    }
  }

  // Materials
  const mats = new Map();
  for (const m of cfg.materials || []) {
    if (mats.has(m.name)) err("materials", "Duplicate material " + m.name);
    mats.set(m.name, m);
    if (m.type === "dielectric") {
      if (!(m.epsilon >= 1)) err("materials", `${m.name}: relative permittivity must be >= 1`);
      if (m.kappa_s_per_m !== undefined && !(m.kappa_s_per_m >= 0)) err("materials", `${m.name}: dielectric conductivity invalid`);
    } else if (m.type === "conductive") {
      if (!(m.conductivity_s_per_m > 0)) err("materials", `${m.name}: conductivity must be positive`);
      warn("materials", `${m.name}: bulk conductors need the mesh to resolve skin depth; prefer PEC for ideal comparisons`);
    } else if (m.type === "conducting_sheet") {
      if (!(m.conductivity_s_per_m > 0)) err("materials", `${m.name}: sheet conductivity must be positive`);
      if (!(m.thickness_m > 0)) err("materials", `${m.name}: sheet thickness (metres) must be positive`);
      else if (m.thickness_m > 1e-3) warn("materials", `${m.name}: thickness_m is ${m.thickness_m} m — the unit is metres, not mm`);
    } else if (m.type !== "pec") err("materials", `${m.name}: unsupported material type ${JSON.stringify(m.type)}`);
  }

  // Geometry
  const geometry = cfg.geometry;
  if (!Array.isArray(geometry) || !geometry.some(g=>g?.enabled!==false)) err("geometry", "At least one enabled geometry object required");
  const conductors=[],parts=[];
  (geometry || []).forEach((g, i) => {
    if(g.enabled===false)return;
    const label = g.name || g.shape || `#${i + 1}`;
    const ref = { kind: "geometry", index: i };
    const m = mats.get(g.material);
    if (!m) err(label, "Undefined material " + JSON.stringify(g.material), ref);
    if (m?.type === "conducting_sheet") {
      if ((g.shape ?? g.type) !== "box") err(label, "Conducting sheets require 2D box geometry", ref);
      else if (Array.isArray(g.start) && Array.isArray(g.stop) &&
               g.start.filter((v, k) => v === g.stop[k]).length !== 1) {
        err(label, "Conducting sheet must have exactly one zero-thickness dimension", ref);
      }
    }
    if (g.priority !== undefined && !Number.isInteger(g.priority)) err(label, "priority must be an integer", ref);
    const bounds = tryv(() => solverBounds(g), label, ref);
    if (bounds && bounds.flat().some(v => !Number.isFinite(v))) err(label, "Non-finite geometry bounding box", ref);
    else if (bounds && ds && de && !(bounds[0].every((v, k) => v >= ds[k]) && bounds[1].every((v, k) => v <= de[k]))) {
      err(label, "Geometry must fit inside domain including thickness", ref);
    }
    if(bounds && bounds.flat().every(fin)) parts.push({ g, label, ref, bounds, material: m });
    if(bounds && bounds.flat().every(fin) && ["pec","conductive","conducting_sheet"].includes(m?.type)){
      try{
        const c=contactShape(g,bounds);
        if(c){
          conductors.push(c);
          if(c.mesh?.winding)warn(label,"Mesh has inconsistent face winding on shared edges; conductor contact and polyhedron simulation may be unreliable.",ref);
          if(c.mesh?.open)warn(label,"Mesh is not a closed two-manifold; verify the intended conducting volume.",ref);
        }
      }catch{/* existing geometry errors are reported above; contact is advisory */}
    }
  });
  // Clearance before PML thickness is an optimistic estimate; avoid claiming
  // actual absorber distance without a solved grid.
  if(ds&&de&&fin(f0)&&fin(fc)&&f0>fc&&conductors.length){
    const quarter=299792458000/(4*(f0-fc));
    let min=Infinity,side="";
    for(const c of conductors)for(let i=0;i<3;i++)for(let s=0;s<2;s++){
      if(!String(boundary?.[2*i+s]).startsWith("PML"))continue;
      const gap=s?de[i]-c.bounds[1][i]:c.bounds[0][i]-ds[i];
      if(gap<min){min=gap;side="XYZ"[i]+(s?"+":"−");}
    }
    if(min>=0&&min<quarter)warn("domain","Conductor-to-domain clearance at "+side+" is "+Number(min.toPrecision(3))+" mm before PML thickness, below λ/4 ("+Number(quarter.toPrecision(3))+" mm) at the excitation low edge. Check boundary convergence.");
  }

  // Mesh against the materials and the real feature sizes. Inside a dielectric
  // the wavelength is shorter by √εr (FR4: 2.1×), so the free-space λ/10 rule
  // alone accepts meshes that are far too coarse in a substrate.
  if (mesh && fin(f0) && fin(fc) && f0 + fc > 0) {
    const lambda0 = SPEED / (f0 + fc) * 1000;
    for (const part of parts) {
      const [lo, hi] = part.bounds;
      const spacing = localSpacing(mesh, lo, hi);
      const eps = part.material?.type === "dielectric" ? Number(part.material.epsilon) : 1;
      if (eps > 1) {
        const limit = lambda0 / Math.sqrt(eps) / 10;
        if (spacing > limit) {
          warn("mesh", `${part.label}: ${Number(spacing.toPrecision(3))} mm cells exceed λ/10 = ${limit.toFixed(2)} mm inside ` +
            `${part.material.name} (εr ${eps}) at ${((f0 + fc) / 1e9).toFixed(3)} GHz; the free-space limit (${(lambda0 / 10).toFixed(2)} mm) does not apply here.`, part.ref);
        }
        const thickness = Math.min(...hi.map((v, i) => v - lo[i]));
        if (thickness > 0 && thickness / spacing < 3) {
          warn("mesh", `${part.label}: ${Number(thickness.toPrecision(3))} mm of ${part.material.name} with ${Number(spacing.toPrecision(3))} mm cells is ` +
            `${(thickness / spacing).toFixed(1)} cells through the slab. Use at least 3 across a dielectric thickness.`, part.ref);
        }
      }
      // A wire thinner than its cell is simulated with a radius the mesh
      // chooses, which moves helix and loop impedance.
      const shape = part.g.shape ?? part.g.type;
      const diameter = Number(part.g.wire_diameter);
      if ((shape === "wire" || shape === "helix") && diameter > 0 && diameter < spacing) {
        warn("mesh", `${part.label}: wire Ø ${Number(diameter.toPrecision(3))} mm is thinner than the local cell ` +
          `(${Number(spacing.toPrecision(3))} mm), so the mesh sets the effective radius. Refine around the wire before trusting its impedance.`, part.ref);
      }
    }
  }

  // Uniform grid mode adds no lines for geometry or ports: CSXCAD snaps each
  // primitive to the nearest line, so anything off-grid moves by up to half a
  // cell, and a rod can end up a full step shorter or longer than specified.
  if (mesh && (mesh.grid_mode ?? "feature") === "uniform" && ds && de && de.every((v, i) => v > ds[i])) {
    const pitch = uniformPitch(mesh, ds, de);
    const offenders = [];
    for (const part of parts) {
      const slip = [0, 1, 2].map(i => Math.max(offGrid(part.bounds[0][i], ds[i], pitch[i]), offGrid(part.bounds[1][i], ds[i], pitch[i])));
      const k = slip.indexOf(Math.max(...slip));
      if (slip[k] > pitch[k] / 4) offenders.push({ part, axis: k, slip: slip[k] });
    }
    if (offenders.length) {
      // One aggregated warning: a scripted array puts every element off-grid,
      // and dozens of identical notes would bury the rest of the checks.
      offenders.sort((a, b) => b.slip / pitch[b.axis] - a.slip / pitch[a.axis]);
      const worst = offenders[0];
      const names = offenders.slice(0, 3).map(o => o.part.label).join(", ");
      warn("mesh", `${offenders.length} part(s) are off the uniform grid (${names}${offenders.length > 3 ? ` and ${offenders.length - 3} more` : ""}). ` +
        `Worst: ${worst.part.label}, ${Number(worst.slip.toPrecision(3))} mm off the ${Number(pitch[worst.axis].toPrecision(3))} mm ` +
        `${"XYZ"[worst.axis]} grid. Uniform mode adds no lines for geometry, so CSXCAD snaps each face by up to ` +
        `${Number((pitch[worst.axis] / 2).toPrecision(3))} mm and a length can change by a full cell. ` +
        "Align sizes and positions to the step, or use feature mode.", worst.part.ref);
    }
  }

  // Ports
  const ports = cfg.ports ?? cfg.sources ?? [];
  if (!ports.length) err("ports", "At least one port is required");
  // Lazily build exactly the same feature grid as the browser solver. Avoid
  // paying for mesh construction unless a narrow curved contact needs it.
  let attemptedGrid=false,feedGrid=null;
  const getFeedGrid=()=>{
    if(attemptedGrid)return feedGrid;
    attemptedGrid=true;
    try{
      if(!mesh||!ds||!de)return null;
      const g=(geometry||[]).filter(x=>x.enabled!==false).map(installGeometry);
      const bounds=ports.map(p=>{
        const ext=p.type==="coaxial"?Number(p.outer_radius??0):0;
        return [p.start.map((v,i)=>Math.min(v,p.stop[i])-ext),p.start.map((v,i)=>Math.max(v,p.stop[i])+ext)];
      });
      feedGrid=setupMesh(cfg,g.map(x=>[x.lo,x.hi]),bounds,g.map(x=>x.preview),ports,ds,de).grid;
    }catch{/* malformed inputs are covered by existing checks */}
    return feedGrid;
  };
  const active = ports.filter(p => p.excite ?? p.enabled ?? false);
  if (ports.length && active.length !== 1) err("ports", `Exactly one port must be excited per run (now ${active.length})`);
  const ids = ports.map(p => Math.trunc(Number(p.id ?? p.port_number ?? 1)));
  if (new Set(ids).size !== ids.length) err("ports", "Port IDs must be unique");
  ports.forEach((p, i) => {
    const label = "port " + (p.name || p.id || i + 1);
    const ref = { kind: "port", index: i };
    if (!(ids[i] >= 1)) err(label, "Port ID must be >= 1", ref);
    const a = tryv(() => vec3(p.start, "port.start"), label, ref);
    const b = tryv(() => vec3(p.stop, "port.stop"), label, ref);
    if (a && b && ds && de) {
      const lo = a.map((v, k) => Math.min(v, b[k])), hi = a.map((v, k) => Math.max(v, b[k]));
      if (!(lo.every((v, k) => v >= ds[k]) && hi.every((v, k) => v <= de[k]))) err(label, "Port must fit within domain", ref);
    }
    if (p.type === "lumped" || p.type === "lumped_port") {
      const d = p.direction ?? p.excitation_direction;
      if (!["x", "y", "z"].includes(d)) err(label, "Lumped port requires direction=x/y/z", ref);
      if (p.impedance_ohm !== undefined && !(p.impedance_ohm > 0)) err(label, "port impedance must be positive", ref);
      if (a && b && ["x", "y", "z"].includes(d)) {
        const k = "xyz".indexOf(d);
        if (a[k] === b[k]) err(label, `Lumped port has zero length along its direction ${d}`, ref);
        else {
          // In uniform mode the port's own end planes are not grid lines, so a
          // feed shorter than one cell can collapse or move off the gap it
          // bridges — and S11 is still produced, so nothing else catches it.
          if (mesh && (mesh.grid_mode ?? "feature") === "uniform" && ds && de && de.every((v, i) => v > ds[i])) {
            const pitch = uniformPitch(mesh, ds, de), length = Math.abs(a[k] - b[k]);
            if (length < pitch[k]) {
              err(label, `Port is ${Number(length.toPrecision(3))} mm along ${d}, shorter than the uniform cell ` +
                `(${Number(pitch[k].toPrecision(3))} mm): it can collapse or move to another cell edge. Lengthen the feed or refine the grid.`, ref);
            } else {
              const slip = Math.max(offGrid(a[k], ds[k], pitch[k]), offGrid(b[k], ds[k], pitch[k]));
              if (slip > pitch[k] / 4) {
                warn(label, `Port end planes are ${Number(slip.toPrecision(3))} mm off the uniform ` +
                  `${Number(pitch[k].toPrecision(3))} mm grid along ${d} and will be snapped; the excited gap may not be where it is specified.`, ref);
              }
            }
          }
          checkFeed(p,a,b,k,conductors,mesh,msg=>warn(label,msg,ref),getFeedGrid);
        }
      }
    } else if (p.type === "msl" || p.type === "coaxial") {
      const metal = mats.get(p.metal_material);
      if (!metal) err(label, "Unknown metal_material " + JSON.stringify(p.metal_material), ref);
      else if (metal.type !== "pec") err(label, "metal_material must be PEC", ref);
      if (p.type === "msl") {
        const pr = p.propagation_direction, ed = p.excitation_direction;
        if (!["x", "y", "z"].includes(pr) || !["x", "y", "z"].includes(ed) || pr === ed) {
          err(label, "MSL port propagation/excitation axes invalid", ref);
        }
      } else {
        if (p.dielectric_material && mats.get(p.dielectric_material)?.type !== "dielectric") {
          err(label, "Coax dielectric must be a dielectric material", ref);
        }
        if (!(p.inner_radius > 0 && p.inner_radius < p.outer_inner_radius && p.outer_inner_radius < p.outer_radius)) {
          err(label, "Coax radii must satisfy 0 < inner < outer_inner < outer", ref);
        }
        if (!["x", "y", "z"].includes(p.propagation_direction)) err(label, "Coax propagation direction must be x/y/z", ref);
      }
    } else err(label, "Unsupported port type " + JSON.stringify(p.type), ref);
  });

  const probes=cfg.probes??[];
  if(!Array.isArray(probes)||probes.length>32)err("diagnostics","Expected an array of at most 32 diagnostic objects");
  else {
    const names=new Set();
    for(const [i,p] of probes.entries()){
      if(p?.enabled===false)continue;
      const ref={kind:"diagnostic",index:i},label="diagnostic "+(p?.name??(i+1));
      if(!p||typeof p.name!=="string"||!p.name.trim()||p.name.length>120||names.has(p.name)){err(label,"Use unique nonempty names (max 120 characters)",ref);continue;}
      names.add(p.name);
      const a=tryv(()=>vec3(p.start,"start"),label,ref),b=tryv(()=>vec3(p.stop,"stop"),label,ref);
      const expected={voltage:1,current:2,electric_field:0,magnetic_field:0};
      if(a&&b){
        if(a.some((v,k)=>v>b[k]))err(label,"start must be <= stop",ref);
        const axes=a.map((v,k)=>b[k]>v+1e-9?k:-1).filter(k=>k>=0),dim=axes.length;
        if(p.type==="current"&&dim!==2)err(label,"Current probe must be a zero-thickness plane. Edit the probe, choose the normal and flatten it; the two tangent dimensions must be nonzero.",ref);
        else if(p.type!=="current"&&(p.type==="field_dump"?dim<2:expected[p.type]!==dim))err(label,"Invalid measurement geometry: voltage=line, E/H=point, dump=plane or volume",ref);
        if(p.type==="voltage"||p.type==="current"){
          const k=p.type==="voltage"?axes[0]:[0,1,2].find(x=>!axes.includes(x)),axis="xyz"[k];
          if(p.direction!==undefined&&![axis,"-"+axis].includes(p.direction))err(label,"Direction must follow the local measurement axis",ref);
        }
        const rot=tryv(()=>vec3(p.transform?.rotate_deg??[0,0,0],"rotation"),label,ref);
        if(rot&&rot.some(x=>Math.abs(x/90-Math.round(x/90))>1e-9))err(label,"Diagnostic boxes support rotations in 90° steps only",ref);
        const points=tryv(()=>{const tf=transformer(p);return Array.from({length:8},(_,j)=>tf([j&1?b[0]:a[0],j&2?b[1]:a[1],j&4?b[2]:a[2]]));},label,ref);
        if(points&&ds&&de&&points.some(q=>q.some((x,k)=>x<ds[k]-1e-9||x>de[k]+1e-9)))err(label,"Measurement outside simulation domain",ref);
      }
      const td=p.time_domain?.enabled??true,fd=p.frequency_domain?.enabled??!!p.frequencies_hz?.length;
      const fs=fd?(p.frequency_domain?.frequencies_hz??p.frequencies_hz??[]):[];
      if(!Array.isArray(fs)||fs.length>12||fs.some(f=>!fin(f)||f<=0||(fin(f0)&&fin(fc)&&(f<f0-fc||f>f0+fc))))err(label,"Invalid diagnostic frequencies (max 12, within excitation band)",ref);
      else if(!td&&!fs.length)err(label,"Enable time capture or specify diagnostic frequencies",ref);
      const os=p.time_domain?.oversampling;
      if(os!==undefined&&(!Number.isInteger(os)||os<1||os>100))err(label,"Time oversampling must be 1–100",ref);
      if(p.type==="field_dump"){
        const sub=p.sub_sampling??[2,2,2];
        if(!["E","H","J","J_total","D","B"].includes(p.field??"E"))err(label,"Unknown field quantity",ref);
        if(!Array.isArray(sub)||sub.length!==3||sub.some(x=>!Number.isInteger(x)||x<1||x>100))err(label,"Subsampling must be three integers from 1 to 100",ref);
        if(td)warn(label,"Recorded field dumps may use significant disk space; increase subsampling for large regions",ref);
      }
    }
  }
  const res = cfg.solver?.resources;
  if (res && (!(res.cpus > 0) || !(res.memory_gib > 0))) warn("solver", "solver.resources needs positive cpus and memory_gib");
  return out;
}
