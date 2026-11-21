"""Validate far-field result quality and produce strict, browser-safe JSON.

A finished FDTD job does not imply a physically valid radiation solution.
Zero radiated power / non-finite directivity must remain visible as a diagnostic,
never be displayed as a fabricated radiation pattern or emitted as NaN JSON.
"""
import math


INVALID_RADIATION = (
    "Far-field unavailable: zero radiated power or undefined directivity. "
    "Inspect feed excitation, port placement, mesh, and NF2FF boundaries."
)


def json_safe(value):
    """Convert non-finite JSON numbers to null, recursively (no data fabrication)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    return value


def radiation_valid(pattern):
    """Return true only if the entire sampled far-field grid is meaningful."""
    power = pattern.get("radiated_power_w")
    peak = pattern.get("max_directivity_dbi")
    grid = pattern.get("directivity_dbi")
    if (type(power) not in (float, int) or not math.isfinite(power) or power <= 0 or
            type(peak) not in (float, int) or not math.isfinite(peak) or
            not isinstance(grid, list) or not grid):
        return False
    return all(
        isinstance(row, list) and bool(row) and all(
            type(sample) in (float, int) and math.isfinite(sample)
            for sample in row
        )
        for row in grid
    )


def normalize_pattern(pattern):
    """Preserve invalid RF results with a clear diagnostic, not fake gain."""
    pattern = json_safe(pattern)
    valid = radiation_valid(pattern) and pattern.get("radiation_valid") is not False
    pattern["radiation_valid"] = valid
    if not valid:
        pattern["radiation_warning"] = pattern.get("radiation_warning") or INVALID_RADIATION
        # Undefined directivity must not appear as 0 dBi or a valid field.
        pattern["max_directivity_dbi"] = None
        rows = pattern.get("directivity_dbi")
        if isinstance(rows, list):
            pattern["directivity_dbi"] = [
                [None] * len(row) if isinstance(row, list) else row for row in rows
            ]
    return pattern
