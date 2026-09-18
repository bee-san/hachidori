# Browser performance direction

## Problem

The original Chrome extension imported Jitendex through single-threaded Hoshidicts WASM and IDBFS in about four seconds before the first usable lookup. Persistence was not the whole cost: the same WASM importer still took about 3.465 seconds against volatile MEMFS, while native threaded Hoshidicts took about 0.351 seconds.

## Measured result

The controlled runs used the same Jitendex archive:

- size: `38,698,313` bytes;
- SHA-256: `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`;
- Chrome: `152.0.7977.75`;
- host: 16 logical CPUs;
- baseline: three measured samples;
- threaded OPFS build: one excluded warmup and five measured samples.

| Metric | Single-thread IDBFS baseline | Threaded OPFS |
| --- | ---: | ---: |
| Import to first correctness-checked lookup | 4.026 `[4.024–4.030]` s | 1.281 `[1.274–1.376]` s |
| Chrome restart to first correctness-checked lookup | 0.802 `[0.796–0.856]` s | 0.789 `[0.758–0.809]` s |
| Durable logical storage | 63.7 MiB | 185.5 MiB |
| Aggregate Chrome RSS during import | 2110.3 MiB | 1951.4 `[1950.2–1956.9]` MiB |

Import to usable is 3.14 times faster, saving 2.745 seconds at the median. The new median is 68.2 percent lower. Restart time is effectively unchanged. Direct OPFS uses 2.91 times the durable logical space of the compressed IDBFS representation, which is a material tradeoff.

The same balanced exact-source matrix also completed Pixiv Light, whose old
array-valued Chrome message exceeded the browser's serialization limit before
Hoshidicts started. Blob-URL archive transport now reaches the importer: Pixiv
Light imported to its first valid lookup in 2.174 `[2.075–2.225]` seconds and
restored in 0.950 `[0.931–1.007]` seconds. It occupied 372.1 MiB of OPFS and the
aggregate Chrome RSS median was 2372.4 MiB. There is no valid old-path Pixiv
timing, so no speedup is claimed for it.

The lookup-only clock starts after the full ready predicate. The first-hit columns
are one correctness-checked request before any lookup warmup; the steady columns
are real `chrome.runtime` round trips after one excluded lookup warmup pass.

| Corpus | First hit after import p50 / p95 | First hit after restart p50 / p95 | Steady hit after import p50 / p95 | Steady hit after restart p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| Jitendex | 10.225 / 10.495 ms | 10.325 / 10.552 ms | 1.980 / 2.871 ms | 1.985 / 2.852 ms |
| Pixiv Light | 9.115 / 9.291 ms | 9.190 / 9.961 ms | 1.587 / 2.298 ms | 1.613 / 2.403 ms |

Aggregate Chrome RSS sums descendant-process RSS and can count shared pages more than once. It is suitable for run-to-run regression checks on this host, not a claim about unique physical memory.

The benchmark checks exact import counts, hits, misses, deinflection, result signatures, and every persistent OPFS file's path, length, and SHA-256 before and after a complete Chrome restart. Raw evidence remains under the ignored local `benchmark/results/` directory; the benchmark source itself is versioned.

## Archive transport, relay, and first-lookup warm-up

On 2026-09-18 the standard Jitendex + Pixiv Light matrix (one excluded warmup,
three measured samples per corpus, five lookup passes, Chrome 152.0.7977.75,
16-vCPU Intel Xeon Platinum 8488C) was rerun on `ba9171bc` (extension tree
SHA-256 `75eddb68…c62353`). Jitendex import to first valid lookup had grown to
2.181 `[2.136–2.236]` s against the 1.281 s recorded above. Instrumenting the
engine worker showed where the time went:

- 0.90–1.02 s writing the 38.7 MB archive into OPFS through WasmFS's `FS.write`,
  which copies from JavaScript into the wasm heap one byte at a time (about
  25 ns per byte, independent of the destination backend);
- 0.88–0.97 s in `hdw_import` (zstd dictionary training 0.16–0.18 s, term banks
  0.47–0.56 s of which ~0.24 s waits for the eight parse/compress workers and
  ~0.05 s is file writing, index and hash tables ~0.08 s);
