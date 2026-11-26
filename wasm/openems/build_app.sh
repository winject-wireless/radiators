# Sourced by build.sh: fparser, CSXCAD and openEMS with their own CMake files
# (SHARED libraries become static ones under Emscripten), then the glue link.

cmake_wasm() { # name srcdir [cmake args...]; TARGETS="a b" builds only those, no install
  local name=$1 src=$2; shift 2
  emcmake cmake -S "$src" -B "$BLD/$name" -G Ninja -Wno-dev \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_FIND_ROOT_PATH="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX" \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS" "$@" >/dev/null
  if [ -n "${TARGETS:-}" ]; then
    # shellcheck disable=SC2086
    cmake --build "$BLD/$name" -j "$JOBS" --target $TARGETS
  else
    cmake --build "$BLD/$name" -j "$JOBS"
    cmake --install "$BLD/$name" >/dev/null
  fi
}

log fparser
cmake_wasm fparser "$SRC/fparser"

log CSXCAD
cmake_wasm CSXCAD "$SRC/CSXCAD" \
  -DFPARSER_ROOT_DIR="$PREFIX" -DTinyXML_ROOT_DIR="$PREFIX" \
  -DHDF5_ROOT="$PREFIX" -DHDF5_USE_STATIC_LIBRARIES=ON -DENABLE_RPATH=OFF

log openEMS
# only the libraries: link.sh links them with the glue (upstream's nf2ff binary
# does not link zlib, and nothing of openEMS needs installing)
TARGETS="openEMS nf2ff" cmake_wasm openEMS "$SRC/openEMS" \
  -DFPARSER_ROOT_DIR="$PREFIX" -DTinyXML_ROOT_DIR="$PREFIX" -DCSXCAD_ROOT_DIR="$PREFIX" \
  -DHDF5_ROOT="$PREFIX" -DHDF5_USE_STATIC_LIBRARIES=ON \
  -DBOOST_ROOT="$PREFIX" -DBoost_USE_STATIC_LIBS=ON -DBoost_NO_SYSTEM_PATHS=ON -DBoost_NO_BOOST_CMAKE=ON \
  -DZLIB_ROOT="$PREFIX" -DENABLE_HIP=OFF -DOPENEMS_GPU_PLUGINS=OFF -DENABLE_RPATH=OFF

source "$HERE/link.sh"
