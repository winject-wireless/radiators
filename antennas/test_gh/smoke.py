"""Small headless openEMS/CSXCAD FDTD execution smoke test.

Not a calibrated antenna model; verifies the solver actually runs and
produces on-disk simulation data. Antenna models can replace this later.
"""
from pathlib import Path
import json
import numpy as np
from CSXCAD import CSXCAD
from openEMS import openEMS

out = Path('/work/results/test_gh')
out.mkdir(parents=True, exist_ok=True)

fdtd = openEMS(NrTS=100, EndCriteria=1e-2)
fdtd.SetGaussExcite(2.45e9, 0.25e9)
fdtd.SetBoundaryCond(['MUR'] * 6)
csx = CSXCAD.ContinuousStructure()
fdtd.SetCSX(csx)
mesh = csx.GetGrid()
mesh.SetDeltaUnit(1e-3)
for axis in 'xyz':
    mesh.SetLines(axis, np.linspace(-50, 50, 21))
metal = csx.AddMetal('PEC_plate')
metal.AddBox([-10, -10, -5], [10, 10, -5])
fdtd.AddLumpedPort(1, 50.0, [-5, -5, -5], [5, 5, 5], 'z', 1.0)
fdtd.Run(str(out / 'simulation'), cleanup=True, verbose=1)
(out / 'summary.json').write_text(json.dumps({
    'test': 'openems_headless_smoke', 'frequency_hz': 2450000000,
    'purpose': 'verify solver execution, not antenna performance',
    'status': 'completed'
}, indent=2))
print('Simulation completed:', out)
