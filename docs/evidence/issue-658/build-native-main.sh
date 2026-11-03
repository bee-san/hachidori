#!/bin/bash
# build-native-main.sh <src> <build dir>: as CI configures hoshidicts main, -j8.
set -eu
. /local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence/env.sh
cmake -S "$1" -B "$2" -DCMAKE_BUILD_TYPE=Release -DHOSHIDICTS_TESTS=ON -DHOSHIDICTS_DEINFLECTOR_TESTS=ON \
  -DHOSHIDICTS_LANGUAGE_TESTS=ON -DHOSHIDICTS_CLI=ON -DHOSHIDICTS_BENCHMARK=ON > "$2.config.log" 2>&1
cmake --build "$2" --parallel 8 > "$2.build.log" 2>&1
echo "BUILD OK $1 -> $2"
