# Dictionary reorder measurements

Issue [#285](https://github.com/bee-san/hachidori/issues/285): Library moves now
update the existing rows immediately and coalesce saves for 150 ms. The engine
changes native order without reloading an unchanged manifest or warming lookup.

The comparison uses baseline `c42cb4190fc3138fa0927ce37fe9d01dfb5e6dfd`
(`origin/main` at the time of measurement) and implementation
`7c7625a2201290b2933a6f50ba2a671125039d52`. The branch head was subsequently
rebased onto `origin/main` `c97339bb8455c4f75319cfe729fb0d5a2017282f` (PR #290
removing Sankoku from the recommended catalogue, PR #276 bumping the test-only
`puppeteer-core` lockfile). The only extension difference from the measured
implementation is `extension/recommended-dictionaries.js` (16 deleted catalogue
lines, PR #290); `engine-service.js`, `offscreen.js`, `settings.js`, the reorder
benchmark and the focused tests are byte-identical to the measured head, so the
reorder path was not re-measured for that unrelated catalogue edit.

The host was Linux 6.12.103 (Amazon Linux 2023), Intel Xeon Platinum 8488C, 16
logical CPUs, 132 GB RAM, shared with light concurrent work (load average
~3–5 during the run).

An isolated move now deliberately waits for the 150 ms debounce before saving;
its reply and first committed lookup arrive later despite the faster native
path. The improvement is immediate interaction and coalesced work, not a claim
that the whole click-to-save interval became shorter.

## Measured results

All values are milliseconds, median / nearest-rank p95. Each regular cell has
30 moves across three fresh profiles; profiles alternate baseline then head.

| Dictionaries | Metric | Baseline | Head |
| ---: | --- | ---: | ---: |
| 10 | Click → DOM | 10.06 / 12.59 | 1.39 / 2.04 |
| 10 | Click → reply | 4.74 / 6.74 | 155.16 / 155.98 |
| 10 | Send → reply | 4.16 / 6.18 | 3.67 / 4.19 |
| 10 | Click → first ranked lookup | 12.34 / 15.48 | 158.13 / 158.93 |
| 50 | Click → DOM | 29.27 / 38.06 | 2.97 / 3.94 |
| 50 | Click → reply | 11.81 / 22.58 | 161.49 / 162.83 |
| 50 | Send → reply | 10.50 / 20.79 | 8.26 / 10.30 |
| 50 | Click → first ranked lookup | 37.98 / 55.86 | 167.79 / 171.04 |
| 150 | Click → DOM | 79.46 / 105.27 | 6.19 / 8.06 |
| 150 | Click → reply | 26.30 / 58.34 | 174.84 / 179.32 |
| 150 | Send → reply | 22.78 / 54.41 | 18.73 / 21.33 |
| 150 | Click → first ranked lookup | 93.62 / 125.11 | 189.73 / 195.17 |

Per-profile median click-to-DOM (baseline → head, pairs 1/2/3):

| Dictionaries | Pair 1 | Pair 2 | Pair 3 |
| ---: | ---: | ---: | ---: |
| 10 | 9.54 → 1.27 | 9.51 → 1.44 | 11.11 → 1.28 |
| 50 | 32.11 → 3.34 | 28.38 → 3.01 | 29.37 → 2.75 |
| 150 | 82.89 → 5.62 | 80.50 → 5.38 | 76.21 → 6.55 |

All 90 measured head moves reported `order-only` and changed the DOM before
the reply arrived. Across regular and low-memory runs, every head move at 150
dictionaries stayed below 16 ms click-to-DOM and 50 ms send-to-reply (maxima
8.35 ms and 22.75 ms respectively). No measured head move used a native
full-load path. The baseline records `unreported-baseline` because it predates
`hd_status.lastLoadPath`; the extension smoke suite's native-call spies
establish its reset/add/warm-lookup behaviour independently.

### Low memory mode and deferred work

One fresh profile per revision, ten measured moves per size. These are a
deferred-work check and repeated within-profile timings, not three independent
low-memory profile pairs.

| Dictionaries | DOM median, base → head | Send/reply median, base → head | Generation after idle, base | Generation after idle, head |
| ---: | ---: | ---: | --- | --- |
| 10 | 11.63 → 1.49 | 5.09 → 3.83 | 13 → 1 | 13 → 13 |
| 50 | 31.87 → 2.80 | 10.68 → 7.76 | 13 → 1 | 13 → 13 |
| 150 | 85.84 → 5.21 | 27.79 → 20.63 | 13 → 1 | 13 → 13 |

Every idle check preserved the correct lookup order. The baseline rebuilt its
worker after the moves (generation reset to 1); the head retained its
generation at all three sizes, so a pure reorder allocates no import
high-water mark and schedules no fresh recycle.

Raw measured rows, archive hashes, exact extension hashes, runtime versions and
per-profile host snapshots are in [the evidence directory](benchmark-data/dictionary-reorder/).

## Reproduce

Use Node 22.23.1, Chrome for Testing 152.0.7977.75 and the locked
`test/tooling` dependencies. Set `HACHIDORI_CHROME` and `HACHIDORI_PUPPETEER`
as described in [the test guide](../test/README.md). The recorded runs use an
isolated network namespace to avoid the host's live Anki local-audio service.
Each sample creates and removes its own disposable browser profile.

```sh
unshare --user --map-root-user --net sh -c 'ip link set lo up && bash reorder-pairs.sh'
```

where `reorder-pairs.sh` alternates the two revisions three times plus one
low-memory pair (`BASE`/`HEAD` are the SHAs above):

```sh
set -eu
for pair in 1 2 3; do
  node benchmark/dictionary-reorder.mjs --revision "$BASE" --samples 1 \
    --output benchmark/results/reorder/base-$pair
  node benchmark/dictionary-reorder.mjs --revision "$HEAD" --samples 1 \
    --expect-path order-only --output benchmark/results/reorder/head-$pair
done
node benchmark/dictionary-reorder.mjs --revision "$BASE" --samples 1 --low-memory true \
  --output benchmark/results/reorder/base-low-memory
node benchmark/dictionary-reorder.mjs --revision "$HEAD" --samples 1 --low-memory true \
  --expect-path order-only --output benchmark/results/reorder/head-low-memory
```

The input grows from 10 to 50 to 150 six-term fixture clones with unique titles,
imported through the real Settings file input and real WASM importer. Each size
excludes two warmup moves, then records ten moves. Every move checks durable
order and all 2 × N glossary titles in the first real lookup after its reply.
`--revision` extracts only that committed extension into the output directory;
it does not switch branches or touch another checkout.

## Timing boundaries

- Click-to-DOM measures the real button handler through the observed rank and
  row-position mutation. It excludes CDP overhead and paint.
- Click-to-reply includes the intentional 150 ms trailing debounce. Send-to-reply
  excludes that debounce. Both stop before subsequent Settings renders,
  including group and option controls.
- Click-to-lookup starts at the move and ends with the first correctly ranked
  lookup after the reply. It includes render work that delays that lookup,
  but does not establish final UI settlement.
- Low-memory idle rows wait 2.5 seconds, then check engine generation and lookup
  order. These waits are excluded from move timings. The bridge regression
  separately verifies that pending import and mode-change recycling still runs.
- Small fixtures measure orchestration and native ordering, not large-dictionary
  I/O, import speed or memory savings. The host is shared; light host work,
  scheduling, thermal and power-management variation are not controlled by this
  benchmark. These are local measurements, not a browser-wide latency guarantee.

## Visible result

The screenshot was taken while the first engine acknowledgement was held. A
subsequent optimistic move already reflects rank 1, and valid arrow controls
remain usable.

![Optimistic dictionary order before the held acknowledgement](assets/dictionary-reorder-optimistic.png)

## Correctness and simplification review

The engine derives the fast path from an unchanged loaded manifest (identity,
path, kinds and enabled state), including tolerated failed packages. It retains
those diagnostics; a refused native order or any changed set falls back to the
existing load path. No new message type or client-provided bypass flag is
needed. Low memory mode trusts only a successful engine `order-only` result
when excluding a fresh recycle.

Settings reuses its serialized CAS queue, authoritative-state restoration,
row/focus helpers and existing unsaved-work guard. Rapid moves share one batch;
new moves during an in-flight commit follow that page's acknowledgement.
Competing Settings writes fail explicitly, bump the reorder epoch, and discard
the stale queued draft. A settled reorder reuses the existing rows by comparing
package records independent of key order. The diff added no settings,
dependencies, submodule changes or generated WASM changes relative to the base;
drag-and-drop remains the existing pointer/keyboard reorder controls.

## Validation

See the pull request for the full command list and outcomes on the rebased
head, including the Node contract suite, both WASM smoke variants, the offscreen
bridge regression, the extension smoke suite, and the real-Chrome end-to-end
suite. Full hosted CI validates the exact merged head.
