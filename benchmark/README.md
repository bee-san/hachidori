# Browser benchmark

This framework measures the production Chrome-extension path rather than the
Node/MEMFS smoke-test path.

Each sample uses a fresh Chrome profile and performs this sequence:

1. load the unpacked MV3 extension and wait for the offscreen WASM engine;
2. import a ZIP through the real `settings.html` file input and `hd_import`
   runtime message;
3. verify the import report, persisted dictionary records, ready state, and
   lookup expectations;
4. time sequential lookup round trips through
   `chrome.runtime -> service worker -> offscreen document -> WASM`;
5. close Chrome, retain the profile, relaunch it, and wait for direct OPFS
   restoration plus engine readiness;
6. repeat the lookup checks and require identical correctness signatures;
7. optionally wait until Chrome actually terminates the idle service worker,
   then measure a cold routed status request and require the same offscreen CDP
   target identity, engine generation, and lookup signature.

The harness writes each completed attempt to `raw.jsonl` with `fsync` before
starting the next sample. Interrupted matrices can therefore resume without
silently losing work; invalid attempts remain auditable and are retried under a
new attempt number.

## What the metrics mean

- **Import to first valid lookup:** starts immediately before Puppeteer selects
  the file and ends after the import report, persisted dictionary rows, ready
  status, and first expected-hit lookup are all validated. This is the primary
  import metric and includes ZIP processing, generated-file persistence,
  dictionary metadata commit, and engine reload.
- **Import UI wall time:** the settings-page clock from file selection until its
  successful state is rendered after the `hd_import` response.
- **Import message wall time:** the narrower `chrome.runtime.sendMessage`
  duration captured by a settings-page probe. It excludes file-input dispatch
  and final UI rendering but keeps the complete durable import operation.
- **First lookup once ready:** one correctness-checked `hd_lookup` round trip
  issued immediately after the complete ready predicate. It is retained
  separately after import and after the full Chrome restart.
- **Usable to steady lookup:** measured request/response latency after one
  excluded lookup warmup pass, with hit, miss, overall, and throughput
  distributions kept separately for post-import and post-restart state.
- **Full Chrome restart to first valid lookup:** closes the first Chrome process,
  waits for it to exit, starts a fresh Chrome process on the retained profile,
  restores direct OPFS state, waits for engine readiness, and validates the first
  expected-hit lookup. It never re-imports the source ZIP.
- **Full Chrome restart to ready:** the narrower fresh-process-launch to
  `hd_status` ready barrier.

Import boundaries use one settings-page `performance.now()` clock from the
pre-upload reset through first-hit completion. Restart boundaries use Node's
monotonic `performance.now()` from immediately before launch through receipt
and correctness analysis of the first hit; the two clocks are not mixed within
either metric.

- **Peak RSS:** sampled Linux RSS summed over the Chrome browser process and
  descendants during import, and over newly launched Chrome descendants from
  immediately before restart launch through the restored first hit. This is a
  process-tree measurement, not only the WASM heap. Shared pages can therefore
  be counted in more than one process.
- **Process-tree CPU:** Linux `/proc` user-plus-system CPU ticks retained across
  discovered Chrome descendants, including children that are later reparented.
- **Durable OPFS state:** browser-reported origin usage plus every OPFS file's
  path, logical length, and SHA-256 before and after a successful restart.

The lookup benchmark intentionally excludes web-page scanning, the configured
hover delay, and popup rendering. It measures the extension's backend lookup
path without injecting benchmark code into the engine.

## Linked-browser relay latency

The existing two-browser Sharing suite can record healthy linked-browser lookup
latency using its real imported fixture and host WASM engine. It reuses the six
queries in `fixture.json`, excludes ten warmup passes, and records fifty measured
passes (300 requests). Every reply is checked for the expected hit/miss and
stable results. Timing uses the linked page's clock around `chrome.runtime` and
includes both workers, the Python relay and the host engine; it excludes setup,
hover delay, popup rendering and CDP evaluation overhead.

```sh
HACHIDORI_RELAY_SERVER=/path/to/baseline/extension/anki-relay/server.py \
HACHIDORI_SHARING_BENCHMARK="$PWD/benchmark/results/relay-before-1.json" \
  npm --prefix test/tooling run test:sharing
HACHIDORI_SHARING_BENCHMARK="$PWD/benchmark/results/relay-after-1.json" \
  npm --prefix test/tooling run test:sharing
```

