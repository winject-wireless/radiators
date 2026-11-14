# Structured openEMS antenna simulations

Each antenna has a separate \`antennas/*.json\` file. The simulator accepts
schema v1 and schema v2. Lengths are millimetres; frequencies are Hz;
conductivity is S/m except conducting-sheet thickness, which is **metres**.

## Schema v2

See [example_helix_v2.json](example_helix_v2.json). The key sections are:

| JSON section | Meaning |
|---|---|
| \`materials\` | \`pec\`, \`dielectric\` (epsilon, kappa_s_per_m), \`conductive\` (conductivity_s_per_m), \`conducting_sheet\` (conductivity_s_per_m, thickness_m) |
| \`geometry\` | \`box\`, \`cylinder\`, \`cylindrical_shell\`, \`sphere\`, \`spherical_shell\`, \`hemisphere\`, \`hemispherical_shell\`, \`wire\`, or \`helix\` |
| \`transform\` | Optional \`{"rotate_deg":[roll,pitch,yaw],"translate":[x,y,z]}\`, rotation X then Y then Z |
| \`ports\` | \`lumped\`, \`coaxial\`, or \`msl\` feed and passive ports. **Exactly one port is excited** per run |
| \`mesh\` | \`max_cell_mm\` (also accepts \`resolution_mm\`), \`growth_ratio\`, optional \`local_min_cell_mm\` and list of local \`refinements\` |
| \`solver.resources\` | Per-antenna Docker resource request \`{"cpus":2,"memory_gib":5}\` |
| \`outputs.s11\` | List of inclusive sweeps \`[{ "start":..., "step":..., "end":... }]\` |
| \`outputs.radiation_frequencies_hz\` | List of NF2FF frequencies in Hz |
| \`outputs\` | Optional \`include_polarization\`, \`include_impedance\`, \`include_realized_gain\`, \`radiation_grid\` angular step sizes |

Examples of geometry-specific fields:

- Wire: \`points\` is a list of XYZ points, \`wire_diameter\` in mm. CSXCAD's native finite-radius wire primitive is used.
- Helix: \`origin\`, \`axis\`, \`diameter\`, \`height\`, \`turns\`, \`wire_diameter\`; optional \`phase_deg\`, \`segments_per_turn\`. This is a **true single continuous curve**, not disconnected cylinders.
- Cylindrical shell: \`start\`, \`stop\`, centerline \`radius\`, \`thickness\` in mm.
- Spherical shell: \`center\`, \`radius\`, \`thickness\` in mm.
- Hemisphere / hemispherical shell: \`center\`, outer \`radius\`, optional \`thickness\`; local positive Z hemisphere, transformed with \`transform\`. These are tessellated into triangular polyhedra.
- Conducting sheet: must be a zero-thickness 2D box. CSXCAD's conducting-sheet model is for thin sheets, not bulk wire geometry.
- Coaxial port: \`metal_material\` referencing PEC, optional \`dielectric_material\`, \`propagation_direction\`, and \`inner_radius\`, \`outer_inner_radius\`, \`outer_radius\`.
- MSL port: \`metal_material\` referencing PEC, \`propagation_direction\`, \`excitation_direction\`. The stripline and substrate must be modeled correctly.

## Outputs

\`result.json\` includes complex S11 (real and imaginary), logarithmic magnitude,
phase, VSWR, complex input impedance, and \`geometry_preview\`. Each
\`pattern_<frequency>Hz.json\` includes the spherical directivity grid (dBi),
radiation efficiency, mismatch efficiency, and optionally complex
\`E_theta\` / \`E_phi\` components and **realized gain** grids.

Realized gain is computed from directivity × radiation efficiency × mismatch
efficiency, where mismatch efficiency is \`1 - |S11|²\` at that frequency.
The result requires a valid port and validated solver convergence.

## Run locally

\`\`\`bash
docker build -t radiators-openems:ci -f docker/openems/Dockerfile .
docker run --rm -v "$PWD:/work" radiators-openems:ci \
  python antennas/simulate.py antennas/example_helix_v2.json \
  --output results/example_helix_v2
\`\`\`

In GitHub Actions, only modified antenna configurations are selected. Each
simulation is scheduled independently using requested CPU and RAM budgets,
including a reserved RAM margin, and the Docker image is restored from a
versioned workflow artifact when available.

## Important engineering limitations

- Schema v2 defines multiple ports, but only **one is excited per FDTD run**;
  it exports S11 of that active port, **not a complete multiport S matrix**.
- Bulk conductivity models have skin-depth / mesh-convergence requirements.
  Do not simply set copper conductivity for a millimetre-scale wire and
  assume an accurate GHz surface-current simulation. Use PEC for ideal-conductor
  comparisons and validate any finite-conductor model carefully.
- A triangulated hemispherical shell is an approximation with discrete faces.
  For very thin metal shells, the mesh resolution may not resolve the thickness.
- Mesh refinement controls provide grid constraints, **not automatic mesh
  convergence**. Independently repeat simulations at finer resolution.
- The radiation-pattern surface in the viewer is scaled for illustration;
  its radius is not a physical length.
- openEMS NF2FF output is a far-field model; translating the displayed 2D
  cutting plane does not change electromagnetic far-field results.
- The output is not a substitute for measurements or RF regulatory certification.
