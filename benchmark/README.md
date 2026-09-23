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

## Hover popup and glyph hit testing

`hover-popup.mjs` drives real pointer movement through the content script and
records input-to-first-result and input-to-complete-result timings, cold and warm,
with result signatures and raw samples from three fresh Chrome profiles:

```sh
node benchmark/hover-popup-fixture.mjs /tmp/hover-fixture.zip
HACHIDORI_CHROME=/path/to/chrome HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
  node benchmark/hover-popup.mjs /tmp/hover-results /tmp/hover-fixture.zip
```

Use `HACHIDORI_HOVER_SAMPLES` to change the profile count. Each profile also times
1,000 production `resolveCandidate()` calls at a glyph, 1,000 at a point in
the tile's padding, 20 CSS pixels left of the text, and 1,000 at a word 600
characters into a 5,000-character paragraph held in one text node with no
sentence terminator, after 100 excluded warmups per point.
`session-*-hit-testing.json` records coordinates, duration and accepted
candidate counts, so a padding miss can be distinguished from a false lookup.
Its `sentenceCost` times the sentence extraction alone on that long-paragraph
candidate at extents from 50 to 800 characters, and on synthetic texts of
1,000 to 50,000 characters at the default extent, so its cost can be checked
to grow with the extent rather than the paragraph.
Those synchronous timings exclude pointer scheduling, messaging, engine lookup
and rendering; the normal hover timings include them. The three-entry fixture
isolates scanning and rendering overhead and does not represent a large library.
Its `deep-nesting-*` scans hover 深層, whose gloss sits under 40 nested
elements, alternating with the flat entries (`deep-nesting-flat-*`); compact
summaries are on, so those timings include the summary walkers.

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

## Overlay-local option saves

`overlay-options.mjs` compares the actual `hd_options_write` path from a linked
overlay. Each sample uses fresh host/overlay Chrome profiles, the existing
dictionary fixture and a packaged relay. It excludes ten warmup width edits,
times thirty alternating width edits on the page clock, counts host option
commits and verifies a real linked lookup. Passing two roots runs three
alternating samples of each:

```sh
HACHIDORI_CHROME=/path/to/chrome HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
HACHIDORI_ANKI_ADDON=/path/to/hachidori-relay.ankiaddon \
  node benchmark/overlay-options.mjs /path/to/baseline /path/to/changed
```

This measures request-to-acknowledgement latency with both browsers on the same
machine. Browser startup, import, link setup, Settings debounce/rendering and
final lookup verification are outside the timed boundary. The report records
the revisions, Chrome version, archive hashes, every sample and host-write count.

## Clicked-kanji selected dictionary lookup

`kanji-click.mjs` isolates the production `hd_lookup_dictionary` route used
after clicking a kanji when a term dictionary is selected. It pins Bee's
Ultimate Kanji Dictionary by byte length and SHA-256, uses three fresh profiles
by default, measures both immediately after import and after a complete Chrome
restart, and interleaves ordinary `hd_lookup` controls. Every selected reply
must be semantically identical to the ordinary reply's cards for Bee's for the
same character.

It also measures a clicked-kanji **group of three**: Bee's beside two in-memory
members from `test/make-fixture.mjs`'s `kanjiGroupFixture()`, one kanji-bank
dictionary and one more term dictionary, both answering every query character.
The three archives import as one Settings batch and the group is created
through the worker's dictionary CAS. `groupMs` times the content script's
fan-out for that group, one `hd_kanji` and two `hd_lookup_dictionary` requests
dispatched and awaited together on the page clock, and checks every member's
reply; `groupToSelectedMedianRatio` compares its median with the single
selected lookup. Like the single case, it excludes click dispatch and popup
rendering.

```bash
export HACHIDORI_KANJI_ARCHIVE=/absolute/path/to/bees-ultimate-kanji-dictionary.zip
HACHIDORI_KANJI_QUIET=1 node benchmark/kanji-click.mjs
```

Override the repeated work with `HACHIDORI_KANJI_SAMPLES` and
`HACHIDORI_KANJI_PASSES`. Set `HACHIDORI_BENCH_REPO` to benchmark another
Hachidori checkout with the same harness during an A/B comparison, and
`HACHIDORI_ALLOW_NO_SANDBOX=1` where sandboxed Chrome cannot start. The result
includes exact revisions, an extension-tree hash, archive, member fixture and
Chrome identities, host details, first-request timings, and steady p50/p95
timings. Like the general lookup benchmark, it deliberately excludes hover
delay, click dispatch, and popup rendering.

## Tiny deterministic acceptance run

