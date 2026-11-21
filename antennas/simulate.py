#!/usr/bin/env python3
"""JSON-driven single-port openEMS FDTD run and far-field extraction."""
import argparse
import json
import math
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.physical_constants import C0


def require(condition, message):
    if not condition:
        raise ValueError(message)


def vec3(value, name):
    require(isinstance(value, list) and len(value) == 3, f"{name}: expected 3 values")
    result = np.asarray(value, dtype=float)
    require(bool(np.all(np.isfinite(result))), f"{name}: non-finite coordinates")
    return result


def sample_s11(sweeps, min_hz, max_hz):
    require(bool(sweeps), "s11: at least one sweep required")
    values = set()
    for i, s in enumerate(sweeps):
        start, step, end = [float(s[k]) for k in ("start", "step", "end")]
        require(start > 0 and step > 0 and end >= start, f"s11[{i}]: bad range")
        n = int(math.floor((end - start) / step + 1e-8)) + 1
        require(n <= 20001, "Too many points in a single S11 sweep")
        for j in range(n):
            values.add(round(start + j * step, 4))
        if not math.isclose(start + (n - 1) * step, end, abs_tol=0.001):
            values.add(round(end, 4))
    result = np.array(sorted(values), dtype=float)
    require(len(result) <= 30000, "Too many total S11 points")
    require(result[0] >= min_hz and result[-1] <= max_hz,
            "S11 range outside excitation center ± bandwidth")
    return result


def finite_or_none(x):
    x = float(x)
    return x if math.isfinite(x) else None


