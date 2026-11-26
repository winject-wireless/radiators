# Sourced by build.sh: link glue + openEMS + nf2ff + deps into dist/openems.{mjs,wasm}
log link
OEMS_SRC="$SRC/openEMS"
OEMS_BLD="$BLD/openEMS"
mkdir -p "$DIST"

# Threads: the simulation runs on the module's main thread inside a Web Worker,
# which blocks, so every pthread must come from the pool made at startup:
# openEMS uses navigator.hardwareConcurrency engine threads, +1 abort watcher,
# +1 spare. Module.pthreadPoolSize (set by the worker) overrides it.
POOL='Module["pthreadPoolSize"]||((globalThis.navigator&&navigator.hardwareConcurrency)||4)+2'

em++ $CXXFLAGS -std=c++17 \
  -I"$OEMS_SRC" -I"$OEMS_BLD" -I"$PREFIX/include" -I"$PREFIX/include/CSXCAD" \
  -DTIXML_USE_STL \
  "$HERE/glue/openems_wasm.cpp" \
  "$OEMS_BLD/libopenEMS.a" "$OEMS_BLD/nf2ff/libnf2ff.a" \
  "$PREFIX/lib/libCSXCAD.a" "$PREFIX/lib/libfparser.a" "$PREFIX/lib/libtinyxml.a" \
  "$PREFIX/lib/libhdf5_hl.a" "$PREFIX/lib/libhdf5.a" \
  "$PREFIX/lib/libboost_program_options.a" "$PREFIX/lib/libboost_thread.a" \
  "$PREFIX/lib/libboost_chrono.a" "$PREFIX/lib/libboost_date_time.a" \
  "$PREFIX/lib/libboost_serialization.a" "$PREFIX/lib/libz.a" \
  $LDFLAGS -O3 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createOpenEMSModule \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sPTHREAD_POOL_SIZE="$POOL" \
  -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_oems_run,_oems_nf2ff,_oems_abort_flag,_oems_h5_list,_oems_h5_read,_oems_h5_attr,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,stringToNewUTF8,wasmMemory,HEAPF64,HEAP32,HEAPU32 \
  -o "$DIST/openems.mjs"

{
  echo "openEMS $OPENEMS_COMMIT"
  echo "CSXCAD  $CSXCAD_COMMIT"
  echo "fparser $FPARSER_COMMIT"
  echo "boost   1.86.0, hdf5 1.14.6, tinyxml 2.6.2, zlib 1.3.1"
  echo "emcc    $(emcc --version | head -1)"
} > "$DIST/BUILD-INFO.txt"
ls -la "$DIST"
