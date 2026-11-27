#!/usr/bin/env python3
"""Generic deterministic parameter-sweep expansion for openEMS configs.

The sweep layer produces ordinary schema-v1/v2 JSON configs. It does not run
openEMS, and no CAD export/conversion is required for native CSXCAD primitives.
"""
from __future__ import annotations

import argparse
import ast
import copy
from decimal import Decimal, InvalidOperation
import importlib.util
import itertools
import json
import math
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MAX_CASES = 128
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
STEM = re.compile(r"^[A-Za-z0-9_-]+$")
FUNCTIONS = {
    "abs": abs, "min": min, "max": max,
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos,
    "tan": math.tan, "floor": math.floor, "ceil": math.ceil,
}
CONSTANTS = {"pi": math.pi, "e": math.e}


def _scalar(value, name):
    if not isinstance(value, (str, int, float, bool)) or (
            isinstance(value, float) and not math.isfinite(value)):
        raise ValueError(f"{name}: parameters must be finite JSON scalars")
    return value


def _expression(expr, parameters):
    """Allow arithmetic with named numeric parameters, never Python eval."""
    if not isinstance(expr, str) or len(expr) > 256:
        raise ValueError("Expression must be a string of at most 256 characters")
    try:
        parsed = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Invalid expression: {expr}") from exc

    def visit(node, depth=0):
        if depth > 20:
            raise ValueError("Expression exceeds maximum depth")
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            result = node.value
        elif isinstance(node, ast.Name):
            if node.id in CONSTANTS:
                result = CONSTANTS[node.id]
            elif node.id in parameters and type(parameters[node.id]) in (int, float):
                result = parameters[node.id]
            else:
                raise ValueError(f"Unknown numeric parameter: {node.id}")
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            x = visit(node.operand, depth + 1)
            result = x if isinstance(node.op, ast.UAdd) else -x
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (
                ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod)):
            a, b = visit(node.left, depth + 1), visit(node.right, depth + 1)
            if isinstance(node.op, ast.Add):
                result = a + b
            elif isinstance(node.op, ast.Sub):
                result = a - b
            elif isinstance(node.op, ast.Mult):
                result = a * b
            elif isinstance(node.op, ast.Div):
                result = a / b
            elif isinstance(node.op, ast.Mod):
                result = a % b
            else:
                if abs(b) > 12 or abs(a) > 1e12:
                    raise ValueError("Expression exponent is too large")
                result = a ** b
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
              and node.func.id in FUNCTIONS and not node.keywords):
            values = [visit(item, depth + 1) for item in node.args]
            result = FUNCTIONS[node.func.id](*values)
        else:
            raise ValueError(f"Unsupported expression: {expr}")
        if type(result) not in (int, float) or not math.isfinite(result) or abs(result) > 1e15:
            raise ValueError(f"Non-finite or excessive expression result: {expr}")
        return result

    try:
        return visit(parsed.body)
    except (OverflowError, ZeroDivisionError, TypeError) as exc:
        raise ValueError(f"Invalid expression result: {expr}") from exc


def resolve_template(value, parameters):
    """Resolve typed {$param:name} and numeric {$expr:expression} recursively."""
    if isinstance(value, dict):
        if "$param" in value or "$expr" in value:
            if len(value) != 1:
                raise ValueError("Parameter/expression objects must have exactly one key")
            if "$param" in value:
                key = value["$param"]
                if key not in parameters:
                    raise ValueError(f"Unknown parameter: {key}")
                return copy.deepcopy(parameters[key])
            return _expression(value["$expr"], parameters)
        return {key: resolve_template(item, parameters) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_template(item, parameters) for item in value]
    return value


