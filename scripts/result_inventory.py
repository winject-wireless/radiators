#!/usr/bin/env python3
"""Detect complete, reusable openEMS case results before scheduling FDTD.

This is intentionally stricter than a result.json existence check: a failed
or interrupted run must never be treated as a completed antenna simulation.
"""
import json
from pathlib import Path


def case_complete(case, results):
    """A valid output folder with S11 and every referenced far-field grid."""
    folder = Path(results) / case["output_name"]
    try:
        info = json.loads((folder / "result.json").read_text())
        if not isinstance(info, dict) or not isinstance(info.get("name"), str) or not info["name"]:
            return False
        metadata = info.get("input_config", {}).get("simulation")
        if metadata is not None:
            if not isinstance(metadata, dict):
                return False
            if (metadata.get("id") != case["simulation_id"] or
                    metadata.get("case_id") != case["case_id"] or
                    metadata.get("parameters", {}) != case["parameters"]):
                return False
        elif case["case_id"] != "default":
            # Older single-case results have no metadata; sweeps always do.
            return False
        s11 = info.get("s11", {})
        frequency = s11.get("frequency_hz") if isinstance(s11, dict) else None
        if not isinstance(frequency, list) or not frequency:
            return False
        for key in ("logmag_db", "phase_deg", "vswr"):
            if not isinstance(s11.get(key), list) or len(s11[key]) != len(frequency):
                return False
        patterns = info.get("patterns")
        if not isinstance(patterns, list) or not patterns:
            return False
        for entry in patterns:
            name = entry.get("file") if isinstance(entry, dict) else None
            if (not isinstance(name, str) or Path(name).name != name or
                    not name.startswith("pattern_") or not name.endswith(".json")):
                return False
            pattern = json.loads((folder / name).read_text())
            if pattern.get("frequency_hz") != entry.get("frequency_hz"):
                return False
            theta = pattern.get("theta_deg")
            phi = pattern.get("phi_deg")
            grid = pattern.get("directivity_dbi")
            if (not isinstance(theta, list) or len(theta) < 2 or
                    not isinstance(phi, list) or len(phi) < 2 or
                    not isinstance(grid, list) or len(grid) != len(theta) or
                    any(not isinstance(row, list) or len(row) != len(phi) for row in grid)):
                return False
        return True
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False