Use the same Python and pinned browser/tooling for both runs. Repeat at least
three pairs in alternating order; each run starts fresh profiles. The JSON keeps
every timing, per-query summaries, reply sizes, result signatures, the relay and
fixture/WASM hashes, extension commit and environment. Each output filename must
be new. The relay override changes only the Python source launched by the test,
allowing a comparison against another checkout with identical browser code.

## Clicked-kanji selected dictionary lookup

`kanji-click.mjs` isolates the production `hd_lookup_dictionary` route used
after clicking a kanji when a term dictionary is selected. It pins Bee's
Ultimate Kanji Dictionary by byte length and SHA-256, uses three fresh profiles
by default, measures both immediately after import and after a complete Chrome
restart, and interleaves ordinary `hd_lookup` controls. Every selected reply
must be semantically identical to the ordinary reply for the same character.

```bash
export HACHIDORI_KANJI_ARCHIVE=/absolute/path/to/bees-ultimate-kanji-dictionary.zip
HACHIDORI_KANJI_QUIET=1 node benchmark/kanji-click.mjs
```

Override the repeated work with `HACHIDORI_KANJI_SAMPLES` and
`HACHIDORI_KANJI_PASSES`. Set `HACHIDORI_BENCH_REPO` to benchmark another
Hachidori checkout with the same harness during an A/B comparison. The result
includes exact revisions, an extension-tree hash, archive and Chrome identities,
host details, first-request timings, and steady p50/p95 timings. Like the
general lookup benchmark, it deliberately excludes hover delay, click dispatch,
and popup rendering.

## Tiny deterministic acceptance run

Generate the existing test fixture, then run one fresh-profile sample:

```bash
node test/make-fixture.mjs
node benchmark/run.mjs \
  --config benchmark/fixture.json \
  --output benchmark/results/fixture
```

The fixture config checks exact import counts, five positive/normalization
lookups, one miss, restart durability, and stable response signatures.

Run framework unit tests separately:

```bash
node --test benchmark/*.test.mjs
```

The live descendant RSS/CPU integration check requires Linux `/proc` and is
explicitly skipped on other platforms. Its Linux assertions remain unchanged;
the other framework tests, including the current-account Chrome cache fixture,
also run on macOS. This does not add non-Linux process metrics to the runner.

## Standard Jitendex + Pixiv Light matrix

The checked-in `jitendex-pixiv-light.json` suite runs Jitendex and Pixiv Light as
separate fresh-profile import cells in balanced order. It pins archive hashes,
exact import counts, corpus-specific positive lookups, one negative lookup, one
excluded sample warmup, five measured samples per corpus, and five steady lookup
passes after both import and restart. Every sample starts and fully stops two
Chrome processes: one for import and one for the retained-profile restart.

Place the two pinned archives in one directory and run:

```bash
export HACHIDORI_BENCH_DATA=/absolute/path/to/archives
node benchmark/run.mjs \
  --config benchmark/jitendex-pixiv-light.json \
  --output benchmark/results/jitendex-pixiv-light
```

Required filenames and SHA-256 hashes:

- `jitendex-yomitan-2026.08.11.0.zip` — `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`
- `PixivLight_2026-08-16.zip` — `50049358e0045c7e97b2916e0eaece7e2ae2ffe89b527ddacbda7641842d6f05`

The report gives separate import-to-first-valid-lookup, full-browser-restart,
first-ready lookup, and steady usable-to-lookup distributions for each corpus.

## Hachidori + Yomitan + JL comparison

`comparison.json` runs the three engines through one fail-closed contract. Every
engine/corpus cell gets a fresh profile or database, one excluded outer warmup,
ten measured imports, one excluded lookup warmup per import, and five measured
lookup passes. A deterministic rotating schedule changes cell position on every
round while running one cell at a time to avoid cross-engine contention.

The adapters use production code paths:

- Hachidori imports through its settings file input and looks up through
  `chrome.runtime`, the MV3 service worker, the offscreen document, and the
  pthread Wasm/OPFS engine;
- Yomitan 26.7.29.0 imports through its settings file input and looks up through
  the extension backend's `termsFind` action;
- JL 4.3.0 builds the pinned `JL.Core` source and calls
  `DictUtils.LoadDictionaries()` and `LookupUtils.LookupText()` with SQLite.

Provide the immutable fixtures, Yomitan release artifact, and clean JL checkout:

```bash
export HACHIDORI_BENCH_DATA=/absolute/path/to/dictionary-archives
export HACHIDORI_BENCH_DEPS=/absolute/path/to/benchmark-dependencies
export HACHIDORI_BENCH_JL=/absolute/path/to/JL-at-cfd64048e1ef1f90a9234cf10ce823d6854e4556

node benchmark/compare.mjs --dry-run
node benchmark/compare.mjs
```