def _values(spec, label):
    if not isinstance(spec, dict) or ("values" in spec) == ("range" in spec):
        raise ValueError(f"{label}: use exactly one of values or range")
    if "values" in spec:
        values = spec["values"]
        if not isinstance(values, list) or not values:
            raise ValueError(f"{label}.values must be a nonempty array")
    else:
        bounds = spec["range"]
        if not isinstance(bounds, dict) or set(bounds) != {"start", "stop", "step"}:
            raise ValueError(f"{label}.range must have start, stop, step")
        try:
            start, stop, step = [Decimal(str(bounds[key]))
                                 for key in ("start", "stop", "step")]
            if not all(v.is_finite() for v in (start, stop, step)):
                raise ValueError("Range must be finite")
            if step == 0 or (stop - start) * step < 0:
                raise ValueError("Range step must advance toward stop")
            count = int((stop - start) // step) + 1
            if not 1 <= count <= MAX_CASES:
                raise ValueError(f"Range must contain 1–{MAX_CASES} values")
            values = [float(start + i * step) for i in range(count)]
        except (InvalidOperation, TypeError, OverflowError) as exc:
            raise ValueError(f"{label}: invalid range") from exc
    if len(values) > MAX_CASES:
        raise ValueError(f"{label}: exceeds {MAX_CASES} values")
    unique = set()
    for v in values:
        _scalar(v, label)
        fingerprint = json.dumps(v, sort_keys=True, allow_nan=False)
        if fingerprint in unique:
            raise ValueError(f"{label}: duplicate value {v!r}")
        unique.add(fingerprint)
    return values


def _parameter_sets(cfg):
    defaults = cfg.get("parameters", {})
    if not isinstance(defaults, dict):
        raise ValueError("parameters must be an object")
    for key, value in defaults.items():
        if not IDENTIFIER.fullmatch(key) or key in CONSTANTS or key in FUNCTIONS:
            raise ValueError(f"Invalid parameter name: {key!r}")
        _scalar(value, key)
    sweep = cfg.get("sweep")
    if sweep is None:
        return [(None, dict(defaults))]
    if not isinstance(sweep, dict):
        raise ValueError("sweep must be an object")
    axes = sweep.get("parameters")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("sweep.parameters must be a nonempty object")
    names = list(axes)
    for key in names:
        if not IDENTIFIER.fullmatch(key) or key in CONSTANTS or key in FUNCTIONS:
            raise ValueError(f"Invalid sweep parameter name: {key!r}")
    values = [_values(axes[name], f"sweep.parameters.{name}") for name in names]
    mode = sweep.get("mode", "product")
    if mode == "product":
        combinations = itertools.product(*values)
        count = math.prod(map(len, values))
    elif mode == "zip":
        if len(set(map(len, values))) != 1:
            raise ValueError("zip sweep requires equal-length parameter axes")
        combinations = zip(*values)
        count = len(values[0])
    else:
        raise ValueError("sweep.mode must be product or zip")
    if count > MAX_CASES:
        raise ValueError(f"Sweep expands to {count} cases, maximum {MAX_CASES}")
    return [(f"case-{i:04d}", {**defaults, **dict(zip(names, combination))})
            for i, combination in enumerate(combinations, 1)]


def _run_generator(spec, cfg, params):
    if not isinstance(spec, dict) or spec.get("language") != "python":
        raise ValueError("generator.language must be python")
    filename = spec.get("path", "")
    if (not isinstance(filename, str) or not
            re.fullmatch(r"antennas/generators/[A-Za-z0-9_-]+\.py", filename)):
        raise ValueError("Generator path must be antennas/generators/<name>.py")
    source = (ROOT / filename).resolve()
    if not source.is_relative_to((ROOT / "antennas" / "generators").resolve()):
        raise ValueError("Generator escapes antennas/generators")
    if not source.is_file():
        raise FileNotFoundError(source)
    loader = importlib.util.spec_from_file_location("radiators_geometry_generator", source)
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    if not callable(getattr(module, "generate", None)):
        raise ValueError(f"{filename} must define generate(config, params)")
    result = module.generate(copy.deepcopy(cfg), dict(params))
    if not isinstance(result, dict):
        raise ValueError("Generator must return a complete JSON config object")
    return result


def _uses_scripts(cfg):
    return "scripts" in cfg or any(
        isinstance(g, dict) and "script" in g for g in cfg.get("geometry") or [])


def _expand_scripts(cfg):
    """Replace geometry-script instances by the primitives their JS generate() returns.

    Runs scripts/geometry_scripts.mjs (the same JS core the editor uses) under Node.
    """
    node = shutil.which("node")
    if node is None:
        raise ValueError("Geometry scripts need Node.js (node) on PATH")
    proc = subprocess.run([node, str(ROOT / "scripts" / "geometry_scripts.mjs")],
                          input=json.dumps(cfg), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise ValueError(f"Geometry script failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def expand_cases(config, source):
    """Return normalized cases with ids and fully resolved config objects."""
    source = Path(source)
    stem = source.stem
    if not STEM.fullmatch(stem):
        raise ValueError(f"Invalid simulation identifier: {stem}")
    if config.get("schema_version") not in (1, 2):
        raise ValueError("Only schema v1/v2 simulations can be swept")
    base_name = config.get("name")
    if not isinstance(base_name, str) or not base_name:
        raise ValueError("Simulation needs a nonempty name")
    is_sweep = config.get("sweep") is not None
    cases = []
    for case_id, parameters in _parameter_sets(config):
        base = copy.deepcopy(config)
        generator = base.pop("generator", None)
        base.pop("sweep", None)
        base.pop("parameters", None)
        base.pop("workspace_units", None)  # editor-only display metadata
        if generator is not None:
            base = _run_generator(generator, base, parameters)
        if base.get("schema_version") == 2 and isinstance(base.get("geometry"), list):
            base["geometry"] = [g for g in base["geometry"] if not isinstance(g, dict) or g.get("enabled") is not False]
        resolved = resolve_template(base, parameters)
        if resolved.get("schema_version") == 2 and isinstance(resolved.get("geometry"), list):
            resolved["geometry"] = [g for g in resolved["geometry"] if not isinstance(g, dict) or g.get("enabled") is not False]
        if _uses_scripts(resolved):
            resolved = _expand_scripts(resolved)
        if resolved.get("schema_version") != config["schema_version"]:
            raise ValueError("Generator may not change schema_version")
        if not isinstance(resolved.get("geometry"), list):
            raise ValueError("Resolved geometry must be a list")
        case_name = ", ".join(f"{k}={v}" for k, v in parameters.items()) if is_sweep else "Default"
        case_id = case_id or "default"
        metadata = {
            "id": stem, "name": base_name,
            "case_id": case_id, "case_name": case_name,
            "parameters": parameters, "sweep": is_sweep,
            "source_config": str(source.as_posix()),
        }
        resolved["simulation"] = metadata
        cases.append({"simulation_id": stem, "case_id": case_id,
                      "case_name": case_name, "parameters": parameters,
                      "output_name": f"{stem}__{case_id}" if is_sweep else stem,
                      "config": resolved})
    return cases


def main():
    parser = argparse.ArgumentParser(description="Validate and show generated sweep cases (no FDTD)")
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    cfg = json.loads(args.config.read_text())
    for case in expand_cases(cfg, args.config):
        print(case["output_name"], json.dumps(case["parameters"], sort_keys=True),
              len(case["config"]["geometry"]), "geometry objects")


if __name__ == "__main__":
    main()
