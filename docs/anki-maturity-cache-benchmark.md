# Anki maturity cache: production benchmark

The cache reduced steady decision latency from **74.25 ms to 0.99 ms median**
on this collection, with zero Anki requests per cached lookup. A full refresh
still has a cost: the largest decision delay during a pull was **1.31 seconds**,
compared with 139 ms on the unchanged live path. This measures the implemented
production handlers, including their timer and persisted cache.

## Inputs and environment

- Baseline: `10e6f0951192dab6de31facc8579f03ef7fdd589`.
- Cache implementation: `2ed10b092813f512796022828924fac4295db781`.
- Measured cache extension content SHA-256:
  `35ed1b83482d2a33d8f4d978a2985b36202c76eace738d071e0f31718753da31`.
- One excluded warmup plus **ten measured fresh Chromium processes per approach**,
  alternating approach order. Each measured browser ran 180 maturity decisions;
  there are 1,800 measured decisions per approach, not 1,800 independent browsers.
- Preserved isolated collection: 13,962 cards; 9,818 Kiku cards; 6,104 mature Kiku
  cards/notes. The maturity scope was Kiku, plain `Expression`, all decks,
  review interval >=21 days, excluding relearning. No notes or cards were changed.
- Fixed workload: 40 mature expressions, 40 immature expressions, 40 verified
  misses, then 20 repeats from each category, mixed in a fixed order. Private
  query JSON SHA-256: `91b843e489d81e070354b7f4b68c8426551d2b2b97be3846050b6a135d8d77da`.
- Anki 26.05; AnkiConnect source matches the preserved benchmark addon (source
  manifest SHA-256 `5f22a3e1c0392a685c47402fff484bac20d8e3fb1993b99279a7516ded7de23a`). Its isolated
  loopback configuration is described below; source-file and actual isolated
  addon hashes are retained in local raw metadata.
- Chromium 150.0.7871.186 Arch Linux; Node v26.4.0; Puppeteer Core 25.10.0;
  Intel(R) Core(TM) Ultra 7 165U, 14 logical CPUs,
  62.2 GiB RAM; linux
  7.1.5-1-cachyos. Anki used offscreen Qt/software OpenGL.
- Measured one-minute host load ranged 1.76–6.02.
  CPU/memory/I/O pressure was recorded at each cell boundary. These are
  host-specific observations under changing load, not an idle-machine baseline.

## Results

| Production decision path | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| Live `hd_anki_maturity` | 74.25 | 107.78 | 139.11 |
| Cached `hd_anki_maturity` | 0.99 | 3.19 | 13.57 |
| Cached throughout a scheduled refresh | 2.58 | 13.05 | 1,312.68 |
| Cached, steady pass after worker restart | 1.21 | 3.41 | 29.52 |

All live/cache Boolean answers matched, including **1,866 requests
covering the complete scheduled refreshes**. Each initial and scheduled refresh
made exactly one `notesInfo({query})` call with the production 25-second timeout.
Every warm and overlapping cached decision made zero Anki requests. All refreshed
word-set signatures matched, and each stopped-worker restoration preserved the
stored snapshot and the full decision signature.

The first request that woke the stopped worker took median
45.30 ms, p95 173.20 ms.
Request instrumentation reattached after that first reply; the zero-call
restoration result covers the subsequent 180-query pass.

| Complete durable refresh | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| First enable | 2,959.70 | 4,054.10 | 4,054.10 |
| Scheduled alarm with concurrent decisions | 3,001.30 | 5,662.40 | 5,662.40 |

Each pull transferred **138,474,410 bytes locally**, returning all fields of
6,104 notes to retain **6,001 distinct expression values**. The complete cache
record occupied 71,396 JSON bytes. The single full pull
avoids repeated search traffic but does not reduce AnkiConnect's response fields.

| Refresh phase | Initial median ms | Concurrent-refresh median ms |
| --- | ---: | ---: |
| Request through response headers | 1,870.78 | 2,105.33 |
| Response body read and JSON parse | 982.30 | 828.50 |
| Word extraction/validation and commit-queue admission | 37.90 | 32.70 |
| Final snapshot storage write | 10.10 | 14.50 |

