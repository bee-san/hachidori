#!/bin/bash
# bench-native.sh: benchmark-lookup over 40,000 16-character novel hovers x 2
# iterations; 35e2dab and the fix, option off and on; 6 rounds in rotated
# order, one process at a time, pinned to one core.
. /local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence/env.sh
cd $E
ARGS=(--term "$DICTS/Jitendex.org [2026-10-03]" "$DICTS/JMnedict [2026-10-31]" "$DICTS/Bee's Ultimate Kanji Dictionary"
  "$DICTS/Bee's Ultimate Grammar Dictionary" --freq "$DICTS/Bee's Ultimate Kanji Dictionary" "$DICTS/Jiten")
CORE=${CORE:-7}
run() {
  case $1 in
    base-off) taskset -c $CORE $E/build-base/benchmark-lookup neko-16.txt 2 "${ARGS[@]}" ;;
    base-on) taskset -c $CORE $E/build-base/benchmark-lookup neko-16.txt 2 "${ARGS[@]}" --metadata-only-terms ;;
    fix-off) taskset -c $CORE $E/build-fix/benchmark-lookup neko-16.txt 2 "${ARGS[@]}" ;;
    fix-on) taskset -c $CORE $E/build-fix/benchmark-lookup neko-16.txt 2 "${ARGS[@]}" --metadata-only-terms ;;
  esac | awk -v v=$1 -v r=$2 '/^total:/ {print "round", r, v, $2}'
}
V=(base-off base-on fix-off fix-on)
for r in 0 1 2 3 4 5; do
  for k in 0 1 2 3; do run ${V[$(( (k + r) % 4 ))]} $r; done
done | tee ${OUT:-bench-native.log}
