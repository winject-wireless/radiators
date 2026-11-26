# Radiators GitHub Pages result viewer

The site consumes JSON produced by the structured openEMS runner.
It uses Plotly from a public CDN for S11, VSWR, phase and rotatable
3D far-field **directivity**. The 3D radius follows normalized far-field electric-field amplitude (20·log10(|E|/|E|max)) rather than power ratio. The **Pattern size** slider multiplies only the rendered field-surface radius (0.25×–4×); it does not change S11, radiation efficiency, directivity, or physical antenna dimensions. Pattern size is arbitrary and is not a distance in millimetres, even when overlaid on millimetre geometry. Only the geometry axes represent physical millimetres. No server is necessary.

Published results are reused only if their full saved antenna configuration matches the current source configuration (ignoring bookkeeping-only simulation metadata). This prevents an old Yagi radiation pattern from appearing alongside a corrected, rotated-loop geometry without rerunning openEMS.

**To publish:** GitHub repository → Settings → Pages → Build and deployment
→ Source: **GitHub Actions**. Merge the feature PR; a push to main will run
the simulator and publish the static viewer.

Proposed URL: https://winject-wireless.github.io/radiators/

Pull requests validate the simulator and upload artifacts without deploying.
The plot viewer does not execute openEMS in the browser.


## Parametric CSXCAD editor

`csxcad/` is a mobile- and desktop-friendly geometry editor for schema v2
configs with parametric modelling (`$param` / `$expr` fields, parameter
sliders, sweep cases). It is installable as a PWA and is ready to wrap as an
Android app with Capacitor. The build publishes it at `csxcad/`. See
[csxcad/README.md](csxcad/README.md). Like the JSCAD editor, it does not run openEMS.

## JSCAD antenna editor

The published site includes `editor.html` (linked from the result viewer).
This is a local-browser antenna geometry editor, distinct from openEMS results:

- Imports/exports existing `schema_version: 2` antenna configuration JSON.
  Existing materials, ports, mesh, domain, solver and output settings survive
  a round trip. The full-JSON editor exposes these settings.
- Each `geometry[]` component retains a human-readable `name` plus an
  `editor_id` stable across rename and geometry edits. JSCAD `geom3` objects
  themselves have no durable name property; identity remains in the document.
- Supports inspector edits for `box`, `cylinder`, `sphere`, `wire`,
  and `helix` components, plus adding, duplicating, hiding and deleting.
  The 3D preview is computed with JSCAD v2 and displayed with Plotly.
- Exports a standalone `.jscad` script with `main()` and the named
  components stored in `config.geometry`. Hidden parts are still exported.
- Length units are millimetres. Rotations apply X then Y then Z. A
  zero-thickness CSXCAD box gets a display-only 0.05 mm thickness in JSCAD.
  Native CSXCAD wires are approximated by tubes in the editor and JSCAD export;
  the simulation JSON always preserves the original wire vertices.
- This is a geometry editor, **not** an openEMS simulator. It does not calculate
  S11, radiation efficiency or patterns. Validate port placements and
  mesh-convergence before using exported JSON for any new simulation.
- The current inspector supports the five common solid/curve types above;
  other v2 geometry shapes are still valid for the solver but will need
  preview support before importing into this editor.

JSCAD's modeling kernel is pinned and bundled at Pages build time, alongside
Plotly, so the published editor does not depend on a runtime CDN.
Run `node site/check_editor.js` to check model naming and JSCAD-source export.
The Pages CI also checks `node site/check_editor.js site/dist`, which exercises
actual geometry generation using the shipped JSCAD bundle.
