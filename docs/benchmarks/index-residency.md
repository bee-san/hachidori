# Hash index residency: main vs paged hash indexes

Measurements for [issue #496](https://github.com/bee-san/hachidori/issues/496)
and PR #497, paired with [hoshidicts #35](https://github.com/bee-san/hoshidicts/pull/35).
Every run compares unmodified `main` (`991c48cd`, all hash tables resident) with
this branch's resident control, 16, 32 and 64 MiB aggregate budgets and fully
paged hashes, on the same installed files. [Commands and measurement
boundaries](../../benchmark/README.md#hash-index-residency).

## Summary

For a 58-package library shaped like the reporter's, the default 32 MiB budget
(Automatic in Low memory mode) pages 21 packages' hash tables and:

- makes lookups **0.47 ms slower at the median (+24%)** and 0.65 ms slower at
  p95 (+16%) with the OS file cache warm, lowering throughput by 15%;
- makes the first lookups after an OS-cold start **9.6 ms slower at the median
  (+81%)** on a disk with 0.56 ms random reads;
- shrinks the WASM heap by **242.5 MiB after loading (−71%)** and **222.6 MiB at
  its peak (−65%)**, and the extension processes' RSS by about 220 MiB (−27%);
- starts 0.4 s faster (0.8 s OS-cold), leaves rendered hover popups and results
  unchanged, and keeps reimport within run-to-run noise.

Libraries whose hash tables fit the budget are unaffected. Recommendation: keep
budgeted hashes as the default only in Low memory mode, at 32 MiB
([details](#recommendation)).

## Setup

| Fixture | Packages | Hash tables | Corpus | Shape |
| --- | ---: | ---: | ---: | --- |
| Reporter-shaped (primary) | 58 | 249.3 MiB (60 KiB–26.6 MiB each) | 570 lookups, 441 distinct | Each package's resident index files are sized after the #496 inventory (275.8 MiB in total against the reporter's 263.5 MiB). Vocabularies are nested by rank; lookups sample ranks log-uniformly (Zipf) and include inflections and misses. |
| Uniform worst case | 58 | 252.9 MiB (4.4 MiB each) | 570 lookups | One 200,000-term dictionary under 58 titles: every hit is in every package. |
| Large index | 1 | 34.9 MiB | 570 lookups | 1.6 million terms: one index larger than the budget. |
| Small | 2 | 1.3 KiB | 28 lookups | Two tiny packages: nothing exceeds any budget. |

All fixtures are synthetic Japanese terms written by the production importer,
plus the existing term, frequency, pitch, kanji, inflection and PNG fixtures;
none is the reporter's private collection. Each sample installs the importer's
files into a fresh Chrome profile, restarts Chrome with Low memory mode and the
variant's policy, waits for the threaded OPFS engine, then times two passes of
the corpus (cold: first pass after the restart; warm: second pass) and 12 real
pointer hovers. It then disables and re-enables packages, restarts with half of
them disabled, reimports one package, waits for the idle worker replacement and
removes a package. Complete ordered results, kanji, a dictionary-selected lookup
and media matched in every sample of every variant. Variant order alternates
between repetitions, and every figure is the median across repetitions.

Lookup times are message round trips from an extension page to the engine and
back, including the WASM call and serialization but not rendering. Hovers
include rendering. The WASM heap never shrinks, so its size after both passes
is the peak. Extension RSS covers the extension's renderer processes (the
offscreen document with its engine worker, and the Settings page driving the
run), sampled every 100 ms from launch through the warm pass (peak) and right
after it (steady).

Environment: Intel Xeon Platinum 8488C, 16 vCPUs, 124 GiB RAM, Linux 6.12
(Amazon Linux 2023), Node 22.23.1, Chrome for Testing 152.0.7977.75 headless.
Both revisions' bundles were built with Emscripten 5.0.2. OS-warm profiles were
on tmpfs; OS-cold profiles on xfs on an EBS volume whose random 4 KiB reads take
0.56 ms (`O_DIRECT` p50).

## Results

### Reporter-shaped library, OS file cache warm (5 samples)

| Variant | Resident hashes | Packages paged | Cold p50 / p95 | Warm p50 / p95 | Warm lookups/s | Hover first / complete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 MiB | 0 | 2.05 / 4.37 ms | 1.94 / 4.03 ms | 463 | 27.8 / 53.2 ms |
| PR, resident | 249.3 MiB | 0 | 2.10 / 4.52 ms | 2.13 / 4.42 ms | 422 | 28.7 / 53.7 ms |
| PR, 16 MiB budget | 15.7 MiB | 28 | 2.72 / 5.13 ms | 2.65 / 5.03 ms | 364 | 28.0 / 52.9 ms |
| **PR, 32 MiB budget (default)** | 32.0 MiB | 21 | 2.54 / 5.03 ms | 2.41 / 4.68 ms | 395 | 29.2 / 52.8 ms |
| PR, 64 MiB budget | 60.2 MiB | 13 | 2.31 / 4.73 ms | 2.25 / 4.44 ms | 414 | 27.7 / 54.1 ms |
| PR, all paged | 0 | 58 | 3.00 / 5.42 ms | 2.89 / 5.10 ms | 353 | 28.6 / 53.3 ms |

| Variant | WASM heap after load / peak | Live allocations | Extension RSS peak / steady | Startup | Reimport |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 / 342.2 MiB | – | 821.1 / 821.1 MiB | 4,179 ms | 4,081 ms |
| PR, resident | 342.2 / 342.2 MiB | 318.9 MiB | 820.4 / 819.6 MiB | 3,868 ms | 4,214 ms |
| PR, 16 MiB budget | 69.2 / 99.7 MiB | 85.4 MiB | 589.0 / 585.9 MiB | 3,730 ms | 4,118 ms |
| **PR, 32 MiB budget (default)** | 99.7 / 119.6 MiB | 101.7 MiB | 602.8 / 599.5 MiB | 3,810 ms | 4,413 ms |
| PR, 64 MiB budget | 119.6 / 143.6 MiB | 129.8 MiB | 633.2 / 630.8 MiB | 3,700 ms | 4,106 ms |
| PR, all paged | 57.6 / 83.1 MiB | 69.7 MiB | 575.4 / 564.6 MiB | 3,464 ms | 4,078 ms |

Against main:

| Variant | Cold p50 | Warm p50 | Warm p95 | Warm throughput | WASM heap after load | WASM heap peak | Extension RSS peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.06 ms (+2.7%) | +0.19 ms (+9.5%) | +0.39 ms (+9.8%) | −8.8% | 0 | 0 | −0.7 MiB (−0.1%) |
| PR, 16 MiB budget | +0.67 ms (+32.7%) | +0.70 ms (+36.0%) | +1.00 ms (+24.9%) | −21.4% | −273.0 MiB (−79.8%) | −242.5 MiB (−70.9%) | −232.1 MiB (−28.3%) |
| **PR, 32 MiB budget (default)** | +0.49 ms (+23.9%) | +0.47 ms (+23.9%) | +0.65 ms (+16.1%) | −14.7% | −242.5 MiB (−70.9%) | −222.6 MiB (−65.0%) | −218.2 MiB (−26.6%) |
| PR, 64 MiB budget | +0.26 ms (+12.4%) | +0.31 ms (+15.7%) | +0.41 ms (+10.2%) | −10.4% | −222.6 MiB (−65.0%) | −198.6 MiB (−58.0%) | −187.8 MiB (−22.9%) |
| PR, all paged | +0.96 ms (+46.6%) | +0.94 ms (+48.6%) | +1.07 ms (+26.6%) | −23.7% | −284.6 MiB (−83.2%) | −259.1 MiB (−75.7%) | −245.7 MiB (−29.9%) |

The resident control is the noise floor: across all runs the branch's resident
hashes stayed within ±0.2 ms of main at the median. Paged hashes share the
existing 32 MiB page cache with entries, which main also reads from disk in Low
memory mode. The corpus's working set is larger than that cache, so the warm
pass rereads pages: at 32 MiB each 570-lookup pass makes about 7,800 index and
28,400 entry page reads (the resident control: about 26,600 entry reads), against
15,200 index reads when every hash is paged.

A repeat run of 3 samples agreed: the 32 MiB budget was 0.60 ms (+29%) slower
at the warm median, 64 MiB 0.43 ms (+21%) and all paged 0.94 ms (+46%), with
identical heap figures ([summary](../../benchmark/results/index-residency/reporter-warm-repeat/summary.md)).

### Reporter-shaped library, OS-cold (3 samples)

Before each measured launch the harness synced and evicted every file of the
seeded profile and temporary extension from the OS page cache; `fincore` found
0 bytes still cached in every sample. Startup and the first pass therefore read
from the disk, for main as well, whose Low memory mode pages entries.

| Variant | Startup | Cold p50 / p95 | Warm p50 / p95 | WASM heap peak | Cold p50 against main |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 5,562 ms | 11.77 / 58.06 ms | 1.86 / 3.96 ms | 342.2 MiB | – |
| PR, resident | 5,541 ms | 11.90 / 57.95 ms | 1.86 / 4.18 ms | 342.2 MiB | +0.13 ms (+1.1%) |
| PR, 16 MiB budget | 4,807 ms | 23.01 / 71.79 ms | 2.42 / 4.71 ms | 99.7 MiB | +11.24 ms (+95.4%) |
| **PR, 32 MiB budget (default)** | 4,719 ms | 21.34 / 69.36 ms | 2.43 / 4.72 ms | 119.6 MiB | +9.56 ms (+81.2%) |
| PR, 64 MiB budget | 5,187 ms | 18.63 / 64.52 ms | 2.16 / 4.40 ms | 143.6 MiB | +6.86 ms (+58.3%) |
| PR, all paged | 4,619 ms | 23.29 / 75.21 ms | 2.84 / 5.12 ms | 83.1 MiB | +11.52 ms (+97.8%) |

The cold p95 rose by 11.30 ms (+19.5%) at 32 MiB. Once read, the pages stay in
the OS cache: the warm pass was 0.57 ms (+31%) slower, as with a warm cache.

### Uniform worst case (3 samples, OS cache warm)

| Variant | Warm p50 / p95 | Against main (warm p50) | WASM heap after load / peak | Extension RSS peak |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 4.69 / 6.06 ms | – | 357.5 / 357.5 MiB | 812.0 MiB |
| PR, 16 MiB budget | 6.09 / 8.34 ms | +1.39 ms (+29.6%) | 69.2 / 99.7 MiB | 564.8 MiB |
| **PR, 32 MiB budget (default)** | 5.82 / 7.36 ms | +1.12 ms (+23.9%) | 83.1 / 119.6 MiB | 578.5 MiB |
| PR, 64 MiB budget | 5.63 / 6.93 ms | +0.94 ms (+19.9%) | 119.6 / 143.6 MiB | 626.5 MiB |
| PR, all paged | 6.12 / 8.38 ms | +1.42 ms (+30.2%) | 48.0 / 83.1 MiB | 552.6 MiB |

Every synthetic hit is present in all 58 packages, so each lookup probes paged
hashes far more often than in the reporter-shaped library. The relative cost is
similar; the absolute cost is about 2.4 times as high.

### Large index and small library (3 samples, OS cache warm)

The 35 MiB index exceeds the 16 and 32 MiB budgets and is paged under them:
warm p50 changes by −0.02 ms, the WASM heap falls from 62.5 to 23.1 MiB after
loading (27.8 MiB peak, −34.8 MiB, −56%) and extension RSS by 31 MiB. The 64 MiB
budget keeps it resident, like main. In the small library every budget keeps
both hashes resident, and those variants stayed within 0.16 ms of main at the
warm median (run-to-run noise on a 28-lookup pass); paging even these tiny
hashes cost 0.29 ms warm and 0.47 ms cold. Full tables:
[large index](../../benchmark/results/index-residency/large-index/summary.md),
[small](../../benchmark/results/index-residency/small/summary.md),
[uniform](../../benchmark/results/index-residency/uniform/summary.md).

### Engine alone (native C++, 3 samples)

The pinned engine's `benchmark-lookup` times `Lookup.lookup` without WASM,
messaging or serialization, for resident against fully paged hashes:

| Library | Resident warm p50 / p95 | Paged warm p50 / p95 | Warm p50 change | Throughput |
| --- | ---: | ---: | ---: | ---: |
| Reporter-shaped | 0.19 / 0.43 ms | 0.31 / 0.57 ms | +0.13 ms (+69%) | −30% |
| Uniform | 0.49 / 0.63 ms | 0.66 / 0.88 ms | +0.17 ms (+34%) | −29% |

### Import and index time

The importer and installed format are unchanged, so import and index build time
are too: the same native importer built every fixture once for all variants. The
in-extension reimport of one package (single-threaded in Low memory mode,
including loading the new generation) took 4.1–4.5 s in every variant and run.

## Recommendation

**Keep budgeted (paged) hash indexes as the default only where this branch puts
them: Automatic in Low memory mode on threaded OPFS, with the 32 MiB budget.**

- For a large library the budget removes two thirds of the engine heap
  (−223 MiB peak) for about half a millisecond per lookup with a warm OS cache.
  That does not show in rendered popups (about 28 ms first, 53 ms complete),
  and Low memory mode is the user's request to trade speed for memory.
- 16 MiB saves only 20 MiB more and costs more. Paging every hash saves 37 MiB
  more than 32 MiB but doubles the per-lookup cost; it remains the explicit
  **Read from disk** choice.
- Keep resident hashes outside Low memory mode for now: paging there would make
  every user with a large library pay about +24% per lookup and about +10 ms on
  the first lookups after a cold start. If the budget is extended later, 64 MiB
  suits that case better: it still removes 58% of the peak heap (against 65%) for
  about two thirds of the 32 MiB budget's per-lookup cost.

## Raw results and limits

[`benchmark/results/index-residency/`](../../benchmark/results/index-residency/)
keeps each run's gzip-compressed definition (source fingerprints, fixture
checksums, environment), raw samples, failed attempts and summary:
`reporter-warm`, `reporter-warm-repeat`, `reporter-os-cold`, `uniform`,
`large-index`, `small`, `native-reporter` and `native-uniform`. Hostnames and
home directories are redacted; nothing else is changed.
`node benchmark/index-residency-report.mjs benchmark/results/index-residency/*/`
recomputes every summary from them.

- The dictionaries are synthetic and sized after, not copied from, the reporter's
  collection; a real library's probe pattern differs.
- One host ran the benchmarks while other work used it; the resident control's
  ±0.2 ms spread is the resulting noise.
- OS-cold timings depend on the disk. A local NVMe SSD reads much faster than
  this EBS volume; a hard disk is much slower.
- RSS counts pages shared between processes once per process, and the Settings
  page that drives the run is part of the extension RSS for every variant.
- One sample of the repeat run stalled before the harness wrote its options
  through the service worker (it was a main sample) and was rerun in a fresh
  profile; `failures.jsonl` records it. The primary and OS-cold runs had none.

![Memory controls on the light palette](../assets/index-residency-memory-light.png)

![Memory controls on the dark palette](../assets/index-residency-memory-dark.png)
