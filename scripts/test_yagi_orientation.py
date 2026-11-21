"""Geometric regression for the measured centered racetrack-loop Yagi.
Run with: python3 -m unittest discover -s scripts -p 'test_yagi_orientation.py' -v
"""
import json
from math import hypot
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "antennas/yagi_16rod_bonded_boom_measured_loop_best_p24_f24_b36_y14_fine_2450.json"


class CenteredYagiLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(CONFIG.read_text(encoding="utf-8"))
        cls.geometry = cls.config["geometry"]

    def test_loop_aperture_normal_to_boom_and_long_axis_parallel_rods(self):
        loop = next(g for g in self.geometry if g["shape"] == "wire" and "loop" in g["name"])
        pts = loop["points"]
        xs, ys, zs = [p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts]
        self.assertTrue(all(abs(x - 360) < 1e-5 for x in xs), "Loop must lie in the YZ plane")
        self.assertAlmostEqual((min(ys) + max(ys)) / 2, 0, places=4)
        self.assertAlmostEqual((min(zs) + max(zs)) / 2, 0, places=4)
        self.assertAlmostEqual(max(ys) - min(ys) + loop["wire_diameter"], 33.4, places=3)
        self.assertAlmostEqual(max(zs) - min(zs) + loop["wire_diameter"], 57.9, places=3)
        self.assertGreater(max(zs) - min(zs), max(ys) - min(ys))
        rods = [g for g in self.geometry if re.fullmatch(r"director-\d\d|reflector-01", g["name"])]
        self.assertEqual(len(rods), 16)
        for rod in rods:
            self.assertEqual(rod["start"][:2], rod["stop"][:2],
                             f'{rod["name"]} must be Z-aligned')
        self.assertEqual(loop["wire_diameter"], 4)

    def test_loop_and_feed_clear_bonded_metal_boom(self):
        loop = next(g for g in self.geometry if g["shape"] == "wire" and "loop" in g["name"])
        boom = next(g for g in self.geometry if g["name"] == "square-aluminum-boom-bonded")
        self.assertEqual(boom["start"][1:], [-8, -8])
        self.assertEqual(boom["stop"][1:], [8, 8])
        wire_radius = loop["wire_diameter"] / 2
        def clearance(y, z):
            return hypot(max(abs(y) - 8, 0), max(abs(z) - 8, 0)) - wire_radius
        # Segment sampling catches a conductor clipping the boom between
        # polygon vertices, not just directly at the vertices.
        for a, b in zip(loop["points"], loop["points"][1:]):
            for i in range(11):
                t = i / 10
                y = a[1] * (1 - t) + b[1] * t
                z = a[2] * (1 - t) + b[2] * t
                self.assertGreater(clearance(y, z), 0,
                                   f"Loop shorts the boom near Y={y}, Z={z}")
        port = self.config["ports"][0]
        self.assertEqual(port["direction"], "z")
        self.assertEqual(port["start"], [360, 14.4, -4])
        self.assertEqual(port["stop"], [360, 14.4, 4])
        self.assertEqual([loop["points"][-1][2], loop["points"][0][2]], [-4, 4])
        for edge, conductor in zip((port["start"], port["stop"]),
                                   (loop["points"][-1], loop["points"][0])):
            self.assertLess(hypot(edge[0]-conductor[0], edge[1]-conductor[1]), wire_radius)
        self.assertGreater(clearance(port["start"][1], 0), 0)

    def test_loop_station_unchanged(self):
        boom = next(g for g in self.geometry if g["name"] == "square-aluminum-boom-bonded")
        director = next(g for g in self.geometry if g["name"] == "director-15")
        reflector = next(g for g in self.geometry if g["name"] == "reflector-01")
        self.assertEqual(boom["start"][0], -32)
        self.assertEqual(boom["stop"][0], 408)
        self.assertEqual(director["start"][0], 336)
        self.assertEqual(reflector["start"][0], 396)
        self.assertEqual(self.config["mesh"]["uniform_step_mm"], 1.6)


if __name__ == "__main__":
    unittest.main()
