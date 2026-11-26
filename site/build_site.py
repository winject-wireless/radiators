#!/usr/bin/env python3
"""Publish the complete, validated antenna result viewer.

Ship Plotly locally so users do not need an external CDN at page-load time.
On main, fail the build rather than silently deploy missing simulations.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import sys
from shutil import copy2, copytree, rmtree
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
p.add_argument("--require-result", action="append", default=[],
               metavar="SIMULATION_ID",
               help="Require a specific completed simulation while retaining all previously published results")
args = p.parse_args()

src_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(src_dir.parent / "scripts"))
from sweep import expand_cases
from result_quality import json_safe, normalize_pattern

args.site.mkdir(parents=True, exist_ok=True)
data = args.site / "data"
if data.exists():
    rmtree(data)
data.mkdir()

configs = sorted((src_dir.parent / "antennas").glob("*.json"))
expected = {
    config.stem: {case["case_id"] for case in expand_cases(json.loads(config.read_text()), config)}
    for config in configs
}
published = {}
runs = []
simulations = {}
for result in sorted(args.results.glob("*/result.json")):
    folder = result.parent
    info = json_safe(json.loads(result.read_text()))
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
    (target / "result.json").write_text(json.dumps(info, allow_nan=False))
    for entry in patterns:
        name = entry.get("file")
        if (not isinstance(name, str) or Path(name).name != name
                or not name.startswith("pattern_") or not name.endswith(".json")):
            raise ValueError(f"Unsafe pattern file in {result}: {name!r}")
        source = folder / name
        if not source.is_file():
            raise FileNotFoundError(f"Missing simulation pattern: {source}")
        pattern = normalize_pattern(json.loads(source.read_text()))
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
        (target / name).write_text(json.dumps(pattern, allow_nan=False))
        if not pattern["radiation_valid"]:
            print(f"WARNING: {source}: {pattern['radiation_warning']}", flush=True)
    metadata = info.get("input_config", {}).get("simulation", {})
    simulation_id = metadata.get("id", folder.name)
    case_id = metadata.get("case_id", "default")
    if (not isinstance(simulation_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", simulation_id)
            or not isinstance(case_id, str) or not re.fullmatch(r"(?:default|case-[0-9]{4})", case_id)):
        raise ValueError(f"Invalid simulation or case ID: {result}")
    if simulation_id not in expected:
        raise ValueError(f"Published result for unknown/deleted simulation: {simulation_id}")
    if case_id in published.setdefault(simulation_id, set()):
        raise ValueError(f"Duplicate simulation case: {simulation_id}/{case_id}")
    published[simulation_id].add(case_id)
    simulation_name = metadata.get("name", info["name"])
    is_sweep = bool(metadata.get("sweep", False))
    case = {
        "id": case_id,
        "name": metadata.get("case_name", "Default"),
        "parameters": metadata.get("parameters", {}),
        "path": f"data/{folder.name}/result.json",
        "generated_at_utc": info.get("generated_at_utc"),
    }
    sim = simulations.setdefault(simulation_id, {
        "id": simulation_id, "name": simulation_name, "sweep": is_sweep, "cases": []
    })
    if sim["sweep"] != is_sweep or sim["name"] != simulation_name:
        raise ValueError(f"Inconsistent simulation metadata: {simulation_id}")
    sim["cases"].append(case)
    runs.append({"name": info["name"], "description": info.get("description", ""),
                 "path": case["path"], "generated_at_utc": info.get("generated_at_utc"),
                 "simulation_id": simulation_id, "case_id": case_id})

if args.require_result:
    missing_required = {
        name: sorted(expected.get(name, {"default"}) - published.get(name, set()))
        for name in args.require_result
        if name not in expected or expected[name] != published.get(name, set())
    }
    if missing_required:
        raise RuntimeError("Refusing Pages deployment without specifically required simulation results: "
                           + str(missing_required))
if args.require_complete:
    missing = {name: sorted(cases - published.get(name, set()))
               for name, cases in expected.items() if cases != published.get(name, set())}
    if missing:
        raise RuntimeError("Refusing incomplete Pages deployment. Missing/extra antenna cases: "
                           + str(missing))
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

# JSCAD geometry kernel for the browser-based editor (pinned, bundled locally).
jscad_version = "2.12.1"
jscad_sources = (
    f"https://cdn.jsdelivr.net/npm/@jscad/modeling@{jscad_version}/dist/jscad-modeling.min.js",
    f"https://unpkg.com/@jscad/modeling@{jscad_version}/dist/jscad-modeling.min.js",
)
jscad_bundle = None
jscad_failures = []
for url in jscad_sources:
    try:
        with urlopen(Request(url, headers={"User-Agent": "radiators-pages-builder/1.0"}),
                     timeout=35) as response:
            candidate = response.read()
        if len(candidate) < 100_000 or b"jscadModeling" not in candidate:
            raise ValueError(f"Invalid JSCAD bundle ({len(candidate)} bytes)")
        jscad_bundle = candidate
        print(f"Bundled JSCAD {jscad_version} from {url} ({len(candidate)} bytes)")
        break
    except Exception as error:
        jscad_failures.append(f"{url}: {error}")
if jscad_bundle is None:
    raise RuntimeError("Failed to bundle JSCAD; refusing a broken editor deployment:\n"
                       + "\n".join(jscad_failures))
(args.site / "jscad-modeling.min.js").write_bytes(jscad_bundle)

for filename in ("app.js", "style.css", "simulation_selectors.js",
                 "editor.js", "editor.css", "editor.html"):
    copy2(src_dir / filename, args.site / filename)
html = (src_dir / "index.html").read_text()
if 'src="./simulation_selectors.js"' not in html:
    raise ValueError("Viewer must include simulation/case selector script")
if 'src="./plotly.min.js"' not in html:
    raise ValueError("Viewer must load locally bundled Plotly")
for filename in ("app.js", "style.css", "simulation_selectors.js", "plotly.min.js"):
    digest = hashlib.sha256((args.site / filename).read_bytes()).hexdigest()[:12]
    html = html.replace(f"./{filename}\"", f"./{filename}?v={digest}\"")
(args.site / "index.html").write_text(html)

editor_html = (args.site / "editor.html").read_text()
for filename in ("editor.js", "editor.css", "plotly.min.js", "jscad-modeling.min.js"):
    digest = hashlib.sha256((args.site / filename).read_bytes()).hexdigest()[:12]
    editor_html = editor_html.replace(f"./{filename}\"", f"./{filename}?v={digest}\"")
(args.site / "editor.html").write_text(editor_html)

# Parametric CSXCAD editor (static, Capacitor-ready): vendors three.js and
# bundles schema v2 examples into site/dist/csxcad/.
import subprocess
subprocess.run([sys.executable, str(src_dir / "csxcad" / "prepare.py"), "--out", str(args.site / "csxcad")],
               check=True)

# openEMS compiled to WebAssembly (built by wasm/openems/build.sh, committed):
# served at openems/ for the editor and the viewer, with its demo page.
openems_dir = args.site / "openems"
if openems_dir.exists():
    rmtree(openems_dir)
copytree(src_dir / "openems", openems_dir)

for sim in simulations.values():
    sim["cases"].sort(key=lambda case: case["id"])
manifest = {
    "schema_version": 2,
    "simulations": sorted(simulations.values(), key=lambda sim: sim["name"].lower()),
    # Legacy flattened index is retained for older consumers and smoke checks.
    "runs": runs,
}
(args.site / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"Built viewer with {len(runs)} complete simulation(s); "
      f"{sum(len(json.loads((args.results / Path(r['path']).parts[1] / 'result.json').read_text())['patterns']) for r in runs)} frequency pattern(s)")