The expected Yomitan artifact is
`$HACHIDORI_BENCH_DEPS/yomitan-26.7.29.0/yomitan-chrome.zip` with SHA-256
`457894937a27947f99a4b474a60e3a3804ec1a2a5105f43807d34f5eb6c90795`.
`--max-runs N` intentionally stops after `N` pending cells so adapter smoke runs
can be inspected and resumed. The same output directory resumes only when every
pinned executable, source tree, archive, config, and stable host identity still
matches its run definition.

The comparison output keeps per-run import timings, every measured per-query
latency and semantic response hash, engine-specific production-path evidence,
input identities before and after every cell, the exact schedule, validation
verdict, summary, CSV, report, and a checksum manifest.

## Custom real-corpus configuration

Create a JSON file outside the repository or below the ignored
`benchmark/results/` directory:

```json
{
  "corpora": [
    {
      "id": "jitendex",
      "archive": "/absolute/path/jitendex.zip",
      "expectedSha256": "optional-64-character-lowercase-sha256",
      "expectedReport": {
        "termCount": 435448
      },
      "expectedDictionaryCount": 1
    },
    {
      "id": "pixiv-light",
      "archive": "/absolute/path/PixivLight.zip",
      "expectedSha256": "optional-64-character-lowercase-sha256",
      "expectedReport": {
        "termCount": 710819
      },
      "expectedFailureIncludes": "optional pinned substring for a known production-path failure"
    }
  ],
  "queries": [
    {
      "id": "common-hit",
      "text": "食べる",
      "expectByCorpus": {
        "jitendex": "hit",
        "pixiv-light": "any"
      },
      "expectedExpressionByCorpus": {
        "jitendex": "食べる"
      }
    },
    {
      "id": "negative",
      "text": "🫠🫨🪼",
      "expect": "miss"
    }
  ],
  "warmups": 1,
  "samples": 5,
  "lookupPasses": 5,
  "idleCheckMs": 35000,
  "seed": 20260902,
  "timeoutMs": 600000,
  "headless": true,
  "keepProfiles": false,
  "allowNoSandbox": false,
  "lookup": {
    "maxResults": 32,
    "scanLength": 32,
    "options": {
      "frequencyDictionary": "",
      "frequencyOrder": "auto",
      "primaryReading": ""
    }
  }
}
```

Run it with:

```bash
node benchmark/run.mjs \
  --config benchmark/results/real-config.json \
  --output benchmark/results/real-$(date -u +%Y%m%dT%H%M%SZ)
```

The seed hashes corpus IDs into one deterministic base permutation. Each
warmup/measured round rotates that order, so every corpus runs once per round
and positions are balanced over complete rotation cycles. Query fixtures are
hash-ordered within hit/miss buckets and then interleaved, giving deterministic
mixed traffic rather than one large hit block followed by one miss block.

CLI overrides are useful for a quick pilot without editing the pinned config:

```bash
node benchmark/run.mjs \
  --config benchmark/results/real-config.json \
  --output benchmark/results/pilot \
  --warmups 1 --samples 3 --lookup-passes 3 --idle-check-ms 0
```

Use `--dry-run` to validate paths, create and verify read-only content-addressed
corpus snapshots, hash every executable input, pin the stable host identity, and
write the schedule without launching Chrome.

## Query expectations

Each query requires a unique `id` and non-empty `text`.

- `"expect": "hit"` requires at least one result.
- `"expect": "miss"` requires zero results.
- `"expect": "any"` records the outcome without constraining it.
- `expectByCorpus` overrides `expect` for named corpora.
- `expectedExpression` requires a returned result expression.
- `expectedExpressionByCorpus` applies that check selectively.

Every semantic response body is canonicalized without timing, request ID, or
engine generation metadata, retained in a content-addressed response-evidence
registry, and hashed. Validators recompute each body hash and byte count from
that registry before recomputing the ordered pass signature. The runner refuses
to report performance if a semantic signature changes between passes, samples,
or the browser restart.

For a production workload that deterministically cannot reach import (for
example, a browser message-size ceiling), `expectedFailureIncludes` can pin the
known failure. It is accepted only when a valid extension `hd_import_result`
reports failure during the import phase, its error contains that substring, and
Chrome shutdown is verified; a success, unverified cleanup, harness error,
lookup/restart/lifecycle error, or different import failure invalidates the
matrix. The report lists the workload as unsupported
and emits no invented performance metrics.

