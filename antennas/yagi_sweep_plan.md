# 2.45 GHz measured-loop Yagi — self-hosted parameter sweep

**Status: experimental optimization, not a validated antenna, not a completed sweep.** See the GitHub Actions job and its `measured-yagi-parameter-sweep` artifact for actual results. The reference physical feed connection, true aluminum diameter beneath plastic caps, boom length, and director pitch are not fully measured.

## Fixed mechanical geometry

- 15 directors, currently each modeled as **51.6 mm metal length**; this is a **provisional upper bound** because the user's 51.6 mm includes plastic end caps.
- One reflector, provisionally **66.6 mm** metal length, also includes end caps in the user's measurement.
- Nominally 8 mm diameter rods, bonded to a **16 × 16 mm** square aluminum boom as one PEC metal structure. Rod metal diameter may differ from plastic cap diameter.
- The measured **57.9 × 33.4 mm outer-dimension racetrack driven loop** made from 4 mm wire, with the loop opening parallel to the boom; loop centerline perimeter ~141.36 mm.
- Preserve measured wire shape, rod count, rod diameter, rod lengths and material across sweep cases.
- **Unknown feed**: assume a 4 mm clear gap and an isolated loop offset away from boom in -Y. Actual cable/balun/shield termination not modeled.

## Swept parameters

All dimensions in mm. The boom, rods and loop move consistently as a mechanical assembly, the FDTD domain stays fixed at screening resolution. Center of first director is X=0, beam aim -X.

| Parameter | Screening values | Starting point | Meaning |
|---|---|---|---|
| Director pitch | 20, 22, **24**, 26, 28 | 24 | Center-to-center equal spacing of the 15 directors |
| Last director → loop center | 16, 20, **24**, 28, 32 | 24 | Longitudinal driven-loop position |
| Loop center → reflector | 16, 20, **24**, 28, 32 | 24 | Rear parasitic spacing |
| Loop offset from boom center | 12, 14, **16**, 20, 24 | 16 | Negative Y distance, keeping conductor clear of grounded boom |

One-factor screening is followed by local coordinate sweeps, a pairwise interaction sweep for the most sensitive two parameters, then **1.6 mm mesh confirmation for the best three candidates**. Total case count is adaptively determined; the starting screening has 17 candidates, with approximately 30–40 cases expected across all stages. **Only four parameters move; conductor lengths and loop perimeter remain fixed.** That avoids unintentionally fitting a new antenna instead of the one measured.

## Primary objective and validity checks

Maximize **forward realized gain**, not maximum 3D directivity and not radiation efficiency alone:

`score = 0.65 × G_realized_forward(2450) + 0.35 × min(G_realized_forward(2400,2450,2500))`

- Forward direction is the physical array boresight **−X**, equivalent to `theta=90°, phi=180°`.
- **Realized gain** includes both radiation efficiency and mismatch loss for a 50 Ω source. It is the practical primary metric.
- Record 2.45 GHz S11, VSWR and complex impedance, forward directivity, front-to-back ratio, and minimum band-edge forward gain.
- Record **radiation efficiency** and **total input-to-radiated efficiency** separately. Ideal PEC often gives ~100% accepted-power radiation efficiency while S11 is poor, so ranking on that field alone is misleading.
- Reject missing/nonfinite results, unphysical radiation efficiencies (outside 0–105%), and runs lacking openEMS energy convergence. A green workflow status alone does not establish a usable RF solution.
- Select the top scoring fine-mesh candidate when available; report separate leaders by total efficiency, forward directivity and realized gain. Report no acceptable matched design if none appears. This sweep does **not guarantee** 16 dBi or S11 < -10 dB.
- 2 mm coarse and 1.6 mm refined grids are **not a formal mesh-convergence study**. The best result still requires 1.2–1.0 mm mesh validation and physical feed measurements before manufacturing.

## 16-vCPU / 64-GB self-hosted machine

