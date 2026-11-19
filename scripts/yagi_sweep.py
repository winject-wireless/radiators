#!/usr/bin/env python3
"""Staged, resource-bounded openEMS sweep of the measured 2.45 GHz Yagi.

Runs only on a trusted self-hosted runner. Works with Linux Docker on a Linux
host or Docker Desktop's Linux backend on a Windows host. No external packages
are needed outside the openEMS container.
"""
import argparse
import concurrent.futures
import copy
import csv
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

FREQS = (2_400_000_000, 2_450_000_000, 2_500_000_000)
BASE = Path("antennas/yagi_16rod_bonded_boom_measured_loop_2450.json")
FIELDS = ("pitch", "front_gap", "back_gap", "offset")
BASE_PARAMS = (24, 24, 24, 16)  # mm; offset is a positive distance toward -Y
LIMITS = ((18, 30), (12, 36), (12, 36), (12, 28))
STEPS = (2, 4, 4, 2)
DOCKER = ["docker"]  # May use passwordless sudo if runner account lacks socket permissions.


def params_dict(p):
    return dict(zip(FIELDS, p))


def case_name(p, fine=False):
    return "p%02d_f%02d_b%02d_y%02d_%s" % (*p, "fine" if fine else "coarse")


def within(p):
    return all(lo <= v <= hi for v, (lo, hi) in zip(p, LIMITS))


def make_geometry(base, p, fine=False):
    """Preserve measured metal, count, element length, and racetrack loop."""
    assert within(p), p
    pitch, front_gap, back_gap, offset = p
    cfg = copy.deepcopy(base)
    directors = sorted((g for g in cfg["geometry"] if re.fullmatch(r"director-\d\d", g["name"])),
                       key=lambda g: g["name"])
    assert len(directors) == 15
    boom = next(g for g in cfg["geometry"] if g["name"] == "square-aluminum-boom-bonded")
    loop = next(g for g in cfg["geometry"] if g["shape"] == "wire" and "loop" in g["name"])
    reflector = next(g for g in cfg["geometry"] if g["name"] == "reflector-01")
    assert abs(loop["wire_diameter"] - 4.0) < 1e-6
    assert boom["start"][1:] == [-8, -8] and boom["stop"][1:] == [8, 8]
    for i, rod in enumerate(directors):
        assert rod["radius"] == 4
        rod["start"][0] = rod["stop"][0] = i * pitch
    center_x = (len(directors) - 1) * pitch + front_gap
    reflector_x = center_x + back_gap
    reflector["start"][0] = reflector["stop"][0] = reflector_x
    boom["stop"][0] = reflector_x + 12  # bonded to reflector; preserve 12 mm overhang
    dx = center_x - 360
    for pt in loop["points"]:
        pt[0] = round(pt[0] + dx, 5)
        pt[1] = -offset
    port = cfg["ports"][0]
    assert port["start"][2] == -4 and port["stop"][2] == 4
    for side in ("start", "stop"):
        port[side][0] += dx
        port[side][1] = -offset
    # The 4 mm copper wire must not overlap the metal boom: with Y=-12,
    # the wire ends at Y=-10, leaving 2 mm clearance from the boom at Y=-8.
    assert offset - loop["wire_diameter"] / 2 > 8
    # The external computational domain remains identical across candidates;
    # this prevents gain differences from being caused by moving PML walls.
    if fine:
        # 1.6 mm ensures both +/-4 mm feed planes lie exactly on Z grid lines.
        cfg["domain"]["start"] = [-120, -96, -100]
        cfg["domain"]["stop"] = [580.8, 96, 100]
        cfg["mesh"] = dict(grid_mode="uniform", uniform_step_mm=1.6,
                           max_cell_mm=1.6, max_cells=8_000_000, growth_ratio=1.35)
        for side in ("start", "stop"):
            # Snap port to the actual 1.6 mm grid, within the 2 mm wire radius.
            for ax in (0, 1):
                start = cfg["domain"]["start"][ax]
                span = cfg["domain"]["stop"][ax] - start
                n = math.ceil(span / 1.6)
                step = span / n
                v = port[side][ax]
                port[side][ax] = round(start + round((v - start) / step) * step, 5)
    else:
        cfg["domain"]["start"] = [-121, -96, -100]
        cfg["domain"]["stop"] = [579, 96, 100]
        cfg["mesh"] = dict(grid_mode="uniform", uniform_step_mm=2,
                           max_cell_mm=2, max_cells=4_000_000, growth_ratio=1.35)
    assert reflector_x + 12 < cfg["domain"]["stop"][0] - 80
    cfg["name"] = "Yagi sweep " + case_name(p, fine)
    cfg["description"] = ("EXPERIMENTAL parameter sweep; measured conductor dimensions fixed; "
                          "unmeasured rod pitch, feed/loop position and reflector spacing varied. "
                          "Optimized for forward -X realized gain at 2.4/2.45/2.5 GHz. "
                          "Not a validated physical build.")
    cfg["solver"]["resources"] = dict(cpus=4, memory_gib=12)
    cfg["outputs"]["radiation_frequencies_hz"] = list(FREQS)
    cfg["outputs"]["radiation_grid"] = dict(theta_step_deg=3, phi_step_deg=5)
    cfg["outputs"]["include_polarization"] = False  # shorter artifacts
    cfg["outputs"]["include_realized_gain"] = True
    cfg["outputs"]["include_impedance"] = True
    cfg["outputs"]["s11"] = [dict(start=2_350_000_000, step=5_000_000, end=2_550_000_000)]
    cfg["excitation"] = dict(center_hz=2_450_000_000, bandwidth_hz=200_000_000)
    return cfg


