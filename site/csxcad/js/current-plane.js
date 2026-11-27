// Editing helpers for passive current integration planes.
// Keep the existing schema (start/stop and local direction) for both solvers.
const axes="xyz";
const same=(a,b)=>a!==undefined&&b!==undefined&&JSON.stringify(a)===JSON.stringify(b);
const validDirection=d=>typeof d==="string"&&/^-?[xyz]$/.test(d);
const axis=d=>axes.indexOf(d.replace("-",""));
const expr=v=>{
  if(typeof v==="number"&&Number.isFinite(v))return String(v);
  if(v&&typeof v.$param==="string")return v.$param;
  if(v&&typeof v.$expr==="string")return "("+v.$expr+")";
  throw Error("Invalid coordinate expression");
};
export function currentDirection(p){
  if(validDirection(p.direction))return p.direction;
  const flat=[0,1,2].filter(k=>same(p.start?.[k],p.stop?.[k]));
  return flat.length===1?axes[flat[0]]:"z";
}
export function currentPlaneAxis(p){return axis(currentDirection(p));}
export function currentPlaneLinked(p){const k=currentPlaneAxis(p);return same(p.start?.[k],p.stop?.[k]);}
export function setCurrentPosition(p,value){
  const k=currentPlaneAxis(p);
  p.start[k]=structuredClone(value);
  p.stop[k]=structuredClone(value);
}
export function setCurrentDirection(p,direction){
  if(!validDirection(direction))throw Error("Choose a current plane normal");
  if(!Array.isArray(p.start)||p.start.length!==3||!Array.isArray(p.stop)||p.stop.length!==3)throw Error("Current probe requires start and stop XYZ");
  const old=currentPlaneAxis(p),next=axis(direction);
  // Rotate the rectangle about its start corner when switching normal axes.
  // The old normal becomes a tangent axis with the previous tangent span.
  if(old!==next&&currentPlaneLinked(p)){
    const a=p.start[old],b=p.start[next],c=p.stop[next];
    p.stop[old]=[a,b,c].every(v=>typeof v==="number")?a+c-b:{$expr:expr(a)+"+("+expr(c)+"-"+expr(b)+")"};
  }
  // Repair imported cubes explicitly at their existing start coordinate.
  p.direction=direction;
  setCurrentPosition(p,p.start[next]);
}
export function moveCurrentCorner(p,corner,position,editable){
  const k=currentPlaneAxis(p),other=corner==="start"?"stop":"start";
  for(let j=0;j<3;j++){
    if(!editable[j]||!Number.isFinite(position[j]))continue;
    const v=+position[j].toFixed(6);
    if(j===k){
      if(typeof p.start[j]==="number"&&typeof p.stop[j]==="number")setCurrentPosition(p,v);
    }else{
      const bound=p[other][j];
      if(typeof bound==="number"&&(corner==="start"?v>=bound:v<=bound))continue;
      p[corner][j]=v;
    }
  }
}
