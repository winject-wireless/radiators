# CSXCAD editor

A parametric geometry editor for radiators **schema v2** antenna configs. It
edits the CSXCAD side of a simulation (geometry primitives, materials, ports,
domain, mesh and outputs) and saves the JSON that goes into `antennas/`.
**It does not simulate.** The radiators scripts (`scripts/run_simulations.py`,
`antennas/simulate_v2.py`, CI) are still the simulator.

Published at `https://winject-wireless.github.io/radiators/csxcad/`.

## What it does

- All schema v2 shapes: box / sheet, cylinder, cylindrical shell, sphere,
  spherical shell, hemisphere, hemispherical shell, wire, helix. Transforms
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

## Layout

Desktop: model tree | 3D view | inspector, with a Parameters / Checks / JSON
dock. Phones (≤760 px): full-screen 3D view, bottom navigation, and each panel
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