`Response.json()` begins after headers arrive, so its duration includes remaining
body transfer and JSON decoding. It is not a pure synchronous-parse CPU metric.
Each measured browser had one 322–1,313 ms decision delay during the body/JSON
phase. Post-parse extraction and storage were much smaller: their combined
concurrent-refresh median was 49.90 ms. The results establish faster steady
checks, while exposing the periodic scheduling delay from the large response.

| Round | Live mean ms | Cache mean ms | Initial refresh ms | Concurrent refresh ms | Concurrent decision max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 55.77 | 0.91 | 2,307.10 | 2,158.40 | 428.30 |
| 2 | 57.71 | 0.68 | 2,016.10 | 2,231.20 | 440.75 |
| 3 | 60.67 | 0.59 | 2,116.20 | 2,170.20 | 379.98 |
| 4 | 79.17 | 3.09 | 4,054.10 | 5,662.40 | 1,312.68 |
| 5 | 82.48 | 2.01 | 3,599.60 | 5,061.60 | 1,066.05 |
| 6 | 83.23 | 0.95 | 3,032.30 | 3,505.20 | 862.72 |
| 7 | 78.14 | 0.99 | 3,272.10 | 3,569.30 | 642.93 |
| 8 | 82.26 | 1.69 | 2,959.70 | 3,001.30 | 488.65 |
| 9 | 84.82 | 1.78 | 4,037.50 | 4,546.60 | 1,095.96 |
| 10 | 82.49 | 0.60 | 2,757.00 | 1,945.80 | 321.86 |

The paired cumulative-wall break-even was median
36.85 decisions per refresh (range
33.67–53.29).
This divides each round's initial refresh cost by its live-minus-cache mean
latency. It is a descriptive wall-time heuristic, not CPU usage or total popup
time saved.

## Reproducing the measurement

The collection and Japanese query list are private and are not checked in. Use
your own isolated collection to reproduce the procedure; matching the original
content and exact timings requires that private snapshot. No benchmark listener,
replacement cache, altered request timeout, or alternate Anki gateway is used.

1. Prepare two worktrees at the revisions above. Use the committed extension
   bundles and the Chromium/Puppeteer setup in [the test guide](../test/README.md).
   Keep both source trees unchanged throughout the matrix.
2. Create a separate Anki base directory with one profile named `Benchmark`.
   Copy a collection with SQLite's read-only URI connection and `Connection.backup`
   into that profile, and copy the same AnkiConnect addon into that base's
   `addons21/2055492159`. Disable sync and automatic backups for the test profile.
   Configure the isolated addon to bind `127.0.0.1:8765`, with no API key and
   `webCorsOriginList: ["*"]`. Leave the ordinary Anki profile unchanged. Launch
   the test instance with a distinct `ANKI_SINGLE_INSTANCE_KEY` and
   `anki -b /path/to/test-base -p Benchmark`; confirm `getActiveProfile` returns
   `Benchmark` before issuing requests. Run the two approaches against this same
   isolated Anki process, whose database caches remain warm.
3. Select one configured note type and one field mapped to plain `{expression}`.
   This run used `Kiku` and `Expression`, across all decks. The source query is
   `"note:Kiku" is:review -is:learn prop:ivl>=21`. Prepare a fixed 180-row JSON
   workload containing 40 expressions with mature cards, 40 present expressions
   with no mature card, 40 verified absent expressions, and 20 repeats from each
   category. Give every row a distinct ID and keep exactly the same order for
   both approaches and every round. Retain a hash of the exact JSON and validate
   the live replies before accepting any performance results.
4. Run eleven rounds: one excluded warmup and ten measured rounds. Alternate
   `live, cached` and `cached, live` order. Each cell gets a new Chromium process
   and an empty browser profile, loading only its worktree's unpacked extension:
   `--disable-extensions-except=/path/to/extension` and
   `--load-extension=/path/to/extension`. This run used headless mode and
   `--disable-gpu`. Locate the `background.js` service-worker target, obtain its
   extension ID, and open `chrome-extension://ID/manifest.json` as the minimal
   runtime caller. Close startup/Settings tabs before configuration to avoid
   their Anki discovery traffic.
