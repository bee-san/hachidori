#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Native baseline for the wasm build.
#
# Builds third_party/hoshidicts with -DHOSHIDICTS_CLI=ON on the host toolchain,
# imports test/fixtures/hachidori-fixture.zip with hoshidicts-cli, and dumps the same
# words node-smoke.mjs looks up. Two things come out of that:
#
#   * the Emscripten portability patches carried on the submodule's `wasm` branch
#     are #ifdef __EMSCRIPTEN__ guarded, so a native build proves they did not
#     change native behaviour;
#   * the wasm output has something independent to be compared against, instead
#     of only being compared to expectations written by the same person.
#
# Everything lands in test/tmp/. The submodule is configured out-of-tree and is
# checked for modifications before the script exits.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
ENGINE="$REPO_ROOT/third_party/hoshidicts"
TMP="${TMP_DIR:-$HERE/tmp}"
BUILD_DIR="$TMP/native"
WORK="$TMP/baseline"
FIXTURE="$HERE/fixtures/hachidori-fixture.zip"
PARENT_FIXTURE="$HERE/fixtures/parent-title.zip"
LOG="$TMP/baseline.txt"

# The words node-smoke.mjs asserts on. Keep the two lists in step.
WORDS="食べる 食べたかった 食べさせられたくなかった たべる タベル ありがとう 漢字 読む 犬猫鳥 xyzzy"

