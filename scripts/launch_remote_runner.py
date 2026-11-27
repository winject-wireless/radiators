#!/usr/bin/env python3
"""Initialize and start a remote radiators runner from a checkout (stdlib only)."""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys

from restore_openems_image import docker_command

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATH = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "radiators-runner" / "config.json"


def defaults():
    try:
        cpus = len(os.sched_getaffinity(0))
    except AttributeError:
        cpus = os.cpu_count() or 2
    return {
        "token": secrets.token_urlsafe(32),
        "bind": "127.0.0.1", "port": 8765,
        "origins": ["https://winject-wireless.github.io", "http://localhost:8080"],
        "image": "radiators-openems:ci",
        "max_cpus": max(1, min(cpus, 16)),
        "max_cells": 20000000, "max_timesteps": 2000000,
        "timeout": 3600, "lease_timeout": 300, "retain": 4, "tls_cert": "", "tls_key": "",
    }


def load_config(path):
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w") as f:
            json.dump(defaults(), f, indent=2)
            f.write("\n")
        print("Created private runner configuration: " + str(path), file=sys.stderr)
    if not path.is_file() or path.is_symlink():
        raise ValueError("Configuration must be a regular non-symlink file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Configuration contains a secret; run chmod 600 " + str(path))
    cfg = json.loads(path.read_text())
    if not isinstance(cfg, dict) or not isinstance(cfg.get("token"), str) or len(cfg["token"]) < 24:
        raise ValueError("Configuration token must be at least 24 characters")
    if not isinstance(cfg.get("origins"), list) or not cfg["origins"] or any(not isinstance(x, str) or not x for x in cfg["origins"]):
        raise ValueError("Configure at least one exact editor origin")
    return cfg


def server_command(cfg):
    cmd = [sys.executable, str(ROOT / "scripts/remote_runner.py")]
    for key in ("bind", "port", "image", "max_cpus", "max_cells", "max_timesteps", "timeout", "retain"):
        cmd += ["--" + key.replace("_", "-"), str(cfg[key])]
    cmd += ["--lease-timeout", str(cfg.get("lease_timeout", 300))]
    for origin in cfg["origins"]:
        cmd += ["--origin", origin]
    for key in ("tls_cert", "tls_key"):
        if cfg.get(key):
            cmd += ["--" + key.replace("_", "-"), str(Path(cfg[key]).expanduser().resolve())]
    return cmd


def ensure_image(cfg, rebuild=False):
    docker = docker_command()
    image = cfg["image"]
    if not rebuild and subprocess.run(docker+["image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        print("Using existing solver image: " + image, flush=True)
    else:
        print("Building native openEMS solver image: " + image, flush=True)
        subprocess.run(docker+["build", "-t", image, "-f", str(ROOT/"docker/openems/Dockerfile"), str(ROOT)], check=True)
    subprocess.run(docker+["run", "--rm", "--network=none", image, "python", "-c",
        "import openEMS, CSXCAD, numpy; print('Native openEMS imports OK')"], check=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", type=Path, default=DEFAULT_PATH)
    options = p.add_mutually_exclusive_group()
    options.add_argument("--init", action="store_true", help="Create private settings without starting Docker")
    options.add_argument("--print-token", action="store_true", help="Display token locally for editor setup")
    options.add_argument("--check", action="store_true", help="Build/reuse image and verify imports, then exit")
    options.add_argument("--rebuild", action="store_true", help="Rebuild image, verify and start")
    args = p.parse_args()
    try:
        cfg = load_config(args.config)
        if args.print_token:
            print(cfg["token"])
            return
        if args.init:
            print(args.config.expanduser())
            return
        cmd = server_command(cfg)
        ensure_image(cfg, args.rebuild)
        if args.check:
            return
        env = dict(os.environ, RADIATORS_RUNNER_TOKEN=cfg["token"])
        print("Starting runner; use ./run-remote.sh --print-token to retrieve its token.", flush=True)
        os.execve(sys.executable, cmd, env)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.CalledProcessError) as exc:
        p.exit(1, "Runner setup failed: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
