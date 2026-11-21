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
for config in sorted(Path("antennas").glob("*.json")):
    raw = json.loads(config.read_text())
    if "sweep" not in raw:
        continue
    generator = raw.get("generator", {})
    if engine_changed or generator.get("path") in changed:
        print(config.as_posix())
