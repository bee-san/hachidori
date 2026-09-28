<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Default vs direct Nazeka — MVP benchmark

Measured on 2026-09-28 at Hachidori **e4af9457acde9fa625805ba0bfb01219dc4e5813**.
Both themes use exactly the same engine, input, options and extension revision.
Subsequent changes update catalogue captions, screenshots, source pins and evidence.

## Results

Six fresh Chrome profiles per theme, in two batches of three. The first batch
runs Default then Nazeka; the second reverses that order. Each profile excludes
one alternating warmup pair. There are **144 warm samples per theme**, covering
flat, 40-level structured and 24-sense dictionary entries.

| Measurement | Default median / p95 | Nazeka median / p95 |
| --- | ---: | ---: |
| Cold first correct frame (6 samples) | 89.65 / 98.50 ms | 69.45 / 77.90 ms |
| Cold complete stable result | 129.90 / 149.40 ms | 71.65 / 80.90 ms |
| Warm first correct frame | 18.70 / 25.20 ms | 17.25 / 18.50 ms |
| Warm complete stable result | 49.80 / 56.90 ms | 33.10 / 33.40 ms |
| Synchronous renderer, including core callbacks/layout it triggers | 5.90 / 11.80 ms | 2.20 / 4.50 ms |
| Script duration during sample | 4.163 / 5.293 ms | 2.059 / 3.069 ms |
| Style recalculation during sample | 1.995 / 4.099 ms | 0.588 / 0.842 ms |
| Layout during sample | 2.132 / 5.652 ms | 0.726 / 1.991 ms |
| Popup element count | 73 / 228 | 18 / 90 |
| Page JS heap used | 3.24 / 3.68 MiB | 2.70 / 3.13 MiB |

Nazeka takes **63% less synchronous render time** and creates fewer nodes. All
measured work categories decrease. Cold first-frame median improves by 23%,
and warm complete-frame median by 34% in this run. Six cold samples are a small
set. These results do **not** establish that every lookup or dictionary search
is faster.

The earlier pre-review comparison at `7ef2a8d` measured 2.45 vs 0.90 ms rendering
(63% less), with warm completion at 33.3 ms for both themes. Absolute times vary
with machine load and frame scheduling: the final run's starting load averages
were 2.20–3.81. We report the final revision above rather than selecting the
fastest run. Historical raw evidence is in `evidence/pre-review/`; its renderer
timer was inside the host, while the final timer wraps the host in the existing
benchmark-only probe. Production code now contains no timing counters.

### Proving that Nazeka becomes the popup

Counters accumulated over each full profile, including nested lookups:

| Work | Default, each profile | Nazeka, each profile |
| --- | ---: | ---: |
| Default view constructions | 2 | **0** |
| Rich glossary helper calls | 296 | **0** |
| Dictionary style applications | 1 | **0** |

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
Only the selected theme differs between runs. Popup 520 × 500, one column,
hover delay zero, definition blur off, compact summaries on for Default.

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run install:chrome
node benchmark/hover-popup-fixture.mjs /tmp/theme-hover-fixture.zip
node benchmark/theme-popup-fixture.mjs /tmp/theme-senses.zip
export HACHIDORI_CHROME="$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"
export HACHIDORI_PUPPETEER="$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
# Repeat in reverse order for a second batch.
for theme in default nazeka; do
  HACHIDORI_HOVER_OPTIONS="{\"popupTheme\":\"$theme\"}" \
    node benchmark/hover-popup.mjs "test/tmp/theme-batch-1/$theme" \
    /tmp/theme-hover-fixture.zip /tmp/theme-senses.zip
done
for theme in nazeka default; do
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
- Default and Nazeka deliberately present different content: Default retains
  rich definitions, images, pitch, tabs and Note/custom buttons. Nazeka flattens
  dictionary data and omits those widgets, while preserving complete text results.
- This compares Hachidori renderers. It does not compare the standalone Nazeka
  extension's dictionary engine with Hachidori. The old post-render transformation
  [prototype results](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run2)
  are historical and are not included in these numbers.
