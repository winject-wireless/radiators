"""Native diagnostic adapter regression tests (NumPy, h5py)."""
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
import numpy as np
import h5py

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"antennas"))
from v2_diagnostics import prepare, install, collect, read_dump


class DiagnosticTests(unittest.TestCase):
    def test_passive_current_transform_and_install(self):
        cfg={"probes":[{"name":"reflector","type":"current","start":[-4,-4,0],
                        "stop":[4,4,0],"direction":"z",
                        "transform":{"translate":[0,-18,5]}}]}
        p=prepare(cfg,np.array([-100]*3),np.array([100]*3))
        self.assertEqual(p[0]["start"],[-4,-22,5])
        self.assertEqual(p[0]["stop"],[4,-14,5])
        csx=Mock()
        install(csx,p)
        csx.AddProbe.assert_called_once_with("diag_000",1,norm_dir=2)
        csx.AddProbe.return_value.AddBox.assert_called_once_with([-4,-22,5],[4,-14,5])
        csx.AddExcitation.assert_not_called()

    def test_bad_plane_and_disabled(self):
        domain=np.array([-100]*3),np.array([100]*3)
        p={"name":"bad","type":"current","start":[0,0,0],"stop":[1,1,1]}
        with self.assertRaises(ValueError): prepare({"probes":[p]},*domain)
        self.assertEqual(prepare({"probes":[dict(p,enabled=False)]},*domain),[])

    def test_probe_samples_and_snapped_geometry(self):
        p=prepare({"probes":[{"name":"I","type":"current","start":[-5,-5,0],
                    "stop":[5,5,0],"direction":"-z"}]},np.array([-100]*3),np.array([100]*3))
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/"diag_000").write_text("% start-coordinates: (-0.004,-0.004,0.001) m\n% stop-coordinates: (0.004,0.004,0.001) m\n0 1\n1e-9 -2\n")
            result=collect(root,p)[0]
            self.assertNotIn("warning",result)
            self.assertEqual(result["sample_start"],[-4,-4,1])
            self.assertEqual(result["values"],[[-1],[2]])

    def test_legacy_and_new_hdf5_axis_order(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"dump.h5"
            for legacy in (False,True):
                with h5py.File(path,"w") as f:
                    f.attrs["openEMS_HDF5_version"]=0.2 if legacy else 0.3
                    for k,v in zip("xyz",([0,.001],[.002],[.003,.004,.005])):
                        f.create_dataset("Mesh/"+k,data=v)
                    arr=np.arange(18).reshape((3,2,1,3))
                    if legacy: arr=arr.transpose(0,3,2,1)
                    ds=f.create_dataset("FieldData/TD/000001",data=arr)
                    ds.attrs["time"]=1e-9
                record,n=read_dump(path,"td",1000)
                self.assertEqual(record["axes_mm"],[[0,1],[2],[3,4,5]])
                self.assertEqual(n,18)
                got=np.frombuffer(base64.b64decode(record["frames_f32"]),dtype="<f4").reshape(6,3)
                np.testing.assert_array_equal(got,np.arange(18).reshape(3,6).T)
                with self.assertRaises(ValueError): read_dump(path,"td",1)

if __name__=="__main__":
    unittest.main()
