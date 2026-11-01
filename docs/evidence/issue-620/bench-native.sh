#!/bin/bash
# hoshidicts' benchmark-lookup over the 40,000 novel hovers, 2 iterations each,
# in six rotated rounds: hoshidicts main, #44 with the option off and #44 with
# --metadata-only-terms. Usage: bench-native.sh <#44 checkout> <main checkout>
# (each configured with -DHOSHIDICTS_BENCHMARK=ON and built in build/).
set -eu
M=$(cd "$(dirname "$0")" && pwd)
BRANCH=$1
BASE=$2
I=$M/imported
ARGS=(--term "$I/Jitendex.org [2026-10-03]" "$I/JMnedict [2026-10-31]" "$I/Bee's Ultimate Kanji Dictionary" \
  "$I/Bee's Ultimate Grammar Dictionary" --freq "$I/Bee's Ultimate Kanji Dictionary" "$I/Jiten")
orders=("main off on" "off on main" "on main off" "main on off" "off main on" "on off main")
for round in 0 1 2 3 4 5; do
  for v in ${orders[$round]}; do
    flag=()
    case $v in
      main) bin=$BASE/build/benchmark-lookup;;
      off) bin=$BRANCH/build/benchmark-lookup;;
      on) bin=$BRANCH/build/benchmark-lookup; flag=(--metadata-only-terms);;
    esac
    printf '%s round %d: %s\n' "$v" $((round + 1)) "$("$bin" "$M/neko-windows.txt" 2 "${ARGS[@]}" "${flag[@]}" | grep total)"
  done
done
