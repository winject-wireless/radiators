"""Native reference for the wasm comparison.

Runs antennas/simulate_v2.py on a config with a native openEMS build and also
writes the openEMS XML that the run used (model.xml) and the NF2FF box
geometry (nf2ff.json), so test/compare.mjs can run the same model in wasm.

Write2XML rounds coordinates to 7 digits, which can move a box onto another
mesh line (the NF2FF box, for one). So the native binary also runs model.xml
itself (xmlrun/): compare.mjs checks the wasm field data against that run, and
the port results (unaffected) against the Python flow's result.json.

  LD_LIBRARY_PATH=.native/opt/lib .native/venv/bin/python test/make_reference.py \
      test/dipole_v2.json .ref/dipole
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "antennas"))

import openEMS  # noqa: E402
import simulate_v2  # noqa: E402

config_path, out = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
timing = {}

Base = openEMS.openEMS  # the class; simulate_v2 does "from openEMS import openEMS"


class Recording(Base):
    def Run(self, sim_path, *a, **kw):
        self.Write2XML(str(out / "model.xml"))
        t0 = time.time()
        try:
            return super().Run(sim_path, *a, **kw)
        finally:
            timing["fdtd_s"] = time.time() - t0

    def CreateNF2FFBox(self, *a, **kw):
        box = super().CreateNF2FFBox(*a, **kw)
        (out / "nf2ff.json").write_text(json.dumps({
            "name": box.name, "start": list(map(float, box.start)), "stop": list(map(float, box.stop)),
            "mirror": list(box.mirror), "e_file": box.e_file, "h_file": box.h_file}))
        return box


openEMS.openEMS = Recording

simulate_v2.output_data(json.loads(config_path.read_text()), out)
(out / "timing.json").write_text(json.dumps(timing))
print("native fdtd", timing)

# the same XML through the native binary (openEMS next to the Python bindings)
xmlrun = out / "xmlrun"
xmlrun.mkdir(exist_ok=True)
(xmlrun / "model.xml").write_text((out / "model.xml").read_text())
native_bin = Path(os.environ.get("OPENEMS_BIN", Path(__file__).resolve().parents[1] / ".native/opt/bin/openEMS"))
t0 = time.time()
subprocess.run([str(native_bin), "model.xml"], cwd=xmlrun, check=True, stdout=subprocess.DEVNULL)
timing["xmlrun_s"] = time.time() - t0
(out / "timing.json").write_text(json.dumps(timing))
print("native xml run", timing)