The sweep launches **8 Docker containers concurrently**, **2 vCPUs per case** and **8 GiB maximum per container**: a total of **16 vCPUs / 64 GiB combined memory ceilings**. Docker `--memory=8g` is only a **limit**, not a reservation: each simulation uses what its FDTD grid needs. The host is Windows with 128 GB RAM and the Linux runner is in WSL2. WSL2 does **not** need a 96 GB ceiling unless actual measured memory pressure warrants it. The scheduler requires Docker to expose the 16 requested vCPUs and at least 8 GiB of Linux memory (enough for one container's ceiling); it does not require all eight memory limits to fit as preallocated RAM. Concurrent heavy runs can still exceed the physical WSL2 limit, so record peak RSS and OOM failures before changing the ceiling. Eight 2-vCPU simulations should offer higher throughput than four 4-vCPU simulations **if** solver per-run scaling is sublinear; compare measured FDTD wall/CPU seconds to verify.

This is a **manual- and trusted-main-only** GitHub workflow, never on `pull_request`, to avoid running untrusted PR code on a persistent machine. The runner must have Docker installed and its daemon must be usable by the GitHub Actions runner account. On Windows 11, Docker Desktop must be running in **Linux containers** mode, with the GitHub runner running in a session that can access Docker Desktop. On Linux or WSL2, standard Linux Docker works. If absent locally, the workflow downloads the existing prebuilt `radiators-openems:ci` image from GitHub Actions artifacts rather than recompiling it.

Artifacts include:
- `summary.md`: ranked table, goal-specific leaders and preferred fine-mesh design.
- `ranking.csv` / `all_results.json`: numeric candidate scores and performance.
- `<case>/config.json`: full geometry needed for reproducibility.
- `<case>/result.json` and `pattern_*Hz.json`: S11/impedance/pattern results.
- `<case>/runner.log`: openEMS solver convergence and iteration statistics.
- `<case>/cpu_start.txt`, `cpu_end.txt`, `memory_peak.txt`: actual container cgroup CPU seconds and memory if exposed.

Run locally:

```bash
python scripts/yagi_sweep.py --self-test
python scripts/yagi_sweep.py --parallel 8 --cpus-per-case 2 --memory-gib-per-case 8
```

GitHub Action: `.github/workflows/yagi-sweep.yml`. Results are uploaded as **measured-yagi-parameter-sweep** artifact; do not publish every sweep case to Pages.

## Initial baseline (before optimization)

The completed measured racetrack-loop model from [run #44512439048](https://github.com/winject-wireless/radiators/actions/runs/44512439048) reports, at 2.45 GHz:

- Forward gain: **+0.92 dBi realized**.
- Peak directivity: **+7.62 dBi**.
- S11: **−1.08 dB**; 50 Ω mismatch efficiency ~22%.
- Input impedance: **791.82 − j105.14 Ω**.
- Accepted-power radiation efficiency: **approximately 100%** (1.0025 in raw PEC numerics, within discretization error).

This baseline is far below the target. Optimizing spatial coupling can improve directivity and feed match, but may not solve the feed topology if the actual loop-to-coax connections differ substantially from the modeled ideal lumped port.

## First self-hosted run — host permission blocker

[Workflow run #44517868884](https://github.com/winject-wireless/radiators/actions/runs/44517868884) was assigned to the connected runner **THEROOFTOPPRINZ**. Ubuntu Python and CLI tools work and geometry self-tests pass. The simulation could **not start** because runner user `ubuntu` is denied access to `unix:///var/run/docker.sock`. Non-interactive `sudo -n docker` is also not preauthorized.

**Fix on runner host (requires a privileged login, cannot be fixed by this nonprivileged workflow):**

```bash
sudo usermod -aG docker ubuntu
# Restart the GitHub Actions runner process/service so group membership applies.
cd /home/ubuntu/actions-runner
sudo ./svc.sh stop && sudo ./svc.sh start    # if configured as a service
# Otherwise stop and restart ./run.sh from a fresh session.
```

After restart, as `ubuntu` verify:

```bash
id -nG
docker info --format '{{.OSType}}'
```

The second command must output `linux` without `sudo`. Then rerun `Measured Yagi parameter optimization` via **Actions → Run workflow → main**.

**Security:** Membership in the `docker` group effectively grants root-equivalent host access. This runner must only accept trusted main-branch workflows; never enable untrusted PR execution on it.

