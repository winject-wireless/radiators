# openEMS in the browser

openEMS (FDTD) and nf2ff compiled to WebAssembly. They run in a Web Worker,
so the editor and the viewer can simulate without a server.
`index.html` is a demo: it runs a 2.45 GHz dipole and shows S11, Zin and the
directivity. It is published at `https://winject-wireless.github.io/radiators/openems/`.

The binaries (`openems.mjs`, `openems.wasm`) are built by
[`wasm/openems/build.sh`](../../wasm/openems/README.md) and committed, so the
Pages build does not need Emscripten. `BUILD-INFO.txt` names the sources.

## API

```js
import { OpenEMS, lumpedPort, nf2ffXml, sweepFrequencies } from '../openems/openems.js';

const ems = await OpenEMS.create({ onLog: (line) => {}, onProgress: (p) => {} });
await ems.writeFile('model.xml', xml);              // openEMS XML: <FDTD> + <ContinuousStructure>
const { exitCode, seconds } = await ems.run('model.xml', { args: ['--numThreads=4'] });

// S11 / Zin of a lumped port, as openEMS.ports.LumpedPort.CalcPort in Python
const freqs = sweepFrequencies([{ start: 2.3e9, step: 10e6, end: 2.6e9 }]);
const port = lumpedPort(await ems.readFile('port_ut_1'), await ems.readFile('port_it_1'), freqs, 50);
port.s11.db; port.zin.re; port.zin.im; port.pAcc;

// far field from the NF2FF box dumps (box as openEMS CreateNF2FFBox makes it)
await ems.writeFile('nf2ff.xml', nf2ffXml({ freqs: [2.45e9], thetaDeg, phiDeg, outfile: 'ff.h5', box }));
await ems.nf2ff('nf2ff.xml');
const ff = await ems.readNf2ff('ff.h5');           // {dmax[], prad[], eTheta, ePhi, eNorm, theta, phi}

ems.terminate();
```

| Method | |
|---|---|
| `OpenEMS.create({threads, onLog, onProgress})` | starts a worker with its own wasm instance and in-memory file system (cwd `/sim`) |
| `OpenEMS.unsupportedReason()` | `null`, or why this page cannot run it |
| `writeFile / readFile(path, 'utf8'?) / exists / remove / list` | files of the instance |
| `run(xml, {args, engine, onLog, onProgress})` | `openEMS <xml> [args]`; resolves `{exitCode, seconds}` |
| `abort()` | stops a run gracefully: openEMS writes its results and `run()` resolves |
| `nf2ff(xml)` | `nf2ff <xml>` |
| `h5List / h5Read / h5Attr` | HDF5 datasets (complex data interleaved re, im) and attributes |
| `readNf2ff(h5)` | an nf2ff result, fields theta-major like Python's `nf2ff_results` |
| `terminate()` | kills the worker, also mid-run |

`onProgress` gets `{timestep, maxTimesteps, speedMCellsPerSec, energyDb, fraction}`
from the openEMS console output. `fraction` is the larger of the timestep ratio
and how far the energy has decayed towards the end criteria.

`run()` uses `--engine=basic` unless told otherwise. openEMS's default (the SSE
engine) runs ~2.5x slower in wasm, where SSE is emulated. `engine: 'cpu'`
(experimental upstream) was another ~1.7x faster on the dipole test, with the
same results.

## Cross-origin isolation

The module uses threads (SharedArrayBuffer), so the page must be cross-origin
isolated: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot send
headers. `coi.js` (`ensureIsolated()`) registers `coi-sw.js`, a service worker
that adds them, and reloads once. A page that has its own service worker (the
CSXCAD editor) must add the same headers in it, because a scope has only one
worker. Everything the page loads must then be same-origin or send CORP.

## XML precision

openEMS snaps boxes to mesh lines. `Write2XML` in CSXCAD writes coordinates
with 7 digits and mesh lines with 15, so a box written on a mesh line can be
read back just outside it and snap to the next line. With the radiators
NF2FF box, which sits next to the PML, that changed the dipole's directivity
from 2.21 to 3.04 dBi. A JavaScript XML writer should write coordinates with
full precision (`examples/dipole.xml` has its NF2FF box snapped to the mesh
lines for this reason).

## License

`openems.mjs` and `openems.wasm` contain openEMS, CSXCAD and fparser
(GPLv3 / LGPLv3) and are distributed under the **GPLv3**. Their corresponding
source is the upstream commits pinned in `wasm/openems/versions.env`, plus
`wasm/openems/patches/`, `wasm/openems/glue/` and the build scripts. The
JavaScript files in this directory are MIT, like the rest of radiators.
