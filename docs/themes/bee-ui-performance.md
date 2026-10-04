<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Bee UI performance

Measured only Bee on 2026-10-04, before
`4cef3089760d3fbe74fa91545baf7f1512986dd6` and after
`7cf27d9e566fb7809adb62c6a05080fa681e0022`. The before extension is identical
to PR #466's reviewed `4aa58ca` extension. The measured after revision includes
the final simplification that applies flex layout directly to frequency tags,
without an extra metadata wrapper. Theme Store card images are outside the hover
and renderer measurements; subsequent evidence commits keep production code fixed.

The change removes repeated frequency and pitch derivation within one result
and retains frequency chips when only pitch, groups or unrelated dictionary
aliases change. Each dictionary still owns its DOM and actions, and all rich
definitions are constructed. The clearer header adds two elements per block.
For 36 visible blocks, total element counts are 2,680 before and 2,752 after.

## Production renderer and synchronous layout

Three fresh browser profiles per revision, 20 excluded warmups and 100 measured
samples per case/profile: **300 samples per case per revision**. Checkout order
is before/after, after/before, before/after; the middle profile also reverses
scenario order. These timings include forced style/layout, excluding engine
lookup, transport, runtime action binding, asynchronous media and paint.

The fixture has 1 or 12 results across JMdict, Jitendex and Grammar dictionary.
Each plain dictionary has eight sense rows; Jitendex has eight structured
paragraphs. Each header has three named frequency sources, position-2 pitch
and three custom links. The popup is 560 × 420. The 12-result JSON has 31,995
characters. The grouped case explicitly restores the first dictionary's group,
so both revisions show 12 of 36 blocks despite the new All default.

| Work, milliseconds | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Render 3 blocks | 2.50 / 4.50 | 1.90 / 2.90 |
| Render 36 blocks, all visible | 22.40 / 34.70 | 20.75 / 26.50 |
| Render 36 blocks, 12 visible | 12.50 / 41.90 | 9.60 / 14.00 |
| Unchanged presentation, 3 blocks | 0.30 / 0.60 | 0.10 / 0.10 |
| Unchanged presentation, 36 visible blocks | 4.10 / 5.70 | 0.60 / 0.70 |
| Pitch-only presentation, 36 visible blocks | 4.30 / 10.00 | 1.60 / 2.00 |
| Unchanged presentation, 12 of 36 visible | 2.00 / 3.20 | 0.20 / 0.40 |
| Pitch-only presentation, 12 of 36 visible | 2.25 / 3.00 | 0.90 / 1.10 |
| Rename a group, 12 of 36 visible | 1.70 / 2.30 | 0.30 / 0.50 |

The unchanged 36-block update improves in every profile: before medians
5.10, 2.90, 4.10 ms; after 0.60, 0.60, 0.60 ms. Pitch-only medians are
7.35, 3.80, 4.20 ms before and 1.80, 1.40, 1.50 ms after. Initial rendering
does not show a consistent speedup: per-profile differences have mixed signs.

| After minus before render median, ms | Profile 0 | Profile 1 | Profile 2 |
| --- | ---: | ---: | ---: |
| 3 blocks | −1.20 | +0.10 | +0.10 |
| 36 blocks, all visible | −8.80 | −1.60 | +5.40 |
| 36 blocks, 12 visible | −7.60 | +1.45 | −3.20 |

The previous extra wrapper was removed after an earlier run showed small
increases in all three profiles for 3-block and grouped rendering. In the final
run, one all-visible profile still increases by 5.4 ms and one grouped profile
by 1.45 ms, while the other profiles decrease. Three independent profile pairs
and substantial within-profile variance do not establish a consistent initial
regression or a general initial-render speedup. The complete distributions stay
in the evidence rather than dropping outliers.

For 12 results, initial frequency and pitch helper calls fall from **36 to 12**
each. Unchanged and pitch-only updates make **zero frequency calls** and retain
all **108 exact frequency nodes**. Pitch-only updates use 12 pitch calculations
instead of 36. All 204 glossary-row calls and 36 action constructions remain;
hidden content is not deferred outside the measured interval. Dictionary,
glossary, visibility, frequency text/accessibility labels and pitch signatures
match between revisions and profiles.

## Production extension hover

Six fresh MV3 profiles per revision, with before/after order reversed in every
other pair. Each excludes an alternating warmup pair and measures 24 warm
lookups: **144 warm samples per revision**. The real WASM importer loads the
committed flat/40-level structured fixture and 24-sense fixture. The popup is
520 × 500, max results 32, compact summaries on, definition blur off.

| Work, milliseconds | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| First visible warm result | 17.20 / 22.90 | 17.20 / 17.90 |
| Complete stable warm result | 33.40 / 33.80 | 33.40 / 33.50 |
| Synchronous warm renderer | 3.10 / 8.50 | 3.00 / 8.10 |
| Blank interval during warm replacement | 0 / 0 | 0 / 0 |

Stable completion requires the complete expected results and two stable frames;
33.4 ms is not continuous rendering work. Warm end-to-end medians are unchanged.
The baseline contains occasional desktop stalls (maximum first display 95.9 ms,
against 25.4 ms after); lower after p95 values do not establish a general
end-to-end speedup on this shared machine.
All production hover assertions passed, including rapid-reply ordering, nested
lookup, glyph/padding hit testing and bounded sentence extraction. Engine result
signatures match across all twelve runs.

Cold first display has only six samples per revision: before median 61.70 ms,
range 31.0–71.8 ms; after median 57.50 ms, range 34.8–68.9 ms. Startup remains
noisy and these samples do not establish a cold speedup or a consistent regression.

## Reproduce and evidence

Linux 7.2.6-1-cachyos, Intel Core Ultra 7 165U, 14 logical CPUs, Node 22.23.1,
Chromium 153.0.8010.36, Puppeteer 25.10.0, headless with no sandbox. This is a
shared desktop without CPU isolation. Local browser correctness suites were
idle during measurements. A preliminary smoke run under heavy unrelated load
was excluded; all reported samples use the paired runs above.

```sh
git worktree add --detach /tmp/bee-before 4cef3089760d3fbe74fa91545baf7f1512986dd6
git worktree add --detach /tmp/bee-after 7cf27d9e566fb7809adb62c6a05080fa681e0022
export HACHIDORI_CHROME=/usr/bin/chromium
export HACHIDORI_PUPPETEER=/path/to/puppeteer-core/lib/puppeteer/puppeteer-core.js
node benchmark/bee-renderer.mjs /tmp/bee-renderer /tmp/bee-before /tmp/bee-after

export HACHIDORI_HOVER_SAMPLES=1
export HACHIDORI_HOVER_OPTIONS='{"popupTheme":"bee"}'
for profile in 0 1 2 3 4 5; do
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

The [manifest](bee-evidence/ui-benchmark-manifest.json) records exact revisions,
environment, setup, boundaries and evidence hashes. The
[renderer summary](bee-evidence/ui-renderer-summary.json),
[renderer raw samples](bee-evidence/ui-renderer-raw.json.gz), and
[hover summary](bee-evidence/ui-hover-summary.json) retain profile results.
Each `ui-hover-{before,after}-{0..5}-manifest.json` records extension, harness,
probe and archive hashes; its corresponding raw JSON is losslessly compressed
as `ui-hover-{before,after}-{0..5}-raw.json.gz` (`gzip -dc` reads it).

Both fixtures are synthetic public inputs. These results isolate Bee's reader
costs and do not model a large installed dictionary library, remote audio/media,
live Anki latency or the Theme Store preview-card image.
