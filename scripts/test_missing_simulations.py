"""Regression checks for incomplete production Pages deployments (no FDTD)."""
import json
from pathlib import Path
import tempfile
import unittest

from result_inventory import case_complete
from select_missing_simulations import select_configs
from sweep import expand_cases


class MissingSimulationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.antennas = self.root / "antennas"
        self.antennas.mkdir()
        self.results = self.root / "results"
        self.results.mkdir()
        self.single = self._config("single", None)
        self.sweep = self._config("sweep", {
            "mode": "product", "parameters": {"diameter": {"values": [1, 2]}}
        })

    def _config(self, name, sweep):
        path = self.antennas / (name + ".json")
        cfg = {
            "schema_version": 2, "name": name, "units": "mm",
            "materials": [{"name": "pec", "type": "pec"}],
            "geometry": [{
                "name": "wire", "shape": "wire", "material": "pec",
                "wire_diameter": {"$param": "diameter"} if sweep else 1,
                "points": [[0, 0, 0], [0, 0, 20]]
            }]
        }
        if sweep:
            cfg["sweep"] = sweep
        path.write_text(json.dumps(cfg))
        return path

    def _cases(self, path):
        return expand_cases(json.loads(path.read_text()), path)

    def _write_result(self, case, legacy=False):
        folder = self.results / case["output_name"]
        folder.mkdir(parents=True, exist_ok=True)
        result = {
            "name": case["config"]["name"],
            "input_config": {key: val for key, val in case["config"].items()
                             if key != "simulation"} if legacy else case["config"],
            "s11": {
                "frequency_hz": [2.45e9],
                "logmag_db": [-10], "phase_deg": [5], "vswr": [1.9]
            },
            "patterns": [{"frequency_hz": 2450000000,
                          "file": "pattern_2450000000Hz.json"}]
        }
        (folder / "result.json").write_text(json.dumps(result))
        pattern = {
            "frequency_hz": 2450000000,
            "theta_deg": [0, 180], "phi_deg": [0, 180],
            "directivity_dbi": [[1, 2], [1, 2]]
        }
        (folder / "pattern_2450000000Hz.json").write_text(json.dumps(pattern))

    def test_missing_on_main_and_not_on_pr(self):
        config_paths = [self.single, self.sweep]
        pr, pr_missing = select_configs(config_paths, self.results, include_missing=False)
        self.assertEqual(pr, [])
        self.assertEqual(pr_missing, [])
        main, missing = select_configs(config_paths, self.results, include_missing=True)
        self.assertEqual(set(main), {p.as_posix() for p in config_paths})
        self.assertEqual(len(missing), 3)

    def test_existing_legacy_single_result_is_reused(self):
        case = self._cases(self.single)[0]
        self._write_result(case, legacy=True)
        self.assertTrue(case_complete(case, self.results))
        selected, missing = select_configs([self.single], self.results, include_missing=True)
        self.assertEqual(selected, [])
        self.assertEqual(missing, [])

    def test_partial_sweep_reruns_only_missing_case(self):
        cases = self._cases(self.sweep)
        self._write_result(cases[0])
        self.assertTrue(case_complete(cases[0], self.results))
        self.assertFalse(case_complete(cases[1], self.results))
        selected, missing = select_configs([self.sweep], self.results, include_missing=True)
        self.assertEqual(selected, [self.sweep.as_posix()])
        self.assertEqual(missing, [(self.sweep.as_posix(), "case-0002")])

    def test_incomplete_case_schedules_regeneration(self):
        case = self._cases(self.single)[0]
        self._write_result(case)
        (self.results / case["output_name"] / "pattern_2450000000Hz.json").unlink()
        self.assertFalse(case_complete(case, self.results))
        selected, _ = select_configs([self.single], self.results, include_missing=True)
        self.assertEqual(selected, [self.single.as_posix()])

    def test_changed_config_selected_even_when_complete(self):
        case = self._cases(self.single)[0]
        self._write_result(case)
        selected, _ = select_configs([self.single], self.results,
                                     changed=[self.single.as_posix()], include_missing=False)
        self.assertEqual(selected, [self.single.as_posix()])

    def test_stale_yagi_geometry_is_not_reused(self):
        case = self._cases(self.single)[0]
        self._write_result(case)
        f = self.results / case["output_name"] / "result.json"
        data = json.loads(f.read_text())
        data["input_config"]["geometry"][0]["points"][1] = [100, 0, 20]
        f.write_text(json.dumps(data))
        self.assertFalse(case_complete(case, self.results),
                         "Radiation calculated for old conductor positions is stale")
        selected, missing = select_configs([self.single], self.results, include_missing=True)
        self.assertEqual(selected, [self.single.as_posix()])
        self.assertEqual(missing, [(self.single.as_posix(), "default")])

    def test_stale_port_and_mesh_are_not_reused(self):
        case = self._cases(self.single)[0]
        self._write_result(case)
        f = self.results / case["output_name"] / "result.json"
        data = json.loads(f.read_text())
        data["input_config"]["mesh"] = {"resolution": 8}
        f.write_text(json.dumps(data))
        self.assertFalse(case_complete(case, self.results))

    def test_legacy_config_with_missing_simulation_metadata_still_reusable(self):
        case = self._cases(self.single)[0]
        self._write_result(case, legacy=True)
        self.assertTrue(case_complete(case, self.results))

    def test_stale_parameter_metadata_rejected(self):
        case = self._cases(self.sweep)[0]
        self._write_result(case)
        file = self.results / case["output_name"] / "result.json"
        info = json.loads(file.read_text())
        info["input_config"]["simulation"]["parameters"]["diameter"] = 999
        file.write_text(json.dumps(info))
        self.assertFalse(case_complete(case, self.results))


if __name__ == "__main__":
    unittest.main()
