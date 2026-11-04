#!/usr/bin/env bash
# NIT 6 and FIX 3 follow-up: audit-hachi-issue-656-c's layout probes on the
# working tree with the title capped beside the icon. Run inside one gate lane.
set -u
T=/local/home/skerraut/herd-synth3/tmp-hachi656
H=/local/home/skerraut/herd-synth3/clones/hachi-issue-656
export PATH="$HOME/.local/share/mise/installs/node/22.23.1/bin:$PATH" TMPDIR=$T OUT=$T/probe3/out
cd $T/probe3
run() { local label=$1; shift; echo "== $(date -u +%FT%TZ) $label: $*"; env "$@" > "$OUT/$label.log" 2>&1; echo "== $(date -u +%FT%TZ) $label rc=$?"; }
ALL=single,short,n25,n34,n55
run v3-head-152 SWEEP=1 SETS=$ALL SHOTSETS=n34 SHOTW=600,420,320,280,240,200 node layout.mjs $H v3-head-152
run v3-head-152-min20 FONTPREF=min20 SWEEP=1 SETS=$ALL SHOTSETS=n34 SHOTW=320,240,214,200 node layout.mjs $H v3-head-152-min20
run v3-head-152-zoom125 ZOOM=1.25 SWEEP=1 SETS=$ALL SHOTSETS=n34 SHOTW=600,236,200 node layout.mjs $H v3-head-152-zoom125
run v3-head-152-default20 FONTPREF=default20 SWEEP=1 SETS=$ALL SHOTSETS=none node layout.mjs $H v3-head-152-default20
run v3-head-128 SWEEP=1 SETS=$ALL SHOTSETS=none node layout.mjs $H v3-head-128 128.0.6613.137
run v3-head-152-zoom175 ZOOM=1.75 SWEEP=1 SETS=$ALL SHOTSETS=none WIDTHS=600,480,320 node layout.mjs $H v3-head-152-zoom175
run v3-head-152-zoom200 ZOOM=2 SWEEP=1 SETS=$ALL SHOTSETS=none WIDTHS=600,480,320 node layout.mjs $H v3-head-152-zoom200
echo "== $(date -u +%FT%TZ) chrome done"
(
  cd $H || exit 2
  export HACHIDORI_FIREFOX="$H/test/tmp/browsers/firefox/linux-stable_159.0/firefox/firefox"
  export HACHIDORI_PUPPETEER=$(cd test/tooling && node -e 'console.log(require.resolve("puppeteer-core"))')
  export HACHIDORI_FIREFOX_EXTENSION="$T/ff3-ext"
  P=$(mktemp -d "$T/ff3-XXXX")
  export HACHIDORI_FIREFOX_PROFILE="$P/p" AUDIT_ROOT="$H" AUDIT_LABEL=v3-ff-159 SETS=$ALL SWEEP=1 STEP=4
  rm -rf "$HACHIDORI_FIREFOX_EXTENSION"
  python3 scripts/build-firefox.py --output-dir "$HACHIDORI_FIREFOX_EXTENSION" > "$OUT/v3-ff-159-build.log" 2>&1
  echo "== $(date -u +%FT%TZ) v3-ff-159"
  node --test --test-force-exit --test-reporter=spec $T/probe3/fflayout.test.mjs > "$OUT/v3-ff-159.log" 2>&1
  echo "== $(date -u +%FT%TZ) v3-ff-159 rc=$?"
  rm -rf "$P"
)
echo "== $(date -u +%FT%TZ) all done"
