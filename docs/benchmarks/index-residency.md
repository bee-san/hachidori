# Hash index residency: benchmark progress

Work for [issue #496](https://github.com/bee-san/hachidori/issues/496), paired
with [hoshidicts #35](https://github.com/bee-san/hoshidicts/pull/35).

**The benchmark matrix is incomplete.** The user requested committing and
opening the PR immediately, with no further tests. Running benchmarks were
stopped. The 32 MiB resident target remains provisional; these observations do
not establish a default from three repeated comparisons or a measured speedup.

The implementation and reproducible harness compare resident hashes, 16/32/64
MiB aggregate targets and fully paged hashes. The page cache remains one shared
4 KiB/32 MiB cache for hashes and entries. Native lookup timing uses the pinned
engine's existing benchmark; Chrome timing covers WASM calls, runtime round trips,
rendered pointer hovers, startup, disable/enable, disabled validation, reimport,
removal and idle recycling. See [commands and boundaries](../../benchmark/README.md#hash-index-residency).

## Completed observations

The 58-package synthetic fixture has 200,000 generated Japanese terms plus
existing term, frequency, pitch, kanji, inflection and PNG fixtures. Each package
has a 4,571,636-byte hash table: 252.87 MiB combined. Binary files come from the
production native importer, with distinct canonical titles and stable package IDs.
It is an accurately labelled substitute, not the reporter's private collection.

- A completed resident baseline sample used a 357.5 MiB fresh and warm WASM heap.
  Its 570-query warm round trip was 9.00 ms median / 11.17 ms p95. Full ordered
  results have SHA-256 `9ebe18b6c914ae161397b6549741b51697affe7b602be0dd5711c226622bf948`.
- A prior 32 MiB preflight used an 83.1 MiB fresh heap and completed full result,
  kanji, selected-dictionary, media and mutation/recycle parity checks. It used
  an earlier, longer corpus and ran alongside other work; its timings are not a
  controlled comparison and are not used to select the budget.
- The small preflight completed resident/budget result and mutation parity.
  Light/dark Settings screenshots below come from the completed 32 MiB preflight.

The final fixed trace touches at least 410 distinct 4 KiB hash pages per package
for exact synthetic hits alone: 92.89 MiB across 58 packages. Even after a 64 MiB
resident budget retains 14 packages, the remaining exact-hit hash working set is
70.47 MiB, exceeding the shared 32 MiB cache before entry/prefix/false-positive
reads. `index-working-set.cpp` reproduces this lower bound.

## Raw evidence and limits

Raw samples and definitions are gzip-compressed without changing their contents:

- [Resident baseline definition](../../benchmark/results/index-residency/baseline-many-definition.json.gz)
  and [completed sample](../../benchmark/results/index-residency/baseline-many-raw.jsonl.gz).
- [58-package preflight definition](../../benchmark/results/index-residency/preflight-many-definition.json.gz)
  and [samples](../../benchmark/results/index-residency/preflight-many-raw.jsonl.gz).
- [Small preflight definition](../../benchmark/results/index-residency/preflight-small-definition.json.gz)
  and [samples](../../benchmark/results/index-residency/preflight-small-raw.jsonl.gz).

Definitions contain exact source fingerprints, revisions, file/archive checksums,
Chrome/Node versions and host information. The environment was Linux 7.2.6
CachyOS, Intel Core Ultra 7 165U, 14 logical CPUs, 64 GiB RAM, Node 22.23.1,
Chrome 152.0.7977.75 and direct threaded OPFS. Generated bundles use Emscripten
6.0.9; native tools use GCC 16.2.1, Release.

OS caches were not controlled. Fresh engine snapshots include header/startup
warmup pages. WASM call times include serialization/glue; native C++ clocks exclude
it; round trips exclude rendering; hover timings include frames. Heap capacity,
live allocator bytes, estimated resident files, cache payload and process RSS are
separate quantities. RSS can count shared pages repeatedly. The complete repeated
matrix, native comparisons and optional browser extension-total snapshots remain
unrun/incomplete. The harness now uses fresh profiles to avoid carrying compiled
service-worker caches across revisions and stores the policy before native startup.

![Memory controls on the light palette](../assets/index-residency-memory-light.png)

![Memory controls on the dark palette](../assets/index-residency-memory-dark.png)
