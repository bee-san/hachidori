#!/bin/sh
# Builds the hoshidicts wasm module and installs it into extension/vendor/.
set -e

WASM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$WASM_DIR/.." && pwd)
BUILD_DIR="${BUILD_DIR:-$WASM_DIR/build}"
VENDOR_DIR="$REPO_ROOT/extension/vendor"

# shellcheck disable=SC1091
. "$WASM_DIR/env.sh"

emcmake cmake -S "$WASM_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --parallel "$(nproc 2>/dev/null || echo 4)"

mkdir -p "$VENDOR_DIR"
cp "$BUILD_DIR/hoshidicts.mjs" "$BUILD_DIR/hoshidicts.wasm" "$VENDOR_DIR/"
chmod 644 "$VENDOR_DIR/hoshidicts.mjs" "$VENDOR_DIR/hoshidicts.wasm"

ls -l "$VENDOR_DIR/hoshidicts.mjs" "$VENDOR_DIR/hoshidicts.wasm"
