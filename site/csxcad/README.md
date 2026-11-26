# CSXCAD editor

A parametric geometry editor for radiators **schema v2** antenna configs. It
edits the CSXCAD side of a simulation (geometry primitives, materials, ports,
domain, mesh and outputs) and saves the JSON that goes into `antennas/`.
Run lumped-port cases locally in the browser using openEMS WebAssembly. The native radiators scripts (`scripts/run_simulations.py`, `antennas/simulate_v2.py`, CI) remain available for other configurations.

Published at `https://winject-wireless.github.io/radiators/csxcad/`.

## What it does

- The CSXCAD primitives: box / sheet, cylinder, cylindrical shell, sphere,
  spherical shell, wire and polyhedron (vertices + faces). Helix and
  hemisphere are built-in scripts; the legacy shapes still open and convert. Transforms
  (rotate X→Y→Z, then translate) and CSXCAD priority.
- Lumped, coaxial and MSL ports (one excited), the four material types,
  domain + boundaries, mesh (with refinement boxes), excitation, S11 sweeps,
  far-field frequencies and solver resources.
- **Parametric modelling.** Any numeric field accepts a number, a parameter name
  (saved as `{"$param": "name"}`) or an expression (`{"$expr": "2*gap + 1"}`).
  Parameters have live sliders, rename updates every reference, and the
  **Sweep** panel edits `sweep` (product / zip, values / range) and previews any
  case. The **Array…** tool makes N copies offset by an expression step.
  `js/params.js` is a port of `scripts/sweep.py` and `check.mjs` proves both
  give the same values, so what you see is what the simulator resolves.
- Checks that mirror the input validation in `simulate_v2.py` (one excited
  port, unique IDs, geometry and ports inside the domain, materials, coax
  radii, S11 inside the excitation band…), run for every sweep case.
- Source / resolved JSON view, undo/redo, local draft autosave, drag & drop,
  bundled examples from `antennas/` and `examples/`.
- Configs that use a Python `generator` open, but their generated geometry only
  exists when the radiators scripts run.

## Geometry scripts

For geometry that is tedious to place by hand (element arrays, radials, meander
lines), write a script in the **Scripts** tab. A script declares its arguments,
each typed like a primitive input, and returns primitives:

```js
const args = {
  center:   { type: "point",  default: [0, 0, 0] },   // vec3 field + 3-axis gizmo
  count:    { type: "int",    default: 4, min: 3 },
  length:   { type: "length", default: 31 },           // mm
  material: { type: "material" },                      // defaults to the first material
};
function generate(a) {
  return Array.from({ length: a.count }, (_, i) => ({ shape: "cylinder", /* … */ }));
}
```

Argument types: `point`, `vector`, `length`, `number`, `int`, `angle`, `material`,
`choice` (with `options`), `bool`.

| Declaration key | Effect in the object editor |
|---|---|
| `type` | the control: point/vector → x y z (point also gets the 3-axis gizmo), length/number/int/angle → number box (mm / °), material/choice → dropdown, bool → checkbox |
| `default` | used when the object does not set a value; shown as placeholder text |
| `label` | row name (default: the key, capitalised) |
| `hint` | help text under the field |
| `more: true` | row sits under **More** unless the object sets a non-default value |
| `step` | snapping for drag handles and the point gizmo; ↑/↓ in a plain-number field nudges by one step (Shift ×10) |
| `min`, `max` | range checked when the script runs (error on the object and in Checks) |
| `options` | values of a `choice` dropdown |
| `handle` | drag diamond for a length/number: `{ from: <point arg>, dir: <vector arg> or [x,y,z], perp?, scale? }` | Each use is one object in Model
(`{"name", "script", "args"}`); its object editor is generated from the
declaration, argument values may be parameters or expressions, and clicking any
generated piece selects the whole object. Generated pieces are named
`<object>/<name or index>`; a piece without a material uses the first material
argument.

**Built-in scripts** ship with the editor and simulator and are used by name
without storing their source: `helix` (one Wire through the coil points),
`hemisphere` (dome or shell, one Polyhedron) and `tapered_cylinder` (frustum or
cone between two points, one Polyhedron; thickness 0 = solid, > 0 = hollow wall
measured inward). CSXCAD has none of these primitives; helix and hemisphere are
identical to the legacy `helix` / `hemisphere` / `hemispherical_shell`
shapes, which the simulator still accepts and the editor can convert (a
legacy transform is folded into center/axis). A length
argument can declare a drag handle, e.g.
`height: { type: "length", default: 24, handle: { from: "origin", dir: "axis" } }`
or `diameter: { …, handle: { from: "origin", dir: "axis", perp: true, scale: 2 } }`;
`dir` may also name a point argument (direction from `from` towards it).
Built-in names are reserved; use **Copy as new script** to customise one.

