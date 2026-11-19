#!/usr/bin/env python3
"""Restore cached openEMS Docker image from GitHub Actions artifact (no rebuild).

Uses only Python stdlib, Docker CLI, and GITHUB_TOKEN with actions:read.
The cache artifact is keyed by sha256(docker/openems/Dockerfile), the same
name used by scripts/ensure-openems-image.sh in normal CI.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile


def request_json(url, token):
    req = urllib.request.Request(
        url,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "winject-radiators-openems-image-restore"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def find_artifact(repo, name, token):
    from urllib.parse import quote
    url = ("https://api.github.com/repos/" + repo + "/actions/artifacts"
           + "?name=" + quote(name) + "&per_page=100")
    data = request_json(url, token)
    matches = [a for a in data.get("artifacts", [])
               if a.get("name") == name and not a.get("expired")]
    if not matches:
        raise RuntimeError("No unexpired prebuilt openEMS artifact named %s. "
                           "The image must be built/uploaded once using the "
                           "regular structured openEMS CI." % name)
    return max(matches, key=lambda a: a.get("created_at", ""))


def docker_command():
    cmd = ["docker"]
    r = subprocess.run(cmd + ["info", "--format", "{{.OSType}}"],
                       capture_output=True, text=True, timeout=45)
    if r.returncode and "permission denied" in (r.stdout + r.stderr).lower():
        if os.name == "posix" and shutil.which("sudo"):
            alternate = ["sudo", "-n", "docker"]
            s = subprocess.run(alternate + ["info", "--format", "{{.OSType}}"],
                               capture_output=True, text=True, timeout=45)
            if s.returncode == 0:
                cmd, r = alternate, s
    if r.returncode or r.stdout.strip() != "linux":
        raise RuntimeError("Linux Docker daemon unavailable: " + r.stdout + r.stderr)
    return cmd


def download_zip(repo, artifact_id, token, target):
    # Obtain the short-lived signed redirect without leaking the GitHub token
    # to the blob-storage host. URL redirects are not followed in this request.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    url = "https://api.github.com/repos/%s/actions/artifacts/%d/zip" % (repo, artifact_id)
    req = urllib.request.Request(url,
                                 headers={"Authorization": "Bearer " + token,
                                          "Accept": "application/vnd.github+json",
                                          "User-Agent": "winject-radiators-openems-image-restore"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(req, timeout=45)
        raise RuntimeError("GitHub artifact download did not return the required redirect")
    except urllib.error.HTTPError as exc:
        if exc.code not in (302, 301, 303, 307, 308):
            raise RuntimeError("Artifact download error HTTP %s" % exc.code) from exc
        signed_url = exc.headers.get("Location")
        if not signed_url or not signed_url.startswith("https://"):
            raise RuntimeError("GitHub did not provide a valid artifact download URL")
    with urllib.request.urlopen(signed_url, timeout=180) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out, length=8 * 1024 * 1024)


def main():
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY", "winject-wireless/radiators")
    if not token:
        raise RuntimeError("GH_TOKEN or GITHUB_TOKEN with actions:read is required")
    docker = docker_command()
    image = "radiators-openems:ci"
    digest = hashlib.sha256(Path("docker/openems/Dockerfile").read_bytes()).hexdigest()
    name = "openems-image-" + digest

    cached = subprocess.run(docker + ["image", "inspect", image],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if cached.returncode == 0:
        print("Reusing locally cached Docker image %s; no download/build." % image,
              flush=True)
        return

    artifact = find_artifact(repo, name, token)
    print("Restoring prebuilt %s from artifact %s (%s bytes)" %
          (name, artifact["id"], artifact.get("size_in_bytes")), flush=True)
    with tempfile.TemporaryDirectory(prefix="openems-image-") as tmp:
        archive = Path(tmp) / "artifact.zip"
        download_zip(repo, artifact["id"], token, archive)
        with zipfile.ZipFile(archive) as zf:
            names = [x.filename for x in zf.infolist()]
            if "openems-image.tar.zst" not in names:
                raise RuntimeError("Expected openems-image.tar.zst, found: " + str(names))
            compressed = Path(tmp) / "openems-image.tar.zst"
            with zf.open("openems-image.tar.zst") as src, compressed.open("wb") as dst:
                shutil.copyfileobj(src, dst, length=8 * 1024 * 1024)
        archive.unlink()
        print("Loading cached Linux Docker image (zstd compression)...", flush=True)
        with subprocess.Popen(docker + ["load", "--input", str(compressed)],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True) as proc:
            for line in proc.stdout:
                print(line, end="", flush=True)
            if proc.wait() != 0:
                raise RuntimeError("Docker image load failed; verify Docker supports zstd.")
    check = subprocess.run(docker + ["image", "inspect", image],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           text=True)
    if check.returncode:
        raise RuntimeError("Artifact restored but expected Docker image %s missing: %s" %
                           (image, check.stderr))
    print("Prebuilt openEMS image ready; no compilation performed.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR: " + str(e), file=sys.stderr)
        sys.exit(1)
