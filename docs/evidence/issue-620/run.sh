#!/bin/bash
# Reproduces the #620 measurements natively.
# Usage: run.sh <hoshidicts branch checkout> <hoshidicts main checkout>
# Each checkout must be built: cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#   -DHOSHIDICTS_TESTS=ON -DHOSHIDICTS_BENCHMARK=ON && cmake --build build -j8
set -eu
M=$(cd "$(dirname "$0")" && pwd)
BRANCH=$1
BASE=$2
. "$M/env.sh"
libs() { echo "$1/build/libhoshidicts.a $1/build/external/zstd/build/cmake/lib/libzstd.a $1/build/external/libdeflate/libdeflate.a $1/build/external/utf8proc/libutf8proc.a $1/build/liblzokay.a $1/build/libgumbo.a"; }
$CXX -std=c++23 -O2 -I"$BRANCH/include" -I"$BRANCH/external/utfcpp/source" "$M/measure.cpp" $(libs "$BRANCH") -lpthread -o "$M/measure"
$CXX -std=c++23 -O2 -I"$BRANCH/include" "$M/measure_text.cpp" $(libs "$BRANCH") -lpthread -o "$M/measure_text"
$CXX -std=c++23 -O2 -DBRANCH -I"$BRANCH/include" "$M/dump.cpp" $(libs "$BRANCH") -lpthread -o "$M/dump_branch"
$CXX -std=c++23 -O2 -I"$BASE/include" "$M/dump.cpp" $(libs "$BASE") -lpthread -o "$M/dump_base"
D=$M/dicts
rm -rf "$M/imported"
"$M/measure" "$M/imported" "$M/jiten-expressions.tsv" "$D/jitendex-yomitan.zip" "$D/JMnedict.zip" \
  "$D/bees-ultimate-kanji-dictionary.zip" "$D/jiten-frequency.zip" "$D/bees-ultimate-grammar-dictionary.zip" | tee "$M/measure.log"
I=$M/imported
ARGS=(--term "$I/Jitendex.org [2026-10-03]" "$I/JMnedict [2026-10-31]" "$I/Bee's Ultimate Kanji Dictionary" \
  "$I/Bee's Ultimate Grammar Dictionary" --freq "$I/Bee's Ultimate Kanji Dictionary" "$I/Jiten")
"$M/measure_text" "$M/neko-windows.txt" "${ARGS[@]}" | tee "$M/text.log"
"$M/dump_base" "$M/all-inputs.txt" "${ARGS[@]}" > "$M/dump-base.txt" &
"$M/dump_branch" "$M/all-inputs.txt" "${ARGS[@]}" > "$M/dump-off.txt" &
METADATA=1 "$M/dump_branch" "$M/all-inputs.txt" "${ARGS[@]}" > "$M/dump-on.txt" &
wait
sha256sum "$M/dump-base.txt" "$M/dump-off.txt" "$M/dump-on.txt" | tee "$M/dump.sha256"
cmp "$M/dump-base.txt" "$M/dump-off.txt" && echo "OFF IDENTICAL TO BASE"
python3 - "$M" <<'PY'
import sys
m = sys.argv[1]
def blocks(path):
    cur, items = None, []
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('= '):
            if cur is not None: yield cur, items
            cur, items = line[2:], []
        else:
            items.append(line)
    if cur is not None: yield cur, items
total = changed = bad = front_bad = 0
for (k1, off), (k2, on) in zip(blocks(f'{m}/dump-off.txt'), blocks(f'{m}/dump-on.txt')):
    assert k1 == k2
    total += 1
    meta = [x for x in on if x.split('|')[8] == '']
    ordinary = [x for x in on if x.split('|')[8] != '']
    changed += bool(meta)
    bad += ordinary != off[:len(ordinary)] or len(on) != min(32, len(off) + len(meta))
    front_bad += on[:len(meta)] != meta
print('inputs', total, 'changed by the option', changed, 'ordinary lists not the off prefix', bad,
      'glossary-less not in front', front_bad)
PY
