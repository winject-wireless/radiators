#!/usr/bin/env python3
"""Publish the complete, validated antenna result viewer.

Ship Plotly locally so users do not need an external CDN at page-load time.
On main, fail the build rather than silently deploy missing simulations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from shutil import copy2, rmtree
from urllib.request import Request, urlopen

PLOTLY_VERSION = "2.35.3"
PLOTLY_SOURCES = (
    f"https://cdn.plot.ly/plotly-{PLOTLY_VERSION}.min.js",
    f"https://cdn.jsdelivr.net/npm/plotly.js-dist-min@{PLOTLY_VERSION}/plotly.min.js",
    f"https://unpkg.com/plotly.js-dist-min@{PLOTLY_VERSION}/plotly.min.js",
)

p = argparse.ArgumentParser()
p.add_argument("--results", type=Path, default=Path("results"))
p.add_argument("--site", type=Path, default=Path("site/dist"))
p.add_argument("--require-complete", action="store_true",
               help="Require one valid result and all patterns for every antenna config")
args = p.parse_args()

src_dir = Path(__file__).resolve().parent
args.site.mkdir(parents=True, exist_ok=True)
data = args.site / "data"
if data.exists():
    rmtree(data)
data.mkdir()

configs = sorted((src_dir.parent / "antennas").glob("*.json"))
expected = {config.stem for config in configs}
published = set()
runs = []
for result in sorted(args.results.glob("*/result.json")):
    folder = result.parent
    info = json.loads(result.read_text())
    if not isinstance(info.get("name"), str) or not info["name"]:
        raise ValueError(f"Invalid simulation name: {result}")
    patterns = info.get("patterns")
    if not isinstance(patterns, list) or not patterns:
        raise ValueError(f"Missing frequency patterns: {result}")
    s11 = info.get("s11")
    if not isinstance(s11, dict) or not s11.get("frequency_hz"):
        raise ValueError(f"Missing S11 data: {result}")

    # Validate every referenced file BEFORE publishing any manifest entry.
    target = data / folder.name
    target.mkdir()
    copy2(result, target / "result.json")
    for entry in patterns:
        name = entry.get("file")
        if (not isinstance(name, str) or Path(name).name != name
                or not name.startswith("pattern_") or not name.endswith(".json")):
            raise ValueError(f"Unsafe pattern file in {result}: {name!r}")
        source = folder / name
        if not source.is_file():
            raise FileNotFoundError(f"Missing simulation pattern: {source}")
        pattern = json.loads(source.read_text())
        theta = pattern.get("theta_deg")
        phi = pattern.get("phi_deg")
        grid = pattern.get("directivity_dbi")
        if (not isinstance(theta, list) or len(theta) < 2
                or not isinstance(phi, list) or len(phi) < 2
                or not isinstance(grid, list) or len(grid) != len(theta)
                or any(not isinstance(row, list) or len(row) != len(phi) for row in grid)):
            raise ValueError(f"Invalid directivity grid: {source}")
        if float(pattern.get("frequency_hz", 0)) != float(entry.get("frequency_hz", -1)):
            raise ValueError(f"Pattern frequency mismatch: {source}")
        copy2(source, target / name)
    published.add(folder.name)
    runs.append({"name": info["name"], "description": info.get("description", ""),
                 "path": f"data/{folder.name}/result.json",
                 "generated_at_utc": info.get("generated_at_utc")})

if args.require_complete:
    missing = sorted(expected - published)
    if missing:
        raise RuntimeError("Refusing incomplete Pages deployment. Missing antenna results: "
                           + ", ".join(missing))
    if not published:
        raise RuntimeError("Refusing to publish a viewer without any simulation results.")
else:
    print(f"Non-production viewer: {len(runs)} result(s) present.")

# Download during CI so a browser can load every simulation without contacting
# an external script CDN. A failed download fails the workflow, preserving the
# previous successful Pages deployment.
bundle = None
failures = []
for url in PLOTLY_SOURCES:
    try:
        with urlopen(Request(url, headers={"User-Agent": "radiators-pages-builder/1.0"}),
                     timeout=35) as response:
            candidate = response.read()
        if len(candidate) < 1_000_000 or b"Plotly" not in candidate:
            raise ValueError(f"Invalid/minimal Plotly JavaScript ({len(candidate)} bytes)")
        bundle = candidate
        print(f"Bundled Plotly {PLOTLY_VERSION} from {url} ({len(bundle)} bytes)")
        break
    except Exception as error:
        failures.append(f"{url}: {error}")
if bundle is None:
    raise RuntimeError("Failed to bundle Plotly; refusing a broken Pages deployment:\n"
                       + "\n".join(failures))
(args.site / "plotly.min.js").write_bytes(bundle)

for filename in ("app.js", "style.css"):
    copy2(src_dir / filename, args.site / filename)
html = (src_dir / "index.html").read_text()
if 'src="./plotly.min.js"' not in html:
    raise ValueError("Viewer must load locally bundled Plotly")
for filename in ("app.js", "style.css", "plotly.min.js"):
    digest = hashlib.sha256((args.site / filename).read_bytes()).hexdigest()[:12]
    html = html.replace(f"./{filename}\"", f"./{filename}?v={digest}\"")
(args.site / "index.html").write_text(html)

manifest = {"schema_version": 1, "runs": runs}
(args.site / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"Built viewer with {len(runs)} complete simulation(s); "
      f"{sum(len(json.loads((args.results / Path(r['path']).parts[1] / 'result.json').read_text())['patterns']) for r in runs)} frequency pattern(s)")