die() {
  echo "baseline: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Toolchain
#
# The engine is C++23: query.cpp and lookup.cpp use std::ranges::to and
# std::views::as_rvalue, the CLI uses std::format, and glaze v8 wants a recent
# front end. This host's default /usr/bin/clang++ is 15 and its /usr/bin/g++ is
# 11.5; neither is enough. Rather than hardcoding a version test, probe each
# candidate with the three features that actually gate the build.
# ---------------------------------------------------------------------------

probe_source="$TMP/.probe.cpp"
probe_bin="$TMP/.probe"

write_probe() {
  mkdir -p "$TMP"
  cat > "$probe_source" <<'EOF'
#include <format>
#include <ranges>
#include <string>
#include <vector>
int main() {
  std::vector<std::string> in{"a", "b"};
  auto out = in | std::views::as_rvalue | std::ranges::to<std::vector>();
  return std::format("{}", out.size()) == "2" ? 0 : 1;
}
EOF
}

probe_compiler() {
  "$1" -std=c++23 "$probe_source" -o "$probe_bin" >/dev/null 2>&1 || return 1
  "$probe_bin" >/dev/null 2>&1 || return 1
  return 0
}

# "c++ compiler:matching c compiler" pairs, best first.
CANDIDATES="g++-15:gcc-15 g++-14:gcc-14 gcc15-g++:gcc15-gcc gcc14-g++:gcc14-gcc g++:gcc clang++-20:clang-20 clang++-19:clang-19 clang++-18:clang-18 clang++:clang"

write_probe
CXX_FOUND=''
CC_FOUND=''
if [ -n "${CXX:-}" ]; then
  if probe_compiler "$CXX"; then
    CXX_FOUND="$CXX"
    CC_FOUND="${CC:-$CXX}"
  else
    die "\$CXX is set to '$CXX' but it cannot build C++23 std::ranges::to / std::views::as_rvalue / std::format"
  fi
else
  for pair in $CANDIDATES; do
    cxx=${pair%%:*}
    cc=${pair##*:}
    command -v "$cxx" >/dev/null 2>&1 || continue
    command -v "$cc" >/dev/null 2>&1 || continue
    if probe_compiler "$cxx"; then
      CXX_FOUND="$cxx"
      CC_FOUND="$cc"
      break
    fi
  done
fi
rm -f "$probe_source" "$probe_bin"

if [ -z "$CXX_FOUND" ]; then
  cat >&2 <<'EOF'
baseline: no host compiler on this machine can build the engine natively.

The engine is C++23. src/query.cpp and src/lookup.cpp use std::ranges::to and
std::views::as_rvalue, cli/main.cpp uses std::format, and external/glaze (v8)
needs a recent front end. That means one of:

  * GCC >= 14 with its own libstdc++, or
  * clang >= 17 with libc++ >= 17 (-stdlib=libc++), or clang >= 17 paired with
    libstdc++ >= 14 headers.

Tried, in order:
EOF
  for pair in $CANDIDATES; do
    printf '  %s\n' "${pair%%:*}" >&2
  done
  cat >&2 <<'EOF'

Install one of those and either put it on PATH or point the script at it:

    CXX=/path/to/g++-14 CC=/path/to/gcc-14 ./test/baseline.sh

Nothing else in this repo needs a native compiler: the wasm module is built by
./wasm/build.sh with emscripten, and test/node-smoke.mjs runs against that wasm
module. Skipping the baseline costs the native/wasm cross-check, not coverage of
the extension itself.
EOF
  exit 3
fi

echo "baseline: using CXX=$CXX_FOUND CC=$CC_FOUND"
"$CXX_FOUND" --version | head -1

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------

node "$HERE/make-fixture.mjs" >/dev/null
[ -f "$FIXTURE" ] || die "could not produce $FIXTURE; run 'node test/make-fixture.mjs'"
[ -f "$PARENT_FIXTURE" ] || die "could not produce $PARENT_FIXTURE; run 'node test/make-fixture.mjs'"

# ---------------------------------------------------------------------------
# Build, out of tree
# ---------------------------------------------------------------------------

mkdir -p "$BUILD_DIR"
CC="$CC_FOUND" CXX="$CXX_FOUND" cmake -S "$ENGINE" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release -DHOSHIDICTS_CLI=ON > "$TMP/configure.log" 2>&1 ||
  { tail -30 "$TMP/configure.log" >&2; die "cmake configure failed; full log in $TMP/configure.log"; }

cmake --build "$BUILD_DIR" --parallel "$(nproc 2>/dev/null || echo 4)" > "$TMP/build.log" 2>&1 ||
  { tail -40 "$TMP/build.log" >&2; die "native build failed; full log in $TMP/build.log"; }

CLI="$BUILD_DIR/hoshidicts-cli"
[ -x "$CLI" ] || die "$CLI was not produced"

PATH_WORK="$TMP/path-safety"
rm -rf "$PATH_WORK"
mkdir -p "$PATH_WORK/input"
cp "$PARENT_FIXTURE" "$PATH_WORK/input/"
printf 'keep\n' > "$PATH_WORK/sentinel"
"$CLI" import "$PATH_WORK/input/parent-title.zip" >/dev/null 2>&1 || true
[ -f "$PATH_WORK/sentinel" ] || die "an archive title escaped its output directory"

# ---------------------------------------------------------------------------
# Import and dump
# ---------------------------------------------------------------------------

rm -rf "$WORK"
mkdir -p "$WORK"
cp "$FIXTURE" "$WORK/"

HEADER="# native baseline
# compiler: $("$CXX_FOUND" --version | head -1)
# engine:   $(git -C "$ENGINE" rev-parse HEAD) ($(git -C "$ENGINE" rev-parse --abbrev-ref HEAD))
# fixture:  $(cksum < "$FIXTURE")"

# Everything below runs with $WORK as the cwd and relative dictionary paths, so
# the log holds no absolute paths and can be diffed run to run and host to host.
cd "$WORK"

# `runtime: N.NNms` lines are wall clock and would make every run differ; strip
# them so $LOG stays diffable too.
run() {
  printf '\n$ hoshidicts-cli %s\n' "$*"
  # `|| true`: grep exits 1 when it filters everything out, and set -e inside the
  # redirected group below would abort the run mid-log.
  "$CLI" "$@" 2>&1 | grep -v '^runtime: ' || true
}

{
  echo "$HEADER"

  run import hachidori-fixture.zip

  printf '\n$ ls hachidori-fixture/\n'
  # Byte sizes, not disk blocks: hash.table and bloom.filter are the two files
  # the Emscripten mmap fix is about, so these are the reference for the sizes
  # node-smoke.mjs reads out of MEMFS.
  for f in $(ls -A hachidori-fixture | sort); do
    printf '  %8s  %s\n' "$(wc -c < "hachidori-fixture/$f")" "$f"
  done

  for word in $WORDS; do
    run lookup hachidori-fixture "$word"
  done

  run query hachidori-fixture 漢字
  run deinflect 食べたかった
  run preprocess タベル
  run freq hachidori-fixture 食べる たべる
  run freq hachidori-fixture 読む よむ
  run kanji hachidori-fixture 食
  run kanji hachidori-fixture 犬
} > "$LOG" 2>&1

cat "$LOG"

# ---------------------------------------------------------------------------

dirty=$(git -C "$ENGINE" status --porcelain)
if [ -n "$dirty" ]; then
  echo "$dirty" >&2
  die "the submodule was modified; the build should have been entirely out-of-tree"
fi

echo
echo "baseline: submodule clean, full log in $LOG"
