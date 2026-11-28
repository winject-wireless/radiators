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


## Generic parameter sweeps

A simulation remains one top-level `antennas/<simulation>.json` file. An optional
`sweep` expands it into independent antenna cases. The UI groups results by
**simulation → case**, hiding the case selector for a normal single-case simulation.

Start with [tests/fixtures/helix_sweep.json](../tests/fixtures/helix_sweep.json) for
parametric JSON primitives or
[tests/fixtures/racetrack_loop_sweep.json](../tests/fixtures/racetrack_loop_sweep.json)
for a programmatic racetrack wire generator. Both examples are **outside**
`antennas/` so they do not launch expensive FDTD jobs on every push.

### Defining parameters

```json
{
  "parameters": {"ground_radius_mm": 45},
  "sweep": {
    "mode": "product",
    "parameters": {
      "wire_mm": {"values": [1, 2, 3, 4]},
      "turns": {"range": {"start": 3, "stop": 5, "step": 1}}
    }
  }
}
```

`product` forms the Cartesian product of axes (here 12 cases).
`zip` pairs equal-length parameter arrays instead. Range values include the
start and stop when the step reaches the stop; otherwise the last value is
the final value that does not pass it. The maximum is 128 cases/config.
Fixed `parameters` apply to all cases. A config without `sweep` is one
`default` case and retains the normal output path.

For existing native CSXCAD geometry (boxes, wire curves, cylinders, helices,
ports, even mesh and domain coordinates), replace literal JSON values with
typed placeholders:

```json
{
  "wire_diameter": {"$param": "wire_mm"},
  "height": {"$expr": "turns * 6"},
  "radius": {"$expr": "ground_radius_mm / 2"}
}
```

`$expr` is a deliberately restricted numeric grammar: literals, named
parameters, +, -, *, /, %, **, parentheses, and
`min/max/abs/sqrt/sin/cos/tan/floor/ceil` and `pi/e`. No `eval`,
Python attribute access, imports, loops or arbitrary calls. Objects with
`$param` must contain only that key.

### Parametric geometry with Python

When the antenna topology itself changes (a racetrack curve, a Yagi with a
variable element count, or different feed-point construction), specify:

```json
"generator": {
  "language": "python",
  "path": "antennas/generators/racetrack_loop.py"
}
```

The trusted, repository-committed Python module must define
`generate(config, params) -> config`. It receives a copy of the base schema
and returns the **same schema** with generated `geometry`, `ports`, and
optionally mesh, domain or material sections. Typed placeholders are resolved
after the generator returns. The generator path is restricted to
`antennas/generators/<name>.py`. Only run trusted generator code.

**Why Python rather than OpenSCAD/JSCAD by default?** The solver needs
electrical materials, wire diameter, port directions and mesh constraints,
not just a CAD solid. A generic STL mesh conversion loses those electrical
semantics. Python reuses the existing CSXCAD JSON primitives without a CAD
dependency. OpenSCAD/JSCAD mesh import may be added as an optional geometry
source later, but still needs native feed/port annotations.

### Running and viewing

```bash
# Validate and list resolved cases without running openEMS:
python3 scripts/sweep.py tests/fixtures/racetrack_loop_sweep.json
python3 -m unittest discover -s scripts -p 'test_sweep.py' -v

# To run a sweep through the normal changed-config pipeline:
cp tests/fixtures/racetrack_loop_sweep.json antennas/racetrack_loop_sweep.json
printf 'antennas/racetrack_loop_sweep.json\n' > changed-antennas.txt
python3 scripts/run_simulations.py --list changed-antennas.txt --results results
```

Each expanded case has a reproducible `case_config.json`, solver log,
`result.json` and frequency patterns in
`results/<simulation>__case-0001/`, etc. Normal simulations still use
`results/<simulation>/`. Each result embeds simulation and case metadata
under `input_config.simulation` (source config, case parameters, ids).
The Pages manifest has `simulations[].cases[]` plus a legacy flat `runs`
index. The viewer presents **Simulation** and, only for sweep results, **Case**.

The scheduler applies its existing CPU/RAM limits to *each case*. It will not
rebuild the openEMS image unless the image cache is missing. Only changed
antenna definitions and sweeps affected by a changed generator are selected.
Changing a sweep axis invalidates the previous cases: the deployment restores
old cases for unchanged simulations but not for changed simulations.

A sample with 4 aspect ratios × 4 conductor diameters creates **16 FDTD
runs**. The racetrack example uses PEC (an idealized copper comparison), a
centered gap on the right straight section, and a localized mesh refinement;
results require mesh convergence and a physically validated feed model.
