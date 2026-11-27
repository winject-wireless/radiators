import assert from "node:assert/strict";
import { prepareDiagnostics, diagnosticXML, readDump, collectDiagnostics } from "../js/sim/wasm-diagnostics.js";
import { diagnosticFrame } from "../js/sim/probe-playback.js";
const f=2.45e9,domain=[[-100,-100,-100],[100,100,100]];
const config={excitation:{center_hz:f,bandwidth_hz:1e9},probes:[
  {name:"I",type:"current",start:[-2,-3,0],stop:[2,3,0],direction:"-z",transform:{translate:[0,-18,5]},frequency_domain:{enabled:true,frequencies_hz:[f]}},
  {name:"E",type:"field_dump",field:"E",start:[0,0,0],stop:[1,0,2],sub_sampling:[1,2,3],time_domain:{enabled:true,oversampling:2},frequency_domain:{enabled:true,frequencies_hz:[f]}}
]};
const probes=prepareDiagnostics(config,...domain);
assert.deepEqual(probes[0].start,[-2,-21,5]);
assert.equal(probes[0].sign,-1);
assert.equal(probes[0].axis,2);
assert.throws(()=>prepareDiagnostics({probes:[{...config.probes[0],stop:[2,3,4]}]},...domain));
const {props,nextID}=diagnosticXML(probes,10);
assert.equal(nextID,13);
assert.match(props[0],/Name="diag_000".*Type="1".*NormDir="2"/);
assert.match(props[0],/<FD_Samples>2450000000<\/FD_Samples>/);
assert.match(props[1],/OverSampling="2".*DumpType="0".*SubSampling="1,2,3"/);
assert.match(props[2],/DumpType="10"/);
const row=(dims,data,complex=false)=>({dims,data:Float64Array.from(data),complex});
const axes=[row([2],[0,.001]),row([1],[.002]),row([3],[.003,.004,.005])];
const raw=Array.from({length:18},(_,i)=>i);
const expected=Array.from({length:6},(_,i)=>[raw[i],raw[6+i],raw[12+i]]).flat();
const decode=s=>{const b=Buffer.from(s,"base64");return Array.from({length:b.length/4},(_,i)=>b.readFloatLE(i*4));};
for(const legacy of [false,true]){
  const dims=legacy?[3,3,1,2]:[3,2,1,3];
  const values=legacy?Array.from({length:18},(_,i)=>{const c=Math.floor(i/6),j=i%6,z=Math.floor(j/2),x=j%2;return raw[c*6+x*3+z];}):raw;
  const map={"/Mesh/x":axes[0],"/Mesh/y":axes[1],"/Mesh/z":axes[2],"/FieldData/TD/000010":row(dims,values),"/FieldData/TD/000020":row(dims,values.map(x=>-x))};
  const ems={h5List:async()=>Object.entries(map).map(([path,d])=>({path,dims:d.dims,complex:d.complex})),h5Read:async(_,p)=>map[p],
    h5Attr:async(_,p,k)=>k==="openEMS_HDF5_version"?[legacy?.2:.3]:k==="time"?[p.endsWith("10")?1e-9:2e-9]:null};
  const {record,used}=await readDump(ems,"test.h5","td",1000);
  assert.deepEqual(record.axes_mm,[[0,1],[2],[3,4,5]]);
  assert.equal(used,36);assert.deepEqual(record.time_s,[1e-9,2e-9]);
  assert.deepEqual(decode(record.frames_f32).slice(0,18),expected);
  assert.deepEqual(decode(record.frames_f32).slice(18),expected.map(x=>-x));
  await assert.rejects(()=>readDump(ems,"test.h5","td",1),/budget/);
}
for(const legacy of [false,true]){
  const d=legacy?[3,3,1,2]:[3,2,1,3];
  const values=legacy?Array.from({length:18},(_,i)=>raw[Math.floor(i/6)*6+(i%2)*3+Math.floor((i%6)/2)]):raw;
  const m={"/Mesh/x":axes[0],"/Mesh/y":axes[1],"/Mesh/z":axes[2]};
  if(legacy){m["/FieldData/FD/f0_real"]=row(d,values);m["/FieldData/FD/f0_imag"]=row(d,values.map(x=>x+2));}
  else m["/FieldData/FD/f0"]=row(d,values.flatMap(x=>[x,x+2]),true);
  const ems={h5List:async()=>Object.keys(m).map(path=>({path})),h5Read:async(_,p)=>m[p],h5Attr:async(_,p,k)=>k==="openEMS_HDF5_version"?[legacy?.2:.3]:k==="frequency"?[f]:null};
  const {record}=await readDump(ems,"test.h5","fd",1000);
  assert.deepEqual(decode(record.real_f32),expected);
  assert.deepEqual(decode(record.imag_f32),expected.map(x=>x+2));
  assert.deepEqual(record.frequency_hz,[f]);
}
const ems={readFile:async name=>name.endsWith("_FD")?"2450000000 2 3\n":"% start-coordinates: (-0.002,-0.021,0.005) m\n0 2\n1e-9 -4\n"};
const [p]=await collectDiagnostics(ems,[probes[0]]);
assert.equal(p.warning,undefined);assert.deepEqual(p.values,[[-2],[4]]);
assert.deepEqual(p.sample_start,[-2,-21,5]);assert.deepEqual(p.real,[[-2]]);assert.deepEqual(p.imag,[[-3]]);
const a=diagnosticFrame([p],{time:1e-9})[0];assert.ok(a.vector[2]<0);
const [failed]=await collectDiagnostics({readFile:async()=>{throw Error("missing");}},[probes[0]]);
assert.match(failed.warning,/missing/);
console.log("WASM diagnostic model, HDF5 layout and result tests passed");
