// Result playback shared by probe graphs and spatial overlays.
export function diagnosticVector(record, row) {
  if (record.components === 3) return row;
  const v=[0,0,0]; v[record.axis]=row[0]; return v;
}
export function sampleTime(times, values, t) {
  if (!times?.length || !values?.length || t<times[0] || t>times[times.length-1]) return null;
  let lo=0,hi=times.length-1;
  while(hi-lo>1){const mid=(hi+lo)>>1;if(times[mid]<=t)lo=mid;else hi=mid;}
  const a=values[lo],b=values[hi],w=hi===lo?0:(t-times[lo])/(times[hi]-times[lo]||1);
  return a.map((v,i)=>v+(b[i]-v)*w);
}
export function nearestTime(times,t) {
  let lo=0,hi=times.length-1;
  while(hi-lo>1){const mid=(hi+lo)>>1;if(times[mid]<=t)lo=mid;else hi=mid;}
  return Math.abs(times[lo]-t)<=Math.abs(times[hi]-t)?lo:hi;
}
const cache=new WeakMap();
function decode64(s) {
  const bytes=Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const data=new DataView(bytes.buffer), out=new Float32Array(bytes.length/4);
  for(let i=0;i<out.length;i++)out[i]=data.getFloat32(i*4,true);
  return out;
}
function fieldData(d) {
  if(cache.has(d))return cache.get(d);
  const points=[];
  for(const x of d.axes_mm[0])for(const y of d.axes_mm[1])for(const z of d.axes_mm[2])points.push([x,y,z]);
  const out={points,td:d.frames_f32?decode64(d.frames_f32):null,
    re:d.real_f32?decode64(d.real_f32):null,im:d.imag_f32?decode64(d.imag_f32):null};
  cache.set(d,out);return out;
}
function center(r){const a=r.sample_start??r.start,b=r.sample_stop??r.stop;return a.map((v,i)=>(v+b[i])/2);}
function peak(r){
  if(cache.has(r))return cache.get(r);
  let max=0;
  for(const v of r.values??[])max=Math.max(max,Math.hypot(...v));
  for(let i=0;i<(r.real?.length??0);i++)max=Math.max(max,Math.sqrt(r.real[i].reduce((n,v,j)=>n+v*v+r.imag[i][j]**2,0)));
  cache.set(r,max);return max;
}
export function diagnosticFrame(records,{mode="td",time=0,frequency=0,phase=0,visible=null,scale=1,density=1}={}) {
  const arrows=[];
  const ph=phase*Math.PI/180;
  for(const r of records){
    if(visible&&!visible.has(r.id))continue;
    const color=r.type==="current"?"#39a9ff":r.type==="voltage"?"#4dd49b":r.field==="H"||r.type==="magnetic_field"?"#f9a23f":"#c28aff";
    if(r.type==="field_dump"){
      const d=r[mode];if(!d)continue;
      if(mode==="td"&&(time<d.time_s[0]||time>d.time_s.at(-1)))continue;
      const f=fieldData(d), n=f.points.length;
      const k=mode==="td"?nearestTime(d.time_s,time):d.frequency_hz.indexOf(frequency);
      if(k<0)continue;
      for(let i=0;i<n;i+=density){
        const j=(k*n+i)*3;
        const v=[0,1,2].map(q=>mode==="td"?f.td[j+q]:f.re[j+q]*Math.cos(ph)-f.im[j+q]*Math.sin(ph));
        arrows.push({position:f.points[i],vector:v.map(x=>x/(d.peak||1)*scale),color});
      }
    }else{
      let row;
      if(mode==="td")row=sampleTime(r.time_s,r.values,time);
      else {const k=r.frequency_hz?.indexOf(frequency)??-1;if(k>=0)row=r.real[k].map((v,j)=>v*Math.cos(ph)-r.imag[k][j]*Math.sin(ph));}
      if(!row)continue;
      const v=diagnosticVector(r,row), val=r.components===1?row[0]:Math.hypot(...row);
      arrows.push({position:center(r),vector:v.map(x=>x/(peak(r)||1)*scale),color,
        label:r.name+" · "+val.toPrecision(4)+" "+r.unit});
    }
  }
  return arrows;
}
