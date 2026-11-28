// Radiators schema v2 vocabulary: shapes, materials and ports as the
// simulator (antennas/simulate_v2.py + v2_geometry.py) understands them.
// Every numeric field accepts a number, a parameter name or an expression.

export const SHAPES = {
  box: {
    label: "Box / sheet", icon: "box",
    fields: [
      { key: "start", type: "vec3", label: "Start" },
      { key: "stop", type: "vec3", label: "Stop" },
    ],
    template: { start: [-10, -10, 0], stop: [10, 10, 1.6] },
    hint: "Axis-aligned. One zero-thickness axis makes a 2D sheet (required for conducting_sheet materials).",
  },
  cylinder: {
    label: "Cylinder", icon: "cylinder",
    fields: [
      { key: "start", type: "vec3", label: "Start (axis)" },
      { key: "stop", type: "vec3", label: "Stop (axis)" },
      { key: "radius", type: "num", unit: "mm", label: "Radius" },
    ],
    template: { start: [0, 0, 0], stop: [0, 0, 30], radius: 1 },
  },
  cylindrical_shell: {
    label: "Cylindrical shell", icon: "tube",
    fields: [
      { key: "start", type: "vec3", label: "Start (axis)" },
      { key: "stop", type: "vec3", label: "Stop (axis)" },
      { key: "radius", type: "num", unit: "mm", label: "Centerline radius" },
      { key: "thickness", type: "num", unit: "mm", label: "Wall thickness" },
    ],
    template: { start: [0, 0, 0], stop: [0, 0, 30], radius: 6, thickness: 0.5 },
  },
  sphere: {
    label: "Sphere", icon: "sphere",
    fields: [
      { key: "center", type: "vec3", label: "Center" },
      { key: "radius", type: "num", unit: "mm", label: "Radius" },
    ],
    template: { center: [0, 0, 10], radius: 5 },
  },
  spherical_shell: {
    label: "Spherical shell", icon: "sphere",
    fields: [
      { key: "center", type: "vec3", label: "Center" },
      { key: "radius", type: "num", unit: "mm", label: "Radius" },
      { key: "thickness", type: "num", unit: "mm", label: "Wall thickness" },
    ],
    template: { center: [0, 0, 10], radius: 8, thickness: 0.5 },
  },
  hemisphere: {
    label: "Hemisphere", icon: "dome",
    fields: [
      { key: "center", type: "vec3", label: "Center" },
      { key: "radius", type: "num", unit: "mm", label: "Outer radius" },
    ],
    template: { center: [0, 0, 0], radius: 10 },
    hint: "Local +Z half; orient with the transform. Tessellated into a polyhedron.",
  },
  hemispherical_shell: {
    label: "Hemispherical shell", icon: "dome",
    fields: [
      { key: "center", type: "vec3", label: "Center" },
      { key: "radius", type: "num", unit: "mm", label: "Outer radius" },
      { key: "thickness", type: "num", unit: "mm", label: "Wall thickness" },
    ],
    template: { center: [0, 0, 0], radius: 10, thickness: 0.5 },
  },
  wire: {
    label: "Wire (polyline)", icon: "wire",
    fields: [
      { key: "points", type: "points", label: "Points" },
      { key: "wire_diameter", type: "num", unit: "mm", label: "Wire diameter" },
    ],
    template: { points: [[0, 0, 0], [0, 0, 25]], wire_diameter: 1 },
    hint: "Native CSXCAD thin wire through the vertices (2–8001 points).",
  },
  polyhedron: {
    label: "Polyhedron (mesh)", icon: "mesh",
    fields: [],
    template: { vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] },
    hint: "Native CSXCAD Polyhedron: a closed mesh of vertices and faces (index lists). Usually produced by a script; edit the lists in JSON.",
  },
  helix: {
    label: "Helix", icon: "helix",
    fields: [
      { key: "origin", type: "vec3", label: "Origin" },
      { key: "axis", type: "vec3", label: "Axis", optional: true, default: [0, 0, 1] },
      { key: "diameter", type: "num", unit: "mm", label: "Coil diameter" },
      { key: "height", type: "num", unit: "mm", label: "Height" },
      { key: "turns", type: "num", label: "Turns" },
      { key: "wire_diameter", type: "num", unit: "mm", label: "Wire diameter" },
      { key: "phase_deg", type: "num", unit: "°", label: "Start phase", optional: true, default: 0 },
      { key: "segments_per_turn", type: "int", label: "Segments / turn", optional: true, default: 24 },
    ],
    template: { origin: [0, 0, 3], axis: [0, 0, 1], diameter: 22, height: 24, turns: 4, wire_diameter: 1.2 },
    hint: "One continuous native wire curve (segments/turn 8–80, ≤8000 segments).",
  },
};

export const MATERIALS = {
  pec: { label: "PEC (perfect conductor)", fields: [] },
  dielectric: {
    label: "Dielectric",
    fields: [
      { key: "epsilon", type: "num", label: "εr", default: 4.3 },
      { key: "kappa_s_per_m", type: "num", unit: "S/m", label: "κ (S/m)", optional: true, default: 0 },
    ],
  },
  conductive: {
    label: "Bulk conductor",
    fields: [{ key: "conductivity_s_per_m", type: "num", unit: "S/m", label: "σ (S/m)", default: 5.8e7 }],
  },
  conducting_sheet: {
    label: "Conducting sheet",
    fields: [
      { key: "conductivity_s_per_m", type: "num", unit: "S/m", label: "σ (S/m)", default: 5.8e7 },
      { key: "thickness_m", type: "num", unit: "m", label: "Thickness", default: 35e-6 },
    ],
  },
};

