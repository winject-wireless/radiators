import assert from "node:assert/strict";
import { prepareDiagnostics, diagnosticXML, readDiagnosticDump, collectDiagnostics } from "../js/sim/probe-capture.js";
import { diagnosticFrame } from "../js/sim/probe-playback.js";
const config={excitation:{center_hz:2.45e9,bandwidth_hz:.5e9},probes:[
  {name:"I",type:"current",start:[-3,-3,0],stop:[3,3,0],direction:"-z",transform:{translate:[0,10,5]},frequencies_hz:[2.45e9]},
  {name:"E",type:"field_dump",field:"E",start:[0,-5,-5],stop:[0,5,5],sub_sampling:[1,2,3],time_domain:{enabled:true,oversampling:2},frequency_domain:{enabled:true,frequencies_hz:[2.45e9]}},
  {name:"disabled",enabled:false}
]};
const objects=prepareDiagnostics(config,[-20,-20,-20],[20,20,20]);
assert.equal(objects.length,2);assert.deepEqual(objects[0].start,[-3,7,5]);assert.equal(objects[0].sign,-1);
const xml=diagnosticXML(objects,5);assert.equal(xml.nextId,8);
assert.match(xml.properties[0],/NormDir="2"/);assert.match(xml.properties[0],/<FD_Samples>2450000000<\/FD_Samples>/);
assert.match(xml.properties[1],/DumpType="0".*SubSampling="1,2,3" OverSampling="2"/);
assert.match(xml.properties[2],/DumpType="10"/);
assert.throws(()=>prepareDiagnostics({...config,probes:[{...config.probes[0],stop:[3,3,1]}]},[-20,-20,-20],[20,20,20]),/dimension/);
function fixture(legacy,fd=false){
  const axes={x:[.001,.002],y:[.003],z:[.004,.005,.006]},dims=legacy?[3,3,1,2]:[3,2,1,3],datasets=new Map(),attrs=new Map();
  const add=(path,data,dims,complex=false)=>datasets.set(path,{path,data:Float64Array.from(data),dims,complex});
  for(const [k,v] of Object.entries(axes))add("/Mesh/"+k,v,[v.length]);
  const data=[];for(let c=0;c<3;c++)for(let j=0;j<6;j++){const x=legacy?j%2:Math.floor(j/3),z=legacy?Math.floor(j/2):j%3;data.push(100*c+10*x+z);}
  const p=fd?"/FieldData/FD/f0":"/FieldData/TD/00001";
  if(fd&&legacy){add(p+"_real",data,dims);add(p+"_imag",data.map(v=>-v),dims);attrs.set(p+"_real:frequency",[2.45e9]);}
  else if(fd){add(p,data.flatMap(v=>[v,-v]),dims,true);attrs.set(p+":frequency",[2.45e9]);}
  else {add(p,data,dims);attrs.set(p+":time",[1e-9]);}
  attrs.set("/:openEMS_HDF5_version",[legacy?.2:.3]);
  return {h5List:()=>[...datasets.values()],h5Read:(_,p)=>datasets.get(p),h5Attr:(_,p,n)=>attrs.get(p+":"+n)??null};
}
for(const legacy of [true,false])for(const fd of [true,false]){
  const {data,used}=await readDiagnosticDump(fixture(legacy,fd),"fake.h5",fd?"fd":"td",1000);
  assert.equal(used,fd?36:18);assert.deepEqual(data.axes_mm,[[1,2],[3],[4,5,6]]);
  const values=Buffer.from(fd?data.real_f32:data.frames_f32,"base64");
  assert.deepEqual(Array.from({length:18},(_,i)=>values.readFloatLE(i*4)),[0,100,200,1,101,201,2,102,202,10,110,210,11,111,211,12,112,212]);
  if(fd)assert.equal(Buffer.from(data.imag_f32,"base64").readFloatLE(4),-100);
}
const probes=await collectDiagnostics({readFile:async p=>p.endsWith("_FD")?"2450000000 3 -4\n":"% start-coordinates: (0,0.007,0.005) m\n0 1\n1e-9 -2\n"},[objects[0]]);
assert.deepEqual(probes[0].values,[[-1],[2]]);assert.deepEqual(probes[0].real,[[-3]]);assert.deepEqual(probes[0].imag,[[4]]);
assert.equal(diagnosticFrame(probes,{time:1e-9})[0].vector[2],-.4);
await assert.rejects(readDiagnosticDump(fixture(false),"fake","td",1),/budget/);
console.log("WASM diagnostic XML, scalar probe and HDF5 layout checks passed");
