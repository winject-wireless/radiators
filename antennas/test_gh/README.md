# openEMS smoke test

This directory contains a minimal 2.45 GHz electromagnetic FDTD smoke test.
It verifies that openEMS and CSXCAD Python bindings load, a small mesh
can be constructed, and the native openEMS solver can execute headlessly.

**This is not an antenna-performance prediction.** It does not report
validated S11, gain, VSWR or radiation patterns.

## Local run

From the repository root:

```bash
docker build -t radiators-openems:ci -f docker/openems/Dockerfile .
mkdir -p results
docker run --rm --cpus=2 --memory=6g -v "$PWD:/work" \
  radiators-openems:ci python antennas/test_gh/smoke.py
```

The generated files appear under `results/test_gh/`. The GitHub Actions
workflow uploads that directory as a downloadable artifact.

## GitHub Actions

Use **Actions > openEMS Docker smoke test > Run workflow** to start manually,
or push changes affecting this directory, the Dockerfile, or workflow.

Initial Docker builds may take a while because openEMS is compiled from source.
The upstream `master` ref is not pinned; pin a tested commit for stable builds.