def check_docker(image, logpath):
    global DOCKER
    res = subprocess.run(DOCKER + ["info", "--format", "{{.OSType}}"],
                         capture_output=True, text=True, timeout=45)
    if res.returncode and "permission denied" in (res.stdout + res.stderr).lower():
        # EC2/WSL/Linux account may not yet belong to the docker group.
        # Use only an already-authorized, non-interactive sudo; never prompt.
        if os.name == "posix" and shutil.which("sudo"):
            alternate = ["sudo", "-n", "docker"]
            elevated = subprocess.run(alternate + ["info", "--format", "{{.OSType}}"],
                                      capture_output=True, text=True, timeout=45)
            if elevated.returncode == 0:
                DOCKER = alternate
                res = elevated
                print("Docker socket denied unprivileged access; "
                      "using preauthorized sudo -n docker.", flush=True)
    if res.returncode or res.stdout.strip().lower() != "linux":
        raise RuntimeError("Docker Linux daemon is not accessible to this runner. "
                           "If the error is /var/run/docker.sock permission denied, "
                           "add the GitHub runner account to the docker group and "
                           "restart its runner service/session, or authorize "
                           "passwordless 'sudo docker'. Output: "
                           + res.stdout + " " + res.stderr)
    chk = subprocess.run(DOCKER + ["image", "inspect", image], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    if chk.returncode:
        print("No cached openEMS image; building on this machine.", flush=True)
        with logpath.open("w", encoding="utf-8") as log:
            built = subprocess.run(DOCKER + ["build", "-t", image,
                                            "-f", "docker/openems/Dockerfile", "."],
                                   stdout=log, stderr=subprocess.STDOUT)
        if built.returncode:
            raise RuntimeError("Docker image build failed; inspect " + str(logpath))


def planned_cases():
    # One-factor screening around actual measured-loop baseline.
    p0 = BASE_PARAMS
    options = {
        "pitch": (20, 22, 26, 28),
        "front_gap": (16, 20, 28, 32),
        "back_gap": (16, 20, 28, 32),
        "offset": (12, 14, 20, 24),
    }
    ans = [p0]
    for axis, values in options.items():
        k = FIELDS.index(axis)
        for value in values:
            p = list(p0); p[k] = value
            ans.append(tuple(p))
    assert len(set(ans)) == 17
    return ans


def fine_cases(records, completed):
    # Fine-mesh verification of top THREE different geometries.
    good = sorted((r for r in records if r.get("valid") and not r["fine"]),
                  key=lambda r: r["score"], reverse=True)
    out, seen = [], set()
    for r in good:
        p = tuple(r[k] for k in FIELDS)
        if p not in seen and case_name(p, True) not in completed:
            out.append(p); seen.add(p)
        if len(out) == 3: break
    return out


def local_cases(records, seen):
    good = sorted((r for r in records if r.get("valid") and not r["fine"]),
                  key=lambda r: r["score"], reverse=True)
    best = tuple(good[0][k] for k in FIELDS) if good else BASE_PARAMS
    candidates = []
    for axis in range(4):
        for sign in (-1, 1):
            p = list(best); p[axis] += sign * STEPS[axis]
            p = tuple(p)
            if within(p) and p not in seen:
                candidates.append(p)
    return candidates


def interaction_cases(records, seen):
    # Try two-dimensional interactions for the two axes showing the largest
    # one-factor performance influence; avoid a full factorial explosion.
    valid = [r for r in records if r.get("valid") and not r["fine"]]
    ranked = sorted(valid, key=lambda r: r["score"], reverse=True)
    best = tuple(ranked[0][k] for k in FIELDS) if ranked else BASE_PARAMS
    baseline = next((r for r in valid if all(r[k] == v for k, v in zip(FIELDS, BASE_PARAMS))), None)
    base_score = baseline["score"] if baseline else (ranked[0]["score"] if ranked else 0)
    differences = []
    for axis in range(4):
        scores = [abs(r["score"] - base_score) for r in valid
                  if sum(r[k] != v for k, v in zip(FIELDS, BASE_PARAMS)) == 1
                  and r[FIELDS[axis]] != BASE_PARAMS[axis]]
        differences.append(max(scores, default=0))
    axes = sorted(range(4), key=lambda a: differences[a], reverse=True)[:2]
    candidates = []
    for da in (-STEPS[axes[0]], 0, STEPS[axes[0]]):
        for db in (-STEPS[axes[1]], 0, STEPS[axes[1]]):
            p = list(best); p[axes[0]] += da; p[axes[1]] += db
            p = tuple(p)
            if within(p) and p not in seen: candidates.append(p)
    return candidates


def cpu_stats(txt):
    usage = re.search(r"(?m)^usage_usec\s+(\d+)", txt)
    return int(usage.group(1)) if usage else None


def collect_case(outdir, p, fine, wall_seconds=0, failed=None):
    name = case_name(p, fine)
    rec = dict(case=name, **params_dict(p), fine=fine,
               wall_seconds=round(wall_seconds, 2), valid=False)
    if failed:
        rec["error"] = failed
        return rec
    try:
        result = json.loads((outdir / "result.json").read_text(encoding="utf-8"))
        logs = (outdir / "runner.log").read_text(encoding="utf-8", errors="replace")
        if not re.search(r"RunFDTD: end-criteria .* reached after", logs):
            raise ValueError("Solver failed energy-convergence criterion")
        cpu_a, cpu_b = (outdir / "cpu_start.txt"), (outdir / "cpu_end.txt")
        if cpu_a.exists() and cpu_b.exists():
            a, b = cpu_stats(cpu_a.read_text()), cpu_stats(cpu_b.read_text())
            if a is not None and b is not None:
                rec["cpu_seconds"] = round(max(0, b - a) / 1e6, 2)
        peak = (outdir / "memory_peak.txt")
        if peak.exists() and peak.read_text().strip().isdigit():
            rec["memory_peak_gib"] = round(int(peak.read_text().strip()) / 1024**3, 3)
        freqs = result["s11"]["frequency_hz"]
        ci = min(range(len(freqs)), key=lambda i: abs(freqs[i] - 2_450_000_000))
        if freqs[ci] != 2_450_000_000:
            raise ValueError("2.45 GHz impedance not evaluated")
        rec.update(s11_db=result["s11"]["logmag_db"][ci],
                   vswr=result["s11"]["vswr"][ci],
                   impedance_real_ohm=result["impedance"]["real_ohm"][ci],
                   impedance_imag_ohm=result["impedance"]["imag_ohm"][ci])
        if not all(math.isfinite(rec[key]) for key in
                   ("s11_db", "vswr", "impedance_real_ohm", "impedance_imag_ohm")):
            raise ValueError("Nonfinite input impedance or S11")
        mismatch = 10 ** (rec["s11_db"] / 10)  # power reflected
        rec["matching_efficiency"] = max(0, min(1, 1 - mismatch))
        fg, dirg, etas = [], [], []
        for f in FREQS:
            pat = json.loads((outdir / ("pattern_%dHz.json" % f)).read_text(encoding="utf-8"))
            theta, phi = pat["theta_deg"], pat["phi_deg"]
            ti = min(range(len(theta)), key=lambda i: abs(theta[i] - 90))
            fi = min(range(len(phi)), key=lambda i: abs(phi[i] - 180))
            bi = min(range(len(phi)), key=lambda i: abs(phi[i]))
            rg = pat["realized_gain_dbi"]
            fwd = rg[ti][fi]; back = rg[ti][bi]
            eta = pat["radiation_efficiency"]
            if eta is None or not math.isfinite(eta) or not (0 <= eta <= 1.05):
                raise ValueError("Unphysical radiation efficiency: %r" % eta)
            if not (math.isfinite(fwd) and math.isfinite(back)):
                raise ValueError("Nonfinite gain")
            fg.append(fwd); etas.append(eta)
            dirg.append(pat["directivity_dbi"][ti][fi])
            if f == 2_450_000_000:
                rec.update(forward_gain_2450_dbi=fwd, front_back_2450_db=fwd-back,
                           directivity_forward_2450_dbi=dirg[-1],
                           peak_gain_2450_dbi=max(map(max, rg)),
                           radiation_efficiency_2450=min(eta, 1),
                           raw_radiation_efficiency_2450=eta)
        rec["min_forward_gain_dbi"] = min(fg)
        rec["mean_forward_gain_dbi"] = sum(fg) / len(fg)
        rec["total_efficiency_2450"] = (rec["radiation_efficiency_2450"]
                                        * rec["matching_efficiency"])
        # Forward realized gain includes radiation and mismatch losses already.
        # Reward performance at center and weakest edge of 2.4–2.5 GHz.
        rec["score"] = 0.65 * rec["forward_gain_2450_dbi"] + 0.35 * rec["min_forward_gain_dbi"]
        rec["valid"] = True
    except (OSError, KeyError, IndexError, TypeError, ValueError, ZeroDivisionError) as exc:
        rec["error"] = str(exc)
    return rec


def simulate(image, base, dest, p, fine, cpu, memory):
    name = case_name(p, fine)
    work = dest / name
    work.mkdir(parents=True, exist_ok=True)
    info = work / "result.json"
    if info.is_file():
        return collect_case(work, p, fine, failed=None)
    cfg = make_geometry(base, p, fine)
    confpath = work / "config.json"
    confpath.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    # Docker must see paths relative to /work: the repository root is bind mounted.
    config_rel = confpath.resolve().relative_to(Path.cwd().resolve()).as_posix()
    out_rel = work.resolve().relative_to(Path.cwd().resolve()).as_posix()
    script = ("cat {0}/cpu.stat > /work/{1}/cpu_start.txt 2>/dev/null || true; "
              "python antennas/simulate.py /work/{1}/config.json --output /work/{1}; "
              "rc=$?; cat {0}/cpu.stat > /work/{1}/cpu_end.txt 2>/dev/null || true; "
              "cat /sys/fs/cgroup/memory.peak > /work/{1}/memory_peak.txt 2>/dev/null || true; "
              "exit $rc").format("/sys/fs/cgroup", out_rel)
    # Deliberately keep root as container user for Windows Docker Desktop bind mounts.
    cmd = DOCKER + ["run", "--rm", "--cpus", str(cpu), "--memory", str(memory) + "g",
           "--memory-swap", str(memory) + "g", "--pids-limit", "512",
           "-e", "OMP_NUM_THREADS=" + str(cpu),
           "-e", "OPENBLAS_NUM_THREADS=1",
           "--mount", "type=bind,source=" + str(Path.cwd().resolve()) + ",target=/work",
           "-w", "/work", image, "bash", "-lc", script]
    # Use the runner's UID/GID on native Linux so Docker outputs don't become
    # root-owned in the persistent self-hosted checkout.
    if os.name == "posix":
        cmd[1:1] = []  # No-op; Docker subcommand follows any optional sudo prefix.
        subcmd_index = len(DOCKER)
        cmd[subcmd_index + 1:subcmd_index + 1] = ["--user", "%d:%d" % (os.getuid(), os.getgid())]
    begin = time.monotonic()
    with (work / "runner.log").open("w", encoding="utf-8") as log:
        run = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    elapsed = time.monotonic() - begin
    rec = collect_case(work, p, fine, wall_seconds=elapsed,
                       failed=("Docker/openEMS failed (exit %d)" % run.returncode)
                       if run.returncode else None)
    print(("%s %s wall=%.1fs fwd=%s dBi S11=%s dB" %
           ("PASS" if rec["valid"] else "FAIL", name, elapsed,
            round(rec.get("forward_gain_2450_dbi", float("nan")), 2),
            round(rec.get("s11_db", float("nan")), 2))), flush=True)
    return rec


def run_phase(phase, cases, base, image, dest, records, cpus, ram, workers, fine=False):
    previously = {r["case"] for r in records}
    todo = [p for p in dict.fromkeys(cases) if case_name(p, fine) not in previously]
    print("PHASE %s: %d new simulations; %d workers x %d CPUs / %d GiB" %
          (phase, len(todo), workers, cpus, ram), flush=True)
    if not todo: return
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(simulate, image, base, dest, p, fine, cpus, ram): p for p in todo}
        for future in concurrent.futures.as_completed(futures):
            try:
                rec = future.result()
            except Exception as exc:
                p = futures[future]
                rec = dict(case=case_name(p, fine), **params_dict(p), fine=fine, valid=False,
                           error=str(exc))
            rec["phase"] = phase
            records.append(rec)
            save_report(dest, records)


