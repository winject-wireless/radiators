#!/usr/bin/env python3
"""Restore completed single-case openEMS results from trusted Actions artifacts.

Call this after restoring the currently published viewer. It only adds missing
results, never replaces freshly simulated or already-published data. Each
result is copied only when its referenced frequency patterns are all present.
"""
import argparse
import json
from pathlib import Path
import re
from shutil import copy2

p = argparse.ArgumentParser()
p.add_argument("--source", type=Path, action="append", required=True)
p.add_argument("--results", type=Path, default=Path("results"))
p.add_argument("--changed", type=Path, default=Path("changed-antennas.txt"))
a = p.parse_args()

known = {cfg.stem for cfg in Path("antennas").glob("*.json")}
changed = ({Path(line.strip()).stem for line in a.changed.read_text().splitlines()
            if line.strip()} if a.changed.exists() else set())
a.results.mkdir(parents=True, exist_ok=True)
restored = set()

for root in a.source:
    if not root.is_dir():
        print(f"Archive absent (possibly expired; existing Pages results remain): {root}")
        continue
    for archived in sorted(root.glob("results/*/result.json")):
        simulation_id = archived.parent.name
        if simulation_id not in known or simulation_id in changed:
            continue
        dst = a.results / simulation_id
        if (dst / "result.json").exists():
            continue
        raw = json.loads(archived.read_text(encoding="utf-8"))
        if not isinstance(raw.get("name"), str) or not raw["name"]:
            raise ValueError(f"Invalid archived simulation: {archived}")
        patterns = raw.get("patterns")
        if not isinstance(patterns, list) or not patterns:
            raise ValueError(f"Missing pattern manifest: {archived}")
        sources = []
        for pattern in patterns:
            filename = pattern.get("file")
            if (not isinstance(filename, str)
                    or not re.fullmatch(r"pattern_[0-9]+Hz\\.json", filename)):
                raise ValueError(f"Unsafe pattern filename in {archived}: {filename!r}")
            source = archived.parent / filename
            if not source.is_file():
                raise FileNotFoundError(f"Archived result missing its pattern: {source}")
            data = json.loads(source.read_text(encoding="utf-8"))
            if float(data.get("frequency_hz", 0)) != float(pattern.get("frequency_hz", -1)):
                raise ValueError(f"Pattern frequency mismatch: {source}")
            sources.append(source)
        dst.mkdir(parents=True, exist_ok=True)
        for source in sources:
            copy2(source, dst / source.name)
        copy2(archived, dst / "result.json")
        restored.add(simulation_id)
        print(f"Restored complete archived openEMS result: {simulation_id}")

print(f"Restored {len(restored)} complete archived antenna result(s).")
