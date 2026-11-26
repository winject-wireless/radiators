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
[csxcad/README.md](csxcad/README.md). It does not run openEMS.
`editor.html` redirects to it (the older JSCAD editor was removed).