def json_safe(value):
    """No non-finite numeric literals in emitted JSON files."""
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (float, np.floating)):
        return finite_or_none(value)
    if isinstance(value, np.integer):
        return int(value)
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("config", type=Path)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    cfg = json.loads(args.config.read_text())
    if cfg.get("schema_version") == 2:
        from simulate_v2 import output_data
        return output_data(cfg, args.output.resolve())
    require(cfg.get("schema_version") == 1, "Unsupported schema_version")
    require(cfg.get("units") == "mm", "Only mm units supported in v1")
    name = cfg["name"]
    require(isinstance(name, str) and name, "non-empty name required")

    f0 = float(cfg["excitation"]["center_hz"])
    fc = float(cfg["excitation"]["bandwidth_hz"])
    require(f0 > fc > 0, "Excitation: require center > bandwidth > 0")
    low, high = f0 - fc, f0 + fc
    freqs = sample_s11(cfg["s11"], low, high)
    pattern_freqs = [float(x) for x in cfg["radiation_pattern_frequencies_hz"]]
    require(bool(pattern_freqs) and len(pattern_freqs) <= 12, "Expected 1–12 pattern frequencies")
    require(all(low <= f <= high for f in pattern_freqs), "Pattern frequency outside excitation band")

    domain = cfg["domain"]
    dstart, dstop = vec3(domain["start"], "domain.start"), vec3(domain["stop"], "domain.stop")
    require(bool(np.all(dstop > dstart)), "Domain stop must exceed start")
    boundary = domain.get("boundary", ["PML_8"] * 6)
    require(isinstance(boundary, list) and len(boundary) == 6, "Need six boundary conditions")
    mesh_cfg = cfg["mesh"]
    res = float(mesh_cfg["resolution_mm"])
    growth = float(mesh_cfg.get("growth_ratio", 1.4))
    require(res > 0 and 1.01 <= growth <= 2, "Invalid mesh resolution or growth ratio")
    solver = cfg.get("solver", {})
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    sim_dir = out / "fdtd"
    fdtd = openEMS(NrTS=int(solver.get("max_timesteps", 20000)),
                   EndCriteria=float(solver.get("end_criteria", 1e-4)))
    fdtd.SetGaussExcite(f0, fc)
    fdtd.SetBoundaryCond(boundary)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)
    for axis, lo, hi in zip("xyz", dstart, dstop):
        mesh.AddLine(axis, [float(lo), float(hi)])

    materials = {}
    for m in cfg["materials"]:
        nm = m["name"]
        require(nm not in materials, f"Duplicate material {nm}")
        if m["type"] == "pec":
            materials[nm] = csx.AddMetal(nm)
        elif m["type"] == "dielectric":
            eps = float(m["epsilon"])
            kappa = float(m.get("kappa_s_per_m", 0))
            require(eps >= 1 and kappa >= 0, "Invalid dielectric epsilon/kappa")
            materials[nm] = csx.AddMaterial(nm, epsilon=eps, kappa=kappa)
        else:
            raise ValueError(f"Unsupported material type: {m['type']}")

    require(bool(cfg["geometry"]), "Geometry cannot be empty")
    for i, g in enumerate(cfg["geometry"]):
        mat = materials[g["material"]]
        a, b = vec3(g["start"], f"geometry[{i}].start"), vec3(g["stop"], f"geometry[{i}].stop")
        require(np.all(a <= b), f"geometry[{i}]: start must be <= stop")
        require(bool(np.all(a >= dstart) and np.all(b <= dstop)), f"geometry[{i}]: outside domain")
        priority = int(g.get("priority", 10))
        if g["shape"] == "box":
            mat.AddBox(start=a.tolist(), stop=b.tolist(), priority=priority)
        elif g["shape"] == "cylinder":
            require(float(g["radius"]) > 0, "Cylinder radius must be positive")
            mat.AddCylinder(start=a.tolist(), stop=b.tolist(),
                            radius=float(g["radius"]), priority=priority)
        else:
            raise ValueError(f"Unsupported shape {g['shape']}")
        for axis, lo, hi in zip("xyz", a, b):
            mesh.AddLine(axis, [float(lo), float(hi)])
            if g["shape"] == "cylinder":
                radius = float(g["radius"])
                for pos in (float(lo - radius), float(lo + radius), float(hi - radius), float(hi + radius)):
                    if float(dstart["xyz".index(axis)]) < pos < float(dstop["xyz".index(axis)]):
                        mesh.AddLine(axis, pos)

    sources = [s for s in cfg["sources"] if s.get("enabled", True)]
    require(len(sources) == 1, "v1 requires exactly one enabled lumped port (S11)")
    s = sources[0]
    require(s["type"] == "lumped_port", "Only lumped_port source supported")
    start, stop = vec3(s["start"], "port.start"), vec3(s["stop"], "port.stop")
    require(s["direction"] in "xyz", "port direction must be x, y or z")
    require(bool(np.all(start >= dstart) and np.all(stop <= dstop)), "Port outside domain")
    require(float(s["impedance_ohm"]) > 0, "Port impedance must be positive")
    for axis, lo, hi in zip("xyz", start, stop):
        mesh.AddLine(axis, [float(lo), float(hi)])

    mesh.SmoothMeshLines("all", res, growth)
    cell_counts = [len(mesh.GetLines(axis)) - 1 for axis in "xyz"]
    cell_total = math.prod(cell_counts)
    require(cell_total <= int(mesh_cfg.get("max_cells", 5000000)),
            f"Estimated {cell_total:,} cells exceeds max_cells")
    port = fdtd.AddLumpedPort(int(s.get("port_number", 1)), float(s["impedance_ohm"]),
                              start.tolist(), stop.tolist(), s["direction"], 1.0, priority=5)
    nf2ff = fdtd.CreateNF2FFBox()
    csx.Write2XML(str(out / "geometry.xml"))
    fdtd.Run(str(sim_dir), cleanup=True, verbose=1)

    port.CalcPort(str(sim_dir), freqs)
    gamma = np.asarray(port.uf_ref) / np.asarray(port.uf_inc)
    mag = np.abs(gamma)
    phase = np.rad2deg(np.angle(gamma))
    vswr = np.where(mag < 1, (1 + mag) / np.maximum(1 - mag, 1e-16), np.inf)
    logmag = 20 * np.log10(np.maximum(mag, 1e-16))
    result = {
        "schema_version": 1,
        "name": name,
        "description": cfg.get("description", ""),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "input_config": cfg,
        "mesh_cells": cell_counts,
        "mesh_total_cells": cell_total,
        "port_name": s.get("name", "feed"),
        "s11": {
            "frequency_hz": freqs.tolist(),
            "real": [finite_or_none(x) for x in gamma.real],
            "imag": [finite_or_none(x) for x in gamma.imag],
            "logmag_db": [finite_or_none(x) for x in logmag],
            "phase_deg": [finite_or_none(x) for x in phase],
            "vswr": [finite_or_none(x) for x in vswr]
        },
        "patterns": []
    }
    grid = cfg.get("radiation_pattern_grid", {})
    theta_step = float(grid.get("theta_step_deg", 10))
    phi_step = float(grid.get("phi_step_deg", 10))
    require(0 < theta_step <= 30 and 0 < phi_step <= 30, "Angle steps must be 0–30 degrees")
    theta = np.linspace(0, 180, round(180 / theta_step) + 1)
    phi = np.linspace(0, 360, round(360 / phi_step), endpoint=False)
    require(theta.size * phi.size <= 30000, "Far field sampling grid too large")
    for f in pattern_freqs:
        ff = nf2ff.CalcNF2FF(str(sim_dir), f, theta, phi, outfile=f"nf2ff_{int(f)}.h5", read_cached=False, verbose=True)
        norm = np.asarray(ff.E_norm[0], dtype=float)
        norm = np.reshape(norm, (len(theta), len(phi)))
        prad = finite_or_none(ff.Prad[0])
        dmax_linear = finite_or_none(ff.Dmax[0])
        valid_radiation = bool(
            prad is not None and prad > 0 and
            dmax_linear is not None and dmax_linear > 0 and
            np.isfinite(norm).all() and np.max(norm) > 0
        )
        if valid_radiation:
            dmax = float(10 * np.log10(dmax_linear))
            dbi = dmax + 20 * np.log10(np.maximum(norm / float(np.max(norm)), 1e-16))
        else:
            dmax = None
            dbi = np.full(norm.shape, np.nan)
            print("WARNING: no valid radiation at", f, "Hz: zero Prad or undefined field/directivity")
        fname = f"pattern_{int(f)}Hz.json"
        radiation_efficiency = None
        try:
            port.CalcPort(str(sim_dir), np.array([f]))
            accepted = float(np.asarray(port.P_acc).ravel()[0])
            if accepted > 0:
                radiation_efficiency = finite_or_none(float(ff.Prad[0]) / accepted)
        except (AttributeError, ValueError, IndexError, ZeroDivisionError) as ex:
            print("Radiation efficiency unavailable:", ex)
        record = {
            "frequency_hz": f,
            "theta_deg": theta.tolist(),
            "phi_deg": phi.tolist(),
            "directivity_dbi": dbi.tolist(),
            "max_directivity_dbi": dmax,
            "radiated_power_w": prad,
            "radiation_valid": valid_radiation,
            "radiation_warning": None if valid_radiation else
                "Far-field unavailable: zero radiated power or undefined directivity. Check feed, mesh, and NF2FF boundaries.",
            "radiation_efficiency": radiation_efficiency,
            "unit": "dBi"
        }
        (out / fname).write_text(json.dumps(json_safe(record), allow_nan=False))
        result["patterns"].append({
            "frequency_hz": f, "file": fname,
            "max_directivity_dbi": record["max_directivity_dbi"],
            "radiation_efficiency": radiation_efficiency
        })
    (out / "result.json").write_text(json.dumps(json_safe(result), indent=2, allow_nan=False))
    print("Written", out / "result.json")


if __name__ == "__main__":
    main()
