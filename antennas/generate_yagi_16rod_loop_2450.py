#!/usr/bin/env python3
"""Regenerate yagi_16rod_loop_2450.json after editing layout dimensions."""
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "yagi_16rod_loop_2450.json"


def generate():
    # Photo-derived baseline; reflector + 15 directors + folded-loop feed.
    cx, rx, rz = 390.0, 11.0, 28.0
    half_gap = 2.0
    delta = math.asin(half_gap / rz)
    loop_points = [[round(cx+rx*math.cos(a), 5), 0,
                    round(rz*math.sin(a), 5)]
                   for a in (delta+(2*math.pi-2*delta)*j/96 for j in range(97))]
    feed_x = 401.0  # exact x-grid plane; within 0.03 mm of the wire terminals
    directors = []
    for i in range(15):
        x = float(26*i)
        length = round(49.8+3.6*i/14, 2)
        directors.append(dict(name=f"director-{i+1:02d}", shape="cylinder",
                              material="pec", start=[x, 0, -length/2],
                              stop=[x, 0, length/2], radius=1.5))
    cfg = dict(
        schema_version=2,
        name="2.45GHz 16-rod loop-excited Yagi from reference photo",
        description="EXPERIMENTAL: photo-inspired 16 straight rods + oval loop, 2.45 GHz. Converged openEMS baseline FAILED: peak realized gain -2.45 dBi, forward -X gain -11.47 dBi, S11 -1.16 dB, VSWR 14.97, pattern peaks sideways. Do not fabricate. Ideal PEC, no boom/coax/balun.",
        units="mm",
        domain=dict(start=[-121,-96,-100], stop=[545,96,100], boundary=["PML_8"]*6),
        mesh=dict(grid_mode="uniform", uniform_step_mm=2, max_cell_mm=2,
                  growth_ratio=1.35, max_cells=3800000),
        solver=dict(max_timesteps=20000, end_criteria=0.0001, resources=dict(cpus=2, memory_gib=5)),
        excitation=dict(center_hz=2450000000, bandwidth_hz=200000000),
        materials=[dict(name="pec", type="pec")],
        geometry=[*directors,
                  dict(name="elliptical-folded-loop-driven", shape="wire", material="pec", points=loop_points, wire_diameter=1.8),
                  dict(name="rear-reflector", shape="cylinder", material="pec", start=[416,0,-31], stop=[416,0,31], radius=1.5)],
        ports=[dict(id=1, name="loop-feed-50ohm-ideal", type="lumped", impedance_ohm=50,
                    direction="z", start=[feed_x,0,-half_gap], stop=[feed_x,0,half_gap], excite=True)],
        outputs=dict(s11=[dict(start=2350000000, step=5000000, end=2550000000)],
                     radiation_frequencies_hz=[2400000000,2450000000,2500000000],
                     include_polarization=True, include_impedance=True, include_realized_gain=True,
                     radiation_grid=dict(theta_step_deg=3, phi_step_deg=5)))
    return cfg

if __name__ == "__main__":
    OUT.write_text(json.dumps(generate(), indent=2)+"\n")
    print(f"Wrote {OUT}")
