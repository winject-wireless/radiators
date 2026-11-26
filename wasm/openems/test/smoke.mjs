// node test/smoke.mjs [xml] [openEMS args...]
// Runs an openEMS XML with site/openems/openems.mjs (default: test/tiny.xml)
// and, for tiny.xml, checks the probe it writes. Runs in CI.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import factory from '../../../site/openems/openems.mjs';
import { OpenEMSCore, ProgressParser } from '../../../site/openems/openems-core.js';
import { parseProbe } from '../../../site/openems/openems-post.js';

const tiny = fileURLToPath(new URL('tiny.xml', import.meta.url));
const xmlPath = process.argv[2] || tiny;
const pp = new ProgressParser();
const core = await OpenEMSCore.create(factory, {
  pthreadPoolSize: 4,
  print: (l) => { const p = pp.line(l); console.log(p ? `progress ${JSON.stringify(p)}` : l); },
  printErr: (l) => console.error(l),
});
core.writeFile('model.xml', readFileSync(xmlPath));
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
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
