#!/usr/bin/env bash
# Build openEMS (+ CSXCAD, nf2ff) as a WebAssembly module with Emscripten.
#
#   ./build.sh            fetch sources, build deps, build openems.{js,wasm} into dist/
#   ./build.sh deps       only the third-party libraries
#   ./build.sh app        only CSXCAD/openEMS/glue (deps already built)
#   ./build.sh link       only the final wasm link (+ JS files) into dist/
#   ./build.sh zlib|tinyxml|hdf5|boost   one dependency
#
# Needs emsdk activated (EMSDK set, emcc on PATH) or EMSDK_DIR pointing at it.
# Sources go to .src/, build trees to .build/, the wasm sysroot to .prefix/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/versions.env"

if ! command -v emcc >/dev/null; then
  EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
fi

SRC="$HERE/.src"
BLD="$HERE/.build"
PREFIX="$HERE/.prefix"
DIST="${DIST:-$HERE/../../site/openems}"
JOBS="${JOBS:-4}"
mkdir -p "$SRC/dl" "$BLD" "$PREFIX" "$DIST"

# Every object is built with shared memory + atomics so the pthread link works.
COMMON_FLAGS="-O3 -pthread -msimd128 -msse -msse2 -fwasm-exceptions"
export CFLAGS="$COMMON_FLAGS"
export CXXFLAGS="$COMMON_FLAGS"
export LDFLAGS="-pthread -fwasm-exceptions"

log() { printf '\n=== %s\n' "$*"; }

fetch_tar() { # name url sha256 [strip]
  local out="$SRC/dl/$1.tar.gz"
  [ -f "$out" ] || curl -sSLf -o "$out" "$2"
  echo "$3  $out" | sha256sum -c --quiet
  if [ ! -d "$SRC/$1" ]; then
    mkdir -p "$SRC/$1"
    tar xzf "$out" -C "$SRC/$1" --strip-components="${4:-1}"
    for p in "$HERE/patches/$1"/*.patch; do
      [ -f "$p" ] || continue
      patch -s -d "$SRC/$1" -p1 < "$p"
    done
  fi
}

fetch_git() { # name url commit
  local dir="$SRC/$1"
  [ -d "$dir/.git" ] || git clone -q "$2" "$dir"
  git -C "$dir" fetch -q origin "$3" 2>/dev/null || true
  git -C "$dir" checkout -q --detach "$3"
  # re-apply local patches from a clean tree
  git -C "$dir" reset -q --hard "$3"
  for p in "$HERE/patches/$1"/*.patch; do
    [ -f "$p" ] || continue
    git -C "$dir" apply --whitespace=nowarn "$p"
  done
}

fetch() {
  log fetch
  fetch_tar boost "$BOOST_URL" "$BOOST_SHA256"
  fetch_tar zlib "$ZLIB_URL" "$ZLIB_SHA256"
  fetch_tar hdf5 "$HDF5_URL" "$HDF5_SHA256" 2   # tarball entries start with ./
  fetch_tar tinyxml "$TINYXML_URL" "$TINYXML_SHA256"
  fetch_git fparser https://github.com/thliebig/fparser.git "$FPARSER_COMMIT"
  fetch_git CSXCAD https://github.com/thliebig/CSXCAD.git "$CSXCAD_COMMIT"
  fetch_git openEMS https://github.com/thliebig/openEMS.git "$OPENEMS_COMMIT"
}

build_zlib() {
  # built here rather than the emscripten port so it gets the same -pthread flags
  log zlib
  local b="$BLD/zlib"; mkdir -p "$b" "$PREFIX/include" "$PREFIX/lib"
  for f in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback \
           inffast inflate inftrees trees uncompr zutil; do
    emcc $CFLAGS -DHAVE_UNISTD_H -c "$SRC/zlib/$f.c" -o "$b/$f.o"
  done
  rm -f "$PREFIX/lib/libz.a"
  emar rcs "$PREFIX/lib/libz.a" "$b"/*.o
  cp "$SRC/zlib/zlib.h" "$SRC/zlib/zconf.h" "$PREFIX/include/"
}

build_tinyxml() {
  log tinyxml
  local b="$BLD/tinyxml"; mkdir -p "$b"
  for f in tinyxml tinystr tinyxmlerror tinyxmlparser; do
    em++ $CXXFLAGS -DTIXML_USE_STL -c "$SRC/tinyxml/$f.cpp" -o "$b/$f.o"
  done
  emar rcs "$PREFIX/lib/libtinyxml.a" "$b"/*.o
  mkdir -p "$PREFIX/include"
  cp "$SRC/tinyxml/tinyxml.h" "$SRC/tinyxml/tinystr.h" "$PREFIX/include/"
}

build_hdf5() {
  log hdf5
  emcmake cmake -S "$SRC/hdf5" -B "$BLD/hdf5" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_TESTING=OFF \
    -DHDF5_BUILD_TOOLS=OFF -DHDF5_BUILD_UTILS=OFF -DHDF5_BUILD_EXAMPLES=OFF \
    -DHDF5_BUILD_CPP_LIB=OFF -DHDF5_BUILD_FORTRAN=OFF -DHDF5_BUILD_JAVA=OFF \
    -DHDF5_BUILD_HL_LIB=ON -DHDF5_ENABLE_THREADSAFE=OFF \
    -DHDF5_ENABLE_Z_LIB_SUPPORT=ON -DZLIB_USE_EXTERNAL=OFF \
    -DZLIB_INCLUDE_DIR="$PREFIX/include" -DZLIB_LIBRARY="$PREFIX/lib/libz.a" \
    -DHDF5_ENABLE_SZIP_SUPPORT=OFF -DHDF5_ENABLE_PARALLEL=OFF \
    -DHDF5_ENABLE_NONSTANDARD_FEATURE_FLOAT16=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS" >/dev/null
  cmake --build "$BLD/hdf5" -j "$JOBS"
  cmake --install "$BLD/hdf5" >/dev/null
  # its package config wants a ZLIB::ZLIB target; FindHDF5's library search is enough
  rm -f "$PREFIX"/cmake/hdf5*.cmake
}

build_boost() {
  log boost
  local b="$SRC/boost"
  ( cd "$b"
    [ -x ./b2 ] || ./bootstrap.sh >/dev/null
    ./b2 -q -j"$JOBS" toolset=emscripten link=static threading=multi variant=release \
      runtime-link=static --disable-icu \
      --with-thread --with-chrono --with-date_time --with-program_options \
      --with-serialization --with-system \
      cxxflags="$CXXFLAGS" cflags="$CFLAGS" linkflags="$LDFLAGS" \
      --prefix="$PREFIX" --build-dir="$BLD/boost" install >/dev/null )
}

deps() {
  build_zlib
  build_tinyxml
  build_hdf5
  build_boost
}

case "${1:-all}" in
  fetch) fetch ;;
  deps)  fetch; deps ;;
  app)   source "$HERE/build_app.sh" ;;
  link)  source "$HERE/link.sh" ;;
  zlib|tinyxml|hdf5|boost) fetch; "build_$1" ;;
  all)   fetch; deps; source "$HERE/build_app.sh" ;;
  *) echo "usage: $0 [fetch|deps|app|link|all|zlib|tinyxml|hdf5|boost]" >&2; exit 2 ;;
esac
