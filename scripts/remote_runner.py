#!/usr/bin/env python3
"""Authenticated, resource-budgeted native openEMS runner for a trusted host.

Run on loopback behind HTTPS (see README). Docker is required; the server never
executes submitted scripts, mounts the repository read-only, and isolates jobs.
"""
import argparse
import hmac
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import fcntl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from restore_openems_image import docker_command

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r"[a-f0-9]{32}")
PATTERN = re.compile(r"pattern_[0-9]+Hz\.json")
MAX_BODY = 2 * 1024**2
MAX_BATCH_BODY = 32 * 1024**2
MAX_JOBS = 256
MAX_ACTIVE = 64
TERMINAL = {"done", "failed", "cancelled"}
SHAPES = {"box", "cylinder", "cylindrical_shell", "sphere", "spherical_shell",
          "wire", "polyhedron", "helix", "hemisphere", "hemispherical_shell"}


def checked_number(x, lo, hi, label, integer=False):
    if type(x) not in (int, float) or not math.isfinite(x) or not lo <= x <= hi or (integer and int(x) != x):
        raise ValueError("Invalid " + label)
    return int(x) if integer else x


def validate(payload, args):
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not ID.fullmatch(payload["id"]):
        raise ValueError("Invalid job ID")
    c = payload.get("config")
    if not isinstance(c, dict) or c.get("schema_version") != 2 or c.get("units") != "mm":
        raise ValueError("Expected resolved schema v2 config in mm")
    if any(k in c for k in ("scripts", "generator", "sweep", "parameters")):
        raise ValueError("Send resolved geometry only; remote script execution is disabled")
    geometry = c.get("geometry")
    if not isinstance(geometry, list) or not 1 <= len(geometry) <= 10000:
        raise ValueError("Invalid geometry list")
    if any(not isinstance(g, dict) or "script" in g or g.get("shape", g.get("type")) not in SHAPES for g in geometry):
        raise ValueError("Unsupported geometry")
    if not isinstance(c.get("solver", {}), dict) or not isinstance(c.get("mesh", {}), dict):
        raise ValueError("Invalid solver or mesh")
    s = c.setdefault("solver", {})
    r = s.get("resources", {})
    if not isinstance(r, dict):
        raise ValueError("Invalid resources")
    cpus = checked_number(r.get("cpus", 2), 1, args.max_cpus, "CPU count", True)
    # memory_gib remains native CI metadata; the remote runner schedules CPUs only.
    checked_number(s.get("max_timesteps", 20000), 1, args.max_timesteps, "max timesteps", True)
    mesh = c.setdefault("mesh", {})
    checked_number(mesh.get("max_cells", 5000000), 1, args.max_cells, "max cells", True)
    return payload["id"], c, cpus