- 0.13–0.15 s loading the generated dictionary; the same load costs 0.15 s on
  restart.

The first `hd_lookup` after a load also spent 7–20 ms inside the native call
against 0.3–0.5 ms once warm (V8 tiering the wasm), and every relayed request
paid a `chrome.runtime.getContexts()` round trip of about 0.2 ms.

Four changes:

1. `streamResponseToFile` collects the body and writes it once through a shared
   writable mapping (`FS.mmap`, one `HEAPU8.set`, `FS.msync`, `FS.munmap`). WasmFS's
   `FS.writeFile` was not usable: on the OPFS backend it appends to an existing
   file and leaves it undeletable until the next start, which the benchmark's
   durable-storage manifest check caught.
2. `relay()` sends to the offscreen document directly once it has answered and
   only verifies the document again when a reply is missing.
3. Publishing a non-empty dictionary set runs one warm-up lookup inside the
   serialised load.
4. The archive is staged in MEMFS for the WasmFS build as well, which removes
   the proxied OPFS write, read-back mapping, and unlink (about 50 ms of
   `hdw_import` for Jitendex) and writes nothing to disk the importer does not
   keep.

| Metric | `ba9171bc` | With changes |
| --- | ---: | ---: |
| Jitendex import to first correctness-checked lookup | 2.181 `[2.136–2.236]` s | 1.322 `[1.175–1.325]` s |
| Pixiv Light import to first correctness-checked lookup | 2.832 `[2.791–2.884]` s | 1.627 `[1.623–1.680]` s |
| Jitendex Chrome restart to first correctness-checked lookup | 0.987 `[0.983–0.990]` s | 1.037 `[0.986–1.047]` s |
| Pixiv Light Chrome restart to first correctness-checked lookup | 1.055 `[0.999–1.066]` s | 1.068 `[1.034–1.095]` s |
| Jitendex first hit after import / after restart | 10.100 / 10.450 ms | 3.550 / 4.030 ms |
| Pixiv Light first hit after import / after restart | 8.780 / 8.885 ms | 2.830 / 3.420 ms |
| Jitendex steady hit p50 after import / after restart | 2.345 / 2.327 ms | 2.000 / 2.070 ms |
| Pixiv Light steady hit p50 after import / after restart | 1.872 / 1.933 ms | 1.720 / 1.790 ms |

Durable OPFS bytes are unchanged (99,440,781 and 154,655,950). Restart is not
a target of these changes: its cost is Chrome and extension startup (about
0.8 s for the six-term fixture) plus the dictionary load, and the three-sample
restart spreads of the two runs overlap (0.94–1.04 s against 0.97–1.04 s for
Jitendex). An earlier run of the first three changes alone measured 1.227 s and
1.673 s for the two imports; the import medians move by about the same amount
between runs.

Under Electron 42.3.2 (Chromium 148, the GameSentenceMiner host) the base
commit ran the single-thread IDBFS fallback: shared memory and workers are
available, but `createSyncAccessHandle` is refused for `chrome-extension://`
origins. Its Jitendex import took 3.9–4.2 s, 3.3 s of it in the single-threaded
native importer and 0.35 s in the IDBFS `syncfs`. A third runtime variant,
`hoshidicts-threaded-idbfs` (pthreads on the classic FS with IDBFS, run by
`engine-worker-idbfs.js`), is now selected when the OPFS probe fails on an
isolated origin. Measured with the same Electron harness, two runs each:

| Metric (Electron, Jitendex) | Base (single-thread, local) | Threaded IDBFS worker |
| --- | ---: | ---: |
| Import message wall | 3.99 / 4.15 s | 1.66 / 1.58 s |
| First hit after import / after restart | 10.3 / 10.2 ms | 2.9–3.2 / 3.0–3.5 ms |
| Steady hit p50 after import / after restart | 2.12 / 1.71 ms | 2.26–2.10 / 1.97–2.17 ms |
| App ready to engine ready after restart | 442 / 444 ms | 493 / 477 ms |

