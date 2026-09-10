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
