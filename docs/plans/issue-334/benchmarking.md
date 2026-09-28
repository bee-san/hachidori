# Benchmarking themes

This file collects four rules. From [c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542): "i want all themes benchmarked ofc", and themes are "their own popup, so we save on rendering cost". From the original body: "every theme … is benchmarked against the default popup before it is accepted, by its author and by the themes-repo CI". From [c26](https://github.com/bee-san/hachidori/issues/334#issuecomment-5870917807): "Measure DOM construction, style/layout/paint work, node counts, memory, cold first hover and end-to-end hover/kanji latency — not only the theme function", and "the old `onRender` p95 budget … must not be applied unchanged to the entire replacement renderer". From [c27](https://github.com/bee-san/hachidori/issues/334#issuecomment-5871156145): "Benchmarks verify that omitted dictionary rendering work is genuinely not performed". AGENTS.md:108-111 adds that the same conditions apply before and after, with recorded commands and repeated samples, and that targeted timings must be kept separate from end-to-end latency.

## Harness

`benchmark/hover-popup.mjs` ([samples 19, settings 21-23, rule 29](https://github.com/bee-san/hachidori/blob/main/benchmark/hover-popup.mjs#L19-L29)) drives real pointer movement through the content script, with fresh Chrome profiles. It records input → first correct frame, input → complete stable result, blank time, `Performance.getMetrics` deltas and long tasks. T-26 extends it:

- `HACHIDORI_HOVER_OPTIONS`: JSON merged into the options the harness writes. `{"popupTheme":"<slug>"}` selects a theme exactly as Settings does. This upstreams the evidence `harness-benchmark.patch`.
- **Renderer-neutral readiness.** The probe waits for the host's `data-hd-render-state="complete"` / `hd:render:complete` mark and takes the expected headwords from the model. It no longer uses `.gsm-hoshidicts-expression` / `.gsm-hoshidicts-show-more` ([hover-popup-probe.js:13-20](https://github.com/bee-san/hachidori/blob/main/benchmark/hover-popup-probe.js#L13-L20)), which a non-Default renderer does not produce.
- Per scan it records host measures (`hd:model`, `hd:render:<id>`), CDP `LayoutDuration`, `RecalcStyleDuration`, `ScriptDuration`, `Nodes` and `JSHeapUsedSize`, and **dictionary work counters**: `hd_styles` requests, dictionary `<style>` elements, structured-content nodes, images.
- A kanji-view step (click the 漢 link → kanji entries in the DOM → next frame) and the 24-sense fixture (`benchmark/theme-fixture.mjs`, from the evidence `theme-bench-fixture.mjs`).

## Inputs (identical on both sides)

| Input | What |
| --- | --- |
| short | 食べる (flat entry; hover fixture) |
| long | 漢字 with 24 numbered senses (233 popup nodes under Default) |
| deep | 深層, gloss under 40 nested elements |
| kanji | click 漢 → kanji view |
| nested | hover inside the definition → child popup (skipped for `none`-mode renderers, and reported as skipped) |
| cold | first hover of a fresh profile (catches load-at-first-popup costs) |

Five fresh profiles per side (CI never uses fewer than 3), back to back on one machine, same Chrome for Testing 152.0.7977.75, same archives. Record the load average at the start. Runs on a loaded host are noise in both directions. The Kanji Atlas, Learner Focus and denshi runs show this.

## What gets benchmarked (all themes, c28)

- **Every PR** measures each changed theme against Default. Renderers and variants run the full input set. Palettes run the short, long and kanji inputs, because they change only colours on the Default renderer.
- **Weekly and on each `fixture/HACHIDORI_COMMIT` bump**, `benchmark-main.yml` re-measures the whole catalogue, sharded across jobs so it stays under an hour. Every published theme therefore has a current `benchmarks/<slug>.json`, and the Store shows its numbers.
- **Renderer themes must also prove the saving**, because c28 wants them "so we save on rendering cost". The run must show zero Default DOM (no `.gsm-hoshidicts-result-chrome` or `.gsm-hoshidicts-glossary-card`), no `default.css` adopted, and, in `text`/`none` mode, zero dictionary work.

## Budgets (CI fails the PR when any is broken)

| Budget | Rule |
| --- | --- |
| End-to-end regression vs Default | For each input, median hover → complete, kanji open and cold first hover must **not** be both > 5 ms **and** > 10 % slower. This is the harness's own rule ([hover-popup.mjs:29](https://github.com/bee-san/hachidori/blob/main/benchmark/hover-popup.mjs#L29)). |
| Memory | Reading-tab JS heap Δ at session end ≤ 2 MiB |
| Omitted work is not done | A renderer declaring only `text`/`none` must show 0 `hd_styles` requests, 0 dictionary style elements, 0 structured-content nodes and 0 images. |
| Renderer baseline | A renderer's `renderBuildMs` p95 and node count must not regress by more than max(1 ms, 10 %) against its own previous published result. |
| Stability | The harness asserts identical result signatures across profiles, so a theme that changes *what* is shown fails there first. `renderer fallback` in any row fails. |

The `onRender` p95 ≤ 2 ms / max ≤ 8 ms budget applied to the post-render prototype and is retired for full renderers (D7). The prototype's numbers remain evidence.

## Store labels (c08)

- **⚡ Lighter** is shown when three things hold: nodes ≤ 75 % of Default's on every input, (style + layout + script) median ≤ 75 % of Default's, and no end-to-end median worse than Default by more than one frame (16.7 ms).
- **standard** is everything else that passes the budgets, and gets no badge.
- There is **no slow tier**, because over-budget themes are rejected (D18).
- The detail pane shows the numbers relative to Default and the Hachidori/Chrome versions they were measured on. [c22](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825617147) suggested exactly this ("as fast as default", "+N ms").

## Comparative report required by c26 (T-52, after T-32/T-33)

Default · Nazeka **onRender prototype** (evidence host, rebased only for measurement) · Nazeka **direct renderer** · **Plain** · Yomitan · Rikaikun (+ Wicked if T-33 is built), with identical inputs. The report gives the renderer build, style/layout/script, nodes, heap, cold first hover, hover/kanji end-to-end and the dictionary work counters. It claims only what the numbers show: "direct rendering gives simpler themes an opportunity to do less work; it does not guarantee a speedup or make dictionary lookup faster" (c26). The Plain row answers c05's "show how much faster that is". Plain is the owner's "as fast as possible" theme and is expected to earn ⚡Lighter.

## How to benchmark a theme (tested guide from the original body, updated)

The original guide was tested end to end from a clean shell (`env -i`, fresh clone, only Node on `PATH`; 1 min 53 s including the clone, `npm ci`, the Chrome download and both runs): [guide-test.txt](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/guide-test.txt).

1. Check out Hachidori at the commit `hachidori-theme-store` pins in `fixture/HACHIDORI_COMMIT`, with **Node 22.23.1** (`.node-version`; `node --version` prints `v22.23.1`).
2. `npm ci --prefix test/tooling` installs the lockfile's puppeteer-core and `@puppeteer/browsers`, nothing global.
3. `npm --prefix test/tooling run install:chrome` installs Chrome for Testing **152.0.7977.75** (`config.chrome` in [test/tooling/package.json](https://github.com/bee-san/hachidori/blob/main/test/tooling/package.json#L12-L15)).
4. Before T-26 merges, apply the two evidence patches ([host-prototype.patch](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch), [harness-benchmark.patch](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/harness-benchmark.patch)). Their content.js hunk no longer applies at 0ea6167 or later and needs manual rebasing, so it is only useful for the prototype measurement. After T-26/T-50, use `node scripts/vendor-themes.mjs --local ../hachidori-theme-store` instead.

```sh
export HACHIDORI_CHROME=$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome
export HACHIDORI_PUPPETEER=$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export HACHIDORI_HOVER_SAMPLES=5
node benchmark/hover-popup-fixture.mjs /tmp/bench/hover-popup-fixture.zip
node benchmark/theme-fixture.mjs /tmp/bench            # 24-sense 漢字 + kanji bank (T-26; evidence: theme-bench-fixture.mjs)
A="/tmp/bench/hover-popup-fixture.zip /tmp/bench/theme-bench-senses.zip /tmp/bench/theme-bench-kanji.zip"
node benchmark/hover-popup.mjs /tmp/bench/default $A                                             # baseline, ≈ 35 s
HACHIDORI_HOVER_OPTIONS='{"popupTheme":"<slug>"}' node benchmark/hover-popup.mjs /tmp/bench/<slug> $A   # ≈ 35 s
node benchmark/theme-summary.mjs /tmp/bench/default /tmp/bench/<slug> /tmp/bench/summary          # table + verdict + label
```

- **Duration**: about 35 s per side at 5 profiles (56 timed scans each), about 2 min in all.
- **Reading the output**:
  - `first`/`complete` are frame-quantised (16.7 ms steps at 60 Hz), so compare medians and treat a one-frame p95 difference as noise.
  - `renderBuildMs`, `style · layout · script` and `nodes` show where a theme spends its time.
  - `fallback: true` in any row means the renderer threw. Fix it before submitting.
  - `summary.md` ends with the verdict and the label.