class Runner:
    def __init__(self, args, docker, work):
        self.args, self.docker, self.work = args, docker, work
        self.lock = threading.Lock()
        self.jobs = {}
        self.closing = False
        self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.restore()

    def persist(self, j):
        # A rename makes each job's metadata visible atomically.
        data = {k: j.get(k) for k in ("id", "state", "error", "cpus", "name",
                "created_at", "seconds", "batch_id", "pool", "case_key", "case_id")}
        target = j["path"] / "state.json"
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, allow_nan=False))
        tmp.replace(target)

    def restore(self):
        # Do not pretend an interrupted FDTD process can resume from a checkpoint.
        # Completed results and queued inputs survive a runner restart.
        for path in self.work.iterdir():
            if not ID.fullmatch(path.name) or not (path / "state.json").is_file():
                continue
            data = json.loads((path / "state.json").read_text())
            ident, cfg, cpus = validate({"id": path.name, "config": json.loads((path / "config.json").read_text())}, self.args)
            if data["id"] != ident or data["state"] not in TERMINAL | {"queued", "starting", "running"}:
                raise ValueError("Invalid stored job " + ident)
            j = dict(data, path=path, cancel=threading.Event(), created=time.monotonic(),
                     last_contact=time.monotonic(), cpus=cpus)
            if j.get("seconds") is None:
                j.pop("seconds", None)
            if j["state"] in ("starting", "running"):
                self.remove_container("radiators-remote-" + ident)
                j.update(state="failed", seconds=0, error="Runner restarted during simulation; rerun this case")
                self.persist(j)
            if j["state"] in TERMINAL:
                j["finished_at"] = time.monotonic()
            self.jobs[ident] = j
        self.jobs = dict(sorted(self.jobs.items(), key=lambda item: item[1]["created_at"]))

    def submit(self, payload):
        return self.submit_many([payload])[0]

    def submit_many(self, payloads, batch_id=None, pool=None):
        if not isinstance(payloads, list) or not 1 <= len(payloads) <= MAX_ACTIVE:
            raise ValueError("Expected 1 to 64 jobs")
        if batch_id is not None and (not isinstance(batch_id, str) or not ID.fullmatch(batch_id)):
            raise ValueError("Invalid batch ID")
        if pool is not None:
            pool = checked_number(pool, 1, self.args.max_cpus, "batch CPU pool", True)
        prepared = []
        for payload in payloads:
            ident, cfg, cpus = validate(payload, self.args)
            if len(json.dumps(cfg, allow_nan=False).encode()) > MAX_BODY:
                raise ValueError("Individual job configuration too large")
            case_key, case_id = payload.get("case_key"), payload.get("case_id")
            if case_key is not None and (not isinstance(case_key, str) or len(case_key) > 100):
                raise ValueError("Invalid case key")
            if case_id is not None and (not isinstance(case_id, str) or len(case_id) > 160):
                raise ValueError("Invalid case ID")
            if pool is not None and cpus > pool:
                raise ValueError("Job CPU count exceeds batch pool")
            prepared.append((ident, cfg, cpus, case_key, case_id, payload.get("require_capacity") is True))
        ids = [p[0] for p in prepared]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate job IDs in batch")
        with self.lock:
            if self.closing:
                raise RuntimeError("Runner is shutting down")
            new = []
            for ident, cfg, cpus, case_key, case_id, immediate in prepared:
                old = self.jobs.get(ident)
                if old is not None:
                    if (json.loads((old["path"] / "config.json").read_text()) != cfg or
                        any(old.get(k) != v for k, v in (("batch_id", batch_id), ("pool", pool),
                            ("case_key", case_key), ("case_id", case_id)))):
                        raise ValueError("Job ID already exists with different input")
                else:
                    new.append((ident, cfg, cpus, case_key, case_id, immediate))
            if not new:
                return ids
            if len(self.jobs) + len(new) > MAX_JOBS or sum(j["state"] not in TERMINAL for j in self.jobs.values()) + len(new) > MAX_ACTIVE:
                raise RuntimeError("Runner job queue full; delete unneeded completed jobs")
            if any(p[-1] for p in new):
                self.dispatch_locked()
                used = sum(j["cpus"] for j in self.jobs.values() if j["state"] in ("starting", "running"))
                if used + sum(p[2] for p in new) > self.args.max_cpus:
                    raise RuntimeError("CPU capacity unavailable; try again when a case finishes")
            created = []
            try:
                for ident, cfg, cpus, case_key, case_id, immediate in new:
                    path = self.work / ident
                    path.mkdir(mode=0o700)
                    created.append(path)
                    (path / "config.json").write_text(json.dumps(cfg, allow_nan=False))
                    j = {"id": ident, "path": path, "state": "queued", "created": time.monotonic(),
                         "created_at": time.time(), "cancel": threading.Event(), "error": None, "cpus": cpus,
                         "last_contact": time.monotonic(), "name": str(cfg.get("name", ""))[:160],
                         "batch_id": batch_id, "pool": pool, "case_key": case_key, "case_id": case_id}
                    self.persist(j)
                    self.jobs[ident] = j
            except Exception:
                for path in created:
                    self.jobs.pop(path.name, None)
                    shutil.rmtree(path, ignore_errors=True)
                raise
            self.dispatch_locked()
            return ids

    def dispatch_locked(self):
        """Reserve CPU before launching, including jobs in Docker startup."""
        if self.closing:
            return
        active = [j for j in self.jobs.values() if j["state"] in ("starting", "running")]
        free_cpu = self.args.max_cpus - sum(j["cpus"] for j in active)
        for j in self.jobs.values():
            if j["state"] != "queued":
                continue
            if j["cancel"].is_set():
                j.update(state="cancelled", seconds=0, finished_at=time.monotonic())
                self.persist(j)
                continue
            batch_used = sum(a["cpus"] for a in active if a.get("batch_id") == j.get("batch_id"))
            if j["cpus"] > free_cpu or (j.get("pool") is not None and batch_used + j["cpus"] > j["pool"]):
                continue
            free_cpu -= j["cpus"]
            j["state"] = "starting"
            self.persist(j)
            active.append(j)
            threading.Thread(target=self.run_reserved, args=(j,), daemon=True).start()

    def run_reserved(self, j):
        try:
            self.execute(j, j["cpus"])
        finally:
            with self.lock:
                if j["state"] not in TERMINAL:
                    j.update(state="failed", error="Job executor exited without result", seconds=0)
                j["finished_at"] = time.monotonic()
                self.persist(j)
                self.dispatch_locked()

    def cancel(self, j, reason=None):
        with self.lock:
            self.cancel_locked(j, reason)
            self.dispatch_locked()

    def cancel_locked(self, j, reason=None):
        if j["state"] not in TERMINAL:
            j["cancel"].set()
            j["error"] = reason or j.get("error")
            if j["state"] == "queued":
                j.update(state="cancelled", seconds=0, finished_at=time.monotonic())
                self.persist(j)

    def purge(self, j):
        with self.lock:
            if j["state"] not in TERMINAL or "finished_at" not in j:
                raise RuntimeError("Only finished jobs can be deleted")
            shutil.rmtree(j["path"])
            self.jobs.pop(j["id"], None)

    def list_jobs(self):
        with self.lock:
            now = time.monotonic()
            return [{**{k: j.get(k) for k in ("id", "state", "name", "cpus", "case_key", "case_id",
                     "batch_id", "created_at", "error")},
                     "last_contact_seconds": round(now-j["last_contact"]),
                     "cancel_requested": j["cancel"].is_set()}
                    for j in self.jobs.values()]

    def execute(self, j, cpus):
        name = "radiators-remote-" + j["id"]
        path = j["path"]
        cmd = self.docker + ["run", "--rm", "--name", name, "--network=none",
              "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
              "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--pids-limit=512",
              "--user", f"{os.getuid()}:{os.getgid()}", "--env", "HOME=/tmp",
              "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "PYTHONUNBUFFERED=1",
              "--env", f"RADIATORS_OPENEMS_THREADS={cpus}", f"--cpus={cpus}",
              "-v", f"{ROOT}:/work:ro", "-v", f"{path}:/job:rw", "--workdir", "/work",
              self.args.image, "python", "antennas/simulate_v2.py", "/job/config.json", "--output", "/job/out"]
        proc = None
        state, error = "failed", "Job did not complete"
        try:
            with self.lock:
                if j["cancel"].is_set():
                    state, error = "cancelled", None
                    return
                j["state"] = "running"
            with (path / "runner.log").open("wb") as log:
                proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + self.args.timeout
                while proc.poll() is None:
                    if j["cancel"].is_set() or time.monotonic() >= deadline:
                        state = "cancelled" if j["cancel"].is_set() else "failed"
                        error = None if state == "cancelled" else "Runner wall-clock timeout"
                        self.remove_container(name)
                        try:
                            proc.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait()
                        self.remove_container(name)
                        return
                    time.sleep(.25)
            if j["cancel"].is_set():
                state, error = "cancelled", None
            elif proc.returncode == 0 and (path / "out/result.json").is_file():
                state, error = "done", None
            else:
                error = f"Native openEMS exited with code {proc.returncode}; inspect log"
        except Exception as exc:
            error = str(exc)
        finally:
            if proc is not None and proc.poll() is None:
                self.remove_container(name)
                proc.kill()
                proc.wait()
            with self.lock:
                j.update(state=state, error=j.get("error") if state=="cancelled" else error, seconds=time.monotonic()-j["created"])

    def remove_container(self, name):
        try:
            subprocess.run(self.docker+["rm", "-f", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=15, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def snapshot(self, j):
        with self.lock:
            if j["state"] not in TERMINAL and not j["cancel"].is_set():
                j["last_contact"] = time.monotonic()
            out = {k: j[k] for k in ("id", "state", "error")}
            out["seconds"] = j.get("seconds", time.monotonic()-j["created"])
        log = j["path"] / "runner.log"
        try:
            with log.open("rb") as f:
                f.seek(max(0, os.fstat(f.fileno()).st_size-65536))
                out["log"] = f.read(65536).decode("utf-8", errors="replace")
        except FileNotFoundError:
            out["log"] = ""
        return out

    def result(self, j):
        with self.lock:
            if j["state"] != "done":
                raise RuntimeError("Job has no completed result")
            path = j["path"] / "out"
            result = json.loads((path / "result.json").read_text())
            for p in result.get("patterns", []):
                filename = p.get("file", "")
                if not PATTERN.fullmatch(filename):
                    raise ValueError("Invalid pattern filename")
                p["record"] = json.loads((path / filename).read_text())
            result.update(generator="remote native openEMS", seconds=j["seconds"])
            result["postprocessing_incomplete"] = any(not p["record"].get("radiation_valid") for p in result.get("patterns", []))
            return result


class Handler(BaseHTTPRequestHandler):
    server_version = "RadiatorsRunner/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def response_headers(self, code, size):
        self.send_response(code)
        origin = self.headers.get("Origin")
        if origin and origin in self.server.runner.args.origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(size))
        self.end_headers()

    def reply(self, code, payload):
        data = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
        self.response_headers(code, len(data))
        self.wfile.write(data)

    def origin_ok(self):
        origin = self.headers.get("Origin")
        return not origin or origin in self.server.runner.args.origin

    def do_OPTIONS(self):
        if not self.origin_ok():
            self.log_error("CORS denied: origin %r not in configured origins", self.headers.get("Origin"))
            return self.response_headers(403, 0)
        self.response_headers(204, 0)

    def auth_error(self):
        # Never log credentials, only why authentication failed.
        if not self.origin_ok():
            self.log_error("CORS denied: origin %r not in configured origins", self.headers.get("Origin"))
            return "Origin not allowed by runner"
        header = self.headers.get("Authorization", "")
        if not header:
            return "Authorization header missing (check reverse proxy)"
        parts = header.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return "Authorization must use Bearer token"
        if not hmac.compare_digest(parts[1].strip().encode(), self.server.runner.args.token.encode()):
            return "Invalid bearer token (check running service configuration)"
        return None

    def handle_api(self, method):
        error = self.auth_error()
        if error:
            self.log_error("Request denied: %s", error)
            return self.reply(403, {"error": error})
        runner = self.server.runner
        path = urlsplit(self.path).path
        try:
            if method == "GET" and path == "/v1/health":
                return self.reply(200, {"api_version": 1, "engine": "native openEMS",
                    "max_cpus": runner.args.max_cpus, "ncpu_pool": runner.args.max_cpus, "parallel_jobs": True, "memory_limit": False, "max_memory_gib": None,
                    "max_cells": runner.args.max_cells, "max_timesteps": runner.args.max_timesteps,
                    "lease_timeout": None, "job_listing": True, "immediate_start": True,
                    "detached_jobs": True, "batch_submission": True, "persistent_jobs": True})
            if method == "GET" and path == "/v1/jobs":
                return self.reply(200, {"jobs": runner.list_jobs()})
            if method == "POST" and path == "/v1/batches":
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BATCH_BODY:
                    return self.reply(413, {"error": "Invalid batch size"})
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or payload.get("id") is None or payload.get("pool") is None:
                    raise ValueError("Batch ID and CPU pool required")
                ids = runner.submit_many(payload.get("jobs"), payload["id"], payload["pool"])
                return self.reply(202, {"ids": ids})
            if method == "POST" and path == "/v1/jobs":
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    return self.reply(413, {"error": "Invalid request size"})
                ident = runner.submit(json.loads(self.rfile.read(length)))
                return self.reply(202, {"id": ident})
            m = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})(/result)?", path)
            if not m:
                return self.reply(404, {"error": "Unknown endpoint"})
            with runner.lock:
                j = runner.jobs.get(m[1])
            if not j:
                return self.reply(404, {"error": "Unknown or expired job"})
            if method == "GET" and m[2]:
                return self.reply(200, runner.result(j))
            if method == "GET":
                return self.reply(200, runner.snapshot(j))
            if method == "DELETE" and m[2]:
                runner.purge(j)
                return self.reply(200, {"id": j["id"], "deleted": True})
            if method == "DELETE" and not m[2]:
                runner.cancel(j)
                return self.reply(202, {"id": j["id"], "cancel_requested": True})
            return self.reply(405, {"error": "Method not supported"})
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            return self.reply(400, {"error": str(exc)})
        except RuntimeError as exc:
            return self.reply(409, {"error": str(exc)})
        except (OSError, json.JSONDecodeError) as exc:
            return self.reply(500, {"error": str(exc)})

    def do_GET(self): self.handle_api("GET")
    def do_POST(self): self.handle_api("POST")
    def do_DELETE(self): self.handle_api("DELETE")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--tls-cert", type=Path)
    p.add_argument("--tls-key", type=Path)
    p.add_argument("--origin", action="append", default=[], help="Allowed editor origin; repeat as needed")
    p.add_argument("--image", default="radiators-openems:ci")
    p.add_argument("--max-cpus", type=int, default=min(os.cpu_count() or 2, 16))
    p.add_argument("--max-memory-gib", type=float, help=argparse.SUPPRESS)  # legacy CLI; ignored
    p.add_argument("--max-cells", type=int, default=20000000)
    p.add_argument("--max-timesteps", type=int, default=2000000)
    p.add_argument("--timeout", type=int, default=3600)
    p.add_argument("--retain", type=int, default=4)
    p.add_argument("--lease-timeout", type=int, help=argparse.SUPPRESS)  # legacy; ignored
    p.add_argument("--work-dir", type=Path, default=Path.home()/".local/state/radiators-runner/jobs")
    args = p.parse_args()
    args.token = os.environ.get("RADIATORS_RUNNER_TOKEN", "")
    if len(args.token) < 24 or not args.origin or args.retain < 1 or args.timeout < 1:
        p.error("Set RADIATORS_RUNNER_TOKEN (at least 24 chars), --origin, positive --retain and --timeout")
    if bool(args.tls_cert) != bool(args.tls_key):
        p.error("TLS requires both --tls-cert and --tls-key")
    if not args.tls_cert and args.bind not in ("127.0.0.1", "localhost"):
        p.error("Plain HTTP may only bind loopback; use TLS or an HTTPS reverse proxy")
    if not (1 <= args.port <= 65535 and args.max_cpus >= 1 and args.max_cells >= 1 and args.max_timesteps >= 1):
        p.error("Invalid runner resource limits or port")
    tls = None
    if args.tls_cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_2
        tls.load_cert_chain(args.tls_cert, args.tls_key)
    docker = docker_command()
    subprocess.run(docker+["image", "inspect", args.image], check=True, stdout=subprocess.DEVNULL)
    work = args.work_dir.expanduser().resolve()
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (work / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runner = Runner(args, docker, work)
        with runner.lock:
            runner.dispatch_locked()
        with ThreadingHTTPServer((args.bind, args.port), Handler) as http:
            http.runner = runner
            if tls:
                http.socket = tls.wrap_socket(http.socket, server_side=True)
            def terminate(signum, frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, terminate)
            scheme = "https" if tls else "http"
            print(f"Radiators runner listening on {scheme}://{args.bind}:{args.port}", flush=True)
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                with runner.lock:
                    runner.closing = True
                    for j in runner.jobs.values():
                        if j["state"] in ("starting", "running"):
                            j["error"] = "Runner stopped during simulation; rerun this case"
                            j["cancel"].set()
                deadline = time.monotonic()+45
                while time.monotonic()<deadline:
                    with runner.lock:
                        if all(j["state"] not in ("starting", "running") for j in runner.jobs.values()):
                            break
                    time.sleep(.25)


if __name__ == "__main__":
    main()
