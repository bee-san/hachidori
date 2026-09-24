#!/usr/bin/env bash
# Clean-shell test of "How to benchmark a theme" (issue bee-san/hachidori#334):
# a fresh clone of main, `env -i` with only Node 22.23.1 and the system binaries
# on PATH, the two evidence patches and the theme fetched from the evidence
# branch with curl, then the guide's commands as written. Everything it prints
# is guide-test.txt next to this script (*.log is gitignored).
#
#   bash guide-test.sh [work-dir]      (default /tmp/guide-test; removed first)
set -euo pipefail
WORK=${1:-/tmp/guide-test}
NODE_BIN=$(dirname "$(readlink -f "$(command -v node)")")
rm -rf "$WORK"; mkdir -p "$WORK/home"
echo "# guide test $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -srm); PATH=$NODE_BIN:/usr/bin:/bin; HOME=$WORK/home"
time env -i HOME="$WORK/home" PATH="$NODE_BIN:/usr/bin:/bin" LANG=C.UTF-8 WORK="$WORK" \
  bash --noprofile --norc -euxo pipefail <<'EOS'
cd "$WORK"
git clone -q --depth 1 https://github.com/bee-san/hachidori.git
cd hachidori
git rev-parse HEAD
node --version; cat .node-version                      # both 22.23.1
npm ci --prefix test/tooling
npm --prefix test/tooling run install:chrome
# Step 4 of the guide (until Phase 2): patches + theme folder + the two driver scripts
RAW=https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store
curl -fsSLO $RAW/nazeka-js/host-prototype.patch
curl -fsSLO $RAW/nazeka-js/benchmark/harness-benchmark.patch
git apply host-prototype.patch harness-benchmark.patch
mkdir -p extension/vendor/themes/nazeka bench-scripts
for f in theme.yaml theme.css theme.js; do curl -fsSL -o extension/vendor/themes/nazeka/$f $RAW/nazeka-js/$f; done
for f in theme-bench-fixture.mjs summarise.mjs; do curl -fsSL -o bench-scripts/$f $RAW/nazeka-js/benchmark/$f; done
# The guide's command block
export HACHIDORI_CHROME=$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome
export HACHIDORI_PUPPETEER=$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export HACHIDORI_HOVER_SAMPLES=5
B=bench-scripts
mkdir -p /tmp/bench && rm -rf /tmp/bench/*
node benchmark/hover-popup-fixture.mjs /tmp/bench/hover-popup-fixture.zip
HACHIDORI_ROOT=$PWD node $B/theme-bench-fixture.mjs /tmp/bench
A="/tmp/bench/hover-popup-fixture.zip /tmp/bench/theme-bench-senses.zip /tmp/bench/theme-bench-kanji.zip"
time node benchmark/hover-popup.mjs /tmp/bench/default $A | tail -2
time HACHIDORI_HOVER_OPTIONS='{"popupTheme":"nazeka"}' node benchmark/hover-popup.mjs /tmp/bench/nazeka $A | tail -2
node $B/summarise.mjs /tmp/bench/default /tmp/bench/nazeka /tmp/bench/summary
ls -la /tmp/bench/summary.*
EOS
