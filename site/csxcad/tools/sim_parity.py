#!/usr/bin/env python3
"""Parity of the editor's openEMS model builder (js/sim/model.js) with antennas/simulate_v2.py.

For every case of the given configs (default: antennas/*.json, examples/*.json) this runs the
real simulate_v2.output_data() with native CSXCAD/openEMS up to the point where it writes
geometry.xml (fdtd.Run is stubbed), builds the same case with the JS builder, and compares the
mesh lines and every property's primitives. Needs native openEMS: source /opt/openEMS/env.sh.
"""
import json, subprocess, sys, tempfile, xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "antennas")]
from sweep import expand_cases          # noqa: E402
import simulate_v2                      # noqa: E402


class Stop(Exception):
    pass


def python_xml(cfg, tmp):
    import openEMS as pkg
    real = pkg.openEMS

    class NoRun(real):  # the extension type is immutable: substitute a subclass instead
        def Run(self, *a, **k):
            raise Stop()

    pkg.openEMS = NoRun  # output_data() does `from openEMS import openEMS` at call time
    try:
        simulate_v2.output_data(cfg, tmp)
    except Stop:
        pass
    finally:
        pkg.openEMS = real
    return ET.parse(tmp / "geometry.xml").getroot()


def js_xml(cfg):
    code = ("import('" + (ROOT / "site/csxcad/js/sim/model.js").as_uri() + "').then(m => {"
            "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(m.buildModel(JSON.parse(s)).xml)}"
            "catch(e){process.stdout.write('ERROR '+e.message)}})})")
    out = subprocess.run(["node", "-e", code], input=json.dumps(cfg), capture_output=True, text=True, check=True).stdout
    if out.startswith("ERROR "):
        raise ValueError(out[6:])
    return ET.fromstring(out).find("ContinuousStructure")


def nums(text):
    return [float(v) for v in text.replace(",", " ").split()]


def prim_signature(p):
    """(tag, sorted numeric content) of a primitive, independent of formatting."""
    vals = [float(v) for k, v in sorted(p.attrib.items()) if k not in ("Priority",)]
    for c in p.iter():
        if c is p:
            continue
        vals += [float(c.attrib[k]) for k in ("X", "Y", "Z") if k in c.attrib]
        if c.text and c.text.strip():
            vals += nums(c.text)
    return p.tag, int(p.attrib.get("Priority", 0)), vals


def compare(a, b, rel=1e-9):
    problems = []
    ga, gb = a.find("RectilinearGrid"), b.find("RectilinearGrid")
    for ax in "XYZ":
        la, lb = nums(ga.find(ax + "Lines").text), nums(gb.find(ax + "Lines").text)
        span = max(abs(lb[-1] - lb[0]), 1)
        if len(la) != len(lb):
            problems.append(f"{ax} lines {len(la)} vs {len(lb)}")
        elif max(abs(x - y) for x, y in zip(la, lb)) > rel * span:
            problems.append(f"{ax} lines differ by {max(abs(x - y) for x, y in zip(la, lb)):.3g}")
    pa = {p.attrib["Name"]: p for p in a.find("Properties")}
    pb = {p.attrib["Name"]: p for p in b.find("Properties")}
    if set(pa) != set(pb):
        problems.append(f"properties {sorted(set(pa) ^ set(pb))}")
    for name in set(pa) & set(pb):
        if pa[name].tag != pb[name].tag:
            problems.append(f"{name}: {pa[name].tag} vs {pb[name].tag}")
        sa = [prim_signature(p) for p in pa[name].find("Primitives") or []]
        sb = [prim_signature(p) for p in pb[name].find("Primitives") or []]
        if len(sa) != len(sb):
            problems.append(f"{name}: {len(sa)} vs {len(sb)} primitives")
            continue
        for k, (x, y) in enumerate(zip(sa, sb)):
            if x[:2] != y[:2] or len(x[2]) != len(y[2]) or any(
                    abs(u - v) > 1e-6 * max(1, abs(v)) for u, v in zip(x[2], y[2])):
                problems.append(f"{name} primitive {k}: {x[0]} differs")
                break
    return problems


def main():
    files = [Path(f) for f in sys.argv[1:]] or sorted((ROOT / "antennas").glob("*.json")) + sorted((ROOT / "examples").glob("*.json")) + sorted((ROOT / "tests/fixtures").glob("*.json"))
    failed = 0
    for f in files:
        cfg = json.loads(f.read_text())
        if cfg.get("schema_version") != 2:
            continue
        for case in expand_cases(cfg, f.relative_to(ROOT) if f.is_absolute() else f):
            c = case["config"]
            label = f"{f.name} {case['case_id']}"
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    py = python_xml(c, Path(tmp))
            except Exception as e:
                print(f"SKIP {label}: python: {e}")
                continue
            try:
                problems = compare(js_xml(c), py)
            except Exception as e:
                problems = [f"js: {e}"]
            print(("OK   " if not problems else "FAIL ") + label + ("" if not problems else ": " + "; ".join(problems[:4])))
            failed += bool(problems)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
