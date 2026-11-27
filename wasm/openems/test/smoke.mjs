// node test/smoke.mjs [xml] [openEMS args...]
// Runs an openEMS XML with site/openems/openems.mjs (default: test/tiny.xml)
// and, for tiny.xml, checks the probe it writes. Runs in CI.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import factory from '../../../site/openems/openems.mjs';
import { OpenEMSCore, ProgressParser } from '../../../site/openems/openems-core.js';
import { parseProbe } from '../../../site/openems/openems-post.js';
import { prepareDiagnostics, diagnosticXML, collectDiagnostics } from '../../../site/csxcad/js/sim/wasm-diagnostics.js';
import assert from 'node:assert/strict';

const tiny = fileURLToPath(new URL('tiny.xml', import.meta.url));
const xmlPath = process.argv[2] || tiny;
const pp = new ProgressParser();
const core = await OpenEMSCore.create(factory, {
  pthreadPoolSize: 4,
  print: (l) => { const p = pp.line(l); console.log(p ? `progress ${JSON.stringify(p)}` : l); },
  printErr: (l) => console.error(l),
});
let xml=readFileSync(xmlPath,"utf8"),diagnostics=[];
if(xmlPath===tiny){
  const fd={enabled:true,frequencies_hz:[1e9]};
  diagnostics=prepareDiagnostics({probes:[
    {name:"Voltage",type:"voltage",start:[2,2,4],stop:[2,2,6],frequency_domain:fd},
    {name:"Current",type:"current",start:[3,3,5],stop:[6,6,5],frequency_domain:fd},
    {name:"Electric point",type:"electric_field",start:[2,2,5],stop:[2,2,5],frequency_domain:fd},
    {name:"Magnetic point",type:"magnetic_field",start:[2,2,5],stop:[2,2,5],frequency_domain:fd},
    {name:"Electric plane",type:"field_dump",field:"E",start:[2,1,2],stop:[2,7,7],sub_sampling:[1,2,2],frequency_domain:fd},
    {name:"Magnetic plane",type:"field_dump",field:"H",start:[2,1,2],stop:[2,7,7],sub_sampling:[1,2,2],frequency_domain:fd},
  ]},[0,0,0],[9,9,9]);
  xml=xml.replace("</Properties>",diagnosticXML(diagnostics,10).props.join("\n")+"\n</Properties>");
}
core.writeFile('model.xml', xml);
const t0 = Date.now();
const rc = core.run('model.xml', process.argv.slice(3));
console.log(`exit ${rc} in ${Date.now() - t0} ms; files:`, core.list().map((f) => `${f.path} ${f.size}`).join(', '));
let ok = rc === 0;
if (xmlPath === tiny) {
  const probe = parseProbe(core.readFile('ut_probe', 'utf8'));
  const peak = Math.max(...probe.v.map(Math.abs));
  // probes are written at the oversampled Nyquist rate, not every timestep
  ok = ok && probe.t.length >= 5 && probe.t.every((t, i) => i === 0 || t > probe.t[i - 1]) && Number.isFinite(peak) && peak > 0;
  console.log(`probe: ${probe.t.length} samples, peak |u| ${peak}`);
  const records=await collectDiagnostics(core,diagnostics);
  for(const p of records){
    assert.equal(p.warning,undefined,p.name+": "+p.warning);
    if(p.type==="field_dump"){
      assert.ok(p.td.time_s.length>=2,p.name+" TD frames");
      assert.ok(p.fd.frequency_hz.length===1,p.name+" FD frames");
      assert.ok(p.td.peak>0,p.name+" nonzero field");
      assert.ok(p.td.axes_mm.every(a=>a.every(v=>v>=0&&v<=9.01)),p.name+" millimetre coordinates");
    }else{
      assert.ok(p.time_s.length>=2,p.name+" TD samples");
      assert.equal(p.frequency_hz.length,1,p.name+" FD samples");
    }
  }
  console.log("Real WASM diagnostic capture PASS: "+records.map(p=>p.name).join(", "));
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