### Dictionary reordering

`dictionary-reorder.mjs` imports six-term fixture clones with distinct titles
through the real Settings file input, growing each fresh profile to 10, 50 and
150 dictionaries. At each size it excludes two warmup moves and measures ten
arrow moves. Every saved order is checked against a real lookup's glossary
order. It uses the browser harness's launch arguments, verified shutdown and
durable `raw.jsonl` writer.

```sh
HACHIDORI_CHROME=/path/to/pinned/chrome HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
  node benchmark/dictionary-reorder.mjs --revision BASE_SHA --samples 3 \
  --output benchmark/results/reorder-before
HACHIDORI_CHROME=/path/to/pinned/chrome HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
  node benchmark/dictionary-reorder.mjs --revision HEAD_SHA --samples 3 \
  --expect-path order-only --output benchmark/results/reorder-after
```

Use fresh output directories and the same Node, Chrome and tooling. For paired
comparisons run one sample per command, alternating the two revisions at least
three times. `--revision` extracts only that committed extension into the output
directory; it does not switch branches or touch another checkout. Without it,
the current working extension is measured. `--counts`, `--moves`, `--samples`
and `--low-memory true` select the matrix. The definition records the revision,
extension hash, archive identities, runtime versions and host. Each size also
saves a Library screenshot on its first sample.

All timings use the Settings page clock: click to the changed DOM rank and
position, click to the engine acknowledgement, send to acknowledgement, and
click to the first successful lookup using the committed order. Click to
acknowledgement includes the 150 ms trailing debounce; send to acknowledgement
excludes it. Reply timings stop before subsequent Settings renders (including
group and option controls). The lookup metric includes any such work that delays
the lookup, but does not establish final UI settlement. The DOM metric excludes
paint and CDP overhead. The small fixtures
measure Settings/message/native-order overhead, not large-dictionary I/O or
import speed. Old revisions without `hd_status.lastLoadPath` record
`unreported-baseline`; the extension smoke suite's native-call spies establish
their reset/add/warm-lookup behaviour independently.

With `--low-memory true`, setup waits for the import's required worker recycle
before measuring. After each size's moves it waits beyond the two-second idle
window and checks the saved lookup order again. A separate `phase: "idle"` raw
row records whether the engine generation restarted; those waits are excluded
from move latency and must be reported separately. `--expect-path order-only`
also requires that no deferred worker rebuild occurs. The [issue #285 measurements](../docs/dictionary-reorder-benchmark.md)
record the settled baseline, paired results and timing limitations.

### Recommended installation

`recommended-install.mjs` measures Settings' recommended-install button through
download, native import, OPFS publication and the final progress message. It
serves the five catalogue URLs with deterministic fixtures (1 MiB of stored
media padding per archive), verifies one request per source, and checks the
persisted inventory and a real lookup. Pass baseline and changed checkout roots
to alternate three fresh-profile samples per revision:

```sh
HACHIDORI_CHROME=/path/to/chrome HACHIDORI_PUPPETEER=/path/to/puppeteer-core.js \
  node benchmark/recommended-install.mjs /path/to/baseline /path/to/changed
```

The JSON output records archive sizes/hashes, runtime versions, revisions and
each timing. These are orchestration measurements with controlled download
bytes, not publisher-network or full-dictionary throughput measurements. The
timed boundary ends at the final UI message; inventory/lookup verification and
browser startup/teardown are outside it.

### Local archive

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

## Low memory mode

`low-memory-mode.mjs` alternates fresh-profile samples with
[Low memory mode](../docs/memory.md) off and on: one archive imported through
Settings' real file input, the import wall time (file selection to ready
status), the engine heap (`hd_memory.heapBytes`) and the summed Chrome
process-tree RSS right after the import settles and, with the mode on, again
after the worker has been recycled, then the median and p95 of repeated
`hd_lookup` round trips. Peak import RSS is not sampled; the standard runner
above does that.

```sh
node benchmark/low-memory-mode.mjs --archive /path/to/jitendex.zip --samples 3 \
  --output benchmark/results/low-memory-mode.json
```

## Dictionary update availability

`dictionary-update.mjs` measures what a reader sees while a dictionary is
replaced by a newer generation. Each sample is a fresh profile; for each library
size in `--others` it imports that many six-term fixture clones through the
real Settings file input, then updates the target dictionary through the same
`hd_import` transaction a managed update runs (a same-title archive at the next
revision) while the page issues `hd_lookup` round trips every 100 ms,
alternating a word only the target answers with a word only the others answer.
It records the import wall time, the lookups refused with `engine-mutating` and
the window they span, the slowest answered lookup (an in-place swap shows up as
latency, not as a refusal), when the first reply carried the new revision, the
engine heap before and after, the transient OPFS bytes while both generations
exist, and whether `hd_status.updating` was reported.

