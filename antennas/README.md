# Structured antenna simulation (schema v1)

Simulations are JSON files: see [example_monopole.json](example_monopole.json).
Coordinates use **millimetres**; frequencies use **Hz**.

- \`materials\`: named \`pec\` or \`dielectric\` (requires \`epsilon\`, optional \`kappa_s_per_m\`).
- \`geometry\`: \`box\` or \`cylinder\` in 3D, attached to a named material.
- \`sources\`: lumped feed-port points (\`start\`, \`stop\`, axis \`direction\`, \`impedance_ohm\`). Version 1 accepts **one enabled source** and reports its S11 only.
- \`s11\`: list of inclusive sweeps (\`start\`, \`step\`, \`end\`, all in Hz). Frequencies are de-duplicated, sorted, and limited to the excitation bandwidth.
- \`radiation_pattern_frequencies_hz\`: requested frequencies in Hz. Samples are interpolated by the solver's frequency-domain NF2FF calculation, NOT separate narrowband FDTD solves.
- \`radiation_pattern_grid\`: angular sampling of the sphere. Theta 0…180° and phi 0…<360°.
- \`domain\`: simulation volume and boundary conditions; \`mesh\`: maximum smoothing step and cell-cap guard.

Outputs: \`result.json\` (S11 complex components, log magnitude in dB, phase in degrees, VSWR and normalized far-field directivity in dBi, plus radiation efficiency where available). \`pattern_*.json\` holds complete spherical samples; \`result.json\` references them.

### Running

\`\`\`bash
docker build -t radiators-openems -f docker/openems/Dockerfile .
mkdir -p results
docker run --rm --cpus=2 --memory=6g -v "$PWD:/work" radiators-openems \
  python antennas/simulate.py antennas/example_monopole.json --output results/example_monopole
python3 site/build_site.py --results results --site site/dist
\`\`\`

The CI workflow performs these steps automatically and uploads the result artifact.

### Conventions and limitations

- The reported far-field quantity is **directivity**, not gain. Directivity does not include feed mismatch or antenna efficiency. Efficiency is computed separately if possible. Do not label this as realized gain.
- Lossy dielectric \`kappa_s_per_m\` uses S/m and a constant value across frequency.
- PEC metals are ideal (no conductor skin effect). Mesh convergence, boundary distances, feed geometry and matching need engineering validation.
- A wire must have volume (cylinders with finite radius) rather than an infinitely thin mathematical curve in v1.
- The solver is a headless time-domain FDTD model; exact mesh/port coupling affects results significantly.
- GitHub Pages shows **generated results only**; it does not run the solver in the browser.
