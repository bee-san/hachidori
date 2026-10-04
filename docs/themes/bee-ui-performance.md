<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Bee UI performance

Measured only Bee on 2026-10-04, before
`4cef3089760d3fbe74fa91545baf7f1512986dd6` and after
`7bd76589c30b3a03b19440ce2f57352218cfbae5`. The before extension is identical
to PR #466's reviewed `4aa58ca` extension. The final benchmark harness is
committed at `f200fec2`; subsequent evidence commits keep the extension fixed.
Theme Store card images are outside these renderer and hover measurements.

**Presentation updates remove repeated work; initial rendering has a small
remaining cost for the clearer header and action icons.** The changes reuse
frequency and pitch derivation within a result, retain unchanged frequency
chips, preserve unchanged dictionary-label text nodes, and remove a redundant
menu scan during teardown. Inline icons reuse the existing editable labels.
The final header has one source/actions wrapper and one extra overflow icon per
block: 36 visible blocks contain 2,680 elements before and 2,752 after.

## Production renderer and synchronous layout

Six fresh browser profiles, 20 excluded warmups and 100 measured samples per
case/revision/profile: **600 samples per case per revision**. Both revisions
remain connected in separate native shadow roots in one document and renderer
process. Each iteration alternates before/after execution order; setup and
scenario order reverse in odd profiles. The harness requires byte-identical
shared production components, while loading each revision's own Bee module
and CSS. This controls the substantial scheduling differences seen between
separate browser processes on this shared desktop.

These timings include forced style/layout, excluding engine lookup, transport,
runtime action binding, asynchronous media and paint. The fixture has 1 or 12
results across JMdict, Jitendex and Grammar dictionary. Each plain dictionary
has eight sense rows; Jitendex has eight structured paragraphs. Each header has
three named frequency sources and position-2 pitch. Three custom actions are
all labelled **Custom button**: a link, an Anki template action and an overflow
link. The popup is 560 × 420; the 12-result JSON has 31,995 characters. The
grouped case explicitly selects the first dictionary, so both revisions show
12 of 36 blocks despite the new All default.

| Work, milliseconds | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Render 3 blocks | 3.40 / 5.10 | 3.50 / 5.40 |
| Render 36 blocks, all visible | 29.80 / 40.70 | 30.50 / 41.60 |
| Render 36 blocks, 12 visible | 16.00 / 22.60 | 16.50 / 20.80 |
| Unchanged presentation, 3 blocks | 0.50 / 0.90 | 0.00 / 0.10 |
| Unchanged presentation, 36 visible blocks | 5.00 / 6.50 | 0.10 / 0.20 |
| Pitch-only presentation, 36 visible blocks | 6.80 / 7.80 | 2.10 / 2.50 |
| Unchanged presentation, 12 of 36 visible | 2.40 / 2.80 | 0.10 / 0.20 |
| Pitch-only presentation, 12 of 36 visible | 3.20 / 3.70 | 1.10 / 1.30 |
| Rename a group, 12 of 36 visible | 2.50 / 3.10 | 0.30 / 0.40 |

Zero-millisecond medians reflect the observed 0.1 ms timer quantization,
rather than an absence of work. Unchanged and pitch-only 36-block updates
improve in all six profiles. Initial rendering is approximately 0.1 ms slower
for 3 blocks, 0.7 ms for 36 visible blocks and 0.5 ms for the grouped workload.
The 3-block and 36-visible median increases occur in **all six paired
profiles**, so this is a consistent modest UI cost, not a claimed initial
speedup. The remaining header/action layout cost accompanies the new UI after
removing the identified unnecessary construction, scans and writes.

| After minus before render median, ms | Profile 0 | Profile 1 | Profile 2 | Profile 3 | Profile 4 | Profile 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 blocks | +0.10 | +0.10 | +0.20 | +0.10 | +0.10 | +0.10 |
| 36 blocks, all visible | +0.80 | +0.75 | +0.65 | +0.80 | +0.70 | +0.30 |
| 36 blocks, 12 visible | +0.55 | +0.40 | +0.35 | +0.50 | +0.25 | −0.15 |

For 12 results, initial frequency and pitch helper calls fall from **36 to 12**
each. Unchanged and pitch-only updates make **zero frequency calls** and retain
all **108 exact frequency nodes**. Pitch-only updates use 12 pitch calculations
instead of 36. All 204 glossary-row calls and 36 action constructions remain;
hidden content is not deferred outside the measured interval. Dictionary,
glossary, visibility, frequency text/accessibility labels and pitch signatures
match between revisions and profiles.

## Production extension hover

Three fresh MV3 profiles per revision, ordered before/after, after/before,
before/after. Each excludes an alternating warmup pair and measures 24 warm
lookups: **72 warm samples per revision**. The real WASM importer loads the
committed flat/40-level structured fixture and 24-sense fixture. The popup is
520 × 500, max results 32, compact summaries on, definition blur off. These
hover profiles use the default empty custom-action configuration; configured
links and Anki actions are exercised by the renderer fixture above.

