#!/bin/sh
# Build the pinned libavif/libaom sequence encoder used by the capture worker.
set -e

AVIF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WASM_DIR=$(CDPATH= cd -- "$AVIF_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$WASM_DIR/.." && pwd)
AVIF_BUILD_DIR="${AVIF_BUILD_DIR:-$AVIF_DIR/build}"
VENDOR_DIR="$REPO_ROOT/extension/vendor"

# shellcheck disable=SC1091
. "$WASM_DIR/env.sh"

emcmake cmake -S "$AVIF_DIR" -B "$AVIF_BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build "$AVIF_BUILD_DIR" --parallel "$(nproc 2>/dev/null || printf '%s\n' 4)"

mkdir -p "$VENDOR_DIR"
cp "$AVIF_BUILD_DIR/avif-encoder.mjs" "$VENDOR_DIR/avif-encoder.mjs"
cp "$AVIF_BUILD_DIR/avif-encoder.wasm" "$VENDOR_DIR/avif-encoder.wasm"
chmod 644 "$VENDOR_DIR/avif-encoder.mjs" "$VENDOR_DIR/avif-encoder.wasm"
ls -l "$VENDOR_DIR/avif-encoder.mjs" "$VENDOR_DIR/avif-encoder.wasm"
