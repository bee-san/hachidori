# Anki duplicate index benchmark

This benchmark compares the two service-level paths that make the same known
duplicate ready for **View in Anki**:

1. An eligible canonical-index miss, followed by the popup's normal status and
   preflight fallback. The scoped live lookup repairs the positive row and
   returns the exact matching note IDs.
2. A warm cache-only `view()` hit that returns those same IDs without discovery,
   field rendering or an Anki request.

Fixture creation, warm-index priming, complete refreshes, browser messaging and
DOM rendering are outside the measured interval. The live path includes the
status discovery and positive repair that a popup miss actually performs. Each
live sample uses a fresh empty in-memory canonical index; runs alternate path
order to reduce ordering bias.

## Reproduce

Start an isolated Anki profile with AnkiConnect on a nonstandard loopback port,
then pass both that endpoint and the profile's exact media directory:

```bash
node benchmark/anki-duplicate-index.mjs \
  --endpoint http://127.0.0.1:18765 \
  --expected-media-dir /tmp/hachidori-anki-index-benchmark/base/HachidoriBenchmark/collection.media \
  --anki-version 26.09.2 \
  --warmups 40 \
  --runs 400 \
  --output /tmp/hachidori-anki-duplicate-index-benchmark.json
```

The driver refuses the standard AnkiConnect port `8765`, verifies
`getMediaDirPath` against the expected isolated profile, creates a dedicated
note type/deck if needed, and checks that both measured paths return identical
note IDs. The live path calls the production mining service's cache-only
`view()`, `status()` and `preflight()` sequence. The warm path calls the same
service's `view()` against a primed production `createAnkiDuplicateIndex`.

The JSON report records every raw sample, medians, nearest-rank p95 values,
request totals, action counts, the exact note IDs, endpoint/media-directory
proof, Git commit, Node/OS/CPU/memory details, and the supplied Anki version.
A warm positive must report zero Anki requests. Keep decision-grade reports
with the pull request evidence instead of replacing this reproducible method
with one machine's timings.
