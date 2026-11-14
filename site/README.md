# Radiators GitHub Pages result viewer

The site consumes JSON produced by the structured openEMS runner.
It uses Plotly from a public CDN for S11, VSWR, phase and rotatable
3D far-field **directivity**. No server is necessary.

**To publish:** GitHub repository → Settings → Pages → Build and deployment
→ Source: **GitHub Actions**. Merge the feature PR; a push to main will run
the simulator and publish the static viewer.

Proposed URL: https://winject-wireless.github.io/radiators/

Pull requests validate the simulator and upload artifacts without deploying.
The plot viewer does not execute openEMS in the browser.
