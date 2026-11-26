"""Offline sweep tests: no Docker or openEMS required."""
import copy
import json
import math
from pathlib import Path
import unittest

from sweep import expand_cases, resolve_template

ROOT = Path(__file__).resolve().parents[1]


try:
    import numpy  # noqa: F401  (v2_geometry needs it; CI's validation step has no numpy)
    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False
needs_numpy = unittest.skipUnless(HAVE_NUMPY, "numpy not installed (simulator geometry module)")


class ScriptTests(unittest.TestCase):
    """JS geometry scripts expand to plain primitives before the simulator sees them."""

    def test_script_example_expands(self):
        path = ROOT / "examples" / "script_radials_sweep.json"
        config = json.loads(path.read_text())
        cases = expand_cases(config, path)
        self.assertEqual([c["parameters"]["n_radials"] for c in cases], [4, 8])
        for case in cases:
            cfg = case["config"]
            self.assertNotIn("scripts", cfg)
            names = [g["name"] for g in cfg["geometry"]]
            n = case["parameters"]["n_radials"]
            self.assertEqual(names, ["radiator"] + [f"ground/radial{i}" for i in range(1, n + 1)])
            for g in cfg["geometry"][1:]:
                self.assertEqual((g["shape"], g["material"]), ("cylinder", "pec-metal"))
                self.assertNotIn("script", g)

    def test_script_errors_are_reported(self):
        path = ROOT / "examples" / "script_radials_sweep.json"
        config = json.loads(path.read_text())
        bad = copy.deepcopy(config)
        bad["geometry"][1]["args"]["count"] = 2  # below the declared min of 3
        with self.assertRaisesRegex(ValueError, "count must be"):
            expand_cases(bad, path)
        bad = copy.deepcopy(config)
        bad["scripts"]["radials"]["source"] = "const args = {}; function generate() { while (true) {} }"
        bad["geometry"][1]["args"] = {}
        with self.assertRaisesRegex(ValueError, "timed out"):
            expand_cases(bad, path)

    @needs_numpy
    def test_builtin_helix_script_matches_legacy_helix_shape(self):
        import sys
        sys.path.insert(0, str(ROOT / "antennas"))
        from v2_geometry import helix_points
        path = ROOT / "examples" / "helix_sweep.json"
        legacy = json.loads(path.read_text())
        helix = legacy["geometry"][1]
        scripted = copy.deepcopy(legacy)
        scripted["geometry"][1] = {"name": helix["name"], "script": "helix", "args": {
            "origin": helix["origin"], "axis": helix["axis"], "diameter": helix["diameter"],
            "height": helix["height"], "turns": helix["turns"], "wire_diameter": helix["wire_diameter"],
            "segments_per_turn": helix["segments_per_turn"], "material": helix["material"]}}
        for old, new in zip(expand_cases(legacy, path), expand_cases(scripted, path)):
            wire = new["config"]["geometry"][1]
            self.assertEqual((wire["name"], wire["shape"]), ("helix/coil", "wire"))
            self.assertNotIn("scripts", new["config"])
            expected = helix_points(old["config"]["geometry"][1])
            self.assertEqual(len(wire["points"]), len(expected))
            for p, q in zip(wire["points"], expected):
                for a, b in zip(p, q):
                    self.assertAlmostEqual(a, b, places=9)

    @needs_numpy
    def test_builtin_hemisphere_is_the_legacy_mesh_as_a_polyhedron(self):
        import sys
        sys.path.insert(0, str(ROOT / "antennas"))
        from v2_geometry import hemisphere_mesh, install_geometry
        path = ROOT / "examples" / "helix_sweep.json"
        base = json.loads(path.read_text())
        for thickness in (0, 1.5):
            cfg = copy.deepcopy(base)
            cfg.pop("sweep")
            cfg["geometry"] = [{"name": "dome", "script": "hemisphere", "args": {
                "center": [1, 2, 3], "radius": 9, "thickness": thickness, "material": "pec-metal"}}]
            poly = expand_cases(cfg, path)[0]["config"]["geometry"][0]
            self.assertEqual(poly["shape"], "polyhedron")
            verts, faces = hemisphere_mesh(9, thickness or None)
            self.assertEqual(poly["faces"], [list(f) for f in faces])
            for p, q in zip(poly["vertices"], verts):
                for a, b in zip(p, q + [1, 2, 3]):
                    self.assertAlmostEqual(a, b, places=9)

            class Material:  # stands in for a CSXCAD material
                def AddPolyhedron(self, priority):
                    self.poly = Poly()
                    return self.poly

            class Poly:
                def __init__(self):
                    self.v, self.f = [], []

                def AddVertex(self, *v):
                    self.v.append(v)

                def AddFace(self, f):
                    self.f.append(f)

            mat = Material()
            lower, upper, preview = install_geometry(mat, poly)
            self.assertEqual((len(mat.poly.v), len(mat.poly.f)), (len(verts), len(faces)))
            self.assertAlmostEqual(upper[2], 12)
            self.assertAlmostEqual(lower[2], 3)

    @needs_numpy
    def test_builtin_tapered_cylinder_installs_as_polyhedron(self):
        import sys
        sys.path.insert(0, str(ROOT / "antennas"))
        from v2_geometry import install_geometry
        path = ROOT / "examples" / "helix_sweep.json"
        cfg = json.loads(path.read_text())
        cfg.pop("sweep")
        cfg["geometry"] = [{"name": "horn", "script": "tapered_cylinder", "args": {
            "start": [0, 0, 0], "stop": [0, 0, 40], "radius_start": 4, "radius_stop": 15,
            "thickness": 1, "material": "pec-metal"}}]
        poly = expand_cases(cfg, path)[0]["config"]["geometry"][0]
        self.assertEqual((poly["name"], poly["shape"]), ("horn/tube", "polyhedron"))

        class Material:
            def AddPolyhedron(self, priority):
                return self

            def AddVertex(self, *v):
                pass

            def AddFace(self, f):
                pass

        lower, upper, _ = install_geometry(Material(), poly)
        self.assertAlmostEqual(lower[2], 0)
        self.assertAlmostEqual(upper[2], 40)
        self.assertAlmostEqual(upper[0], 15, places=6)

    @needs_numpy
    def test_polyhedron_rejects_bad_faces(self):
        import sys
        sys.path.insert(0, str(ROOT / "antennas"))
        from v2_geometry import install_geometry
        g = {"shape": "polyhedron", "material": "m", "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
             "faces": [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 9]]}
        with self.assertRaisesRegex(ValueError, "valid vertex indices"):
            install_geometry(None, g)

    def test_builtin_names_are_reserved(self):
        path = ROOT / "examples" / "script_radials_sweep.json"
        config = json.loads(path.read_text())
        config["scripts"]["helix"] = {"source": "const args = {}; function generate() { return []; }"}
        with self.assertRaisesRegex(ValueError, "reserved"):
            expand_cases(config, path)

    def test_configs_without_scripts_are_unchanged(self):
        path = ROOT / "examples" / "helix_sweep.json"
        config = json.loads(path.read_text())
        for case in expand_cases(config, path):
            self.assertNotIn("scripts", case["config"])


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
        cfg["parameters"].update({"wire_mm": 2, "turns": 4})
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
