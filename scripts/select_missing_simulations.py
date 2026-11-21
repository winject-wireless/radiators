#!/usr/bin/env python3
"""Select changed configs and unpublished/incomplete antenna simulations.

Run *after* restoring previously published results. PR previews only schedule
changed configs; the production branch also schedules missing antenna cases.
When a sweep has only a few missing cases, the runner skips its complete ones.
"""
import argparse
import json
from pathlib import Path
from result_inventory import case_complete
from sweep import expand_cases


def select_configs(config_paths, results, changed=(), include_missing=False):
    changed = set(changed)
    selected = set()
    missing = []
    for config in sorted(config_paths):
        config = Path(config)
        source = config.as_posix()
        if source in changed:
            selected.add(source)
        if not include_missing:
            continue
        cases = expand_cases(json.loads(config.read_text()), config)
        for case in cases:
            if not case_complete(case, results):
                selected.add(source)
                missing.append((source, case["case_id"]))
    return sorted(selected), missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--changed", type=Path, default=Path("changed-antennas.txt"))
    parser.add_argument("--output", type=Path, default=Path("selected-antennas.txt"))
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--antennas", type=Path, default=Path("antennas"))
    parser.add_argument("--include-missing", action="store_true")
    args = parser.parse_args()

    changed = [line.strip() for line in args.changed.read_text().splitlines()
               if line.strip()] if args.changed.exists() else []
    configs = sorted(args.antennas.glob("*.json"))
    available = {file.as_posix() for file in configs}
    unknown = set(changed) - available
    if unknown:
        raise ValueError(f"Selected antenna config no longer exists: {sorted(unknown)}")
    selected, missing = select_configs(
        configs, args.results, changed, args.include_missing)
    args.output.write_text("".join(f"{name}\n" for name in selected))
    for source, case_id in missing:
        print(f"MISSING {source} / {case_id}")
    print(f"Selected {len(selected)} antenna configs; {len(missing)} missing cases")
    print(f"Selected list: {args.output}")


if __name__ == "__main__":
    main()
