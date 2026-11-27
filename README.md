# radiators
Antenna Designs

## CSXCAD editor and simulator

[Open the editor](https://winject-wireless.github.io/radiators/csxcad/) · [User manual](https://winject-wireless.github.io/radiators/csxcad/help.html)

The manual covers geometry, materials, ports, parameters, sweeps, mesh setup, browser and remote simulation, result interpretation, diagnostics and troubleshooting. It is also available from the editor’s More menu.

## Remote simulation runner

On Linux or WSL2 with Docker and Python 3, clone this repository and run `./run-remote.sh`. The script creates private settings, builds/reuses the native openEMS image and starts the remote service. See [remote runner setup](docs/remote-runner.md) for editor connection, HTTPS and optional automatic startup.
