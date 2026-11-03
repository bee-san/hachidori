#!/bin/bash
# build-probe.sh <src> <build dir> <out>: probe.cpp against that build's library.
set -eu
. /local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence/env.sh
S=$1; B=$2
$CXX -O2 -std=gnu++23 -Wno-missing-braces -I$S/include -I$S/external/utfcpp/source -I$S/external/xxHash -isystem $S/external/glaze/include \
  $E/probe.cpp -o "$3" $B/libhoshidicts.a $B/external/zstd/build/cmake/lib/libzstd.a $B/external/libdeflate/libdeflate.a $B/external/utf8proc/libutf8proc.a $B/liblzokay.a $B/libgumbo.a
echo "PROBE OK $3"