The worker hop and the eager pthread pool cost about 0.2 ms per lookup and
40 ms at startup against the base's in-document engine; the import no longer
blocks the offscreen document's thread, which also hosts pronunciation and Anki
work.

## Incremental dictionary reorder, disable, and enable

Loading a package copies its files out of OPFS into the wasm heap: `blobs.bin`
alone is 80 MB for Jitendex and 128 MB for Pixiv Light, and the copy runs at
about 1.3 GB/s, so one package costs 100–150 ms (65% of it the blob copy, the
rest the hash table, bloom filter, and zstd dictionary). Until now every
dictionary change in Settings, including a drag to reorder, went through
`hdw_reset` and re-added every package, so two dictionaries cost about 250 ms
per change and every disabled package was probe-loaded again on top.

Hoshidicts now exposes `remove_dict` and `set_dict_order` (`hdw_remove_dict`
and `hdw_set_dict_order` in the wasm ABI), and `engine-service.js` keeps a
record of which packages loaded this session. A change whose packages all
loaded before is applied in place: packages that leave the enabled set are
removed, packages that rejoin it are added alone, and the engine order is set to
the new list. Anything else (a first load, an import, a package that never
loaded, a rejected in-place step) falls back to the full rebuild, whose
`hdw_reset` also discards anything a partial step left behind. Package paths
are generation-scoped and immutable once loaded, which is what makes "loaded
once this session" a safe proxy for "loads now".

Measured with Jitendex and Pixiv Light loaded (`hd_apply_state` wall from a
settings page, five samples each):

| Change | Before | After |
| --- | ---: | ---: |
| Reorder two dictionaries | 256 ms | 6 ms |
| Disable one dictionary | 240 ms | 8 ms |
| Re-enable one dictionary | 240 ms | 146 ms (only that package is copied) |
| Reorder with one dictionary disabled | 246 ms | 4 ms |
| Restart to ready with one disabled | 1182 ms | 1147 ms (unchanged: nothing is verified yet) |

## Importer: one glossary buffer per bank

