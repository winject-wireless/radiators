"""Offline sweep tests: no Docker or openEMS required."""
import copy
import json
import math
from pathlib import Path
import unittest

from sweep import expand_cases, resolve_template

ROOT = Path(__file__).resolve().parents[1]


class SweepTests(unittest.TestCase):
    def example(self, filename):
        path = ROOT / "examples" / filename
        return json.loads(path.read_text()), path

    def test_racetrack_sweep(self):
        config, path = self.example("racetrack_loop_sweep.json")
        cases = expand_cases(config, path)
        self.assertEqual(len(cases), 16)
        self.assertEqual(cases[0]["case_id"], "case-0001")
        self.assertEqual(cases[-1]["case_id"], "case-0016")
        self.assertEqual({c["parameters"]["conductor_mm"] for c in cases},
                         {1, 2, 3, 4})
        self.assertEqual({c["parameters"]["aspect_ratio"] for c in cases},
                         {1.4, 1.6, 1.8, 2.0})
        for case in cases:
            cfg = case["config"]
            self.assertEqual(cfg["schema_version"], 2)
            self.assertNotIn("generator", cfg)
            self.assertNotIn("sweep", cfg)
            self.assertEqual(cfg["simulation"]["id"], path.stem)
            self.assertEqual(cfg["simulation"]["case_id"], case["case_id"])
            wire = cfg["geometry"][0]
            self.assertEqual(wire["wire_diameter"], case["parameters"]["conductor_mm"])
            self.assertGreater(len(wire["points"]), 90)
            port = cfg["ports"][0]
            self.assertEqual(port["start"][2], -port["stop"][2])
            self.assertEqual(port["start"][0], port["stop"][0])
            for actual, expected in zip(wire["points"][0], port["stop"]):
                self.assertAlmostEqual(actual, expected)
            for actual, expected in zip(wire["points"][-1], port["start"]):
                self.assertAlmostEqual(actual, expected)
            physical_gap = port["stop"][2] - port["start"][2] - wire["wire_diameter"]
            self.assertAlmostEqual(physical_gap, 4)
            self.assertEqual(port["impedance_ohm"], 50)
            self.assertTrue(port["excite"])

    def test_json_expression(self):
        config, path = self.example("helix_sweep.json")
        cases = expand_cases(config, path)
        self.assertEqual(len(cases), 4)
        self.assertEqual([c["config"]["geometry"][1]["height"] for c in cases],
                         [18, 24, 18, 24])
        self.assertEqual([c["config"]["geometry"][1]["wire_diameter"] for c in cases],
                         [1, 1, 2, 2])
        self.assertEqual(resolve_template({"x": {"$expr": "sqrt(4)+pi"}},
                          {})["x"], 2+math.pi)

    def test_unsafe_expression_rejected(self):
        for expr in ("__import__('os').system('echo dangerous')",
                     "foo.bar", "[1][0]", "pow(2,9999)", "2**1000",
                     "1/0", "unknown+1", "sqrt(-1)"):
            with self.subTest(expr=expr):
                with self.assertRaises((ValueError, OverflowError)):
                    resolve_template({"$expr": expr}, {})

    def test_cartesian_cap(self):
        cfg, path = self.example("helix_sweep.json")
        cfg["sweep"]["parameters"]["wire_mm"]["values"] = list(range(1, 100))
        cfg["sweep"]["parameters"]["turns"]["values"] = [3, 4]
        cfg["sweep"]["parameters"]["turns"].pop("range", None)
        with self.assertRaisesRegex(ValueError, "maximum"):
            expand_cases(cfg, path)

    def test_zip_and_nonsweep(self):
        cfg, path = self.example("helix_sweep.json")
        cfg["sweep"]["mode"] = "zip"
        self.assertEqual(len(expand_cases(cfg, path)), 2)
        cfg.pop("sweep")
        cfg["parameters"] = {"wire_mm": 2, "turns": 4}
        result = expand_cases(cfg, path)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["case_id"], "default")
        self.assertEqual(result[0]["output_name"], path.stem)

    def test_invalid_generator_and_duplicate_axis(self):
        cfg, path = self.example("helix_sweep.json")
        cfg["generator"] = {"language": "python",
                            "path": "../untrusted.py"}
        with self.assertRaisesRegex(ValueError, "Generator path"):
            expand_cases(cfg, path)
        cfg.pop("generator")
        cfg["sweep"]["parameters"]["turns"] = {"values": [4, 4]}
        with self.assertRaisesRegex(ValueError, "duplicate"):
            expand_cases(cfg, path)


if __name__ == "__main__":
    unittest.main()