def save_report(dest, records):
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "all_results.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    keys = ["case", "phase", *FIELDS, "fine", "valid", "score",
            "forward_gain_2450_dbi", "min_forward_gain_dbi", "peak_gain_2450_dbi",
            "directivity_forward_2450_dbi", "front_back_2450_db",
            "s11_db", "vswr", "impedance_real_ohm", "impedance_imag_ohm",
            "radiation_efficiency_2450", "total_efficiency_2450",
            "cpu_seconds", "wall_seconds", "memory_peak_gib", "error"]
    with (dest / "ranking.csv").open("w", encoding="utf-8", newline="") as fp:
        writer = csv.DictWriter(fp, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted(records, key=lambda r: r.get("score", -1e6), reverse=True))
    good = [r for r in records if r.get("valid")]
    rank = sorted(good, key=lambda r: r["score"], reverse=True)
    lines = ["# Yagi optimization sweep", "",
             "Measured 57.9 × 33.4 mm, 4 mm wire racetrack loop; 15 directors and "
             "one bonded 16 × 16 mm PEC boom/reflector. All dimensions in mm.",
             "",
             "Objective: 0.65 × forward **realized gain at 2.45 GHz** + 0.35 × "
             "minimum forward realized gain at 2.40/2.45/2.50 GHz.",
             "Realized gain includes mismatch; radiation efficiency alone is ~100% "
             "for ideal PEC and is not sufficient to rank these antennas.",
             "No true aluminum loss, plastic caps, coax/balun or verified loop feed topology.",
             "", "Successful %d / attempted %d." % (len(good), len(records)), ""]
    lines.append("| Rank | Candidate | Forward 2.45 (dBi) | Worst band (dBi) | "
                 "S11 (dB) | Total eff. | F/B (dB) | CPU s |")
    lines.append("|---:|---|---:|---:|---:|---:|---:|---:|")
    for i, r in enumerate(rank[:15]):
        lines.append("| %d | %s | %.2f | %.2f | %.2f | %.1f%% | %.1f | %s |" %
                     (i+1, r["case"], r["forward_gain_2450_dbi"],
                      r["min_forward_gain_dbi"], r["s11_db"],
                      100*r["total_efficiency_2450"], r["front_back_2450_db"],
                      ("%.0f" % r["cpu_seconds"]) if "cpu_seconds" in r else "n/a"))
    if rank:
        # Prefer a mesh-refined candidate for the final recommendation.
        verified = [r for r in rank if r["fine"]]
        best = verified[0] if verified else rank[0]
        by_eff = max(rank, key=lambda r: r["total_efficiency_2450"])
        by_directivity = max(rank, key=lambda r: r["directivity_forward_2450_dbi"])
        lines += ["", "## Objective-specific leaders", "",
                  "- Best total feed-to-radiated efficiency: %s (%.2f%%)" %
                  (by_eff["case"], 100*by_eff["total_efficiency_2450"]),
                  "- Best forward directivity: %s (%.2f dBi)" %
                  (by_directivity["case"], by_directivity["directivity_forward_2450_dbi"]),
                  "- Best broad-band realized-gain score: %s" % rank[0]["case"], ""]
        lines += ["", "## Preferred candidate (fine mesh when available)", "",
                  "- Parameters: " + json.dumps(params_dict(tuple(best[k] for k in FIELDS))),
                  "- Mesh: " + ("fine (1.6 mm)" if best["fine"] else "coarse (2 mm)"),
                  "- Forward realized gain: %.2f dBi" % best["forward_gain_2450_dbi"],
                  "- S11 at center: %.2f dB" % best["s11_db"],
                  "- VSWR: %.2f" % best["vswr"],
                  "- Forward directivity: %.2f dBi" % best["directivity_forward_2450_dbi"],
                  "- Radiation efficiency (ideal conductor): %.2f%%" %
                  (100*best["radiation_efficiency_2450"]),
                  "- Total input-to-radiated efficiency: %.2f%%" %
                  (100*best["total_efficiency_2450"]),
                  "", "**This is a simulation-based search, not proof of an optimized or "
                  "manufacturable real antenna.** A final choice should be re-run with "
                  "finer mesh and the actual feed/rod dimensions.", ""]
    else:
        lines += ["", "**No numerically valid / converged candidates yet.**", ""]
    (dest / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=BASE)
    parser.add_argument("--dest", type=Path, default=Path("results/yagi_sweep"))
    parser.add_argument("--image", default="radiators-openems:ci")
    parser.add_argument("--parallel", type=int, default=4)
    parser.add_argument("--cpus-per-case", type=int, default=4)
    parser.add_argument("--memory-gib-per-case", type=int, default=12)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    assert args.cpus_per_case*args.parallel <= 16, "CPU budget > 16"
    assert args.memory_gib_per_case*args.parallel <= 52, "Leave >=12 GiB for host"
    assert args.dest.resolve().is_relative_to(Path.cwd().resolve()), "Output must be in repo"
    base = json.loads(args.base.read_text(encoding="utf-8"))
    if args.self_test:
        for p in planned_cases():
            a = make_geometry(base, p)
            assert len(a["geometry"]) == 18
            assert a["ports"][0]["start"][2] == -4
        a = make_geometry(base, BASE_PARAMS, fine=True)
        assert a["mesh"]["max_cells"] == 8_000_000
        assert a["ports"][0]["start"][0] == a["ports"][0]["stop"][0]
        print("Sweep geometry checks passed; 17 screening candidates.", flush=True)
        return 0
    args.dest.mkdir(parents=True, exist_ok=True)
    # Safe on rerun: collect only recorded results, and write a running CSV.
    record_file = args.dest / "all_results.json"
    records = json.loads(record_file.read_text(encoding="utf-8")) if record_file.exists() else []
    check_docker(args.image, args.dest / "docker_build.log")
    # The host can have 64 GiB while Docker Desktop/WSL2 exposes less.
    # Respect resources actually visible to Docker, not the marketing spec.
    info = subprocess.run(DOCKER + ["info", "--format", "{{json .}}"],
                          capture_output=True, text=True, check=True)
    dinfo = json.loads(info.stdout)
    total_cpus = int(dinfo["NCPU"])
    total_mem_gib = int(dinfo["MemTotal"]) // (1024 ** 3)
    workers = min(args.parallel, total_cpus // args.cpus_per_case,
                  (total_mem_gib - 8) // args.memory_gib_per_case)
    if workers < 1:
        raise RuntimeError("Docker has %d vCPUs and %d GiB; need at least %d CPUs "
                           "and %d GiB (including 8 GiB host reserve). Increase WSL2/"
                           "Docker Desktop resources or reduce per-case budgets." %
                           (total_cpus, total_mem_gib, args.cpus_per_case,
                            args.memory_gib_per_case + 8))
    print("Docker resources: %d CPUs, %d GiB; running %d parallel cases" %
          (total_cpus, total_mem_gib, workers), flush=True)
    run_phase("A-screen", planned_cases(), base, args.image, args.dest, records,
              args.cpus_per_case, args.memory_gib_per_case, workers)
    seen = {tuple(r[k] for k in FIELDS) for r in records}
    run_phase("B-local", local_cases(records, seen), base, args.image, args.dest, records,
              args.cpus_per_case, args.memory_gib_per_case, workers)
    seen = {tuple(r[k] for k in FIELDS) for r in records}
    run_phase("C-interaction", interaction_cases(records, seen), base, args.image, args.dest, records,
              args.cpus_per_case, args.memory_gib_per_case, workers)
    completed = {r["case"] for r in records}
    run_phase("D-fine", fine_cases(records, completed), base, args.image, args.dest, records,
              args.cpus_per_case, args.memory_gib_per_case, args.parallel, fine=True)
    save_report(args.dest, records)
    print((args.dest / "summary.md").read_text(encoding="utf-8"), flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fp:
            fp.write((args.dest / "summary.md").read_text(encoding="utf-8") + "\n")
    return 0 if any(r.get("valid") for r in records) else 1


if __name__ == "__main__":
    sys.exit(main())