For representative lookup data, include a deterministic mixture of:

- common exact hits;
- long/short terms and kana/kanji forms;
- deinflection and normalization cases;
- corpus-specific hits;
- validated misses.

Do not compare two runs whose query fixture, archive hash, import report, or
correctness signatures differ.

## Outputs

A successful run directory contains:

- `run-definition.json` — normalized config, source paths, pinned corpus snapshot
  hashes/sizes, exact live extension, benchmark, and Hoshidicts content hashes,
  Chrome/Node executable hashes, Puppeteer package-tree hash, paths/versions,
  and stable host identity;
- `inputs/<sha256>.zip` — the exact read-only, content-addressed archive supplied
  to Chrome; its checksum is included in `SHA256SUMS`;
- `schedule.json` — deterministic warmup/measured execution order;
- `raw.jsonl` — a durable append-only attempt log with explicit attempt numbers,
  including the complete import response envelope, exact request string code
  points, per-query latency, retained response bodies and recomputable
  correctness hashes, monotonic timing endpoints for every headline wall metric,
  before/after archive identities, and verified-shutdown evidence;
- `summary.json` — measured distributions, including p25/median/p75/p95 and
  every underlying sample;
- `results.csv` — tidy metric rows for plotting/regression tooling;
- `report.md` — human-readable medians, ranges, p95 lookup latency, and method;
- `validation.json` — explicit correctness/completeness verdict;
- `SHA256SUMS` — integrity hashes for every report artifact;
- `runs/<run-id>-attempt-<n>/diagnostics.log` — Chrome/extension console diagnostics.

Successful temporary Chrome profiles are scheduled for best-effort removal only
after their success row is durably appended. A post-persistence cleanup failure
is warned without appending a contradictory second attempt, and the row records
that cleanup policy rather than claiming deletion succeeded. Failed and
expected-failure runs retain their profiles for diagnosis. Set `keepProfiles`
to `true` or pass `--keep-profiles` when every browser state is intended as an
artifact.

Reusing an output directory resumes validated sample IDs. Each retry gets a new
explicit attempt number; invalid attempts remain in `raw.jsonl` but do not poison
the run or masquerade as completion. Resume is rejected if the normalized
config, pinned corpus snapshot bytes, stable host identity, or any executable
content hash differs. Incomplete resumes compare the existing definition and
current source-archive identity before creating any new snapshot. An exclusive
lock prevents concurrent writers; an unterminated final JSONL record is
discarded and rerun, while malformed complete records—including
blank records and invalid UTF-8—fail closed. Before a completed no-op resume can
mutate any prepared artifact, it verifies the exact, duplicate-free checksum
manifest and every generated artifact. It neither recreates snapshots nor
rewrites completion provenance.

## Interpreting results

One warmup plus three measured fresh processes is a noisy pilot. Use at least
one warmup plus ten measured samples for a decision-grade run, and keep the
machine otherwise idle. Lookup request percentiles pool request observations
across passes and browser samples; their `n` is not the independent process
sample count shown for import/restoration. The report records load averages and
Linux CPU, memory, and I/O pressure at both ends so noisy runs remain auditable.
Process RSS/CPU sampling is every 50 ms, so a descendant that both starts and
exits between samples can be missed. CPU is reported in Linux clock ticks and
`run-definition.json` records ticks per second.

The hard lifecycle invariant is independent of speed:

> Service-worker idling must retain the exact offscreen CDP target identity,
> engine generation, and lookup correctness signature.

Absolute timings are only comparable on the same pinned runtime, host class,
corpus, query fixture, and correctness boundary.

## Runtime overrides

The defaults match `test/chrome-e2e.mjs`. Override them when necessary:

```bash
HACHIDORI_CHROME=/path/to/chrome \
HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
node benchmark/run.mjs --config config.json --output output-dir
```

Chrome's sandbox remains enabled by default. `allowNoSandbox: true` or
`--allow-no-sandbox` is an explicit trusted-input-only escape hatch for hosts
where sandboxed Chrome cannot start; do not use it for untrusted archives.


## Anki maturity refresh contention

The focused [maturity cache diagnostic](../docs/anki-maturity-cache-benchmark.md#dedicated-worker-regression-check)
compares two unpacked extension revisions with an identical 138 MB synthetic
Anki response, production scheduled refreshes and concurrent maturity requests.
It uses the existing external Chrome/Puppeteer installation and never contacts
the user's Anki collection. Run its dedicated driver as documented there; the
dictionary-import benchmark above measures a different production path.
