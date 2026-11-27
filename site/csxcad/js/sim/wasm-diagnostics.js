// WASM diagnostic capture, with the same result contract as antennas/v2_diagnostics.py.
import { transformer } from "../geometry.js";
export const FIELDS={E:[0,"V/m"],H:[1,"A/m"],J:[2,"A/m²"],J_total:[3,"A/m²"],D:[4,"C/m²"],B:[5,"T"]};
const TYPES={voltage:[0,"V",1],current:[1,"A",1],electric_field:[2,"V/m",3],magnetic_field:[3,"A/m",3]};
const MAX_POINTS=4096,MAX_FLOATS=4_000_000;
const req=(ok,msg)=>{if(!ok)throw Error(msg);};
const vec=(a)=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
export function prepareDiagnostics(config,ds,de){
  const probes=config.probes??[],out=[],names=new Set();
  req(Array.isArray(probes)&&probes.length<=32,"probes must be an array of at most 32 objects");
  for(const [i,p] of probes.entries()){
    req(p&&typeof p==="object","Invalid diagnostic object");
    if(p.enabled===false)continue;
    const {name,type,start:a,stop:b}=p;
    req(typeof name==="string"&&name.trim()&&name.length<=120&&!names.has(name),"Diagnostic names must be unique nonempty strings");
    names.add(name);
    req(vec(a)&&vec(b)&&a.every((v,k)=>v<=b[k]),name+": invalid start/stop");
    const rot=p.transform?.rotate_deg??[0,0,0];
    req(vec(rot)&&rot.every(x=>Math.abs(x/90-Math.round(x/90))<=1e-9),name+": only 90-degree rotations");
    const tf=transformer(p),corners=Array.from({length:8},(_,j)=>tf([j&1?b[0]:a[0],j&2?b[1]:a[1],j&4?b[2]:a[2]]));
    const lo=[0,1,2].map(k=>Math.min(...corners.map(v=>v[k]))),hi=[0,1,2].map(k=>Math.max(...corners.map(v=>v[k])));
    for(let k=0;k<3;k++)if(Math.abs(hi[k]-lo[k])<=1e-9)hi[k]=lo[k];
    req(lo.every((v,k)=>v>=ds[k]-1e-9&&hi[k]<=de[k]+1e-9),name+": probe outside simulation domain");
    const nz=[0,1,2].filter(k=>hi[k]-lo[k]>1e-9),local=[0,1,2].filter(k=>b[k]-a[k]>1e-9);
    let axis=null,sign=1;
    if(type==="current"||type==="voltage"){
      req(nz.length===(type==="current"?2:1),name+": invalid current/voltage measurement geometry");
      axis=type==="current"?[0,1,2].find(k=>!nz.includes(k)):nz[0];
      const k=type==="current"?[0,1,2].find(k=>!local.includes(k)):local[0],dir=p.direction??"xyz"[k];
      req([ "xyz"[k],"-"+"xyz"[k]].includes(dir),name+": direction must follow local probe axis");
      const v=[0,0,0];v[k]=1;
      sign=Math.sign(tf(v)[axis]-tf([0,0,0])[axis])*(dir.startsWith("-")?-1:1);
    }else if(type==="electric_field"||type==="magnetic_field")req(nz.length===0,name+": field probe requires a point");
    else if(type==="field_dump")req(nz.length>=2&&Object.hasOwn(FIELDS,p.field??"E"),name+": invalid field dump");
    else throw Error(name+": unknown diagnostic type");
    const sub=p.sub_sampling??[2,2,2],td=p.time_domain?.enabled??true,fd=p.frequency_domain??{};
    const fs=(fd.enabled??!!p.frequencies_hz?.length)?(fd.frequencies_hz??p.frequencies_hz??[]):[];
    const f0=config.excitation?.center_hz,fc=config.excitation?.bandwidth_hz;
    req(Array.isArray(sub)&&sub.length===3&&sub.every(x=>Number.isInteger(x)&&x>=1&&x<=100),name+": invalid subsampling");
    req(Array.isArray(fs)&&fs.length<=12&&fs.every(f=>Number.isFinite(f)&&f>0&&(f0==null||fc==null||(f>=f0-fc&&f<=f0+fc))),name+": invalid diagnostic frequencies");
    req(td||fs.length,name+": enable time or frequency capture");
    const mode=p.dump_mode??"node",oversampling=p.time_domain?.oversampling;
    req(["node","cell"].includes(mode),name+": invalid interpolation");
    req(oversampling==null||(Number.isInteger(oversampling)&&oversampling>=1&&oversampling<=100),name+": invalid oversampling");
    out.push({id:"diag_"+String(i).padStart(3,"0"),name,type,start:lo,stop:hi,axis,sign,field:p.field??"E",
      td:!!td,fs,sub,dump_mode:mode==="node"?1:2,oversampling});
  }
  return out;
}
export function diagnosticXML(objects,startID){
  let id=startID;const props=[];
  for(const p of objects){
    const point=(tag,a)=>"<"+tag+" "+["X","Y","Z"].map((k,i)=>k+'="'+a[i]+'"').join(" ")+" />";
    const box='<Primitives><Box Priority="0">'+point("P1",p.start)+point("P2",p.stop)+"</Box></Primitives>";
    const samples=p.fs.length?"<FD_Samples>"+p.fs.join(",")+"</FD_Samples>":"";
    const common=(name,type,axis,os)=>'ID="'+id+++'" Name="'+name+'" Number="0" Type="'+type+'" Weight="1" NormDir="'+axis+'"'+(os==null?"":' OverSampling="'+os+'"');
    if(p.type==="field_dump"){
      for(const mode of ["td","fd"]){
        if(mode==="td"?!p.td:!p.fs.length)continue;
        const attrs=common(p.id+"_"+mode,0,-1,mode==="td"?p.oversampling:null);
        props.push('<DumpBox '+attrs+' DumpType="'+(FIELDS[p.field][0]+(mode==="fd"?10:0))+'" DumpMode="'+p.dump_mode+'" FileType="1" MultiGridLevel="0" SubSampling="'+p.sub.join(",")+'">'+box+(mode==="fd"?samples:"")+"</DumpBox>");
      }
    }else props.push("<ProbeBox "+common(p.id,TYPES[p.type][0],p.type==="current"?p.axis:-1,p.oversampling)+">"+box+samples+"</ProbeBox>");
  }
  return {props,nextID:id};
}
function table(text,cols){
  const rows=[],coords={};
  for(const line of text.split("\n")){
    const s=line.trim();if(!s)continue;
    if(s[0]==="%"){
      const m=/(start|stop)-coordinates:\s*\(([^)]*)\)\s*m/.exec(s);
      if(m){const a=m[2].split(",").map(x=>Number(x)*1000);if(vec(a))coords["sample_"+m[1]]=a;}
      continue;
    }
    const row=s.split(/\s+/).map(Number);
    req(row.length===cols&&row.every(Number.isFinite),"Unexpected diagnostic probe columns");
    rows.push(row);
  }
  req(rows.length,"No diagnostic probe samples");
  return {rows,coords};
}
export async function readProbe(ems,p,budget){
  const [_,unit,n]=TYPES[p.type],out={unit,components:n};let used=0;
  if(p.td){
    const {rows,coords}=table(await ems.readFile(p.id,"utf8"),1+n);
    used+=rows.length*(1+n);req(used<=budget,"Probe sample limit exceeded");
    req(rows.every((r,i)=>!i||r[0]>rows[i-1][0]),"Non-increasing probe timestamps");
    Object.assign(out,coords,{time_s:rows.map(r=>r[0]),values:rows.map(r=>r.slice(1).map(v=>v*p.sign))});
  }
  if(p.fs.length){
    const {rows}=table(await ems.readFile(p.id+"_FD","utf8"),1+2*n);
    used+=rows.length*(1+2*n);req(used<=budget,"Probe sample limit exceeded");
    Object.assign(out,{frequency_hz:rows.map(r=>r[0]),real:rows.map(r=>Array.from({length:n},(_,j)=>r[1+2*j]*p.sign)),imag:rows.map(r=>Array.from({length:n},(_,j)=>r[2+2*j]*p.sign))});
  }
  return {record:out,used};
}
function pack(array){
  const bytes=new Uint8Array(array.length*4),view=new DataView(bytes.buffer);
  for(let i=0;i<array.length;i++){view.setFloat32(i*4,array[i],true);req(Number.isFinite(view.getFloat32(i*4,true)),"Nonfinite diagnostic samples");}
  // 24 KiB chunks are divisible by three, so concatenating base64 is safe.
  let s="";for(let i=0;i<bytes.length;i+=24576)s+=btoa(String.fromCharCode(...bytes.subarray(i,i+24576)));
  return s;
}
export function flattenField(dataset,shape,legacy,part=0){
  const [nx,ny,nz]=shape,n=nx*ny*nz,expected=[3,...(legacy?[nz,ny,nx]:shape)],out=new Float32Array(n*3);
  req(dataset.dims.length===4&&expected.every((v,k)=>v===dataset.dims[k]),"Unexpected HDF5 field shape: "+dataset.dims);
  req(dataset.data.length===n*3*(dataset.complex?2:1),"Truncated field dataset");
  for(let x=0;x<nx;x++)for(let y=0;y<ny;y++)for(let z=0;z<nz;z++){
    const dst=(x*ny+y)*nz+z,src=legacy?(z*ny+y)*nx+x:dst;
    for(let c=0;c<3;c++)out[dst*3+c]=dataset.data[(c*n+src)*(dataset.complex?2:1)+part];
  }
  return out;
}
export async function readDump(ems,file,mode,budget){
  const list=await ems.h5List(file),paths=new Set(list.map(d=>d.path));
  const axes=[];
  for(const k of "xyz")axes.push(Array.from((await ems.h5Read(file,"/Mesh/"+k)).data,x=>x*1000));
  const shape=axes.map(a=>a.length),n=shape.reduce((a,b)=>a*b,1);
  req(n>0&&n<=MAX_POINTS,"Field dump exceeds 4096 spatial samples; increase subsampling");
  req(axes.every(a=>a.every(Number.isFinite)),"Invalid mesh coordinates");
  const attr=(path,name)=>ems.h5Attr(file,path,name);
  const version=(await attr("/","openEMS_HDF5_version"))?.[0]??0.2;
  const legacy=version<=0.2||!!(await attr("/","legacy_fmt"))?.[0];
  const group="/FieldData/"+mode.toUpperCase(),prefix=group+"/";
  const keys=list.map(d=>d.path).filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length))
    .filter(k=>mode==="td"?/^\d+$/.test(k):/^f\d+(?:_real)?$/.test(k))
    .sort((a,b)=>mode==="td"?Number(a)-Number(b):parseInt(a.slice(1))-parseInt(b.slice(1)));
  req(keys.length,"No "+mode+" field samples");
  const width=n*3,used=keys.length*width*(mode==="fd"?2:1);
  req(used<=budget,"Field capture exceeds transfer budget; increase spatial subsampling or shorten simulation");
  const re=new Float32Array(keys.length*width),im=mode==="fd"?new Float32Array(re.length):null,axis=[];
  let peak=0;
  const groupFreq=mode==="fd"?await attr(group,"frequency"):null;
  for(const [k,key] of keys.entries()){
    const path=prefix+key,d=await ems.h5Read(file,path);
    const r=flattenField(d,shape,legacy);
    re.set(r,k*width);
    let iv=null;
    if(mode==="fd"){
      if(d.complex)iv=flattenField(d,shape,legacy,1);
      else {const ip=path.replace(/_real$/,"_imag");req(ip!==path&&paths.has(ip),"Missing complex field component");iv=flattenField(await ems.h5Read(file,ip),shape,legacy);}
      im.set(iv,k*width);
      axis.push((await attr(path,"frequency"))?.[0]??groupFreq?.[parseInt(key.slice(1))]);
    }else axis.push((await attr(path,"time"))?.[0]);
    for(let j=0;j<width;j+=3)peak=Math.max(peak,Math.hypot(r[j],r[j+1],r[j+2],...(iv?[iv[j],iv[j+1],iv[j+2]]:[])));
  }
  req(axis.every(Number.isFinite),"Missing field sample time/frequency metadata");
  if(mode==="td")req(axis.every((v,i)=>!i||v>axis[i-1]),"Non-increasing field timestamps");
  req(Number.isFinite(peak),"Nonfinite field peak");
  return {used,record:mode==="td"?{axes_mm:axes,time_s:axis,frames_f32:pack(re),peak}:{axes_mm:axes,frequency_hz:axis,real_f32:pack(re),imag_f32:pack(im),peak}};
}
export async function collectDiagnostics(ems,objects){
  let budget=MAX_FLOATS;const records=[];
  for(const p of objects){
    const {id,name,type,start,stop,axis,sign,field}=p,r={id,name,type,start,stop,axis,sign,field},errors=[];
    if(type==="field_dump"){
      r.unit=FIELDS[field][1];
      for(const mode of ["td","fd"]){
        if(mode==="td"?!p.td:!p.fs.length)continue;
        try{const {record,used}=await readDump(ems,id+"_"+mode+".h5",mode,budget);r[mode]=record;budget-=used;}
        catch(e){errors.push(mode+": "+e.message);}
      }
    }else{
      try{const {record,used}=await readProbe(ems,p,budget);Object.assign(r,record);budget-=used;}
      catch(e){errors.push(e.message);}
    }
    if(errors.length)r.warning=errors.join("; ");
    records.push(r);
  }
  return records;
}
