#!/bin/bash
# build-wasm.sh <label>: wasm/build.sh unchanged, 8 jobs (nproc shim), build
# dirs outside the repo; then the vendor bundles' sha256.
set -eu
E=/local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence
HC=/local/home/skerraut/herd-synth3/clones/hachi-issue-658
export PATH="$E/shim:$HOME/.local/share/mise/installs/cmake/3.31.6/cmake-3.31.6-linux-x86_64/bin:$PATH"
export BUILD_DIR=$E/wasm-build
cd $HC
./wasm/build.sh > $E/wasm-$1.log 2>&1
(. ./wasm/env.sh; emcc --version | head -1) >> $E/wasm-$1.log
sha256sum extension/vendor/hoshidicts*.wasm extension/vendor/hoshidicts*.mjs > $E/wasm-$1.sha256
echo "WASM OK $1"
