// Pure mesh-overlay geometry: actual rectilinear solver grid, in millimetres.
export const planeAxes={XY:[0,1,2],XZ:[0,2,1],YZ:[1,2,0]};
export function validMeshLines(lines){
  return Array.isArray(lines)&&lines.length===3&&lines.every(a=>Array.isArray(a)&&a.length>=2&&a.every((v,i)=>Number.isFinite(v)&&(!i||v>a[i-1])));
}
export function meshMinima(lines){
  if(!validMeshLines(lines))throw Error("Invalid mesh grid");
  return lines.map((a,axis)=>{
    let index=0;
    for(let i=1;i<a.length-1;i++)if(a[i+1]-a[i]<a[index+1]-a[index])index=i;
    return {axis,index,min:a[index+1]-a[index],start:a[index],stop:a[index+1]};
  });
}
export function nearestLine(a,position){
  let lo=0,hi=a.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(a[mid]<position)lo=mid+1;else hi=mid;}
  return lo>0&&Math.abs(a[lo-1]-position)<=Math.abs(a[lo]-position)?lo-1:lo;
}
function sampled(a,limit,extra=[]){
  if(a.length<=limit)return a;
  const s=new Set([0,a.length-1,...extra]);
  const stride=Math.ceil((a.length-1)/(limit-1));
  for(let i=0;i<a.length;i+=stride)s.add(i);
  return [...s].filter(i=>i>=0&&i<a.length).sort((x,y)=>x-y).map(i=>a[i]);
}
export function meshSegments(lines,{plane="XZ",index,highlight=true,pml=false,boundary=[],max3D=24}={}){
  if(!validMeshLines(lines))throw Error("Invalid mesh grid");
  const minima=meshMinima(lines),start=lines.map(a=>a[0]),stop=lines.map(a=>a.at(-1));
  const regular=[],smallest=[],absorbing=[];
  const segment=(target,axis,at)=>{const a=[...at],b=[...at];a[axis]=start[axis];b[axis]=stop[axis];target.push(...a,...b);};
  const boundaryIndex=(axis,side)=>{
    const m=/^PML_(\d+)$/.exec(boundary[axis*2+side]??"");
    if(!m)return null;
    const n=Math.min(lines[axis].length-1,Number(m[1]));
    return side?lines[axis].length-1-n:n;
  };
  const cuts=lines.map((_,k)=>[boundaryIndex(k,0),boundaryIndex(k,1)].filter(i=>i!==null));
  const isPml=(axis,v)=>pml&&cuts[axis].some(i=>v===lines[axis][i]);
  const isMin=(axis,v)=>highlight&&(v===minima[axis].start||v===minima[axis].stop);
  const target=(axis,v)=>isMin(axis,v)?smallest:isPml(axis,v)?absorbing:regular;
  if(plane==="3D"){
    const coords=lines.map((a,k)=>sampled(a,Math.max(2,Math.min(40,max3D)),[...cuts[k],minima[k].index,minima[k].index+1]));
    for(let axis=0;axis<3;axis++){
      const [u,v]=[0,1,2].filter(k=>k!==axis);
      for(const x of coords[u])for(const y of coords[v]){
        const at=[0,0,0];at[u]=x;at[v]=y;
        // Highlight the limiting pair as boundary-edge lines rather than flooding the volume red.
        const edge=(x===start[u]||x===stop[u]||y===start[v]||y===stop[v]);
        segment(edge&&(isMin(u,x)||isMin(v,y))?smallest:edge&&(isPml(u,x)||isPml(v,y))?absorbing:regular,axis,at);
      }
    }
    return {regular,smallest,absorbing,minima,decimated:coords.some((a,k)=>a.length<lines[k].length)};
  }
  const axes=planeAxes[plane];if(!axes)throw Error("Unknown mesh plane");
  const [u,v,n]=axes;
  const idx=Math.max(0,Math.min(lines[n].length-1,Number.isInteger(index)?index:nearestLine(lines[n],0)));
  const at=[0,0,0];at[n]=lines[n][idx];
  for(const x of lines[u]){at[u]=x;segment(target(u,x),v,at);}
  for(const y of lines[v]){at[v]=y;segment(target(v,y),u,at);}
  return {regular,smallest,absorbing,minima,index:idx,position:at[n],decimated:false};
}
