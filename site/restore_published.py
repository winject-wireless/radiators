#!/usr/bin/env python3
"""Restore previous published results before overlaying only changed simulations.

Requires public GitHub Pages. A missing site is expected on first deployment.
A failure other than 404 is fatal to avoid silently deleting published results.
"""
import argparse
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import urlopen

p = argparse.ArgumentParser()
p.add_argument("--site-url", required=True)
p.add_argument("--results", type=Path, default=Path("results"))
p.add_argument("--changed", type=Path, default=Path("changed-antennas.txt"))
a = p.parse_args()
a.results.mkdir(parents=True, exist_ok=True)
known = {f.stem for f in Path("antennas").glob("*.json")}
changed = {Path(line.strip()).stem for line in a.changed.read_text().splitlines() if line.strip()} if a.changed.is_file() else set()

def download(url):
    with urlopen(url, timeout=20) as response:
        return response.read()

base = a.site_url.rstrip("/") + "/"
try:
    manifest = json.loads(download(urljoin(base, "manifest.json")))
except HTTPError as e:
    if e.code == 404:
        print("No existing published manifest (first deployment).")
        raise SystemExit(0)
    raise

for entry in manifest["runs"]:
    path = entry["path"]
    parts = Path(path).parts
    if len(parts) != 3 or parts[0] != "data" or parts[2] != "result.json":
        raise ValueError(f"Unsafe manifest path: {path}")
    name = parts[1]
    if not name.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"Unsafe run name: {name}")
    simulation_id = entry.get("simulation_id", name)
    if simulation_id not in known:
        print(f"Skipping removed simulation {simulation_id}")
        continue
    if simulation_id in changed:
        print(f"Skipping old cases for changed simulation {simulation_id}")
        continue
    target = a.results / name
    if (target / "result.json").exists():
        print(f"Keeping new simulation {name}")
        continue
    result_bytes = download(urljoin(base, path))
    info = json.loads(result_bytes)
    patterns = {}
    for pattern in info["patterns"]:
        filename = pattern["file"]
        if Path(filename).name != filename or not filename.startswith("pattern_") or not filename.endswith(".json"):
            raise ValueError("Unsafe pattern filename")
        patterns[filename] = download(urljoin(base, f"data/{name}/{filename}"))
    target.mkdir(parents=True, exist_ok=True)
    (target / "result.json").write_bytes(result_bytes)
    for filename, body in patterns.items():
        (target / filename).write_bytes(body)
    print(f"Restored unchanged simulation {name}")
