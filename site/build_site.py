#!/usr/bin/env python3
"""Build static GitHub Pages data from structured simulation results."""
import argparse
import json
from pathlib import Path
from shutil import copy2, copytree, rmtree

p = argparse.ArgumentParser()
p.add_argument("--results", type=Path, default=Path("results"))
p.add_argument("--site", type=Path, default=Path("site/dist"))
args = p.parse_args()
args.site.mkdir(parents=True, exist_ok=True)
for filename in ("index.html", "app.js", "style.css"):
    copy2(Path(__file__).parent / filename, args.site / filename)
data = args.site / "data"
if data.exists():
    rmtree(data)
data.mkdir()
runs = []
for result in sorted(args.results.glob("*/result.json")):
    info = json.loads(result.read_text())
    folder = result.parent
    target = data / folder.name
    target.mkdir()
    for src in folder.iterdir():
        if src.name == "result.json" or (src.name.startswith("pattern_") and src.suffix == ".json"):
            copy2(src, target / src.name)
    runs.append({"name": info["name"], "description": info.get("description", ""),
                 "path": f"data/{folder.name}/result.json", "generated_at_utc": info.get("generated_at_utc")})
(args.site / "manifest.json").write_text(json.dumps({"schema_version": 1, "runs": runs}, indent=2))
print(f"Built viewer for {len(runs)} simulation(s)")
