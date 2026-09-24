#!/bin/sh
# 3 alternating pairs: default theme, then omikuji-shrine; one fresh Chrome profile per run.
ROOT=/local/home/skerraut/.herdr/worktrees/hachidori/theme330-omikuji-shrine
export HACHIDORI_CHROME=$HOME/.cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome
export HACHIDORI_PUPPETEER=$HOME/.cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export HACHIDORI_BENCH_REPO=$ROOT
export HACHIDORI_HOVER_SAMPLES=1
D=/tmp/omikuji-dicts
for pair in 1 2 3; do
  for theme in default omikuji-shrine; do
    out=/tmp/bench-omikuji/results/$theme-$pair
    rm -rf "$out"; mkdir -p "$out"
    uptime > "$out/uptime-before.txt"
    HACHIDORI_HOVER_THEME=$theme node /tmp/bench-omikuji/hover-popup.mjs "$out" $D/jitendex-yomitan.zip $D/jiten-frequency.zip $D/KANJIDIC_english.zip > "$out/stdout.log" 2> "$out/stderr.log"
    echo "exit=$?" > "$out/exit.txt"
    uptime > "$out/uptime-after.txt"
  done
done
echo ALLDONE > /tmp/bench-omikuji/results/ALLDONE
