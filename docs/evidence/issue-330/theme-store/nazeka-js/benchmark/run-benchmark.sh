#!/usr/bin/env bash
# Theme benchmark for issue #334: default popup vs the vendor/themes/nazeka theme
# through benchmark/hover-popup.mjs (same Chrome, same archives, same session
# count), then the summary. Run from the Hachidori checkout that carries the
# theme prototype (docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch
# and harness-benchmark.patch applied):
#
#   bash docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run-benchmark.sh <out-dir> [sessions]
#
# Prerequisites (see "How to benchmark a theme" in issue #334):
#   npm ci --prefix test/tooling && npm --prefix test/tooling run install:chrome
set -euo pipefail
OUT=${1:?out dir}
SESSIONS=${2:-5}
ROOT=$(git rev-parse --show-toplevel)
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
export HACHIDORI_CHROME="$ROOT/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"
export HACHIDORI_PUPPETEER="$ROOT/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
export HACHIDORI_HOVER_SAMPLES=$SESSIONS
LOG="$OUT/commands.txt"
run() { echo "\$ $*" | tee -a "$LOG"; "$@" 2>&1 | tee -a "$LOG"; }
{
  echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) $(uname -srm) node $(node --version) $("$HACHIDORI_CHROME" --version)"
  echo "# revision $(git -C "$ROOT" rev-parse HEAD) (+ worktree prototype), sessions=$SESSIONS"
  echo "# HACHIDORI_CHROME=$HACHIDORI_CHROME"
  echo "# HACHIDORI_PUPPETEER=$HACHIDORI_PUPPETEER"
} | tee "$LOG"
cd "$ROOT"
run node benchmark/hover-popup-fixture.mjs "$OUT/hover-popup-fixture.zip"
HACHIDORI_ROOT=$ROOT run node "$HERE/theme-bench-fixture.mjs" "$OUT"
ARCHIVES=("$OUT/hover-popup-fixture.zip" "$OUT/theme-bench-senses.zip" "$OUT/theme-bench-kanji.zip")
echo "\$ time node benchmark/hover-popup.mjs $OUT/default ${ARCHIVES[*]}" | tee -a "$LOG"
( time node benchmark/hover-popup.mjs "$OUT/default" "${ARCHIVES[@]}" ) > "$OUT/default.log" 2>&1
tail -3 "$OUT/default.log" | tee -a "$LOG"
echo "\$ time HACHIDORI_HOVER_OPTIONS='{\"popupTheme\":\"nazeka\"}' node benchmark/hover-popup.mjs $OUT/nazeka ${ARCHIVES[*]}" | tee -a "$LOG"
( time HACHIDORI_HOVER_OPTIONS='{"popupTheme":"nazeka"}' node benchmark/hover-popup.mjs "$OUT/nazeka" "${ARCHIVES[@]}" ) > "$OUT/nazeka.log" 2>&1
tail -3 "$OUT/nazeka.log" | tee -a "$LOG"
run node "$HERE/summarise.mjs" "$OUT/default" "$OUT/nazeka" "$OUT/summary"
