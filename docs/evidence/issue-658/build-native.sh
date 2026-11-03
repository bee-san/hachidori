#!/bin/bash
# build-native.sh <src> <build dir>: Release build with tests and the benchmark, -j8.
set -eu
. /local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence/env.sh
cmake -S "$1" -B "$2" -DCMAKE_BUILD_TYPE=Release -DHOSHIDICTS_TESTS=ON -DHOSHIDICTS_DEINFLECTOR_TESTS=ON -DHOSHIDICTS_BENCHMARK=ON > "$2.config.log" 2>&1
cmake --build "$2" --parallel 8 > "$2.build.log" 2>&1
echo "BUILD OK $1 -> $2"
