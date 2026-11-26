// Thin synchronous layer over one openems.wasm instance: files, runs, HDF5.
// Used by openems-worker.js in the browser and directly by node tests.
// Everything here blocks the calling thread while openEMS runs.

export const SIM_DIR = '/sim';

// "[@ 4s] Timestep: 1386 || Speed: 10.7 MC/s (9.4e-02 s/TS) || Energy: ~7.0e-14 (- 9.07dB)"
const TS_RE = /Timestep:\s*(\d+)\s*\|\|\s*Speed:\s*([\d.eE+-]+)\s*MC\/s.*Energy:\s*~?\s*([\d.eE+-]+)\s*\(\s*-\s*([\d.eE+-]+)\s*dB\)/;
const MAXTS_RE = /Max\. number of timesteps:\s*(\d+)/i;
const ENDCRIT_RE = /end criteria.*?([\d.]+(?:e[+-]?\d+)?)\s*(?:\(([-\d.]+)\s*dB\))?/i;

// Parses openEMS console lines into progress records; keeps the state between lines.
export class ProgressParser {
  constructor() {
    this.maxTimesteps = null;
    this.endCriteria = null;
  }

  line(text) {
    let m = MAXTS_RE.exec(text);
    if (m) this.maxTimesteps = Number(m[1]);
    m = TS_RE.exec(text);
    if (!m) return null;
    const timestep = Number(m[1]);
    const energyDb = -Number(m[4]);
    const endDb = this.endCriteria ? 10 * Math.log10(this.endCriteria) : null;
    let fraction = this.maxTimesteps ? timestep / this.maxTimesteps : 0;
    if (endDb && energyDb < 0) fraction = Math.max(fraction, energyDb / endDb);
    return {
      timestep,
      maxTimesteps: this.maxTimesteps,
      speedMCellsPerSec: Number(m[2]),
      energy: Number(m[3]),
      energyDb,
      fraction: Math.min(1, fraction),
    };
  }
}

// End criteria (e.g. 1e-5) from an openEMS XML, for the progress estimate.
export function endCriteriaFromXml(xml) {
  const m = /<FDTD\b[^>]*\bendCriteria="([^"]+)"/.exec(xml);
  return m ? Number(m[1]) : null;
}

export class OpenEMSCore {
  // factory: the default export of openems.mjs; options are passed to it
  // (print/printErr, locateFile, pthreadPoolSize, mainScriptUrlOrBlob...).
  static async create(factory, options = {}) {
    const core = new OpenEMSCore();
    core.module = await factory(options);
    core.FS = core.module.FS;
    core.mkdirs(SIM_DIR);
    core.FS.chdir(SIM_DIR);
    core.abortPtr = core.module._oems_abort_flag();
    return core;
  }

  // the shared wasm memory and the address of the abort flag (an int32)
  abortHandle() {
    return { memory: this.module.wasmMemory, ptr: this.abortPtr };
  }

  resolve(path) {
    return path.startsWith('/') ? path : `${SIM_DIR}/${path}`;
  }

  mkdirs(path) {
    let cur = '';
    for (const part of path.split('/').filter(Boolean)) {
      cur += '/' + part;
      try { this.FS.mkdir(cur); } catch (e) { /* exists */ }
    }
  }

  writeFile(path, data) {
    const full = this.resolve(path);
    this.mkdirs(full.slice(0, full.lastIndexOf('/')) || '/');
    this.FS.writeFile(full, data);
  }

  readFile(path, encoding) {
    return this.FS.readFile(this.resolve(path), encoding ? { encoding } : undefined);
  }

  exists(path) {
    return this.FS.analyzePath(this.resolve(path)).exists;
  }

  remove(path) {
    const full = this.resolve(path);
    const st = this.FS.stat(full);
    if (this.FS.isDir(st.mode)) {
      for (const name of this.FS.readdir(full)) {
        if (name !== '.' && name !== '..') this.remove(`${full}/${name}`);
      }
      this.FS.rmdir(full);
    } else {
      this.FS.unlink(full);
    }
  }

