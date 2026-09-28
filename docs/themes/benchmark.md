<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Default, Nazeka and Plain — MVP benchmark

Measured on 2026-09-28 at Hachidori **89e07c6f5b66599dda0b7bcd303a0b287b01f03d**.
All three themes use exactly the same engine, input, options and extension revision.
Subsequent changes update catalogue captions, screenshots, source pins and evidence.
The final integration also includes main PRs #378 and #381; #381 changes Default
glossary markup/CSS. The timings below describe the recorded revision, not a new
measurement of those later Default changes.
The experimental-switch description was updated during capture; renderer, engine
and probe code stayed identical. Manifests retain the full asset hashes.

## Results

Six fresh Chrome profiles per theme, in two batches of three. The first batch
runs Default, Nazeka, Plain; the second reverses that order. Each profile excludes
one alternating warmup pair. There are **144 warm samples per theme**, covering
flat, 40-level structured and 24-sense dictionary entries.

| Measurement | Default median / p95 | Nazeka median / p95 | Plain median / p95 |
| --- | ---: | ---: | ---: |
| Cold first correct frame (6 samples) | 91.55 / 96.50 ms | 71.55 / 82.90 ms | 23.60 / 24.90 ms |
| Cold complete stable result | 100.10 / 145.50 ms | 73.90 / 85.90 ms | 32.80 / 34.90 ms |
| Warm first correct frame | 18.65 / 26.10 ms | 17.15 / 18.40 ms | 16.90 / 18.40 ms |
| Warm complete stable result | 49.90 / 55.20 ms | 33.10 / 33.40 ms | 33.20 / 33.70 ms |
| Synchronous renderer, including core callbacks/layout it triggers | 5.60 / 11.50 ms | 2.10 / 4.20 ms | 1.00 / 1.90 ms |
| Script duration during sample | 4.262 / 5.176 ms | 2.060 / 2.827 ms | 1.732 / 2.562 ms |
| Style recalculation during sample | 1.969 / 3.981 ms | 0.565 / 0.828 ms | 0.324 / 0.384 ms |
| Layout during sample | 2.074 / 5.515 ms | 0.733 / 1.946 ms | 0.394 / 1.126 ms |
| Popup element count | 73 / 228 | 18 / 90 | 1 / 1 |
| Page JS heap used | 3.25 / 3.69 MiB | 2.70 / 3.13 MiB | 2.69 / 3.09 MiB |

Plain takes **82% less synchronous render time than Default**, and **52% less
than Nazeka**. It creates one element per result and no controls. Its cold
first-frame median is 23.6 ms, versus 91.55 ms for Default and 71.55 ms for Nazeka.
Nazeka takes **63% less render time than Default**.

Warm complete-frame medians are 49.9 ms (Default), 33.1 ms (Nazeka), and 33.2 ms
(Plain). Plain's lower construction cost does not buy another complete frame
on this workload. These numbers do not establish that every lookup or the
shared dictionary engine is faster. Six cold samples per theme are a small set.

An earlier pre-review comparison at `7ef2a8d` measured 2.45 vs 0.90 ms rendering
for Default/Nazeka, with warm completion at 33.3 ms for both. Absolute times vary
with machine load and frame scheduling. Historical raw evidence is retained in
`evidence/pre-review/`; its renderer timer was inside the host, while the final
timer wraps the host in the existing benchmark-only probe. Production code
contains no timing counters. One setup attempt failed in the pre-existing
offscreen-document creation path before collecting samples; it was rerun.

### Proving that themes become the popup

Counters accumulated over each full profile, including nested lookups:

| Work | Default, each profile | Nazeka, each profile | Plain, each profile |
| --- | ---: | ---: | ---: |
| Default view constructions | 2 | **0** | **0** |
| Rich glossary helper calls | 296 | **0** | **0** |
| Dictionary style applications | 1 | **0** | **0** |

The focused Chrome check additionally verifies no Default layout rules in
Nazeka's stylesheet, no rich dictionary/image/link DOM, and no dictionary style
nodes. It checks actual hover, kanji/Back, carousel selection, preview and
switching back to Default. The final layout check also uses a local fake
AnkiConnect to verify the real Anki button is ready, audio follows the reading,
and no lookup count is created even when global counts are enabled. The renderer contract test injects a failure and
checks model replay with Default CSS.

An initial run found Nazeka's bold Japanese source context loaded an additional
CJK font on first display. A diagnostic trace isolated about 32 ms inside initial
positioning/layout. Keeping context emphasis through colour and using regular
weight reduced the diagnostic cold render from about 34 ms to 17 ms. The final
repeated results above include this fix. Text conversion and source highlighting
remain in the measured path; work is not deferred outside the result barrier.

## Reproduce

Environment: Intel Core Ultra 7 165U, 14 logical CPUs, Linux, Node v26.8.2,
Chrome for Testing 152.0.7977.75, headless, production threaded OPFS engine.
The project pins Node 22.23.1 for CI; the local benchmark used the installed Node.
The selected theme is the only runtime option differing between runs. Popup 520 × 500, one column,
hover delay zero, definition blur off, compact summaries on for Default.

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run install:chrome
node benchmark/hover-popup-fixture.mjs /tmp/theme-hover-fixture.zip
node benchmark/theme-popup-fixture.mjs /tmp/theme-senses.zip
export HACHIDORI_CHROME="$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"
export HACHIDORI_PUPPETEER="$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
# Repeat in reverse order for a second batch.
for theme in default nazeka plain; do
  HACHIDORI_HOVER_OPTIONS="{\"popupTheme\":\"$theme\"}" \
    node benchmark/hover-popup.mjs "test/tmp/theme-batch-1/$theme" \
    /tmp/theme-hover-fixture.zip /tmp/theme-senses.zip
done
for theme in plain nazeka default; do
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
  lookup data rather than looking for a headword. This additional probe work
  is included in measured frame latency; the production renderer has no such check.
- Synchronous renderer timings include the DOM and any synchronous style/layout
  and core action work they trigger. They are not backend lookup timings.
- Performance-domain deltas include the page and measurement probe. Heap is the
  page's JS heap at sampling time, not retained memory or engine/browser RSS.
  Warm paint/GPU work is present in local trace files but is not separately
  quantified in this table. Native kanji correctness is checked; native kanji
  latency is not separately benchmarked in this MVP.
- The fixture includes a long entry but not a large real dictionary collection.
  OS font/file caches are not flushed between fresh profiles. Neither live Anki
  latency nor remote audio requests are part of this comparison.
- The themes deliberately present different content: Default retains
  rich definitions, images, pitch, tabs and Note/custom buttons. Nazeka flattens
  dictionary data and omits those widgets, while preserving complete text results.
  Plain also omits headwords, readings, labels, metadata, counts, Anki/audio controls
  and icon CSS. The benchmark leaves Anki unconfigured and audio autoplay off
  for all themes; the separate browser check verifies configured Nazeka mining.
- This compares Hachidori renderers. It does not compare the standalone Nazeka
  extension's dictionary engine with Hachidori. The old post-render transformation
  [prototype results](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run2)
  are historical and are not included in these numbers.