const AXES = ["x", "y", "z"];
export const PORTS = {
  lumped: {
    label: "Lumped port",
    fields: [
      { key: "start", type: "vec3", label: "Start" },
      { key: "stop", type: "vec3", label: "Stop" },
      { key: "direction", type: "select", options: AXES, label: "Direction" },
      { key: "impedance_ohm", type: "num", unit: "Ω", label: "Impedance", optional: true, default: 50 },
    ],
    template: { start: [0, 0, 0], stop: [0, 0, 3], direction: "z", impedance_ohm: 50 },
  },
  coaxial: {
    label: "Coaxial port",
    fields: [
      { key: "start", type: "vec3", label: "Start" },
      { key: "stop", type: "vec3", label: "Stop" },
      { key: "propagation_direction", type: "select", options: AXES, label: "Propagation" },
      { key: "metal_material", type: "material", filter: "pec", label: "Metal (PEC)" },
      { key: "dielectric_material", type: "material", filter: "dielectric", label: "Dielectric", optional: true },
      { key: "inner_radius", type: "num", unit: "mm", label: "Inner radius" },
      { key: "outer_inner_radius", type: "num", unit: "mm", label: "Shield inner radius" },
      { key: "outer_radius", type: "num", unit: "mm", label: "Shield outer radius" },
    ],
    template: { start: [0, 0, -10], stop: [0, 0, 0], propagation_direction: "z",
      inner_radius: 0.65, outer_inner_radius: 2.1, outer_radius: 2.5 },
  },
  msl: {
    label: "Microstrip (MSL) port",
    fields: [
      { key: "start", type: "vec3", label: "Start" },
      { key: "stop", type: "vec3", label: "Stop" },
      { key: "metal_material", type: "material", filter: "pec", label: "Metal (PEC)" },
      { key: "propagation_direction", type: "select", options: AXES, label: "Propagation" },
      { key: "excitation_direction", type: "select", options: AXES, label: "Excitation" },
    ],
    template: { start: [-5, -1.5, 0], stop: [5, 1.5, 1.6], propagation_direction: "x", excitation_direction: "z" },
  },
};

export const BOUNDARIES = ["PML_8", "PML_6", "PML_4", "MUR", "PEC", "PMC"];

// Independent offline/new-project starter; bundled examples retain their own configurations.
export const STARTER = {
  "schema_version": 2,
  "name": "2.45 GHz Dipole",
  "description": "Center-fed half-wave dipole. L is the total tip-to-tip length including the feed gap, r is the conductor radius, and gap is the feed gap. Tune L after simulation.",
  "units": "mm",
  "parameters": {
    "L": 58,
    "r": 1,
    "gap": 2
  },
  "domain": {
    "start": [
      -120,
      -120,
      -120
    ],
    "stop": [
      120,
      120,
      120
    ],
    "boundary": [
      "PML_8",
      "PML_8",
      "PML_8",
      "PML_8",
      "PML_8",
      "PML_8"
    ]
  },
  "mesh": {
    "max_cell_mm": 6,
    "growth_ratio": 1.4,
    "max_cells": 5000000,
    "refinements": [
      {
        "start": [
          -3,
          -3,
          {
            "$expr": "-L/2"
          }
        ],
        "stop": [
          3,
          3,
          {
            "$expr": "L/2"
          }
        ],
        "resolution_mm": 1
      },
      {
        "start": [
          -2,
          -2,
          {
            "$expr": "-gap/2"
          }
        ],
        "stop": [
          2,
          2,
          {
            "$expr": "gap/2"
          }
        ],
        "resolution_mm": 0.5
      }
    ]
  },
  "solver": {
    "max_timesteps": 50000,
    "end_criteria": 0.0001,
    "resources": {
      "cpus": 2,
      "memory_gib": 5
    }
  },
  "excitation": {
    "center_hz": 2450000000,
    "bandwidth_hz": 350000000
  },
  "materials": [
    {
      "name": "copper",
      "type": "pec"
    }
  ],
  "geometry": [
    {
      "name": "arm_negative",
      "shape": "cylinder",
      "material": "copper",
      "start": [
        0,
        0,
        {
          "$expr": "-L/2"
        }
      ],
      "stop": [
        0,
        0,
        {
          "$expr": "-gap/2"
        }
      ],
      "radius": {
        "$param": "r"
      }
    },
    {
      "name": "arm_positive",
      "shape": "cylinder",
      "material": "copper",
      "start": [
        0,
        0,
        {
          "$expr": "gap/2"
        }
      ],
      "stop": [
        0,
        0,
        {
          "$expr": "L/2"
        }
      ],
      "radius": {
        "$param": "r"
      }
    }
  ],
  "ports": [
    {
      "id": 1,
      "name": "feed",
      "type": "lumped",
      "start": [
        0,
        0,
        {
          "$expr": "-gap/2"
        }
      ],
      "stop": [
        0,
        0,
        {
          "$expr": "gap/2"
        }
      ],
      "direction": "z",
      "impedance_ohm": 50,
      "excite": true
    }
  ],
  "outputs": {
    "s11": [
      {
        "start": 2000000000,
        "step": 10000000,
        "end": 3000000000
      }
    ],
    "radiation_frequencies_hz": [
      2450000000
    ],
    "radiation_grid": {
      "theta_step_deg": 5,
      "phi_step_deg": 5
    },
    "include_realized_gain": true,
    "include_polarization": true
  }
};
