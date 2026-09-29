<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Default, Nazeka, Plain and JL benchmark

Measured on 2026-09-29 at Hachidori **fb999351c10d50be1124acd3165070c0ab0ebb8a**.
All four themes use exactly the same engine, input, options and extension revision.
Later commits change only catalogue captions, the source pin and this report;
renderer, engine and probe code stay identical. Manifests retain the full asset hashes.

## Results

Six fresh Chrome profiles per theme, in two batches of three. The first batch
runs Default, Nazeka, Plain, JL; the second reverses that order. Each profile
excludes one alternating warmup pair. There are **144 warm samples per theme**,
covering flat, 40-level structured and 24-sense dictionary entries.

| Measurement | Default median / p95 | Nazeka median / p95 | Plain median / p95 | JL median / p95 |
| --- | ---: | ---: | ---: | ---: |
| Cold first correct frame (6 samples) | 31.95 / 33.40 ms | 24.30 / 25.10 ms | 16.65 / 16.70 ms | 24.85 / 26.60 ms |
| Cold complete stable result | 49.80 / 49.90 ms | 33.20 / 33.20 ms | 33.20 / 33.20 ms | 33.20 / 35.20 ms |
| Warm first correct frame | 16.90 / 17.30 ms | 16.80 / 16.90 ms | 16.70 / 16.90 ms | 16.80 / 16.90 ms |
| Warm complete stable result | 33.30 / 33.40 ms | 33.20 / 33.40 ms | 33.20 / 33.30 ms | 33.20 / 33.40 ms |
| Synchronous renderer, including core callbacks/layout it triggers | 2.25 / 4.50 ms | 0.80 / 1.50 ms | 0.40 / 0.80 ms | 0.80 / 1.40 ms |
| Script duration during sample | 1.221 / 1.483 ms | 0.732 / 0.949 ms | 0.553 / 0.767 ms | 0.655 / 0.844 ms |
| Style recalculation during sample | 0.750 / 1.647 ms | 0.229 / 0.301 ms | 0.132 / 0.149 ms | 0.232 / 0.277 ms |
| Layout during sample | 0.742 / 1.648 ms | 0.285 / 0.722 ms | 0.149 / 0.463 ms | 0.261 / 0.584 ms |
| Popup element count | 77 / 352 | 18 / 90 | 1 / 1 | 20 / 34 |
| Page JS heap used | 3.29 / 3.73 MiB | 2.75 / 3.16 MiB | 2.72 / 3.10 MiB | 2.76 / 3.17 MiB |

JL renders in 0.80 ms at the median, the same as Nazeka and 64% less than
Default. Plain is still the cheapest at 0.40 ms. JL builds one block per result
and dictionary: 漢字 has definitions in both fixture dictionaries, so it gets two
blocks, and the 24-sense entry is one block of numbered senses. That is why JL's
median element count is close to Nazeka's but its p95 is lower (34 against 90).

Warm complete frames land in the same frame for every theme on this machine
(33.2 to 33.3 ms), so none of the text themes buys a whole extra frame over
Default here. Default's cold complete result takes one frame more (49.8 ms).
These numbers do not show that every lookup or the shared dictionary engine is
faster, and six cold samples per theme are a small set.

This run used a faster machine than the 2026-09-28 three-theme run (Xeon
Platinum 8488C against Core Ultra 7 165U), so every absolute time dropped:
Default's render median went from 5.60 to 2.25 ms and Nazeka's from 2.10 to
0.80 ms. Compare themes within one run, not across runs. The older evidence is
in git history, and the pre-review comparison at `7ef2a8d` stays in
`evidence/pre-review/`; its renderer timer was inside the host, while this one
wraps the host in the existing benchmark-only probe. Production code contains
no timing counters.

### Proving that themes become the popup

Counters accumulated over each full profile, including nested lookups:

| Work | Default, each profile | Nazeka, each profile | Plain, each profile | JL, each profile |
| --- | ---: | ---: | ---: | ---: |
| Default view constructions | 2 | **0** | **0** | **0** |
| Rich glossary helper calls | 296 | **0** | **0** | **0** |
| Dictionary style applications | 1 | **0** | **0** | **0** |