| Work, milliseconds | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| First visible warm result | 17.10 / 17.50 | 17.00 / 17.50 |
| Complete stable warm result | 33.30 / 33.50 | 33.30 / 33.50 |
| Synchronous warm renderer | 2.10 / 5.30 | 2.10 / 5.20 |
| Blank interval during warm replacement | 0 / 0 | 0 / 0 |

Stable completion requires complete expected results and two stable frames;
33.3 ms is not continuous rendering work. Warm end-to-end performance is
unchanged at this precision; these figures do not demonstrate a hover speedup.
All production assertions passed, including rapid-reply ordering, nested
lookup, glyph/padding hit testing and bounded sentence extraction. Engine
result signatures match across all six runs.

Cold first display has only three samples per revision: before median 33.40 ms,
range 30.9–42.1 ms; after median 33.60 ms, range 32.6–40.0 ms. This is insufficient
to establish a cold speedup or a consistent startup regression.

## Retained investigations

The manifest indexes every retained intermediate distribution. Two balanced
three-profile batches compared the first icon implementation (`f13aff4f`) with
the baseline. A mask-only diagnostic retained boxes and DOM while hiding the
glyphs; it is a diagnostic, not a valid product optimization. Two label-reuse
runs retain both the attempt contaminated by an unrelated eight-way WASM build
and the subsequent confirmation. Reusing inline labels removed 72 elements
from the 36-block fixture.

The earlier `7222cac3` six-profile sequential comparison and all twelve hover
runs also remain. A same-process three-profile control narrowed the initial
cost to roughly 0.1–0.2 ms for 3 blocks and 0.3–0.7 ms for grouped rendering.
A separate controlled removal of the word wrapper reduced 36-block medians
by 0.35, 0.35 and 0.45 ms, with complete results and unchanged signatures.
The final source includes that simplification and the removal of redundant
label writes and the teardown menu query.

These diagnostics use three links labelled Search/Sentence/More. The final
fixture uses link/Anki/link, all labelled Custom button. Different source
revisions, action fixtures and measurement boundaries are **not pooled** with
the final results. All measured samples from the indexed runs, including stalls, remain;
none were dropped from reported distributions.

## Reproduce and evidence

Linux 7.2.6-1-cachyos, Intel Core Ultra 7 165U, 14 logical CPUs, Node 22.23.1,
Chromium 153.0.8010.36, Puppeteer 25.10.0, headless with no sandbox. This is a
shared desktop without CPU isolation. Local correctness suites were idle
during the final measurements; unrelated desktop processes remained active.

```sh
git worktree add --detach /tmp/bee-before 4cef3089760d3fbe74fa91545baf7f1512986dd6
git worktree add --detach /tmp/bee-after 7bd76589c30b3a03b19440ce2f57352218cfbae5
export HACHIDORI_CHROME=/usr/bin/chromium
export HACHIDORI_PUPPETEER=/path/to/puppeteer-core/lib/puppeteer/puppeteer-core.js
HACHIDORI_BEE_PROFILES=6 node benchmark/bee-renderer.mjs \
  /tmp/bee-renderer /tmp/bee-before /tmp/bee-after

export HACHIDORI_HOVER_SAMPLES=1
export HACHIDORI_HOVER_OPTIONS='{"popupTheme":"bee"}'
for profile in 0 1 2; do
  order="before after"
  if (( profile % 2 )); then order="after before"; fi
  for revision in $order; do
    HACHIDORI_BENCH_REPO="/tmp/bee-$revision" node benchmark/hover-popup.mjs \
      "/tmp/bee-hover-$revision-$profile" \
      /tmp/bee-before/docs/themes/bee-evidence/bee-hover-fixture.zip \
      /tmp/bee-before/docs/themes/bee-evidence/bee-senses.zip
  done
done
```

Run these commands with Node 22.23.1 from the branch containing the final
harness; the reproduction loop uses Bash. The
[manifest](bee-evidence/ui-benchmark-manifest.json) records exact revisions,
extension/harness hashes, setup, boundaries, diagnostics and artifact hashes.
The [renderer summary](bee-evidence/ui-renderer-summary.json),
[renderer raw samples](bee-evidence/ui-renderer-raw.json.gz), and
[hover summary](bee-evidence/ui-hover-summary.json) retain profile results.
Each `ui-hover-{before,after}-{0..2}-manifest.json` records extension, harness,
probe and archive hashes; its raw JSON is losslessly compressed as
`ui-hover-{before,after}-{0..2}-raw.json.gz`. The `ui-investigation-*` artifacts
retain earlier raw data, exact diagnostic patches and the private control
harness. `gzip -dc` reads all compressed evidence.

Both fixtures are synthetic public inputs. These measurements do not model a
large installed dictionary library, remote audio/media, live Anki latency or
the Theme Store preview-card image.
