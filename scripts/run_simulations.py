#!/usr/bin/env python3
"""Run independent antenna configs concurrently within available CPU and RAM.

Each run receives a Docker CPU quota and an enforced memory limit. Jobs are
scheduled by both resources, not merely a fixed worker count. A failed job
does not prevent other runnable jobs from finishing, but makes the step fail.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from sweep import expand_cases


def cpu_capacity():
    cpus = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            cpus = min(cpus, max(1, math.floor(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, cpus)


def ram_capacity_bytes():
    # Choose the smaller of host MemAvailable and remaining cgroup memory.
    available = None
    try:
        with Path("/proc/meminfo").open() as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    available = int(line.split()[1]) * 1024
                    break
    except OSError:
        pass
    try:
        max_str = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        current = int(Path("/sys/fs/cgroup/memory.current").read_text())
        if max_str != "max":
            limit_left = max(0, int(max_str) - current)
            available = min(available, limit_left) if available is not None else limit_left
    except (OSError, ValueError):
        pass
    if available is None:
        raise RuntimeError("Cannot determine available RAM safely")
    return available


def load_requests(path, default_cpu, default_memory_gib):
    found = []
    names = set()
    for filename in path.read_text().splitlines():
        filename = filename.strip()
        if not filename:
            continue
        if not re.fullmatch(r"antennas/[A-Za-z0-9_-]+\.json", filename):
            raise ValueError(f"Unexpected antenna path: {filename!r}")
        if filename in names:
            continue
        names.add(filename)
        cfg_path = Path(filename)
        if not cfg_path.is_file():
            raise FileNotFoundError(filename)
        raw = json.loads(cfg_path.read_text())
        for case in expand_cases(raw, cfg_path):
            settings = case["config"].get("solver", {}).get("resources", {})
            cpus = int(settings.get("cpus", default_cpu))
            memory_gib = float(settings.get("memory_gib", default_memory_gib))
            if not (1 <= cpus <= 128 and 0.25 <= memory_gib <= 1024 and math.isfinite(memory_gib)):
                raise ValueError(f"{cfg_path}: invalid solver.resources")
            found.append((filename, case, cpus, int(memory_gib * 1024 ** 3)))
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", type=Path, default=Path("changed-antennas.txt"))
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--image", default="radiators-openems:ci")
    parser.add_argument("--cpus-per-job", type=int, default=2)
    parser.add_argument("--memory-gib-per-job", type=float, default=5)
    parser.add_argument("--reserve-memory-gib", type=float, default=2)
    args = parser.parse_args()
    requests = load_requests(args.list, args.cpus_per_job, args.memory_gib_per_job)
    if not requests:
        print("No changed antenna configurations: nothing to simulate")
        return 0

    cpu_budget = cpu_capacity()
    memory_available = ram_capacity_bytes()
    reserve = int(args.reserve_memory_gib * 1024 ** 3)
    memory_budget = max(0, memory_available - reserve)
    print(f"Runner resources: {cpu_budget} CPUs; available RAM {memory_available / 1024 ** 3:.2f} GiB; "
          f"RAM reserved {args.reserve_memory_gib} GiB", flush=True)
    for filename, case, cpus, memory in requests:
        if cpus > cpu_budget or memory > memory_budget:
            raise RuntimeError(f"{filename} ({case['case_id']}): asks for {cpus} CPUs and {memory / 1024 ** 3:.2f} GiB, "
                               f"budget is {cpu_budget} CPUs and {memory_budget / 1024 ** 3:.2f} GiB")

    args.results.mkdir(parents=True, exist_ok=True)
    pending = list(requests)
    running = []
    failures = []
    free_cpu = cpu_budget
    free_memory = memory_budget

    while pending or running:
        # Start any task that fits the remaining resources; don't block a
        # smaller runnable task behind a larger pending task.
        for item in pending[:]:
            filename, case, cpus, memory = item
            if cpus > free_cpu or memory > free_memory:
                continue
            out = args.results / case["output_name"]
            out.mkdir(parents=True, exist_ok=True)
            config_path = out / "case_config.json"
            config_path.write_text(json.dumps(case["config"], indent=2))
            log = (out / "runner.log").open("w")
            command = [
                "docker", "run", "--rm",
                f"--cpus={cpus}",
                f"--memory={memory}",
                f"--memory-swap={memory}",
                "--pids-limit=512",
                "-v", f"{Path.cwd().resolve()}:/work",
                "--workdir", "/work",
                args.image,
                "python", "antennas/simulate.py", str(config_path),
                "--output", str(out),
            ]
            proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            print(f"START {case['output_name']} from {filename} pid={proc.pid} CPUs={cpus} RAM={memory / 1024 ** 3:.2f} GiB; "
                  f"free CPUs={free_cpu - cpus} free RAM={(free_memory - memory) / 1024 ** 3:.2f} GiB",
                  flush=True)
            running.append((item, proc, log, out / "runner.log"))
            pending.remove(item)
            free_cpu -= cpus
            free_memory -= memory

        if not running and pending:
            raise RuntimeError("Scheduler deadlock: no runnable jobs despite validated budgets")

        completed = []
        for item, proc, log, path in running:
            ret = proc.poll()
            if ret is None:
                continue
            log.close()
            name, case, cpus, memory = item
            free_cpu += cpus
            free_memory += memory
            completed.append((item, proc, log, path))
            print(f"{'DONE' if ret == 0 else 'FAIL'} {case['output_name']} exit={ret}: {path}", flush=True)
            if ret != 0:
                failures.append((case["output_name"], ret, str(path)))
                print("Last 50 lines from failed simulation:", flush=True)
                for line in path.read_text(errors="replace").splitlines()[-50:]:
                    print(line, flush=True)

        for finished in completed:
            running.remove(finished)
        if running and not completed:
            time.sleep(0.3)

    (args.results / "scheduler.json").write_text(json.dumps({
        "cpu_capacity": cpu_budget,
        "ram_budget_gib": round(memory_budget / 1024 ** 3, 3),
        "jobs": len(requests),
        "failures": failures,
    }, indent=2))
    if failures:
        print(f"{len(failures)} simulation(s) failed", file=sys.stderr)
        return 1
    print(f"All {len(requests)} simulation(s) completed.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
