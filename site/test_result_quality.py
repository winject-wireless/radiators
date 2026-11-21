"""Regression coverage for invalid zero-power far-field artifacts."""
import json
import math
import unittest

from result_quality import json_safe, normalize_pattern, radiation_valid


def pattern(power=0.25, peak=4.3, values=None):
    return {
        "frequency_hz": 2450000000,
        "theta_deg": [0, 180],
        "phi_deg": [0, 180],
        "radiated_power_w": power,
        "max_directivity_dbi": peak,
        "directivity_dbi": values if values is not None else [[4.3, 1.0], [0.2, 1.0]],
        "E_theta_real": [[0.5, 0.1], [0.0, 0.2]],
    }


class RadiationQualityTests(unittest.TestCase):
    def test_valid_radiation_remains_unchanged(self):
        input_pattern = pattern()
        output = normalize_pattern(input_pattern)
        self.assertTrue(radiation_valid(input_pattern))
        self.assertTrue(output["radiation_valid"])
        self.assertEqual(output["directivity_dbi"], input_pattern["directivity_dbi"])
        self.assertNotIn("radiation_warning", output)

    def test_zero_power_with_nan_grid_is_not_fabricated(self):
        input_pattern = pattern(power=0, peak=None,
                                values=[[math.nan, math.nan], [math.nan, math.nan]])
        input_pattern["E_theta_real"][0][0] = math.inf
        output = normalize_pattern(input_pattern)
        self.assertFalse(output["radiation_valid"])
        self.assertIsNone(output["max_directivity_dbi"])
        self.assertEqual(output["directivity_dbi"], [[None, None], [None, None]])
        self.assertIsNone(output["E_theta_real"][0][0])
        self.assertIn("zero radiated power", output["radiation_warning"])
        result = json.dumps(output, allow_nan=False)
        self.assertNotIn("NaN", result)
        self.assertNotIn("Infinity", result)
        self.assertIsNone(json.loads(result)["directivity_dbi"][0][0])

    def test_all_zero_field_cannot_claim_valid_gain(self):
        output = normalize_pattern(pattern(power=0))
        self.assertFalse(output["radiation_valid"])
        self.assertTrue(all(value is None for row in output["directivity_dbi"] for value in row))

    def test_nonfinite_samples_are_marked_invalid(self):
        output = normalize_pattern(pattern(values=[[4.3, math.inf], [0, 1]]))
        self.assertFalse(output["radiation_valid"])
        self.assertIsNone(output["max_directivity_dbi"])

    def test_explicitly_unavailable_pattern_remains_unavailable(self):
        original = pattern()
        original["radiation_valid"] = False
        output = normalize_pattern(original)
        self.assertFalse(output["radiation_valid"])
        self.assertEqual(output["radiation_warning"], output["radiation_warning"])

    def test_other_arrays_are_safely_serialized(self):
        safe = json_safe({"s11": [0.1, math.nan, -math.inf], "values": [{"gain": math.inf}]})
        self.assertEqual(safe, {"s11": [0.1, None, None], "values": [{"gain": None}]})
        json.dumps(safe, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
