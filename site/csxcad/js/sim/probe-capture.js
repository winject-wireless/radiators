// Passive schema-v2 diagnostic objects for both the WASM XML builder and result extraction.
import { transformer } from "../geometry.js";

const fields={E:[0,"V/m"],H:[1,"A/m"],J:[2,"A/m²"],J_total:[3,"A/m²"],D:[4,"C/m²"],B:[5,"T"]};
const scalar={voltage:[0,"V",1],current:[1,"A",1],electric_field:[2,"V/m",3],magnetic_field:[3,"A/m",3]};
const require=(x,m)=>{if(!x)throw Error(m);};
const finite3=a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
export function prepareDiagnostics(config,ds,de){
  const probes=config.probes??[],names=new Set(),out=[];
  require(Array.isArray(probes)&&probes.length<=32,"Expected at most 32 diagnostic objects");
  for(const [i,p] of probes.entries()){
    require(p&&typeof p==="object","Invalid diagnostic object");
    if(p.enabled===false)continue;
    const name=p.name, fail=m=>name+": "+m;
    require(typeof name==="string"&&name.trim()&&name.length<=120&&!names.has(name),"Diagnostic names must be unique and nonempty");
    names.add(name);
    const a=p.start,b=p.stop,kind=p.type;
    require(finite3(a)&&finite3(b)&&a.every((x,k)=>x<=b[k]),fail("Invalid start/stop"));
    const rot=p.transform?.rotate_deg??[0,0,0];
    require(finite3(rot)&&rot.every(x=>Math.abs(x/90-Math.round(x/90))<1e-9),fail("Only 90° rotations supported"));
    const tf=transformer(p),corners=Array.from({length:8},(_,j)=>tf([j&1?b[0]:a[0],j&2?b[1]:a[1],j&4?b[2]:a[2]]));
    const start=[0,1,2].map(k=>Math.min(...corners.map(c=>c[k]))),stop=[0,1,2].map(k=>Math.max(...corners.map(c=>c[k])));
    for(let k=0;k<3;k++){if(Math.abs(stop[k]-start[k])<1e-9)stop[k]=start[k];require(start[k]>=ds[k]-1e-9&&stop[k]<=de[k]+1e-9,fail("Outside domain"));}
    const local=[0,1,2].filter(k=>b[k]-a[k]>1e-9),world=[0,1,2].filter(k=>stop[k]-start[k]>1e-9);
    const dimension={voltage:1,current:2,electric_field:0,magnetic_field:0};
    require(kind==="field_dump"?world.length>=2:dimension[kind]===world.length,fail("Invalid measurement dimension"));
    let axis=null,sign=1;
    if(kind==="voltage"||kind==="current"){
      const k=kind==="voltage"?local[0]:[0,1,2].find(k=>!local.includes(k));
      axis=kind==="voltage"?world[0]:[0,1,2].find(k=>!world.includes(k));
      const direction=p.direction??"xyz"[k];
      require(["xyz"[k],"-"+"xyz"[k]].includes(direction),fail("Invalid local direction"));
      const e=[0,0,0];e[k]=1;
      sign=Math.sign(tf(e)[axis]-tf([0,0,0])[axis])*(direction.startsWith("-")?-1:1);
    }
    const td=p.time_domain?.enabled??true,fd=p.frequency_domain?.enabled??!!p.frequencies_hz?.length;
    const fs=fd?(p.frequency_domain?.frequencies_hz??p.frequencies_hz??[]):[];
    const {center_hz:f0,bandwidth_hz:fc}=config.excitation??{};
    require(Array.isArray(fs)&&fs.length<=12&&fs.every(f=>Number.isFinite(f)&&f>0&&(!Number.isFinite(f0)||!Number.isFinite(fc)||f>=f0-fc&&f<=f0+fc)),fail("Invalid diagnostic frequencies"));
    require(td||fs.length,fail("Enable time or frequency capture"));
    const sub=p.sub_sampling??[2,2,2],over=p.time_domain?.oversampling,dump=p.dump_mode??"node",field=p.field??"E";
    require(Array.isArray(sub)&&sub.length===3&&sub.every(x=>Number.isInteger(x)&&x>=1&&x<=100),fail("Invalid spatial subsampling"));
    require(over===undefined||Number.isInteger(over)&&over>=1&&over<=100,fail("Invalid oversampling"));
    require(["node","cell"].includes(dump),fail("Invalid dump interpolation"));
    require(kind!=="field_dump"||Object.hasOwn(fields,field),fail("Unknown field"));
    out.push({id:"diag_"+String(i).padStart(3,"0"),name,type:kind,start,stop,axis,sign,field,td:!!td,fs,sub,over,dumpMode:dump==="node"?1:2});
  }
  return out;
}
export function diagnosticXML(objects,firstId){
  let id=firstId;const properties=[];
  const pt=(tag,p)=>"<"+tag+" "+p.map((v,i)=>"XYZ"[i]+'="'+v+'"').join(" ")+" />";
  for(const p of objects){
    const box='<Primitives><Box Priority="0">'+pt("P1",p.start)+pt("P2",p.stop)+'</Box></Primitives>';
    const os=p.over===undefined?"":' OverSampling="'+p.over+'"';
    const frequency=p.fs.length?"<FD_Samples>"+p.fs.join(",")+"</FD_Samples>":"";
    if(p.type==="field_dump"){
      for(const mode of ["td","fd"]){
        if(mode==="td"?!p.td:!p.fs.length)continue;
        properties.push('<DumpBox ID="'+id+++'" Name="'+p.id+'_'+mode+'" Number="0" Type="0" Weight="1" NormDir="-1" DumpType="'+(fields[p.field][0]+(mode==="fd"?10:0))+'" DumpMode="'+p.dumpMode+'" FileType="1" MultiGridLevel="0" SubSampling="'+p.sub.join(",")+'"'+(mode==="td"?os:"")+'>'+box+(mode==="fd"?frequency:"")+'</DumpBox>');
      }
    }else{
      properties.push('<ProbeBox ID="'+id+++'" Name="'+p.id+'" Number="0" Type="'+scalar[p.type][0]+'" Weight="1" NormDir="'+(p.type==="current"?p.axis:-1)+'"'+os+'>'+box+frequency+'</ProbeBox>');
    }
  }
  return {properties,nextId:id};
}
const LIMIT=4_000_000,POINT_LIMIT=4096;
function pack(a){
  const bytes=new Uint8Array(a.length*4),view=new DataView(bytes.buffer);
  for(let i=0;i<a.length;i++){require(Number.isFinite(a[i]),"Nonfinite field sample");view.setFloat32(i*4,a[i],true);require(Number.isFinite(view.getFloat32(i*4,true)),"Field sample exceeds Float32");}
  let s="";for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(s);
}
function table(text,columns){
  const rows=[];
  for(const line of text.split(/\r?\n/)){
    const s=line.trim();if(!s||s.startsWith("%"))continue;
    const a=s.split(/\s+/).map(Number);
    require(a.length===columns&&a.every(Number.isFinite),"Unexpected probe columns");rows.push(a);
  }
  require(rows.length,"No probe samples");
  return rows;
}
export async function readDiagnosticProbe(ems,p,budget){
  const [,unit,n]=scalar[p.type],r={unit,components:n};let used=0,errors=[];
  if(p.td)try{
    const text=await ems.readFile(p.id,"utf8"),rows=table(text,n+1);
    require(rows.length*(n+1)<=budget,"Probe sample limit exceeded");
    require(rows.every((a,i)=>!i||a[0]>rows[i-1][0]),"Non-increasing probe timestamps");
    r.time_s=rows.map(a=>a[0]);r.values=rows.map(a=>a.slice(1).map(v=>v*p.sign));used+=rows.length*(n+1);
    for(const m of text.matchAll(/(start|stop)-coordinates:\s*\(([^)]*)\)\s*m/g)){
      const xyz=m[2].split(",").map(v=>Number(v)*1000);if(finite3(xyz))r["sample_"+m[1]]=xyz;
    }
  }catch(e){errors.push("td: "+e.message);}
  if(p.fs.length)try{
    const rows=table(await ems.readFile(p.id+"_FD","utf8"),1+2*n);
    r.frequency_hz=rows.map(a=>a[0]);r.real=rows.map(a=>Array.from({length:n},(_,j)=>p.sign*a[1+2*j]));r.imag=rows.map(a=>Array.from({length:n},(_,j)=>p.sign*a[2+2*j]));
    used+=rows.length*(1+2*n);
  }catch(e){errors.push("fd: "+e.message);}
  if(errors.length)r.warning=errors.join("; ");
  return {record:r,used};
}
export async function readDiagnosticDump(ems,file,mode,budget){
  const list=await ems.h5List(file),paths=new Set(list.map(d=>d.path));
  const read=path=>ems.h5Read(file,path);
  const attr=async(path,name)=>await ems.h5Attr(file,path,name);
  const axes=await Promise.all(["x","y","z"].map(async k=>Array.from((await read("/Mesh/"+k)).data,v=>v*1000)));
  const shape=axes.map(a=>a.length),[nx,ny,nz]=shape,n=nx*ny*nz;
  require(n>0&&n<=POINT_LIMIT,"Field dump exceeds 4096 spatial samples; increase subsampling");
  const version=(await attr("/","openEMS_HDF5_version"))?.[0]??0.2;
  const legacy=!!((await attr("/","legacy_fmt"))?.[0]??(version<=.2));
  const group="/FieldData/"+mode.toUpperCase();
  const pattern=mode==="td"?/^\d+$/:/^f\d+(?:_real)?$/;
  const names=list.filter(d=>d.path.startsWith(group+"/")&&pattern.test(d.path.slice(group.length+1))).map(d=>d.path).sort((a,b)=>Number(a.split("/").at(-1).replace(/^f/,"").split("_")[0])-Number(b.split("/").at(-1).replace(/^f/,"").split("_")[0]));
  const size=names.length*n*3;
  require(names.length&&size*(mode==="fd"?2:1)<=budget,"No field samples or field capture exceeds transfer budget");
  const real=new Float32Array(size),imag=mode==="fd"?new Float32Array(size):null,keys=[];let peak=0;
  const expected=[3,...(legacy?[nz,ny,nx]:shape)];
  for(const [k,path] of names.entries()){
    const d=await read(path),split=mode==="fd"&&path.endsWith("_real");
    require(same(d.dims,expected),"Unexpected HDF5 field dimensions "+d.dims.join("x"));
    let im=null;
    if(split){const other=path.replace(/_real$/,"_imag");require(paths.has(other),"Missing imaginary dataset");const q=await read(other);require(same(q.dims,expected)&&!q.complex,"Invalid imaginary dataset");im=q.data;}
    require(mode==="td"?!d.complex:split?!d.complex:d.complex,"Unexpected HDF5 field datatype");
    let j=0;
    for(let x=0;x<nx;x++)for(let y=0;y<ny;y++)for(let z=0;z<nz;z++){
      const index=legacy?(z*ny+y)*nx+x:(x*ny+y)*nz+z;
      let mag=0;
      for(let c=0;c<3;c++){
        const i=c*n+index,a=d.data[d.complex?2*i:i],b=imag?(split?im[i]:d.data[2*i+1]):0;
        require(Number.isFinite(a)&&Number.isFinite(b),"Nonfinite field sample");
        real[k*n*3+j]=a;if(imag)imag[k*n*3+j]=b;
        mag+=a*a+b*b;j++;
      }
      peak=Math.max(peak,Math.sqrt(mag));
    }
    let key;
    if(mode==="td")key=(await attr(path,"time"))?.[0];
    else {
      key=(await attr(path,"frequency"))?.[0];
      if(key===undefined){const index=Number(path.split("/").at(-1).slice(1).split("_")[0]);key=(await attr(group,"frequency"))?.[index];}
    }
    require(Number.isFinite(key),"Missing field sample timestamp/frequency");
    keys.push(key);
  }
  require(keys.every((v,i)=>!i||v>keys[i-1]),"Non-increasing field timestamps/frequencies");
  const data={axes_mm:axes,peak};
  if(mode==="td")Object.assign(data,{time_s:keys,frames_f32:pack(real)});
  else Object.assign(data,{frequency_hz:keys,real_f32:pack(real),imag_f32:pack(imag)});
  return {data,used:size*(imag?2:1)};
}
export async function collectDiagnostics(ems,objects){
  const records=[];let budget=LIMIT;
  for(const p of objects){
    const {id,name,type,start,stop,axis,sign,field}=p,r={id,name,type,start,stop,axis,sign,field};
    if(type==="field_dump"){
      r.unit=fields[field][1];const warnings=[];
      for(const mode of ["td","fd"]){
        if(mode==="td"?!p.td:!p.fs.length)continue;
        try{const {data,used}=await readDiagnosticDump(ems,id+"_"+mode+".h5",mode,budget);r[mode]=data;budget-=used;}
        catch(e){warnings.push(mode+": "+e.message);}
      }
      if(warnings.length)r.warning=warnings.join("; ");
    }else{const {record,used}=await readDiagnosticProbe(ems,p,budget);Object.assign(r,record);budget-=used;}
    records.push(r);
  }
  return records;
}
