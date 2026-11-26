// openEMS in the browser: one OpenEMS object = one Web Worker running one
// openems.wasm instance with its own in-memory file system (cwd /sim).
//
//   import { OpenEMS } from './openems/openems.js';
//   const ems = await OpenEMS.create({ onLog, onProgress });
//   await ems.writeFile('model.xml', xmlText);           // openEMS FDTD + CSX XML
//   const { exitCode } = await ems.run('model.xml');     // like `openEMS model.xml`
//   const ut = await ems.readFile('port_ut_1', 'utf8');  // probes, dumps, ...
//   await ems.writeFile('nf2ff.xml', nf2ffXml({...}));
//   await ems.nf2ff('nf2ff.xml');                        // like `nf2ff nf2ff.xml`
//   const ff = await ems.readNf2ff('nf2ff.h5');          // Dmax, Prad, E fields
//   ems.terminate();
//
// The module uses threads (SharedArrayBuffer), so the page must be cross-origin
// isolated (COOP: same-origin + COEP: require-corp, see README.md).
export { lumpedPort, nf2ffXml, parseProbe, dft, sweepFrequencies } from './openems-post.js';

const here = new URL('./', import.meta.url);

export class OpenEMSError extends Error {}

export class OpenEMS {
  // options:
  //   threads      pthread pool size (default: navigator.hardwareConcurrency + 2);
  //                openEMS itself uses hardwareConcurrency threads unless
  //                run(..., {args: ['--numThreads=N']}) says otherwise
  //   onLog(line, stream)   every console line of openEMS / nf2ff
  //   onProgress(p)         {timestep, maxTimesteps, speedMCellsPerSec, energyDb, fraction}
  //   workerUrl    override the worker script URL
  static async create(options = {}) {
    const why = OpenEMS.unsupportedReason();
    if (why) throw new OpenEMSError(why);
    const ems = new OpenEMS(options);
    const handle = await ems.call('init', { pthreadPoolSize: options.threads });
    ems.abortView = new Int32Array(handle.memory.buffer);
    ems.abortIndex = handle.ptr >> 2;
    return ems;
  }

  // null if this page can run openEMS, else why not
  static unsupportedReason() {
    if (typeof Worker === 'undefined') return 'Web Workers are not available';
    if (typeof SharedArrayBuffer === 'undefined' || (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)) {
      return 'openEMS needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp) for SharedArrayBuffer threads';
    }
    if (typeof WebAssembly === 'undefined') return 'WebAssembly is not available';
    return null;
  }

  constructor(options) {
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.runListeners = null;
    this.worker = new Worker(options.workerUrl || new URL('openems-worker.js', here), { type: 'module', name: 'openEMS' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(new OpenEMSError(`openEMS worker error: ${e.message || e}`));
  }

  onMessage(msg) {
    if (msg.type === 'log') {
      this.options.onLog?.(msg.line, msg.stream);
      this.runListeners?.onLog?.(msg.line, msg.stream);
      return;
    }
    if (msg.type === 'progress') {
      this.options.onProgress?.(msg.progress);
      this.runListeners?.onProgress?.(msg.progress);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new OpenEMSError(msg.error));
  }

  fail(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  call(op, args, transfer = []) {
    if (!this.worker) return Promise.reject(new OpenEMSError('openEMS worker terminated'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args }, transfer);
    });
  }

  // data: string, Uint8Array or ArrayBuffer. Relative paths are below /sim.
  writeFile(path, data) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    return this.call('writeFile', { path, data });
  }

  // Uint8Array, or a string with encoding 'utf8'
  readFile(path, encoding) { return this.call('readFile', { path, encoding }); }
  exists(path) { return this.call('exists', { path }); }
  remove(path) { return this.call('remove', { path }); }
  // [{path, size, dir}], recursively
  list(path = '/sim') { return this.call('list', { path }); }

  // Runs openEMS on an XML file (FDTD + ContinuousStructure). args are openEMS
  // options, e.g. ['--numThreads=4', '--disable-dumps'].
  // engine: 'basic' by default. openEMS's own default (the SSE engine) runs
  // ~2.5x slower in wasm, where SSE is emulated; 'cpu' (experimental upstream)
  // is ~1.7x faster than 'basic'. An --engine in args wins.
  // Resolves {exitCode, seconds}; while it runs, no other call is served.
  async run(xmlPath, { args = [], engine = 'basic', onLog, onProgress } = {}) {
    if (engine && !args.some((a) => a.startsWith('--engine'))) args = [`--engine=${engine}`, ...args];
    this.abortView && Atomics.store(this.abortView, this.abortIndex, 0);
    this.runListeners = { onLog, onProgress };
    try {
      return await this.call('run', { xmlPath, args });
    } finally {
      this.runListeners = null;
    }
  }

  // Stops a running simulation gracefully: openEMS finishes the timestep, writes
  // its results and run() resolves as usual.
  abort() {
    if (this.abortView) Atomics.store(this.abortView, this.abortIndex, 1);
  }

  // nf2ff on an nf2ff XML (see nf2ffXml()); resolves {exitCode, seconds}
  nf2ff(xmlPath, { onLog } = {}) {
    this.runListeners = { onLog };
    return this.call('nf2ff', { xmlPath }).finally(() => { this.runListeners = null; });
  }

  // HDF5 access: dataset list [{path, complex, rank, dims}], one dataset
  // {dims, complex, data: Float64Array}, a numeric attribute (Float64Array | null)
  h5List(path) { return this.call('h5List', { path }); }
  h5Read(path, dataset) { return this.call('h5Read', { path, dataset }); }
  h5Attr(path, object, name) { return this.call('h5Attr', { path, object, name }); }

  // nf2ff result file -> {freqs, theta, phi, prad, dmax, eTheta, ePhi, eNorm}
  readNf2ff(path) { return this.call('readNf2ff', { path }); }

  // Kills the worker at once (also mid-run) and frees its memory.
  terminate() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.fail(new OpenEMSError('openEMS worker terminated'));
  }
}
