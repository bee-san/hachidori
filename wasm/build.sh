#!/bin/sh
# Builds the threaded OPFS runtime and the single-thread IDBFS fallback.
set -e

WASM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$WASM_DIR/.." && pwd)
THREADED_BUILD_DIR="${BUILD_DIR:-$WASM_DIR/build}"
FALLBACK_BUILD_DIR="${FALLBACK_BUILD_DIR:-${THREADED_BUILD_DIR}-fallback}"
VENDOR_DIR="$REPO_ROOT/extension/vendor"

# shellcheck disable=SC1091
. "$WASM_DIR/env.sh"

build_runtime() {
  build_dir=$1
  pthreads=$2
  emcmake cmake -S "$WASM_DIR" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DHACHIDORI_PTHREADS="$pthreads"
  cmake --build "$build_dir" --parallel "$(nproc 2>/dev/null || printf '%s\n' 4)"
}

build_runtime "$THREADED_BUILD_DIR" ON
build_runtime "$FALLBACK_BUILD_DIR" OFF

mkdir -p "$VENDOR_DIR"
cp "$THREADED_BUILD_DIR/hoshidicts-threaded.mjs" "$VENDOR_DIR/hoshidicts-threaded.mjs"
cp "$THREADED_BUILD_DIR/hoshidicts-threaded.wasm" "$VENDOR_DIR/hoshidicts-threaded.wasm"
cp "$FALLBACK_BUILD_DIR/hoshidicts.mjs" "$VENDOR_DIR/hoshidicts.mjs"
cp "$FALLBACK_BUILD_DIR/hoshidicts.wasm" "$VENDOR_DIR/hoshidicts.wasm"
chmod 644 \
  "$VENDOR_DIR/hoshidicts-threaded.mjs" \
  "$VENDOR_DIR/hoshidicts-threaded.wasm" \
  "$VENDOR_DIR/hoshidicts.mjs" \
  "$VENDOR_DIR/hoshidicts.wasm"

ls -l \
  "$VENDOR_DIR/hoshidicts-threaded.mjs" \
  "$VENDOR_DIR/hoshidicts-threaded.wasm" \
  "$VENDOR_DIR/hoshidicts.mjs" \
  "$VENDOR_DIR/hoshidicts.wasm"