```sh
node benchmark/dictionary-update.mjs --output benchmark/results/dictionary-update
node benchmark/dictionary-update.mjs --revision origin/main --output benchmark/results/dictionary-update-base
node benchmark/dictionary-update.mjs --archive jitendex.zip --update-archive jitendex-next.zip --query 食べる
```

`--revision` snapshots another commit's `extension/` tree with `git archive`, so
a base can be measured from the same worktree. The default target is a
synthetic 100,000-row dictionary (`--target-rows`); `--archive` measures a real
one and `--update-archive` supplies its next revision (a copy whose
`index.json` revision differs). Rows go to `raw.jsonl` with `definition.json`
beside them. The other dictionaries are small, so their reload cost is small;
lookups are backend round trips, not page scanning or popup rendering.

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


## Anki duplicate index

The focused [duplicate-index benchmark](../docs/anki-duplicate-index-benchmark.md)
alternates two equivalent service-level View-readiness outcomes for the same
known duplicate: an eligible cache miss followed by status plus live preflight
repair, and a warm canonical-index positive returning the same exact IDs with
zero Anki requests. Setup, complete refreshes, browser messaging and DOM work
are excluded. The JSON includes every raw sample, action counts and environment
details. The driver refuses AnkiConnect's standard port and verifies the
isolated profile's media directory before measuring.

### Complete index refresh against a seeded collection

`anki-index-refresh.mjs` times the production complete pull (`fetchAnkiIndex`:
two `findNotes` plus one whole-collection `notesInfo`) and the live per-word
miss path (`lookupAnkiIndex`) against the same isolated Anki, after seeding the
benchmark note type to a chosen size. It reports per-action wall time and reply
bytes for every run, so the `notesInfo` duration can be compared with the
worker's 25 s request timeout:

```sh
node benchmark/anki-index-refresh.mjs --notes 20000 --runs 5 \
  --endpoint http://127.0.0.1:18765 \
  --expected-media-dir /tmp/hachidori-anki-index-benchmark/base/HachidoriBenchmark/collection.media \
  --output /tmp/anki-index-refresh-20k.json
```

`--back-bytes 2000` pads the second field of newly seeded notes to a realistic
mined-note size; use another `--model`/`--deck` for that collection so the
plain one stays comparable. Seeding is idempotent and only adds missing notes.

### Scheduling inside a real Electron overlay host

`anki-index-electron.mjs` loads a copy of the extension with `OVERLAY_MODE` on
into the minimal Electron host (`electron-host/`), the GameSentenceMiner shape,
and drives three launches on one profile against the isolated Anki: a fresh
profile with Anki reachable, an attempt record left without an outcome (a host
torn down mid-pull), and a failed attempt whose 30-minute backoff ends shortly
after launch. It records whether `chrome.alarms` exists and dispatches, whether
`storage.onChanged` reaches the worker, when the snapshot appears, and the
page-clock latency of `hd_anki_preflight` for the first request and the next
twenty:

```sh
HDW_ELECTRON=/path/to/electron node benchmark/anki-index-electron.mjs \
  --extension extension --endpoint http://127.0.0.1:18765 \
  --model "Hachidori Duplicate Index Benchmark" --deck "Hachidori Duplicate Index Benchmark" \
  --output /tmp/anki-index-electron.json
```

Pass `--extension /path/to/other/checkout/extension` to compare revisions with
the same harness. Needs `xvfb-run` and puppeteer-core like `electron.mjs`.

## Electron (classic FS + IDBFS)

`benchmark/electron.mjs` drives the extension inside a minimal Electron host
(`benchmark/electron-host/`), which is the GameSentenceMiner shape: shared
memory and cross-origin isolation, but no OPFS sync access handles, so the
engine runs on the classic Emscripten FS with IDBFS persistence. It imports the
given archives through the real settings page, times lookups from the page, then
relaunches on the same profile and times restart-to-ready.

```sh
HDW_ELECTRON=/path/to/electron node benchmark/electron.mjs extension a.zip b.zip
```

Needs `xvfb-run` and puppeteer-core (`HDW_PUPPETEER` if it is not under
`~/.cache/hachidori-e2e`). The host is shut down through a quit file rather
than a signal: an abruptly killed Electron cannot re-register the extension's
service worker on the next launch with the same profile.