A CPU profile of the import workers (Jitendex, `--profiling-funcs` build,
Chrome's sampling profiler attached to every pthread) put the work at roughly
1.5 s of JSON parsing, 1.45 s of zstd, 0.3 s of inflate and 0.17 s of malloc
and free across the eight workers, with the writer thread spending 80 ms
deduplicating glossaries and copying them into a per-bank buffer. The
allocator and copy costs came from keeping one heap vector per distinct
glossary (350k for Jitendex, 650k for Pixiv Light). Workers now compress
straight into one per-bank blob and record spans; the writer emits the blob
with one write per run between glossaries an earlier bank already wrote. The
files produced are byte-identical.

| Import (settings upload to "Finished", 3 runs) | Before | After |
| --- | ---: | ---: |
| Jitendex | 1222–1253 ms | 1138–1162 ms |
| Pixiv Light | 1445–1614 ms | 1247–1281 ms |

The native `hdw_import` alone in node: Jitendex 844 → 746 ms, Pixiv Light
961 → 829 ms (medians of three).

## Runtime build: wasm SIMD and link-time optimisation

Every supported host (Chrome ≥ 128, Electron, Node) runs wasm SIMD, so the
runtimes are now compiled with `-msimd128` and linked with `-flto`. Output
files are byte-identical; the compiler vectorises the parsers and inlines
across the engine, zstd, glaze, and libdeflate. xxHash stays scalar because its
wasm SIMD path goes through the SIMDe `arm_neon.h` shim, which pulls C++
headers inside an `extern "C"` block and does not compile.

| Measurement | Before | After |
| --- | ---: | ---: |
| Native `hdw_lookup` in node, p50 (食べました / 走り出した / 美しい景色 / 日本語を勉強しています) | 186 / 222 / 59 / 279 µs | 155 / 158 / 50 / 254 µs |
| Native `hdw_import` in node, Jitendex / Pixiv Light | 769 / 802 ms | 731 / 764 ms |
| Import from the settings page, Jitendex / Pixiv Light (median of 3) | 1187 / 1348 ms | 1127 / 1314 ms |
| End-to-end hover lookup (Jitendex hit, median) | 2.0 ms | 2.0 ms (transport-bound) |

The threaded runtime shrinks by 4 KB. Builds stay byte-reproducible.

## Importer: no UTF-8 re-validation of bank strings

The bank parsers capture every string raw (`raw_string`, `raw_json_view`) and
copy it through unchanged, yet glaze's default `validate_utf8` re-walked every
skipped string. Turning it off for the bank parsers (not `index.json`) leaves
the produced files byte-identical and removes 12–18% of a Jitendex import.

| Import (settings upload to "Finished", 3 runs) | Before | After |
| --- | ---: | ---: |
| Jitendex | 1070–1254 ms (median 1110) | 962–996 ms (median 973) |
| Pixiv Light | 1163–1615 ms (median 1331) | 1097–1146 ms (median 1116) |

Native `hdw_import` in node: Jitendex 667 → 544 ms, Pixiv Light 652 → 618 ms.
One behaviour change, for corrupt input only: a bank containing malformed UTF-8
used to fail the whole import ("empty dictionary" when it was the only bank);
it now imports with the bytes as they are, and renderers show U+FFFD for them,
which is what Yomitan does.

## Importer: trainer threads and the default FSE table

Two engine changes (hoshidicts #8 and #9), both leaving every produced data file
byte-identical for nine dictionaries (the fixture, Jitendex, Pixiv Light, JMdict,
JMnedict, KANJIDIC, JPDB and BCCWJ frequency, Kanjium pitch):

- The zstd dictionary trainer tries five values of k; each trial walks a 4 MiB
  frequency table and is memory-bound, so five trials at once were slower than
  three in two rounds. Jitendex training wall on 16 cores: 8 threads 133 ms,
  3 threads 96 ms. The trainer is now capped at three threads.
- zstd's `set_basic` path (blocks with one or two sequences, i.e. short
  glossaries) rebuilt the format-defined default FSE table on every block. For
  JMnedict that was 360 ms of CPU, the largest item in its import profile. The
  table is now built once (`third_party/hoshidicts/src/zstd`, which replaces one
  upstream translation unit).

| Import (settings upload to "Finished", medians of 3) | Before | After |
| --- | ---: | ---: |
| Jitendex | 1104 ms | 971 ms |
| Pixiv Light | 1216 ms | 1145 ms |
| JMdict (English) | 802 ms | 707 ms |
| JMnedict | 616 ms | 581 ms |
| BCCWJ frequency | 948 ms | 894 ms |
| JPDB frequency | 497 ms | 469 ms |
| KANJIDIC, Kanjium pitch | unchanged | unchanged |

Node, four cores (`taskset -c 0-3`): JMnedict 606 → 540 ms, JMdict 629 → 594 ms,
Jitendex 974 → 821 ms.

## Dictionary loads through sync access handles

WasmFS's OPFS backend opens a read-only descriptor as a Blob: every read copies
the range into a JavaScript `ArrayBuffer` and then into the heap, with an async
round trip in between. A read-write descriptor uses a sync access handle whose
`read` lands straight in the heap. Loading a dictionary is one mmap copy of each
file, so the WasmFS runtime (hoshidicts `HOSHIDICTS_WASMFS`) now opens the files
read-write for the copy and closes the descriptor immediately afterwards; the
access handle and its lock exist only for the copy. The IDBFS and single-threaded
runtimes are unchanged (their wasm is byte-identical).

Everything that (re)loads dictionaries gets faster:

| Chrome | Before | After |
| --- | ---: | ---: |
| Restart to ready, five dictionaries (one disabled) | 1446 ms | 1173 ms |
| Reload after an import, seven installed | 446 ms | 237 ms |
| Reload after an import, five installed | 246 ms | 133 ms |
| Re-enable JMnedict | 153 ms | 74 ms |
| Import Jitendex with six others installed | 1062 ms | 880 ms |
| Import BCCWJ with six others installed | 980 ms | 797 ms |

The post-import reload is the phase that grows with the number of installed
dictionaries (the importer unloads everything to free the address space and
reloads it afterwards); with seven installed it was almost half of an import.

## Importer: SIMD glossary skip

Term glossaries are captured raw and make up most of a term bank's bytes. glaze
skipped them eight bytes at a time and dropped to a byte-and-switch loop at
every quote or bracket, which structured content hits every few bytes; that
skip was the largest item in the import profile (about 40% of a VNDB import
under native `perf`). hoshidicts now classifies 64 bytes per step (wasm simd128)
and only walks the structural bits of a block in which the matching bracket can
fall. Output is byte-identical for eleven dictionaries, and a differential test
against glaze's own skip runs in hoshidicts' ctest.

| | Before | After |
| --- | ---: | ---: |
| Chrome import Jitendex (medians of 3) | 878 ms | 798 ms |
| Chrome import Pixiv Light | 965 ms | 913 ms |
| Node, 16 cores: Jitendex / Pixiv Light / VNDB / full Pixiv | 571 / 627 / 3234 / 2310 ms | 436 / 553 / 2903 / 2156 ms |
| Node, four cores: Jitendex / Pixiv Light | 881 / 1084 ms | 717 / 891 ms |

Meta banks (frequency, pitch) go through the same skipper for their object
values (hoshidicts #12): node import JPDB 149 → 132 ms, Kanjium 49 → 42 ms,
BCCWJ 440 → 429 ms; output byte-identical.

## Electron: classic-FS file growth during imports

On the IDBFS runtime (Electron), the importer's output files live in the
classic Emscripten FS, whose `MEMFS` grows a file's JavaScript array by 12.5%
per write once it passes 1 MiB; streaming an 80 MB `blobs.bin` therefore copies
about nine times its size (`expandFileStorage` was 340 ms of a Jitendex import).
`engine-service.js` now doubles the capacity instead and trims the finished
files back to their exact size before `syncfs` (IDBFS stores each file as a view
of its array, and a structured clone of a view carries the whole backing buffer,
so trimming first also keeps the IndexedDB write at the real size).

Electron 42, `benchmark/electron.mjs`, imports with the previous dictionaries
still installed:

| Import | Before | After |
| --- | ---: | ---: |
| Jitendex | 1408 ms | 1206 ms |
| JMdict (English) | 1281 ms | 1130 ms |
| JMnedict | 1598 ms | 1398 ms |

Of the remainder, the IDBFS `syncfs` (IndexedDB write of the new files) is
320–890 ms and grows with the database; restart-to-ready with three dictionaries
is unchanged at about 4.2 s (3.5 s of it is an empty start). Chrome is unaffected
(OPFS runtime).

## Importer: one worker pool, tail phases in parallel

After the term-bank workers finished, the rest of an import ran on the calling
thread on Emscripten: meta and kanji banks, the offset radix sort (its eight
chunks executed serially), the hash table, the Bloom filter and the media
extraction. For VNDB (6.6M terms) that tail was 1.5 s of a 2.7 s import.
hoshidicts now runs the whole import on one worker pool created after training,
so those phases use the same threads the bank workers used (hoshidicts #13).
Output is byte-identical for ten dictionaries.

| Node import, 16 cores | Before | After |
| --- | ---: | ---: |
| Jitendex | 456 ms | 326 ms |
| Pixiv Light | 560 ms | 419 ms |
| VNDB | 2510 ms | 1811 ms |
| JMnedict | 329 ms | 224 ms |
| JPDB frequency / Kanjium pitch | 143 / 43 ms | 123 / 19 ms |

Chrome (settings upload to "Finished", single runs): JMnedict 650 → 583 ms, BCCWJ
782 → 728, JPDB 475 → 432, Pixiv Light 783 → 749. Electron: JMnedict 1398 → 1164.

## Clicked-kanji selected dictionary lookup

On 2026-09-09, a focused Chrome probe measured the production
`hd_lookup_dictionary` route used when a clicked kanji is configured to use a
term dictionary. The previous binding created a temporary native query for every
request, reopening the selected term dictionary plus every frequency and pitch
dictionary even though the engine had already loaded them.

The comparison used:

- Hachidori baseline `b0a0fa6` with Hoshidicts `6859c32`;
- baseline extension tree SHA-256
  `99cb4ae3b7d07d148c2b7fbb9a20bc39e75674da7810b8be77cc80498dd08826`
  and optimized extension tree SHA-256
  `1f0aeecf405ac82583921b6c58b9bc30f8c99fb01ca9face12d978b7f5636d98`;
- Bee's Ultimate Kanji Dictionary revision `2026.08.19.1`, 11,782,705 bytes,
  SHA-256 `f96fbead89f86a584298f710d71f49eccec623b54f1c73a00501a87567e93f09`;
- Chrome 152.0.7977.75 on a 16-vCPU Intel Xeon Platinum 8488C host;
- three fresh profiles, each importing through Settings, measuring after ready,
  then closing Chrome completely and measuring again from the retained OPFS
  profile;
- twelve common kanji over three measured passes per profile, giving 108
  selected-dictionary requests per phase. Ordinary `hd_lookup` requests were
  interleaved as a loaded-query control.

The reproducible command was:

```bash
HACHIDORI_KANJI_ARCHIVE=/absolute/path/to/bees-ultimate-kanji-dictionary.zip \
HACHIDORI_KANJI_QUIET=1 node benchmark/kanji-click.mjs
```

| Phase | Metric | Reopen per request | Reuse loaded query | Reduction |
| --- | --- | ---: | ---: | ---: |
| Post-import | First selected request, median `[min–max]` | 178.570 `[169.730–187.800]` ms | 9.060 `[8.705–9.745]` ms | 94.9% |
| Post-import | Steady selected request, p50 / p95 | 140.560 / 160.810 ms | 2.030 / 2.695 ms | 98.6% / 98.3% |
| Post-restart | First selected request, median `[min–max]` | 181.650 `[178.445–182.420]` ms | 8.690 `[8.615–8.915]` ms | 95.2% |
| Post-restart | Steady selected request, p50 / p95 | 139.690 / 162.695 ms | 2.200 / 2.715 ms | 98.4% / 98.3% |

The optimized selected lookup is within about half a millisecond of the
interleaved ordinary lookup median. The clock covers
`chrome.runtime → service worker → offscreen document → engine worker → WASM`
and response serialization. It deliberately excludes hover delay, DOM click
dispatch, and popup rendering, so these are targeted backend timings rather
than complete pointer-to-paint latency.

## Implemented architecture

1. Compile Hoshidicts and the bindings with pthread support.
2. Run the threaded runtime in a dedicated module Worker owned by the offscreen document.
3. Use an eager strict pthread pool with up to eight importer workers and one WasmFS OPFS proxy worker.
4. Process term banks through a bounded worker group instead of creating one thread per bank.
5. Keep nested radix work, filesystem work, frequency banks, and kanji banks inline in the Emscripten pthread build so they cannot recursively exhaust the pool.
6. Mount direct OPFS through WasmFS and remove whole-filesystem `syncfs` from the primary path.
7. Stage replacement imports, move individual files because OPFS cannot rename directories, write the Hoshidicts marker last, flush completed files, and recover interrupted installs.
8. Keep a separate single-thread classic-FS/IDBFS bundle for compatibility.

Browsers with pthread and OPFS support use threaded Hoshidicts with direct OPFS. Browsers lacking either capability use the single-thread IDBFS runtime.

Hoshidicts remains responsible for archive import, index construction, memory mapping, dictionary loading, and lookup. OPFS and IDBFS are persistence layers only.

## Manabitan comparison

Manabitan does not use Hoshidicts. It uses SQLite WASM, an OPFS SAH-pool VFS, custom term-record and term-content files, and in-memory lookup indexes. Its behavior cannot be reproduced by substituting OPFS for IDBFS while retaining Hoshidicts.

## Deferred direction

For known dictionaries, client-side conversion could eventually be avoided by distributing immutable prebuilt Hoshidicts indexes. Each bundle must be bound to the source ZIP SHA-256, Hoshidicts revision, WASM build hash, and index/schema version. OPFS would remain the local durable store; IPFS could distribute bytes but would not replace local storage or Hoshidicts. This phase is not implemented.