5. Obtain a complete normalized Anki configuration from the production worker's
   `HDReaderOptions.normaliseOptions` with the chosen model and expression field.
   Set it and `definitionBlurAnkiMature: true` through `hd_options_write` with
   target `hoshidicts-worker` and the current options `baseRevision`. The cached
   implementation must return cold maturity requests promptly and publish its
   initial snapshot using exactly one `notesInfo` request. Wait for the snapshot,
   then run six excluded decision warmups before the 180 measured requests.

The actual decision loop runs in the extension-origin page and times each
production runtime round trip:

```js
const rows = [];
for (const query of queries) {
  const started = performance.now();
  const reply = await chrome.runtime.sendMessage({
    target: "hachidori-anki",
    type: "hd_anki_maturity",
    request: { term: { expression: query.expression, reading: "" } },
  });
  rows.push({ id: query.id, ms: performance.now() - started,
    ok: reply.ok, mature: reply.mature });
}
```

6. Attach CDP `Network` events to the worker before enabling the feature.
   Count the actual `findCards`/`notesInfo` requests and retain request/response
   lengths, query, and timestamps. Wrap `Response.prototype.json` only to time
   its native implementation and count returned records; wrap the worker's
   `chrome.storage.local.set` only to time native cache-state writes. Neither
   wrapper changes data or control flow. Full durable refresh time spans the
   non-null attempt reservation write's start through the successful snapshot
   write's completion on one worker `performance.now()` clock. The first
   configuration-invalidation write is excluded. For the narrower fetch/parse
   breakdown, map CDP request wall time to the worker's `performance.timeOrigin`.
7. After the warm cached pass, accelerate one actual scheduled refresh using
   only the temporary browser's persisted attempt time, preserving the complete
   cache record and its configuration revision:

```js
const { ankiMaturityCache: cache } =
  await chrome.storage.local.get("ankiMaturityCache");
await chrome.storage.local.set({
  ankiMaturityCache: {
    ...cache,
    attempt: { ...cache.attempt, startedAt: Date.now() - 30 * 60 * 1000 - 1 },
  },
});
await chrome.alarms.create("hachidori-anki-maturity", { when: Date.now() });
```

   Install a storage-change listener before firing the alarm. Repeat the same
   real maturity requests, with a 10 ms pause between requests, until that
   listener observes a new snapshot `refreshedAt`. This covers the complete
   refresh, rather than stopping after a fixed interval. Require exactly one
   `notesInfo` request, zero per-lookup requests, identical Boolean answers, and
   the same sorted-word cache signature after publication.

8. With the fresh attempt timestamp retained, use CDP `ServiceWorker.enable`
   to identify the running worker version. Detach the direct worker debugger,
   call `ServiceWorker.stopWorker`, and verify its target disappears. Issue the
   first maturity message from the existing extension page to wake it and time
   that request. Attach instrumentation to the new worker, repeat the full
   180-query pass, and require identical replies, zero Anki requests during that
   pass, and byte-for-byte unchanged stored cache state.
9. Close Chromium and verify process exit before starting the next cell. Record
   host load and CPU/memory/I/O pressure at cell boundaries. Keep an append-only
   raw record for each completed cell, including every Boolean answer and
   duration, request count, cache signature, phase timings, and shutdown result.
   Reject source changes, failed replies, wrong traffic counts, partial refresh
   coverage, changed signatures, or missing worker/browser lifecycle evidence.
   Exclude the complete first round and compute nearest-rank percentiles from
   the ten measured rounds. Report request-level distributions separately from
   the number of independent browser samples. Stop only the isolated Anki
   instance after finishing.

The alarm is accelerated; the benchmark does not wait 30 minutes. Initial and
scheduled pulls happen close together in each fresh browser, so retained JSON
allocations and garbage collection can affect the second pull. Instrumentation
reattaches after the first waking reply, so the zero-request restoration claim
covers the subsequent full pass, not that first request. Popup rendering,
dictionary lookup, hover delay, and end-to-end visual latency are outside these
decision timings. The final in-memory Set installation follows durable storage
and is outside the narrow refresh metric; overlapping decision timings include
any delay it causes.
