# Anki duplicate index benchmark

This benchmark compares only two equivalent production paths for the same
known duplicate:

1. A normal scoped Anki lookup that returns the exact matching note IDs.
2. A warm local-index hit that returns those same IDs.

Fixture creation, index priming, complete refreshes, cold-cache work and
cache-miss repair are outside the measured interval. Runs alternate path order
to reduce ordering bias.

## Reproduce

Start an isolated Anki profile with AnkiConnect on a nonstandard loopback port,
then pass both that endpoint and the profile's exact media directory:

```bash
node benchmark/anki-duplicate-index.mjs \
  --endpoint http://127.0.0.1:18765 \
  --expected-media-dir /tmp/hachidori-anki-index-benchmark/base/HachidoriBenchmark/collection.media \
  --warmups 40 \
  --runs 400 \
  --output /tmp/hachidori-anki-duplicate-index-benchmark.json
```

The driver refuses the standard AnkiConnect port `8765`, verifies
`getMediaDirPath` against the expected isolated profile, creates a dedicated
note type/deck if needed, and checks that both measured paths return identical
note IDs. The live path calls the production `lookupAnkiIndex`; the warm path
calls the production `createAnkiDuplicateIndex().lookup`.

## Recorded result

Measured on 2026-09-14 against a warm throwaway Anki 26.05 profile with
AnkiConnect commit `4064fa142785975255457abd6a496015f5b71f38`. The driver used
40 excluded warmups and 400 alternating measured runs per path for note ID
`1789392215981`.

| Production path | median (ms) | p95 (ms) | requests | requests/run |
| --- | ---: | ---: | ---: | ---: |
| Live scoped Anki lookup | 74.716 | 76.573 | 1200 | 3.00 |
| Warm local-index hit | 0.358 | 1.052 | 0 | 0.00 |

Median speedup was **208.5×**. The p95 ratio was **72.8×**.

The live request count is the expected three calls per lookup: `findNotes` for
scoped candidates, `notesInfo` for exact direct-field verification, and
`findNotes` for aggregate maturity. A warm hit performs no Anki request.
