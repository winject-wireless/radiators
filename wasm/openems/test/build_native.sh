#!/usr/bin/env bash
# Native openEMS from the same pinned sources (.src/, run ../build.sh fetch
# first) into .native/opt, plus its Python bindings in .native/venv: the
# reference for compare.mjs. Needs the -dev packages listed in README.md.
set -euo pipefail
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="$W/.native"; S="$W/.src"
mkdir -p "$N/build"
for r in fparser CSXCAD openEMS; do
  cmake -S "$S/$r" -B "$N/build/$r" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$N/opt" \
    -DFPARSER_ROOT_DIR="$N/opt" -DCSXCAD_ROOT_DIR="$N/opt" -DENABLE_HIP=OFF -DOPENEMS_GPU_PLUGINS=OFF >/dev/null
  cmake --build "$N/build/$r" -j"${JOBS:-4}"
  cmake --install "$N/build/$r" >/dev/null
done
[ -x "$N/venv/bin/python" ] || python3 -m venv --system-site-packages "$N/venv"
export CSXCAD_INSTALL_PATH="$N/opt" OPENEMS_INSTALL_PATH="$N/opt"
# the pip builds clone nothing: install the checked out python/ packages
(cd "$S/CSXCAD" && git clean -qfdx python) ; (cd "$S/openEMS" && git clean -qfdx python)
"$N/venv/bin/pip" install -q --no-build-isolation "$S/CSXCAD/python" "$S/openEMS/python"
echo "native openEMS in $N/opt; python: LD_LIBRARY_PATH=$N/opt/lib $N/venv/bin/python"
