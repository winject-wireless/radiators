# Radiators GitHub Pages result viewer

The site consumes JSON produced by the structured openEMS runner.
It uses Plotly from a public CDN for S11, VSWR, phase and rotatable
3D far-field **directivity**. The 3D radius follows normalized far-field electric-field amplitude (20·log10(|E|/|E|max)) rather than power ratio, and is an arbitrary display radius: only geometry axes represent physical millimetres. No server is necessary.

**To publish:** GitHub repository → Settings → Pages → Build and deployment
→ Source: **GitHub Actions**. Merge the feature PR; a push to main will run
the simulator and publish the static viewer.

Proposed URL: https://winject-wireless.github.io/radiators/

Pull requests validate the simulator and upload artifacts without deploying.
The plot viewer does not execute openEMS in the browser.
