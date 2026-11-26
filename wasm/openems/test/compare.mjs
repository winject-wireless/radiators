// node test/compare.mjs <reference dir> <config.json>
// Runs <ref>/model.xml (written by make_reference.py) in wasm and post-processes
// it in JS. Checks: S11 / Zin against the Python flow (result.json); the probe
// files and the far field against the native binary on the same XML (xmlrun/,
// nf2ff run here with NF2FF_BIN, default .native/opt/bin/nf2ff).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import factory from '../../../site/openems/openems.mjs';
import { OpenEMSCore, ProgressParser, endCriteriaFromXml } from '../../../site/openems/openems-core.js';
import { lumpedPort, nf2ffXml, readNf2ff, sweepFrequencies } from '../../../site/openems/openems-post.js';

const [refDir, configPath] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const ref = JSON.parse(readFileSync(join(refDir, 'result.json'), 'utf8'));
const box = JSON.parse(readFileSync(join(refDir, 'nf2ff.json'), 'utf8'));
const xml = readFileSync(join(refDir, 'model.xml'), 'utf8');

const pp = new ProgressParser();
pp.endCriteria = endCriteriaFromXml(xml);
let last = null;
const core = await OpenEMSCore.create(factory, {
  pthreadPoolSize: Number(process.env.POOL || 6),
  print: (l) => { const p = pp.line(l); if (p) { last = p; console.log(`progress ${(100 * p.fraction).toFixed(0)}% ts=${p.timestep} ${p.speedMCellsPerSec} MC/s ${p.energyDb} dB`); } else if (/Speed|Time for|simulation size/.test(l)) console.log(l); },
  printErr: (l) => console.error(l),
});
core.writeFile('model.xml', xml);
let t0 = performance.now();
const rc = core.run('model.xml', (process.env.OEMS_ARGS || '').split(' ').filter(Boolean));
const fdtdS = (performance.now() - t0) / 1000;
if (rc !== 0) { console.error('openEMS rc', rc); process.exit(1); }

const port = cfg.ports.find((p) => p.excite);
const id = port.id ?? 1;
const freqs = sweepFrequencies(cfg.outputs.s11);
const res = lumpedPort(core.readFile(`port_ut_${id}`), core.readFile(`port_it_${id}`), freqs, port.impedance_ohm);

const maxAbs = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
const checks = [];
const check = (name, err, tol) => { checks.push({ name, err, tol, ok: err <= tol }); };
check('S11 |dB| max diff', maxAbs(Array.from(res.s11.db), ref.s11.logmag_db), 0.05);
check('S11 re/im max diff', Math.max(maxAbs(Array.from(res.s11.re), ref.s11.real), maxAbs(Array.from(res.s11.im), ref.s11.imag)), 2e-3);
check('Zin re max diff (ohm)', maxAbs(Array.from(res.zin.re), ref.impedance.real_ohm), 0.5);

// raw probe: time-domain port voltage vs native
const parse = (t) => t.split('\n').filter((l) => l && l[0] !== '%').map((l) => l.trim().split(/\s+/).map(Number));
const nu = parse(readFileSync(join(refDir, 'xmlrun', `port_ut_${id}`), 'utf8'));
const wu = parse(core.readFile(`port_ut_${id}`, 'utf8'));
const peak = Math.max(...nu.map((r) => Math.abs(r[1])));
check('port_ut samples (native vs wasm count diff)', Math.abs(nu.length - wu.length), 0);
check('port_ut max diff / peak', Math.max(...nu.slice(0, Math.min(nu.length, wu.length)).map((r, i) => Math.abs(r[1] - wu[i][1]))) / peak, 1e-3);

// far field
const grid = cfg.outputs.radiation_grid;
const theta = Array.from({ length: Math.round(180 / grid.theta_step_deg) + 1 }, (_, i) => i * grid.theta_step_deg);
const phi = Array.from({ length: Math.round(360 / grid.phi_step_deg) }, (_, i) => i * grid.phi_step_deg);
const nf2ffBin = process.env.NF2FF_BIN || new URL('../.native/opt/bin/nf2ff', import.meta.url).pathname;
for (const pat of ref.patterns) {
  const out = `nf2ff_${pat.frequency_hz}.h5`;
  const nfXml = nf2ffXml({ freqs: [pat.frequency_hz], thetaDeg: theta, phiDeg: phi, outfile: out, box });
  core.writeFile('nf2ff.xml', nfXml);
  t0 = performance.now();
  if (core.nf2ff('nf2ff.xml') !== 0) { console.error('nf2ff failed'); process.exit(1); }
  const nfS = (performance.now() - t0) / 1000;
  const ff = readNf2ff(core, out);

  // native nf2ff on the native field dumps of the same XML; read back through the wasm reader
  writeFileSync(join(refDir, 'xmlrun', 'nf2ff.xml'), nfXml);
  execFileSync(nf2ffBin, ['nf2ff.xml'], { cwd: join(refDir, 'xmlrun'), stdio: 'ignore' });
  core.writeFile('native_nf2ff.h5', readFileSync(join(refDir, 'xmlrun', out)));
  const nf = readNf2ff(core, 'native_nf2ff.h5');

  const dmaxDbi = 10 * Math.log10(ff.dmax[0]);
  const nDmaxDbi = 10 * Math.log10(nf.dmax[0]);
  check(`Dmax dBi @${pat.frequency_hz / 1e9} GHz vs native`, Math.abs(dmaxDbi - nDmaxDbi), 1e-3);
  check('Prad rel diff vs native', Math.abs(ff.prad[0] - nf.prad[0]) / nf.prad[0], 1e-4);
  const en = ff.eNorm[0];
  const nen = nf.eNorm[0];
  const emax = Math.max(...nen);
  check('|E| max diff / peak vs native', en.reduce((m, x, i) => Math.max(m, Math.abs(x - nen[i])), 0) / emax, 1e-4);
  console.log(`nf2ff ${nfS.toFixed(2)} s; Dmax wasm ${dmaxDbi.toFixed(3)} dBi, native-from-XML ${nDmaxDbi.toFixed(3)} dBi, Python flow ${pat.max_directivity_dbi.toFixed(3)} dBi`);
}

const native = JSON.parse(readFileSync(join(refDir, 'timing.json'), 'utf8'));
const imin = res.s11.db.indexOf(Math.min(...res.s11.db));
console.log(`\nwasm FDTD ${fdtdS.toFixed(1)} s vs native ${native.xmlrun_s.toFixed(1)} s; S11 min ${res.s11.db[imin].toFixed(2)} dB @ ${(freqs[imin] / 1e9).toFixed(3)} GHz`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.err.toExponential(3)} (tol ${c.tol})`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