The script editor is CodeMirror 5 (vendored by `prepare.py`, loaded only when the
Scripts tab opens): line numbers, JavaScript highlighting, bracket matching and
autocomplete that knows the script API (`a.` → declared arguments, `type: "` →
argument types, `shape: "` → primitives, `Math.` → members; Ctrl+Space to open).
The maximize button gives it the whole window (desktop) or a full-height sheet
(phone); Esc restores.

Scripts are stored in the config under `scripts.<name>.source`. The simulator
expands them after resolving parameters (`scripts/sweep.py` runs
`scripts/geometry_scripts.mjs`, which needs Node.js); the editor runs the same
`js/scriptcore.js` in a Web Worker. Scripts get 2 s per run. See
`examples/script_radials_sweep.json`.

## Simulating in the browser

**Simulation → Run in browser** defaults to the CPU engine (experimental); Basic remains selectable. It simulates a single case on the device with openEMS
compiled to WebAssembly (`site/openems`, PR #20; copied into `vendor/openems` by
`prepare.py`). Nothing is uploaded. The results panel shows best S11, the −10 dB band,
Zin, Dmax / efficiency / realized gain, S11 / Zin / VSWR charts and three directivity
cuts per far-field frequency, and offers the run as `result.json` (the shape
`antennas/simulate_v2.py` writes). **Stop** ends the FDTD early and post-processes what
was computed. For sweeps, **Run all** queues a snapshot of the resolved cases and runs them sequentially to limit device memory. Completed results appear immediately in the fixed Results case selector; failed cases do not block the rest. **Stop** cancels the remaining queue and retains completed results. On phones, swipe left/right across the Results content to change cases while preserving the relative vertical scroll position. Case labels show only the swept variables, with complete parameters retained in the configuration. The compact layout uses consistent typography and spacing for panels, controls and viewport overlays. The More menu shows the deployed build hash, and the service worker revalidates the app shell without discarding local drafts or simulation results. Solver max timesteps and end criteria apply to both browser and native runs; advanced native CI CPU/memory settings are export-only. Successful results are saved locally in IndexedDB by exact resolved input and restored after a refresh, including each completed sweep case. Edited configs never reuse a mismatched result; interrupted jobs must be restarted. The browser may evict site storage or deny writes, so download important results as JSON.

- `js/sim/model.js` ports `simulate_v2.output_data()` up to the run (validation,
  materials, primitives, lumped ports, NF2FF box, excitation, boundaries) and
  `js/sim/mesh.js` ports CSXCAD's `SmoothMeshLines` and `setup_mesh`, so the XML matches
  the Python simulator: `tools/sim_parity.py` compares the mesh and every primitive with
  native CSXCAD for all repo configs, and `tools/sim_e2e.mjs` compares a wasm run with a
  native `result.json` (S11, Zin, Dmax, efficiency). `check.mjs` (CI) compares the dipole
  with the golden `site/openems/examples/dipole.xml`.
- Lumped ports only; MSL / coaxial ports and Python generators still need the radiators
  scripts.
- openEMS uses threads (SharedArrayBuffer), so the page must be cross-origin isolated:
  `sw.js` adds COOP / COEP headers and the page reloads once on the first visit. This
  works on https (GitHub Pages) and `http://localhost`; a plain-http LAN address cannot
  run simulations (serve it over https with the same headers instead). The editor waits until
  the new service worker actually controls the document before reloading. If isolation is
  blocked, open the editor directly in Chrome (not an embedded browser), or use **Retry isolation**
  in the Simulation panel. The native Android WebView may not expose SharedArrayBuffer.
- Large models are slow on phones; the dipole example (`examples/dipole_2450.json`,
  ~130k cells) is a quick test.

### Inspecting a radiation result

After a successful run, select a far-field frequency in the viewport. **XY, YZ,
XZ** show the exact intersections of the triangulated radiation surface with
the three principal planes through the origin. Each plane can be toggled
independently. **Follow point** moves all three enabled planes through the
sampling point instead.

