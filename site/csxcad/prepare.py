#!/usr/bin/env python3
"""Assemble the CSXCAD editor as a self-contained static web app.

* Downloads the pinned three.js modules into site/csxcad/vendor/ (cached).
* Copies antennas/*.json and examples/*.json into site/csxcad/examples/ with
  an index.json, so "Open example" works offline.
* Writes a complete copy to --out (default: site/csxcad/www, the Capacitor
  webDir) with the service-worker cache version stamped.

No runtime CDN: the published page and the Android APK load only local files.
"""
import argparse
import hashlib
import json
from pathlib import Path
from shutil import copy2, copytree, rmtree
from urllib.request import Request, urlopen

THREE_VERSION = "0.160.0"
VENDOR = {
    "three.module.min.js": (f"build/three.module.min.js", b"REVISION", 500_000),
    "addons/controls/OrbitControls.js": (f"examples/jsm/controls/OrbitControls.js", b"class OrbitControls", 10_000),
    "addons/environments/RoomEnvironment.js": (f"examples/jsm/environments/RoomEnvironment.js", b"class RoomEnvironment", 1_000),
    "addons/controls/TransformControls.js": (f"examples/jsm/controls/TransformControls.js", b"class TransformControls", 10_000),
}
# CodeMirror 5: classic scripts (no bundler), loaded on demand by js/code-editor.js.
CM_VERSION = "5.65.16"
CM_FILES = {
    "lib/codemirror.js": (b"CodeMirror", 300_000),
    "lib/codemirror.css": (b".CodeMirror", 5_000),
    "mode/javascript/javascript.js": (b"defineMode", 20_000),
    "addon/hint/show-hint.js": (b"showHint", 10_000),
    "addon/hint/show-hint.css": (b"CodeMirror-hints", 300),
    "addon/edit/closebrackets.js": (b"autoCloseBrackets", 3_000),
    "addon/edit/matchbrackets.js": (b"matchBrackets", 3_000),
    "addon/comment/comment.js": (b"toggleComment", 3_000),
    "addon/selection/active-line.js": (b"styleActiveLine", 1_000),
}
CM_CDNS = (
    "https://cdn.jsdelivr.net/npm/codemirror@{v}/{path}",
    "https://unpkg.com/codemirror@{v}/{path}",
)
CDNS = (
    "https://cdn.jsdelivr.net/npm/three@{v}/{path}",
    "https://unpkg.com/three@{v}/{path}",
)
APP_FILES = ("index.html", "app.css", "manifest.webmanifest", "icon.svg", "icon-maskable.svg", "sw.js")

here = Path(__file__).resolve().parent
repo = here.parent.parent


def fetch_vendor():
    vendor = here / "vendor"
    stamp = vendor / "VERSION"
    if stamp.is_file() and stamp.read_text().strip() == THREE_VERSION and all(
            (vendor / name).is_file() for name in VENDOR):
        return
    for name, (path, marker, min_size) in VENDOR.items():
        errors = []
        for pattern in CDNS:
            url = pattern.format(v=THREE_VERSION, path=path)
            try:
                with urlopen(Request(url, headers={"User-Agent": "radiators-csxcad-prepare/1.0"}), timeout=35) as r:
                    body = r.read()
                if len(body) < min_size or marker not in body:
                    raise ValueError(f"unexpected content ({len(body)} bytes)")
                target = vendor / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                print(f"vendored three@{THREE_VERSION} {name} from {url} ({len(body)} bytes)")
                break
            except Exception as error:  # try the next CDN
                errors.append(f"{url}: {error}")
        else:
            raise RuntimeError("Failed to vendor three.js:\n" + "\n".join(errors))
    stamp.write_text(THREE_VERSION + "\n")


def fetch_codemirror():
    vendor = here / "vendor" / "codemirror"
    stamp = vendor / "VERSION"
    if stamp.is_file() and stamp.read_text().strip() == CM_VERSION and all(
            (vendor / name).is_file() for name in CM_FILES):
        return
    for name, (marker, min_size) in CM_FILES.items():
        errors = []
        for pattern in CM_CDNS:
            url = pattern.format(v=CM_VERSION, path=name)
            try:
                with urlopen(Request(url, headers={"User-Agent": "radiators-csxcad-prepare/1.0"}), timeout=35) as r:
                    body = r.read()
                if len(body) < min_size or marker not in body:
                    raise ValueError(f"unexpected content ({len(body)} bytes)")
                target = vendor / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                print(f"vendored codemirror@{CM_VERSION} {name} ({len(body)} bytes)")
                break
            except Exception as error:
                errors.append(f"{url}: {error}")
        else:
            raise RuntimeError("Failed to vendor CodeMirror:\n" + "\n".join(errors))
    stamp.write_text(CM_VERSION + "\n")


# openEMS compiled to WebAssembly (site/openems, built by wasm/openems): copied into the
# editor so it is self-contained (Pages, PWA and the Android wrapper).
OPENEMS_FILES = ("openems.js", "openems-core.js", "openems-post.js", "openems-worker.js",
                 "openems.mjs", "openems.wasm", "BUILD-INFO.txt")


def copy_openems():
    src, dst = repo / "site" / "openems", here / "vendor" / "openems"
    dst.mkdir(parents=True, exist_ok=True)
    for name in OPENEMS_FILES:
        if not (src / name).is_file():
            raise RuntimeError(f"missing {src / name} (openEMS wasm build)")
        copy2(src / name, dst / name)


def collect_examples():
    target = here / "examples"
    if target.exists():
        rmtree(target)
    target.mkdir()
    index = []
    for folder in ("antennas", "examples"):
        for source in sorted((repo / folder).glob("*.json")):
            try:
                cfg = json.loads(source.read_text())
            except json.JSONDecodeError:
                continue
            if cfg.get("schema_version") != 2:
                continue  # the editor is schema v2 only
            name = f"{folder}__{source.name}"
            copy2(source, target / name)
            index.append({
                "file": name, "source": f"{folder}/{source.name}", "name": cfg.get("name", source.stem),
                "description": (cfg.get("description") or "")[:160],
                "sweep": "sweep" in cfg, "generator": "generator" in cfg,
            })
    (target / "index.json").write_text(json.dumps(index, indent=1))
    print(f"bundled {len(index)} schema v2 example(s)")


def build(out: Path):
    if out.exists():
        rmtree(out)
    out.mkdir(parents=True)
    for name in APP_FILES:
        copy2(here / name, out / name)
    for folder in ("js", "vendor", "examples"):
        copytree(here / folder, out / folder)
    digest = hashlib.sha256()
    for path in sorted(p for p in out.rglob("*") if p.is_file()):
        digest.update(path.relative_to(out).as_posix().encode())
        digest.update(path.read_bytes())
    version = digest.hexdigest()[:12]
    sw = out / "sw.js"
    sw.write_text(sw.read_text().replace("CACHE_VERSION", version))
    html = out / "index.html"
    html.write_text(html.read_text().replace("EDITOR_BUILD", version))
    print(f"CSXCAD editor assembled in {out} (cache {version})")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=here / "www",
                        help="output directory (default: site/csxcad/www for Capacitor)")
    args = parser.parse_args()
    fetch_vendor()
    fetch_codemirror()
    copy_openems()
    collect_examples()
    build(args.out.resolve())


if __name__ == "__main__":
    main()
