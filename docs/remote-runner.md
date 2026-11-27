# Remote openEMS runner

A clone is sufficient to install and start the native solver service. Requires
Linux (or WSL2), Bash, Python 3.10+ and a working Linux Docker daemon. No pip
packages or compiler installation on the host are needed. Docker builds the
native C++ solver image on first use; subsequent launches reuse it.

## Start

From the repository root:

```bash
./run-remote.sh
```

This creates private settings and a random access token in
`~/.config/radiators-runner/config.json` (or under XDG_CONFIG_HOME), builds
the image if missing, verifies the Python bindings, and starts the runner.
Use a second terminal to retrieve the token:

```bash
./run-remote.sh --print-token
```

In the editor select Simulation → Runner → Remote, enter
http://localhost:8765 if the browser is on the same host, paste the token,
and select Test connection. Browser/OS local-network permission may be
required. From another device use the HTTPS address described below.

Optional commands:

```bash
./run-remote.sh --init          # create settings only
./run-remote.sh --check         # build/reuse image and test native imports
./run-remote.sh --rebuild       # rebuild and start
```

Settings are independent of the checkout so git pull does not reset the
token. Edit the JSON to change CPU/RAM caps, job timeout, port and origins.
The default cap is up to 16 logical CPUs and 32 GiB, scaled down for smaller
hosts. The editor's ncpu_pool and ncpu_per_job control sweep parallelism; solver.resources.memory_gib controls memory per case. Server max_cpus and max_memory_gib are aggregate budgets across all active containers.
Do not commit or share the token. The token gives access to all jobs.

## Connect from another machine or Android

Default bind is loopback. A browser loading the HTTPS hosted editor cannot
reliably connect to an unencrypted LAN IP. Use a trusted HTTPS endpoint.

Option A: put a reverse proxy (for example Caddy) on the runner host, using
a hostname/certificate trusted by the client. Example Caddyfile (replace
the example hostname with your own DNS name):

```caddyfile
runner.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Leave the runner bound to 127.0.0.1. Enter https://runner.example.com in
the editor. Restrict access to your LAN/VPN where possible; the reverse
proxy and DNS/certificate setup are not installed automatically.

Option B: if you already have a certificate and private key trusted by
the client, set bind to 0.0.0.0 and tls_cert / tls_key to their absolute
paths in config.json, then restart. Connect to the HTTPS hostname and
configured port. Plain HTTP cannot bind to non-loopback addresses.

Set origins to the exact origin of your editor (scheme + host + port,
not the path); the hosted editor uses https://winject-wireless.github.io.
An Android WebView or different deployment may require a different origin.

## Run at boot (optional)

With systemd available (including WSL2 with systemd enabled), create a user
service at ~/.config/systemd/user/radiators-runner.service; replace the path
with your actual absolute checkout path. The user must have Docker access.

```ini
[Unit]
Description=Radiators native openEMS remote runner
After=network-online.target

[Service]
ExecStart=/home/USER/radiators/run-remote.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now radiators-runner
journalctl --user -u radiators-runner -f
```

For startup before login, enable lingering for the service user if supported
and appropriate. Stop the service before git pull; restart afterwards.
A Ctrl+C or SIGTERM requests cancellation of active containers.

## Limits and verification

Jobs are automatically dispatched within aggregate CPU and RAM budgets (up to 64 outstanding jobs and 256 retained records). Results are retained in temporary storage until restart or eviction, not in a durable queue. Unretrieved results are protected from eviction for at least one hour.
Client disconnects do not cancel jobs. Native solver output is rendered
in the existing viewer; remote diagnostic plots and PEC export are not yet
implemented. Docker enforces CPU and RAM caps, but there is no separate
output-disk quota. Run on a trusted machine with sufficient disk space.

```bash
python3 -m unittest discover -s scripts -p test_remote_runner.py
```

These are API/config tests using a fake job executor, not an electromagnetic
simulation. For a real smoke test, run a small dipole from the editor and
compare S11 and radiation against Browser mode. The solver image can be
reused if it has already been restored by the repository's existing CI.