The yellow sampling point reports its XYZ display coordinates, theta/phi,
interpolated directivity, gain (including radiation efficiency), realized gain
(including mismatch efficiency), and normalized E-field magnitude. Click the
point or **Sampling point** to attach the same three-axis translation gizmo as
the geometry editor. The readout follows the drag without editing the antenna
or invalidating simulation results. **Reset** returns to the peak direction;
**Point** hides or shows the probe. The marker has a fixed on-screen radius across camera zoom; the compact bottom readout shows directional metrics, with coordinates, angles, frequency and global efficiencies/power under **Point details**.

The pattern is an angular far-field representation, not a spatial field map.
The displayed radius and point distance in millimetres are illustrative; only
the direction from the origin determines the sampled gain. Directional values
at the origin or when data is unavailable are undefined. Radiation and mismatch
efficiencies are global metrics.

## Layout

Desktop: model tree | 3D view | inspector, with a Parameters / Checks / JSON
dock. Drag the horizontal grip above its tabs to resize it (double-click to reset, arrow keys to adjust); the height is remembered. Simulation has a compact run toolbar and grouped, collapsible setup cards. Results place the summary and download above responsive frequency-response and radiation chart grids. Phones (≤760 px): full-screen 3D view, bottom navigation, and each panel
as a bottom sheet (drag the handle up for full height, down to close; Android
back closes it). One finger orbits, two fingers zoom and pan, tap selects.

## Files

| File | Purpose |
|---|---|
| `index.html`, `app.css` | App shell and responsive layout |
| `js/params.js` | `$param` / `$expr` grammar, sweep expansion (port of `scripts/sweep.py`) |
| `js/schema.js` | Shapes, materials, ports and the parametric starter |
| `js/geometry.js` | Tessellation and solver bounds (port of `antennas/v2_geometry.py`) |
| `js/checks.js` | Pre-flight checks (from `antennas/simulate_v2.py`) |
| `js/viewport.js` | three.js view (Z up, picking, view presets) |
| `js/platform.js` | Save / share for browser, PWA and Capacitor |
| `prepare.py` | Vendors three.js 0.160.0, bundles examples, builds `www/` |
| `js/code-editor.js` | CodeMirror script editor and script-aware autocomplete |
| `js/scriptcore.js`, `js/script-worker.js` | Geometry scripts: argument types, expansion (shared with the simulator), worker runner |
| `js/sim/*.js` | In-browser simulation: mesh, openEMS model, run + post-processing, charts, run panel |
| `tools/sim_parity.py`, `tools/sim_e2e.mjs` | Parity with the native simulator (need native openEMS) |
| `check.mjs` | Node parity and smoke checks (run in CI) |

There is no bundler: plain ES modules plus an import map. `prepare.py` pins
three.js and downloads it once into `vendor/`, so no CDN is used at runtime.

## Run locally

```bash
cd site/csxcad
python3 prepare.py                         # vendor/ + examples/ + www/
python3 -m http.server 8080 --directory www   # open http://localhost:8080/
node check.mjs                             # parity with scripts/sweep.py
```

The Pages build (`site/build_site.py`) runs `prepare.py --out site/dist/csxcad`.

## Android

The app is offline-capable as a PWA: open it in Chrome on Android and use
**Install app**. For an APK, wrap `www/` with Capacitor (`capacitor.config.json`
is ready; JDK 17 and the Android SDK are needed):

```bash
cd site/csxcad
npm run android:init    # prepare.py, Capacitor 6 + filesystem/share plugins, `cap add android`
npm run android:sync    # after every web change
npm run android:open    # build / run from Android Studio
```

No code changes are needed for the wrapper. Inside Capacitor the app saves
through `@capacitor/filesystem` (Documents, falling back to the cache) and
opens the share sheet through `@capacitor/share`. The results-viewer links
point to the published site. `www/`, `android/` and `node_modules/` are not
committed.

### Workspace units

Open **More → Workspace units** to select default length, frequency, angle,
resistance, conductivity and memory units for the current document. These
preferences are stored as `workspace_units` in the saved antenna JSON. Numeric
fields accept e.g. `1 GHz`, `1000 MHz`, `{f_ghz * 1000} MHz` or a bare value in
the selected default. One trailing unit applies to the entire expression;
mixed-unit arithmetic within an expression is not supported. Parameters and
sweep values remain scalar, with units applied at the dimensional field.
The saved physical values remain in schema units (mm, Hz, degrees, Ω, S/m,
GiB, or metres for conducting sheet thickness). Expressions compile to ordinary
`$expr` values, so native CI and browser sweeps agree. Workspace display metadata
is removed from resolved cases and has no effect on cached simulation inputs.
