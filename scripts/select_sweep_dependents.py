#!/usr/bin/env python3
"""Select only the sweep configs affected by changed generator/engine files."""
import argparse
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--changed", type=Path, required=True)
args = p.parse_args()
changed = set(args.changed.read_text().splitlines())
engine_changed = "scripts/sweep.py" in changed
script_engine = {"scripts/geometry_scripts.mjs", "site/csxcad/js/scriptcore.js",
                 "site/csxcad/js/schema.js"}
script_changed = bool(script_engine & changed)
for config in sorted(Path("antennas").glob("*.json")):
    raw = json.loads(config.read_text())
    uses_scripts = "scripts" in raw or any(isinstance(g, dict) and "script" in g
                                           for g in raw.get("geometry") or [])
    if uses_scripts and (engine_changed or script_changed):
        print(config.as_posix())
        continue
    if "sweep" not in raw:
        continue
    generator = raw.get("generator", {})
    if engine_changed or generator.get("path") in changed:
        print(config.as_posix())
