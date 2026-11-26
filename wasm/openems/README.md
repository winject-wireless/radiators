# openEMS → WebAssembly build

Builds openEMS, CSXCAD, fparser and nf2ff with Emscripten into
`site/openems/openems.{mjs,wasm}` (the JavaScript API is in `site/openems/`,
see its README).

```bash
~/emsdk/emsdk install 4.0.10 && ~/emsdk/emsdk activate 4.0.10   # EMSDK_VERSION in versions.env
./build.sh            # fetch, deps, openEMS, link (~15 min on 4 cores)
./build.sh link       # relink only, after a glue change
```

| Stage | |
|---|---|
| `fetch` | sources at the pins in `versions.env` into `.src/`, with `patches/<name>/` applied |
| `deps` | zlib, tinyxml, HDF5 1.14 (+HL), Boost 1.86 (thread, chrono, date_time, program_options, serialization) into `.prefix/` |
| `app` | fparser, CSXCAD (installed) and the openEMS / nf2ff libraries with their own CMake files |
| `link` | `glue/openems_wasm.cpp` + all libraries → `openems.mjs` + `openems.wasm` + `BUILD-INFO.txt` |

Everything is built with `-pthread -msimd128 -msse2 -fwasm-exceptions`. HDF5
needs one patch (no `FE_INVALID` in wasm). Upstream's standalone nf2ff binary
does not link zlib, so only the libraries are built and the link is ours.

## Module

ES module factory `createOpenEMSModule` (MODULARIZE, EXPORT_ES6), for web
workers and node. The glue exports:

- `oems_run(argc, argv)`: like the `openEMS` binary, without exiting
- `oems_nf2ff(xml)`: like the `nf2ff` binary
- `oems_abort_flag()`: the address of an int in shared memory. A nonzero value
  stops a run gracefully; a watcher thread hands it to `openEMS::SetAbort`.
- `oems_h5_list / oems_h5_read / oems_h5_attr`: reads HDF5 files (nf2ff
  results, field dumps) without an HDF5 library in JavaScript

The simulation runs on the module's main thread inside the worker, which
blocks. So every thread comes from the pthread pool created at startup
(`Module.pthreadPoolSize`, default `hardwareConcurrency + 2`).

## Tests

```bash
node test/smoke.mjs                      # tiny cavity, in CI
node test/compare.mjs <ref> test/dipole_v2.json
node test/browser.mjs headers|sw         # headless Chromium, the demo page
```

`compare.mjs` compares wasm with a native build of the same pinned sources.
`make_reference.py` creates the reference: it runs `antennas/simulate_v2.py`
natively, records the openEMS XML (`model.xml`) and the NF2FF box, and runs
the native binary on that XML. To build the native side:

```bash
sudo apt install libhdf5-dev libboost-{thread,program-options,chrono,date-time,serialization}-dev \
  libtinyxml-dev cython3 python3-dev python3-numpy python3-h5py python3-matplotlib
./build.sh fetch && test/build_native.sh      # .native/opt + .native/venv
LD_LIBRARY_PATH=.native/opt/lib .native/venv/bin/python test/make_reference.py test/dipole_v2.json .ref/dipole
```

Result on the dipole (138k cells, RK3588, 2026-11-26): wasm matches native to
1e-7 relative on S11, Zin, the port voltage and the far field (Dmax, Prad,
|E|), with the `basic` and `cpu` engines and openEMS's default engine. Times:
native default 8.8 s. In wasm: default (SSE) 24.5 s, `basic` 11.0 s, `cpu` 6.5 s.
In Chromium the whole demo (FDTD + nf2ff) takes 15 s.
