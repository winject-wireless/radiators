// Web Worker hosting one openEMS wasm instance (module worker, see openems.js).
// Messages in:  {id, op, args}; out: {id, ok, result | error} plus streamed
// {type: 'log', stream, line} and {type: 'progress', progress} during runs.
import createOpenEMSModule from './openems.mjs';
import { OpenEMSCore, ProgressParser, endCriteriaFromXml } from './openems-core.js';
import { readNf2ff } from './openems-post.js';

let core = null;
let parser = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function onLine(stream) {
  return (line) => {
    post({ type: 'log', stream, line });
    if (stream === 'stdout' && parser) {
      const p = parser.line(line);
      if (p) post({ type: 'progress', progress: p });
    }
  };
}

const ops = {
  async init({ pthreadPoolSize } = {}) {
    if (core) return core.abortHandle();
    const options = { print: onLine('stdout'), printErr: onLine('stderr') };
    if (pthreadPoolSize) options.pthreadPoolSize = pthreadPoolSize;
    core = await OpenEMSCore.create(createOpenEMSModule, options);
    return core.abortHandle();
  },
  writeFile({ path, data }) { core.writeFile(path, data); },
  readFile({ path, encoding }) { return core.readFile(path, encoding); },
  exists({ path }) { return core.exists(path); },
  remove({ path }) { core.remove(path); },
  list({ path }) { return core.list(path); },
  run({ xmlPath, args }) {
    parser = new ProgressParser();
    try { parser.endCriteria = endCriteriaFromXml(core.readFile(xmlPath, 'utf8')); } catch (e) { /* no estimate */ }
    const t0 = performance.now();
    try {
      const exitCode = core.run(xmlPath, args || []);
      return { exitCode, seconds: (performance.now() - t0) / 1000 };
    } finally {
      parser = null;
    }
  },
  nf2ff({ xmlPath }) {
    const t0 = performance.now();
    const exitCode = core.nf2ff(xmlPath);
    return { exitCode, seconds: (performance.now() - t0) / 1000 };
  },
  h5List({ path }) { return core.h5List(path); },
  h5Read({ path, dataset }) { return core.h5Read(path, dataset); },
  h5Attr({ path, object, name }) { return core.h5Attr(path, object, name); },
  readNf2ff({ path }) { return readNf2ff(core, path); },
};

// typed arrays in a result are transferred, not copied
function transferables(value, out = []) {
  if (ArrayBuffer.isView(value)) out.push(value.buffer);
  else if (Array.isArray(value)) value.forEach((v) => transferables(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => transferables(v, out));
  return [...new Set(out)].filter((b) => !(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer));
}

// One request at a time: a run blocks this worker anyway.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { id, op, args } = e.data;
  queue = queue.then(async () => {
    try {
      if (!ops[op]) throw new Error(`unknown op ${op}`);
      if (op !== 'init' && !core) throw new Error('openEMS worker not initialised');
      const result = await ops[op](args || {});
      post({ id, ok: true, result }, op === 'init' ? [] : transferables(result));
    } catch (err) {
      post({ id, ok: false, error: String(err && err.stack || err) });
    }
  });
};
