// Real pinned openEMS WASM smoke test: capture all probe types and both field modes.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import factory from "../../../site/openems/openems.mjs";
import {OpenEMSCore} from "../../../site/openems/openems-core.js";
import {prepareDiagnostics,diagnosticXML,collectDiagnostics} from "../../../site/csxcad/js/sim/probe-capture.js";
const config={excitation:{center_hz:1e9,bandwidth_hz:1e9},probes:[
  {name:"I",type:"current",start:[3,3,5],stop:[5,5,5],direction:"z",frequencies_hz:[1e9]},
  {name:"V",type:"voltage",start:[4,4,4],stop:[4,4,6],frequencies_hz:[1e9]},
  {name:"E",type:"electric_field",start:[4,4,5],stop:[4,4,5],frequencies_hz:[1e9]},
  {name:"H",type:"magnetic_field",start:[3,4,5],stop:[3,4,5],frequencies_hz:[1e9]},
  {name:"field",type:"field_dump",field:"E",start:[4,2,3],stop:[4,6,7],sub_sampling:[1,2,2],
    time_domain:{enabled:true},frequency_domain:{enabled:true,frequencies_hz:[1e9]}}
]};
const objects=prepareDiagnostics(config,[0,0,0],[9,9,9]);
const xml=readFileSync(new URL("./tiny.xml",import.meta.url),"utf8").replace("</Properties>",diagnosticXML(objects,2).properties.join("\n")+"\n</Properties>");
const core=await OpenEMSCore.create(factory,{pthreadPoolSize:6,print:console.log,printErr:console.error});
try{
  core.writeFile("model.xml",xml);
  assert.equal(core.run("model.xml",["--engine=basic","--numThreads=1"]),0);
  const records=await collectDiagnostics(core,objects);
  console.log("Diagnostic results:",records.map(r=>({name:r.name,warning:r.warning,td:r.time_s?.length??r.td?.time_s.length,fd:r.frequency_hz??r.fd?.frequency_hz})));
  for(const r of records){
    assert.equal(r.warning,undefined,r.name+": "+r.warning);
    if(r.type==="field_dump"){
      assert.ok(r.td.time_s.length>=2);assert.ok(r.td.peak>0);assert.equal(r.fd.frequency_hz[0],1e9);assert.ok(r.fd.peak>0);
      assert.ok(r.td.axes_mm.flat().every(x=>x>=0&&x<=9.001));
    }else{
      assert.ok(r.time_s.length>=2);assert.equal(r.values[0].length,r.components);assert.equal(r.frequency_hz[0],1e9);
      assert.ok(r.real[0].every(Number.isFinite));
    }
  }
  assert.ok(records[1].values.some(v=>Math.abs(v[0])>0));
  console.log("Real WASM diagnostic capture: PASS");
  process.exit(0);
}catch(e){console.error(e);console.error(core.list());process.exit(1);}