  // [{path, size, dir}] below `path`, recursively
  list(path = SIM_DIR) {
    const out = [];
    const walk = (dir) => {
      for (const name of this.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const full = `${dir}/${name}`;
        const st = this.FS.stat(full);
        const dirFlag = this.FS.isDir(st.mode);
        out.push({ path: full.startsWith(SIM_DIR + '/') ? full.slice(SIM_DIR.length + 1) : full, size: st.size, dir: dirFlag });
        if (dirFlag) walk(full);
      }
    };
    walk(this.resolve(path));
    return out;
  }

  callStrings(fn, strings, extra = []) {
    const M = this.module;
    const ptrs = strings.map((s) => M.stringToNewUTF8(s));
    const argv = M._malloc(4 * ptrs.length);
    ptrs.forEach((p, i) => { M.HEAPU32[(argv >> 2) + i] = p; });
    try {
      return fn(ptrs.length, argv, ...extra);
    } finally {
      ptrs.forEach((p) => M._free(p));
      M._free(argv);
    }
  }

  // openEMS <xmlPath> [args...] in SIM_DIR; returns the exit code (0 = ok).
  run(xmlPath, args = []) {
    this.FS.chdir(SIM_DIR);
    const xml = this.resolve(xmlPath);
    return this.callStrings((argc, argv) => this.module._oems_run(argc, argv), ['openEMS', xml, ...args]);
  }

  // nf2ff <xmlPath>; returns the exit code (0 = ok).
  nf2ff(xmlPath) {
    this.FS.chdir(SIM_DIR);
    const M = this.module;
    const p = M.stringToNewUTF8(this.resolve(xmlPath));
    try { return M._oems_nf2ff(p); } finally { M._free(p); }
  }

  // [{path, complex, rank, dims}] of every dataset in an HDF5 file
  h5List(file) {
    const M = this.module;
    const f = M.stringToNewUTF8(this.resolve(file));
    try {
      const p = M._oems_h5_list(f);
      if (!p) throw new Error(`cannot open HDF5 file ${file}`);
      const text = M.UTF8ToString(p);
      M._free(p);
      return text.split('\n').filter(Boolean).map((line) => {
        const [path, kind, rank, ...dims] = line.split('\t');
        return { path, complex: kind === 'c', rank: Number(rank), dims: dims.map(Number) };
      });
    } finally { M._free(f); }
  }

  // a dataset as {dims, complex, data: Float64Array} (row major, dims as HDF5
  // stores them; complex data interleaved re, im)
  h5Read(file, path) {
    const info = this.h5List(file).find((d) => d.path === path || d.path === '/' + path);
    if (!info) throw new Error(`no dataset ${path} in ${file}`);
    const n = info.dims.reduce((a, b) => a * b, 1) * (info.complex ? 2 : 1);
    const M = this.module;
    const f = M.stringToNewUTF8(this.resolve(file));
    const d = M.stringToNewUTF8(info.path);
    const buf = M._malloc(8 * Math.max(1, n));
    try {
      if (M._oems_h5_read(f, d, buf) !== 0) throw new Error(`cannot read ${path} from ${file}`);
      return { dims: info.dims, complex: info.complex, data: M.HEAPF64.slice(buf >> 3, (buf >> 3) + n) };
    } finally {
      M._free(f); M._free(d); M._free(buf);
    }
  }

  // a numeric attribute as Float64Array, or null
  h5Attr(file, path, name) {
    const M = this.module;
    const f = M.stringToNewUTF8(this.resolve(file));
    const p = M.stringToNewUTF8(path);
    const a = M.stringToNewUTF8(name);
    const max = 4096;
    const buf = M._malloc(8 * max);
    try {
      const n = M._oems_h5_attr(f, p, a, buf, max);
      return n < 0 ? null : M.HEAPF64.slice(buf >> 3, (buf >> 3) + Math.min(n, max));
    } finally {
      M._free(f); M._free(p); M._free(a); M._free(buf);
    }
  }
}
