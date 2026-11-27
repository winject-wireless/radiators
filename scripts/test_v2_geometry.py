"""Regression tests for native schema-v2 cylinder transforms.

Run: python3 -m unittest discover -s scripts -p test_v2_geometry.py -v
The CSXCAD serialization test also runs when native bindings are installed.
"""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
from xml.etree import ElementTree

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "antennas"))
from v2_geometry import install_geometry, transformed


def cylinder(name, start, stop, shift=None):
    g = dict(name=name, shape="cylinder", material="copper",
             start=start, stop=stop, radius=2)
    if shift is not None:
        g["transform"] = {"translate": shift}
    return g


class CylinderTransformTests(unittest.TestCase):
    def test_yagi_endpoints_and_mesh_bounds(self):
        L, G = 47, 5
        cases = [
            ("driven", [0, 0, 0], [0, 0, (L-G)/2], [0, 0, G/2],
             [0, 0, 2.5], [0, 0, 23.5]),
            ("gnd", [0, 0, 0], [0, 0, -(L-G)/2], [0, 0, -G/2],
             [0, 0, -2.5], [0, 0, -23.5]),
            ("reflector", [0, 0, -L*1.06/2], [0, 0, L*1.06/2],
             [0, -L*.4, 0], [0, -18.8, -24.91], [0, -18.8, 24.91]),
            ("director", [0, 0, -L*.94/2], [0, 0, L*.94/2],
             [0, L*.35, 0], [0, 16.45, -22.09], [0, 16.45, 22.09]),
        ]
        for name, a, b, shift, expected_a, expected_b in cases:
            with self.subTest(name=name):
                material = Mock()
                lo, hi, preview = install_geometry(
                    material, cylinder(name, a, b, shift))
                material.AddCylinder.assert_called_once()
                x, y, r = material.AddCylinder.call_args.args
                self.assertEqual(r, 2)
                np.testing.assert_allclose(x, expected_a, atol=1e-12)
                np.testing.assert_allclose(y, expected_b, atol=1e-12)
                np.testing.assert_allclose(lo, np.minimum(expected_a, expected_b)-2)
                np.testing.assert_allclose(hi, np.maximum(expected_a, expected_b)+2)
                np.testing.assert_allclose(preview["start"], expected_a, atol=1e-12)
                np.testing.assert_allclose(preview["stop"], expected_b, atol=1e-12)

    def test_rotation_then_translation(self):
        g = {"transform": {"rotate_deg": [0, 90, 0], "translate": [1, 2, 3]}}
        np.testing.assert_allclose(transformed([[0, 0, 10]], g),
                                   [[11, 2, 3]], atol=1e-12)

    def test_absolute_coordinates_equivalence(self):
        a, b = Mock(), Mock()
        x = install_geometry(a, cylinder("reflector", [0, 0, -20],
                                         [0, 0, 20], [0, 18, 0]))
        y = install_geometry(b, cylinder("reflector", [0, 18, -20],
                                         [0, 18, 20]))
        self.assertEqual(a.AddCylinder.call_args, b.AddCylinder.call_args)
        for p, q in zip(x[:2], y[:2]):
            np.testing.assert_array_equal(p, q)
        self.assertEqual(x[2], y[2])

    @unittest.skipUnless(importlib.util.find_spec("CSXCAD"), "native CSXCAD not installed")
    def test_native_csxcad_serialization(self):
        from CSXCAD import ContinuousStructure
        with tempfile.TemporaryDirectory() as tmp:
            def serialize(g, filename):
                csx = ContinuousStructure()
                grid = csx.GetGrid()
                grid.SetDeltaUnit(1e-3)
                for axis in "xyz":
                    grid.AddLine(axis, [-50, 0, 50])
                install_geometry(csx.AddMetal("copper"), g)
                path = Path(tmp) / filename
                csx.Write2XML(str(path))
                nodes = ElementTree.parse(path).findall(".//Cylinder")
                self.assertEqual(len(nodes), 1)
                return nodes[0]

            shifted = serialize(cylinder("reflector", [0, 0, -20],
                                          [0, 0, 20], [0, 18, 0]), "shifted.xml")
            absolute = serialize(cylinder("reflector", [0, 18, -20],
                                           [0, 18, 20]), "absolute.xml")
            for tag, expected in (("P1", [0, 18, -20]), ("P2", [0, 18, 20])):
                for node in (shifted, absolute):
                    point = node.find(tag)
                    self.assertIsNotNone(point)
                    np.testing.assert_allclose([float(point.attrib[k]) for k in "XYZ"],
                                               expected, atol=1e-12)


if __name__ == "__main__":
    unittest.main()