The focused Chrome check additionally verifies no Default layout rules in
Nazeka's or JL's stylesheet, no rich dictionary/image/link DOM, and no
dictionary style nodes. It checks actual hover, kanji/Back, carousel selection,
preview and switching back to Default. A local fake AnkiConnect verifies that
Nazeka's real Anki button is ready, that audio follows the reading and that no
lookup count is created even when global counts are enabled; with JL it verifies
one audio button and one ready Anki button per block. The renderer contract test
injects a failure and checks model replay with Default CSS.

An initial Nazeka run found its bold Japanese source context loaded an additional
CJK font on first display. A diagnostic trace isolated about 32 ms inside initial
positioning/layout. Keeping context emphasis through colour and using regular
weight reduced the diagnostic cold render from about 34 ms to 17 ms, and every
run since includes that fix. Text conversion and source highlighting remain in
the measured path; work is not deferred outside the result barrier.

## Reproduce

Environment: Intel Xeon Platinum 8488C, 16 logical CPUs, Linux, Node v22.23.1
(the version CI pins), Chrome for Testing 152.0.7977.75, headless, production
threaded OPFS engine. The selected theme is the only runtime option differing
between runs. Popup 520 × 500, one column, hover delay zero, definition blur off,
compact summaries on for Default.

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run install:chrome
node benchmark/hover-popup-fixture.mjs /tmp/theme-hover-fixture.zip
node benchmark/theme-popup-fixture.mjs /tmp/theme-senses.zip
export HACHIDORI_CHROME="$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"
export HACHIDORI_PUPPETEER="$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
# The second batch repeats the first in reverse order.
for theme in default nazeka plain jl; do
  HACHIDORI_HOVER_OPTIONS="{\"popupTheme\":\"$theme\"}" \
    node benchmark/hover-popup.mjs "test/tmp/theme-batch-1/$theme" \
    /tmp/theme-hover-fixture.zip /tmp/theme-senses.zip
done
for theme in jl plain nazeka default; do
  HACHIDORI_HOVER_OPTIONS="{\"popupTheme\":\"$theme\"}" \
    node benchmark/hover-popup.mjs "test/tmp/theme-batch-2/$theme" \
    /tmp/theme-hover-fixture.zip /tmp/theme-senses.zip
done
node benchmark/theme-popup-report.mjs docs/themes/evidence \
  test/tmp/theme-batch-1 test/tmp/theme-batch-2
```

[Summary JSON](evidence/summary.json), manifests and losslessly compressed raw
samples are in `evidence/`. Each manifest records exact revision, extension and
probe hashes, archive sizes/hashes, options, CPU and startup load. `gzip -dc`
reads a raw sample file. Archives contain synthetic public fixture data only.

## Boundaries and limitations

- Input-to-frame timings include event scanning, messaging, engine lookup,
  rendering and frame scheduling. Completion requires the full expected result
  and two stable frames. It does not end at the theme function's return.
  For Plain the probe compares complete rendered definition text against the
  lookup data rather than looking for a headword, and for JL it expects one
  headword per block. This additional probe work is included in measured frame
  latency; the production renderers have no such check.
- Synchronous renderer timings include the DOM and any synchronous style/layout
  and core action work they trigger. They are not backend lookup timings.
- Performance-domain deltas include the page and measurement probe. Heap is the
  page's JS heap at sampling time, not retained memory or engine/browser RSS.
  Warm paint/GPU work is present in local trace files but is not separately
  quantified in this table. Native kanji correctness is checked; native kanji
  latency is not separately benchmarked.
- The fixture includes a long entry and two dictionaries, but not a large real
  dictionary collection. A word with definitions in many dictionaries makes more
  JL blocks, and more Anki duplicate checks once Anki is set up; this run does not
  measure that. OS font/file caches are not flushed between fresh profiles.
  Neither live Anki latency nor remote audio requests are part of this comparison.
- The themes deliberately present different content: Default retains rich
  definitions, images, pitch, tabs and Note/custom buttons. Nazeka flattens
  dictionary data and omits those widgets, while preserving complete text results.
  JL flattens the same data into one block per dictionary with tabs and a pitch
  marker, and omits images, Note/custom buttons and counts. Plain also omits
  headwords, readings, labels, metadata, counts, Anki/audio controls and icon CSS.
  The benchmark leaves Anki unconfigured and audio autoplay off for all themes;
  the separate browser check verifies configured Nazeka and JL mining.
- This compares Hachidori renderers. It does not compare the standalone Nazeka
  extension or JL's own dictionary engines with Hachidori. The old post-render
  transformation [prototype results](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run2)
  are historical and are not included in these numbers.
