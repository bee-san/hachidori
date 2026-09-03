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
