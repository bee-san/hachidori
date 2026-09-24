## Theme proposal: Retro Terminal — an amber phosphor candidate list with j/k selection, pitch as `LHL`, and a status line

Slug `retro-terminal`, built against the schema-1 host in `host-prototype.patch`, captured in the real popup (Chrome for Testing 152.0.7977.75, Hachidori 0.1.6, dictionaries imported through Settings). Every file named below — theme files, `capture-retro-terminal.mjs`, `evidence.json` (measured DOM state behind every screenshot), `bench-themes.mjs` + `bench-summary.json`, contrast scripts — is on branch `evidence/issue-330-theme-retro-terminal` under [`docs/evidence/issue-330/themes/retro-terminal/`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal).

### The learner moment

Japanese has no spaces, so a hover is rarely one word: `掛けたかった` gives JMdict six parses (掛ける, 掛け ×2, 掛 ×3), `日本語` nine. Today the popup opens on the first parse's card with its 26 senses and the other five wait below "Show more", so you learn what else the reader found by scrolling past 26 lines of 掛ける. A reader deep in a visual novel already knows most of those senses; when the popup opens they want *which* word this is, how it is said and how common it is — for every candidate at once — and one keypress to the right one.

Retro Terminal borrows the oldest Japanese UI there is, the IME candidate window. The top of the popup is a fixed-width list, one line per parse — `idx | word▮ | reading | LHL[2] | #rank | 26 senses · JMdict` — six rows visible, the rest scroll. The selected row is inverse video with a blinking block cursor; `j`/`k` (↑/↓, `1`–`9`, `g`/`G`) move it and the body scrolls to that record; `m` presses Show more; `⏎` presses the reader's Anki button for the selected entry. The headword line carries the reading in NHK notation (`たべ＼る`: drop after べ, nothing for heiban) and the deinflection as a trace (`← 食べたかった · -た › -たい`); the bottom line is a vim-style status line — `TERM 1/6 │ 掛ける かけ＼る │ LHL[2] │ #202㋕ │ Looked up 2 times` — the line you would copy into your notes. `LHL[2]` is what OJAD/NHK-accent learners write; it is the contour graph without the graph.

The look is one P3 phosphor at three intensities (`#ffd166` headword, `#ffb000` text, `#d09a1e` readings and rules) on `#0b0a06`, monospace, box rules, `[bracketed]` tags, an optional CRT raster. Nostalgia is the excuse; the reasons are functional: monospace lines the columns up without a table, one colour encodes nothing in hue, no `backdrop-filter` blur, and the popup hugs its content (307 px for 食べたかった instead of a fixed 420).

**Why JavaScript.** None of that is CSS: the candidate list is a *new* element whose rows aggregate text from *n* entries (headword, reading from `aria-label`, pitch attributes turned into `LHL`/`＼`, frequency values, dictionary names, sense counts); the status line moves the reader's lookup-count node and summarises the selected entry; selection is state (keyboard, click, scroll) kept across progressive re-renders; a `<details>` becomes a trace line, a `<dl>` a stats line. CSS does the rest: palette, monospace, key caps, rules, raster, blink, reduced motion.

### Screenshots

Real popup on a plain page, 2× scale, hover lookups, opacity 100. Left default, right Retro Terminal, same lookup.

**食べたかった, fixture dictionary** — 560 × 420 → 560 × 307; headword `18px rgb(255, 209, 102)`, inline `たべ＼る`, trace, two candidates, status `TERM 1/2 │ 食べる たべ＼る │ LHL[2] LHH[0] +1 │ #142 │ tabeɾɯ │ Looked up 2 times`.

![Default vs Retro Terminal, 食べたかった term view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/side-by-side-term.png)

**Keyboard** — click a row (the popup takes focus), press `j`: row 2 goes inverse video with the block cursor after 食 and a dashed focus ring, the gutter mark moves to record 2, the status follows (`TERM 2/2 │ 食 たべもの`); `k` came back.

![Row 1 selected, then after pressing j](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/keyboard-states.png)

**Long entry: 掛けたかった with JMdict + Kanjium pitch + JPDB frequency** — six candidates with pitch (`LHL[2]`, `LH[0]`, `—` where Kanjium has none), JPDB rank and sense counts (26, 6, 8, 8, 2, 6); the body is a flat numbered list with `[1][v1][vt][uk]` in a fixed column. After `j` `j` record 3 is selected and the body scrolled to it (`retro-long-keyboard.png`); `G` jumps to 6/6 (`retro-long-last.png`).

![Default vs Retro Terminal, 掛けたかった](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/long-entry.png)

**Nine candidates: 日本語** — the six-row window (`にほんご LHHH[0]`, `にっぽんご LHHHH[0]`, `にほん LHL[2]`, `にっぽん LHHL[3]`, 日 ×5); `3` selects 日本 and the body shows record 3.

![Candidate list for 日本語, then after pressing 3](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/candidate-list.png)

**食 kanji view (fixture)** — glyph in a double rule, `ON`/`KUN` columns, numbered meanings, `Details` flattened to `strokes 9 · grade 2 · freq 382`. Back re-rendered the term view and the hook ran again (`afterBack.themed: true`).

![Default vs Retro Terminal, 食 kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/side-by-side-kanji.png)

**分 with KANJIDIC** — 34 indexes: the line keeps `strokes 4 · grade 2 · jlpt 4 · freq 24`, `+ Details` keeps the other 30.

![Default vs Retro Terminal, 分 KANJIDIC kanji view](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/kanji-real.png)

**`prefers-reduced-motion: reduce`** ([`retro-term-reduced-motion.png`](https://raw.githubusercontent.com/bee-san/hachidori/evidence/issue-330-theme-retro-terminal/docs/evidence/issue-330/themes/retro-terminal/retro-term-reduced-motion.png)): raster gone (`::after` `display: none`), cursor a static 2.8 px bar (`animation-name: none`), nothing else changes (`evidence.json` → `reducedMotion`).

### What the JavaScript does

All inside `onRender(view, api)` on the DOM the reader produced; no lookups, network, storage or HTML strings (only `api.el`).

- **Inline reading in ＼ notation** from `.gsm-hoshidicts-expression[aria-label="<expr>, <reading>"]` (the only plain-text reading) and the header's `.gsm-hoshidicts-pitch-mora[data-pitch-level][data-pitch-transition]` spans → `span.rt-reading` (`api.el` + `api.move`); theme.css hides the `rt` furigana.
- **Deinflection trace**: `details.gsm-hoshidicts-deinflection` (`-endpoint`, `-step-name`) → `span.rt-trace`, the disclosure `api.hide`n.
- **Candidate list**: `div.rt-list[role=listbox]` moved between `view.chrome` and `view.content`; one `div.rt-row[role=option]` per `view.entries[i]` from its `.gsm-hoshidicts-tag-pitch` morae (→ `LHL[2]`), `.gsm-hoshidicts-frequency-value` (→ `#202㋕`), `.gsm-hoshidicts-glossary-card-title` and `.gsm-hoshidicts-definitions > li` count (→ `26 senses · JMdict`). Rows are built **once per entry node** (WeakMap state per popup): the reader appends later entries in 8 ms batches and calls `onRender` after each, so list and status are reused.
- **Metadata absorbed**: `api.hide` on `.gsm-hoshidicts-primary-metadata-row` and `.gsm-hoshidicts-metadata` in every entry; the reader's `.gsm-hoshidicts-lookup-stats` node is `api.move`d into the status line, so its later repaint lands there.
- **Status line** `div.rt-status` appended to `view.popup`: mode, `i/n`, selected word + ＼ reading, all pitches (`LHL[2] LHH[0] +1`), rank per frequency dictionary, IPA (`.gsm-hoshidicts-ipa-body`), lookup count, key hints.
- **Selection** `select(i)`: `aria-selected`/roving `tabIndex` on rows, `data-rt-selected` on the entry (CSS gutter mark + inverse video), status rewrite; on user navigation only, scroll the list window and `view.content` to `entry.offsetTop`. Listeners attach **once per popup** (`keydown`, `click`, capture-phase `scroll`); `onDeactivate` removes them and every `.rt-*` node and un-hides what was hidden.
- **Keyboard** (focus inside the popup only; the hover popup never steals focus): `j`/`k`, ↑/↓, Home/End in the list, `g`/`G`, `1`–`9`, `m` → `.gsm-hoshidicts-show-more`, `⏎` → the selected entry's `.gsm-hoshidicts-mine-button`. Modifier combinations pass through, so the reader's keybinds (Alt+↑/↓…) still work; they scroll the body and the `scroll` listener re-derives the selection from `scrollTop` (`less` model).
- **Kanji**: `details.gsm-hoshidicts-kanji-stats > dl` → `div.rt-stats` (`strokes · grade · jlpt · freq`); the disclosure stays when there is more.
- **Fresh vs continued render** by `view.entries[0]` identity: a new lookup, tab or Back resets to row 1; a batch or Show more keeps the selection.
- **Never throws**: every lookup is null-checked, every column degrades to `—` (string pitches, entries without frequency, kana-only headwords).

### theme.yaml / theme.css / theme.js

`theme.yaml` validates against the skeleton's `theme.schema.json` (Ajv 2020-12, strict; see gap 6); `theme.js` passes the skeleton's ESLint gate with 0 problems and exports exactly the declared hooks (`lint-run.txt`; the same config gives a hostile `document`/`fetch`/`innerHTML`/`setTimeout` snippet 7 errors). Sizes: yaml 2.0 KB, css 24.2 KB, js 20.9 KB (limit 64 KiB).

`themes/retro-terminal/theme.yaml`

```yaml
# themes/retro-terminal/theme.yaml — Hachidori theme manifest, schema 1
schema: 1
slug: retro-terminal
name: Retro Terminal
version: 1.0.0
author: hachidori contributors
link: https://github.com/bee-san/hachidori/issues/334
description: An amber phosphor terminal. JS turns the popup into a text-mode UI — a candidate list in fixed columns (word, reading, pitch as LHL, rank), j/k selection in inverse video with a blinking cursor, and a status line — over a monospace single-colour popup with optional CRT scanlines.
tags: [dark, compact, monochrome, vn, js]
license: GPL-3.0-or-later
minHachidoriVersion: 0.1.7
mode: dark
extends: default
palette:                     # one phosphor: P3 amber (#ffb000) at three intensities on near-black
  color-scheme: dark
  base-100: "#0b0a06"        # screen
  base-200: "#12100a"
  base-300: "#1a170e"
  base-content: "#ffb000"    # normal text: 10.9:1 on base-100
  primary: "#ffb000"         # selection / inverse video
  primary-content: "#0b0a06"
  secondary: "#ffd166"       # bright: headword, kanji glyph
  secondary-content: "#0b0a06"
  accent: "#d09a1e"          # dim: readings, rules, key hints (7.9:1)
  accent-content: "#0b0a06"
  neutral: "#2a2412"
  neutral-content: "#ffb000"
  info: "#2a2412"
  info-content: "#ffb000"
  success: "#ffd166"
  warning: "#ffb000"
  error: "#ff9f1c"
css: theme.css
js:                          # bundled-only: shipped inside the Hachidori release, never fetched at runtime
  file: theme.js
  hooks: [onRender, onDeactivate]
  summary: Builds a candidate list, inline reading with pitch notation, a deinflection trace and a status line from the rendered entries; adds j/k, arrow and 1-9 keyboard selection while the popup has focus.
options:                     # one-shot suggestions applied on activation, with Undo
  popupOpacityPercent: 100   # phosphor does not blend with the page
  popupColumns: 1
  popupToolbarPosition: top
screenshot: screenshot.png
preview:
  swatches: ["#0b0a06", "#ffb000", "#ffd166", "#d09a1e"]
```

`themes/retro-terminal/theme.css`

```css
/* themes/retro-terminal/theme.css — an amber phosphor terminal (issue #334).
 *
 * One phosphor, three intensities: bright #ffd166 (headword), normal #ffb000
 * (text, inverse-video selection), dim #d09a1e (readings, rules, hints) on
 * #0b0a06. Contrast, plain / through the darkest CRT scanline row: text 10.8 /
 * 8.1, bright 13.7 / 10.1, dim 7.9 / 5.9, inverse video 10.8 / 8.1 (measured).
 *
 * Structure is theme.js's job (candidate list, inline reading, trace, status
 * line, j/k selection). This file gives the popup its text-mode look, restyles
 * the reader's controls as key caps, and draws the optional CRT overlay, which
 * is off under prefers-reduced-motion together with the blinking cursor.
 * The palette block is what `build-index.mjs` generates from theme.yaml. */

:host([data-hoshidicts-theme="retro-terminal"]) {
  --hoshidicts-palette-color-scheme: dark;
  --hoshidicts-palette-base-100: #0b0a06;
  --hoshidicts-palette-base-200: #12100a;
  --hoshidicts-palette-base-300: #1a170e;
  --hoshidicts-palette-base-content: #ffb000;
  --hoshidicts-palette-primary: #ffb000;
  --hoshidicts-palette-primary-content: #0b0a06;
  --hoshidicts-palette-secondary: #ffd166;
  --hoshidicts-palette-secondary-content: #0b0a06;
  --hoshidicts-palette-accent: #d09a1e;
  --hoshidicts-palette-accent-content: #0b0a06;
  --hoshidicts-palette-neutral: #2a2412;
  --hoshidicts-palette-neutral-content: #ffb000;
  --hoshidicts-palette-info: #2a2412;
  --hoshidicts-palette-info-content: #ffb000;
  --hoshidicts-palette-success: #ffd166;
  --hoshidicts-palette-warning: #ffb000;
  --hoshidicts-palette-error: #ff9f1c;
}

/* -- the screen -- */

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup {
  --rt-bg: var(--hoshidicts-palette-base-100);
  --rt-fg: var(--hoshidicts-palette-base-content);
  --rt-bright: var(--hoshidicts-palette-secondary);
  --rt-dim: var(--hoshidicts-palette-accent);
  --rt-line: #5c4409;                 /* rules and key-cap borders: decorative, never text */
  --rt-soft: #241c08;                 /* hovered row */
  --rt-glow: rgba(255, 209, 102, 0.35);
  --hoshidicts-border: var(--rt-line);
  --hoshidicts-border-strong: var(--rt-fg);
  --hoshidicts-text-muted: var(--rt-dim);
  --hoshidicts-text-faint: var(--rt-dim);
  --hoshidicts-card-background: transparent;
  --hoshidicts-accent-soft: var(--rt-soft);
  --hoshidicts-scrollbar: var(--rt-dim);
  --hoshidicts-link: var(--rt-bright);
  --hoshidicts-link-hover: var(--rt-bright);
  height: auto !important;                                 /* the screen hugs its text … */
  max-height: var(--gsm-hoshidicts-popup-height, 420px);   /* … up to the Design height */
  border: 1px solid var(--rt-fg);
  border-radius: 3px;
  -webkit-backdrop-filter: none;                           /* no 16 px blur: cheaper to paint than the default */
  backdrop-filter: none;
  box-shadow: 0 0 0 3px #171208, 0 0 22px rgba(255, 176, 0, 0.14);   /* bezel + faint phosphor bloom */
  color: var(--rt-fg);
  font-family: ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
}

/* Optional CRT: a 3 px scanline raster; text through the dark line keeps ≥ 5.9:1
 * (measured). Off entirely under reduced motion. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0, 0, 0, 0.14) 2px 3px);
  box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.35);           /* bezel shadow, inside the 8 px padding */
}

@media (prefers-reduced-motion: reduce) {
  :host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup::after {
    display: none;
  }
}

:host([data-hoshidicts-theme="retro-terminal"]) [data-theme-hidden] {
  display: none !important;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup ::-webkit-scrollbar {
  width: 7px;
  height: 7px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup ::-webkit-scrollbar-thumb {
  border: 0;
  border-radius: 0;
  background: var(--rt-dim);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup ::-webkit-scrollbar-track {
  background: var(--rt-soft);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-resize-handle {
  background: repeating-linear-gradient(135deg, transparent 0 3px, var(--rt-bg) 3px 4px);
}

/* -- title bar: > 食べる たべ＼る  ← 食べたかった · たい › 過去   [♪][✎][×] -- */

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-result-chrome {
  flex-shrink: 0;                    /* the body scrolls, the title bar never does */
  max-height: none;
  border-bottom: 1px solid var(--rt-line);
  background: transparent;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-primary-header {
  min-height: 0;
  padding: 4px 8px 3px;
  gap: 2px 12px;
  align-items: baseline;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-headword {
  gap: 0 10px;
  align-items: baseline;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-expression {
  font-size: 18px;
  line-height: 1.3;
  color: var(--rt-bright);
  text-shadow: 0 0 6px var(--rt-glow);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-primary-header .gsm-hoshidicts-expression::before {
  content: "> ";
  color: var(--rt-dim);
  font-size: 13px;
  text-shadow: none;
}

/* The reading is shown inline (theme.js), in the NHK ＼ notation when a pitch exists. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-expression rt {
  display: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-reading {
  color: var(--rt-dim);
  font-size: 14px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-trace {
  flex: 1 1 100%;
  min-width: 0;
  color: var(--rt-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-trace > b {
  color: var(--rt-fg);
  font-weight: 400;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-compact-definition-summary {
  display: none;                     /* the glosses are one line below anyway */
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-link {
  border-bottom: 1px dotted var(--rt-dim);
}

/* Action buttons become key caps; their currentColor icon masks stay. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-actions {
  margin: 0;
  padding: 0;
  gap: 3px;
  align-self: baseline;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-actions > button,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-audio-control > button,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-back,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup-close {
  flex: 0 0 auto;
  width: auto;
  height: 22px;
  min-width: 22px;
  min-height: 22px;
  padding: 0 4px;
  border: 1px solid var(--rt-line);
  border-radius: 2px;
  background: transparent;
  color: var(--rt-dim);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-actions button:hover:not(:disabled),
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-actions button:focus-visible {
  border-color: var(--rt-fg);
  background: var(--rt-fg);
  color: var(--rt-bg);
  outline: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-actions .hd-icon,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-audio-button::before,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-popup-close::before {
  width: 16px;
  height: 16px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-back::before {
  content: "← ";
}

/* Dictionary tabs: [All] [JMdict] — the selected one in inverse video. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-metadata-strip {
  padding: 0 8px 3px;
  border-top: 0;
  gap: 4px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab-list {
  gap: 2px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab {
  min-height: 0;
  max-width: 24ch;
  padding: 0 1px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--rt-dim);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab::before { content: "["; }
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab::after { content: "]"; }

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab:hover:not(:disabled):not([aria-selected="true"]) {
  background: var(--rt-soft);
  color: var(--rt-fg);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab[aria-selected="true"] {
  background: var(--rt-fg);
  color: var(--rt-bg);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab:focus-visible {
  outline: 1px dashed var(--rt-bright);
  outline-offset: 0;
}

/* -- candidate list (theme.js): idx | word▮ | reading | LHL[2] | #rank | senses · dicts -- */

:host([data-hoshidicts-theme="retro-terminal"]) .rt-list {
  position: relative;                /* row.offsetTop is then relative to the list (theme.js) */
  display: grid;
  grid-template-columns: 2ch minmax(6ch, max-content) minmax(5ch, max-content) minmax(4ch, max-content) minmax(3ch, max-content) minmax(0, 1fr);
  column-gap: 1.5ch;
  flex: 0 0 auto;
  max-height: calc(6 * 20px + 4px);          /* six candidates, then the list scrolls */
  margin: 0;
  padding: 2px 8px;
  overflow-x: hidden;
  overflow-y: auto;
  border-bottom: 1px solid var(--rt-line);
  line-height: 20px;
  user-select: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: baseline;
  cursor: pointer;
  white-space: nowrap;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row:hover:not([aria-selected="true"]) {
  background: var(--rt-soft);
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row[aria-selected="true"] {
  background: var(--rt-fg);
  color: var(--rt-bg);
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row:focus-visible {
  outline: 1px dashed var(--rt-bright);
  outline-offset: -1px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row[aria-selected="true"]:focus-visible {
  outline-color: var(--rt-bg);
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-idx {
  text-align: right;
  color: var(--rt-dim);
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-word {
  color: var(--rt-bright);
  font-size: 14px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-read,
:host([data-hoshidicts-theme="retro-terminal"]) .rt-dict {
  color: var(--rt-dim);
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-pitch {
  letter-spacing: 0.04em;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-freq {
  text-align: right;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row[aria-selected="true"] > span {
  color: inherit;
}

/* The block cursor after the selected headword blinks; a static bar under
 * reduced motion. (@keyframes: see the proposal's note on the sanitiser.) */
:host([data-hoshidicts-theme="retro-terminal"]) .rt-cur::after {
  content: "";
  display: inline-block;
  width: 0.55em;
  height: 0.95em;
  margin-left: 2px;
  vertical-align: -0.1em;
  background: transparent;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-row[aria-selected="true"] .rt-cur::after {
  background: currentColor;
  animation: rt-blink 1.06s steps(1, end) infinite;
}

@keyframes rt-blink {
  50% { background: transparent; }
}

@media (prefers-reduced-motion: reduce) {
  :host([data-hoshidicts-theme="retro-terminal"]) .rt-row[aria-selected="true"] .rt-cur::after {
    width: 0.2em;
    animation: none;
  }
}

/* -- body: the reader's entries as flat terminal records -- */

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-content-scroll {
  position: relative;                /* entry.offsetTop is then the scroll target (theme.js) */
  flex: 0 1 auto;
  padding: 0 8px 4px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tab-panel {
  counter-reset: rt-entry;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry {
  counter-increment: rt-entry;
  margin: 0;
  padding: 0 0 3px 6px;
  border: 0;
  border-left: 2px solid transparent;   /* the gutter marks the current record */
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry[data-rt-selected],
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry[data-rt-selected] {
  border-left-color: var(--rt-fg);
}

/* The primary entry's headword lives in the title bar, so its record rule is a
 * counter; the others restyle their own header. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry:first-child::before {
  content: "── " counter(rt-entry) " ──";
  display: block;
  margin-top: 3px;
  color: var(--rt-dim);
  font-size: 12px;
  line-height: 20px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-header {
  min-height: 0;
  margin-top: 3px;
  gap: 0 8px;
  flex-wrap: nowrap;
  align-items: baseline;
  line-height: 20px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-header:not(.gsm-hoshidicts-primary-header) > .gsm-hoshidicts-headword::before {
  content: "── " counter(rt-entry) " ";
  color: var(--rt-dim);
  font-size: 12px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-header:not(.gsm-hoshidicts-primary-header) .gsm-hoshidicts-expression {
  font-size: 15px;
  text-shadow: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-header:not(.gsm-hoshidicts-primary-header) .rt-reading {
  font-size: 13px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-entry-header > .gsm-hoshidicts-entry-actions {
  flex: 0 0 auto;
  margin-left: auto;
}

/* Glosses: one flat numbered list per dictionary, the dictionary as a dashed rule. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-grid {
  display: block;
  margin: 0;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-card {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-card-title,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-dictionary,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry h4 {
  display: flex;
  align-items: center;
  gap: 1ch;
  margin: 2px 0 0;
  color: var(--rt-dim);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-card-title::after,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-dictionary::after,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry h4::after {
  content: "";
  flex: 1 1 auto;
  border-top: 1px dashed var(--rt-line);
}

/* One flat numbered list per dictionary; the number is a counter so the sense's
 * tags and gloss share its line. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definitions,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definitions-single {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: rt-sense;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definitions > li {
  display: flex;
  align-items: baseline;
  gap: 0 1ch;
  margin: 0;
  padding: 0;
  counter-increment: rt-sense;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definitions > li::before {
  content: counter(rt-sense) ".";
  flex: 0 0 3ch;
  color: var(--rt-dim);
  text-align: right;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-meanings {
  margin: 0;
  padding-left: 4ch;
  list-style: decimal;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-meanings > li {
  margin: 0;
  padding: 0;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-meanings > li::marker {
  color: var(--rt-dim);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-content {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.45;
}

/* One phosphor: dictionary-authored colours and boxes flatten to amber; images
 * are tinted. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-content * {
  color: inherit !important;
  background: transparent !important;
  border-color: var(--rt-line) !important;
  box-shadow: none !important;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-glossary-content img,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-image-hover-preview img {
  filter: grayscale(1) sepia(1) saturate(3) hue-rotate(-8deg) brightness(0.9) contrast(1.1);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definition-tags {
  flex: 0 1 auto;
  max-width: 22ch;                   /* long JMdict tag lists wrap here rather than push the gloss */
}

/* Tags are [bracketed] dim text, no pills. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tags,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-definition-tags {
  gap: 0 0.5ch;
  margin: 0;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tag {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent !important;
  color: var(--rt-dim);
  font: inherit;
  font-size: 11px;
  line-height: inherit;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tag::before { content: "["; }
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-tag::after { content: "]"; }

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-show-more {
  margin: 4px 0 0;
  padding: 0 1ch;
  border: 1px dashed var(--rt-line);
  border-radius: 0;
  background: transparent;
  color: var(--rt-dim);
  font-size: 12px;
  line-height: 20px;
  text-align: left;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-show-more::before {
  content: "+ ";
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-show-more:hover,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-show-more:focus-visible {
  border-color: var(--rt-fg);
  background: var(--rt-soft);
  color: var(--rt-fg);
}

/* -- status line (theme.js): inverse video, pinned to the bottom -- */

:host([data-hoshidicts-theme="retro-terminal"]) .rt-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 1.5ch;
  min-height: 20px;
  padding: 0 18px 0 8px;             /* room for the resize handle */
  background: var(--rt-fg);
  color: var(--rt-bg);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  user-select: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-mode {
  flex: 0 0 auto;
  font-weight: 700;
  letter-spacing: 0.08em;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-info {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The key hint gives way first (flex-shrink 1000 vs the info's 1). */
:host([data-hoshidicts-theme="retro-terminal"]) .rt-keys {
  flex: 0 1000 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-status .gsm-hoshidicts-lookup-stats {
  display: inline;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-status .gsm-hoshidicts-lookup-stats[hidden] {
  display: none;
}

/* -- messages, note form, audio menu -- */

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-mining-feedback,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-lookup-notice {
  margin: 0;
  padding: 1px 8px;
  border: 0;
  border-top: 1px solid var(--rt-line);
  border-radius: 0;
  background: transparent;
  color: var(--rt-fg);
  font-size: 12px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-mining-feedback::before,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-lookup-notice::before {
  content: "! ";
  color: var(--rt-dim);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-note-form {
  margin: 4px 8px;
  border: 1px solid var(--rt-line);
  border-radius: 0;
  background: transparent;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-note-form input,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-note-form textarea,
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-note-actions button {
  border-radius: 0;
  font-family: inherit;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-audio-menu {
  border: 1px solid var(--rt-fg);
  border-radius: 0;
  background: var(--rt-bg);
  font-family: inherit;
}

/* -- kanji view: a double-ruled glyph, readings in columns, stats as a line -- */

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-navigation {
  gap: 0 12px;
  align-items: center;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-navigation::before {
  content: "> kanji";
  color: var(--rt-dim);
  font-size: 13px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-glyph {
  padding: 2px 8px;
  border: 3px double var(--rt-fg);
  color: var(--rt-bright);
  font-size: 40px;
  line-height: 1.1;
  text-shadow: 0 0 8px var(--rt-glow);
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry {
  margin-top: 3px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-dictionary {
  margin-top: 4px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-readings {
  display: grid;
  grid-template-columns: 4ch minmax(0, 1fr);
  gap: 0 1ch;
  margin: 2px 0 0;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-reading-group {
  display: contents;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-reading-group > strong {
  color: var(--rt-dim);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-entry h4 {
  margin-top: 4px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-stats {
  margin-top: 3px;
  color: var(--rt-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}

:host([data-hoshidicts-theme="retro-terminal"]) .rt-stats > b {
  color: var(--rt-fg);
  font-weight: 400;
}

/* The remaining indexes (KANJIDIC has ~34) stay behind the reader's disclosure. */
:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats {
  margin-top: 2px;
  font-size: 12px;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats > summary {
  color: var(--rt-dim);
  list-style: none;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats > summary::before {
  content: "+ ";
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats[open] > summary::before {
  content: "- ";
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats > summary:focus-visible {
  outline: 1px dashed var(--rt-bright);
  outline-offset: 0;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats dl {
  grid-template-columns: minmax(12ch, auto) 1fr;
  gap: 0 1ch;
  margin: 2px 0 0 2ch;
}

:host([data-hoshidicts-theme="retro-terminal"]) .gsm-hoshidicts-kanji-stats dt {
  color: var(--rt-dim);
}
```

`themes/retro-terminal/theme.js`

```js
// themes/retro-terminal/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis/timers/observers — only
//    `view` and `api`;
//  - a hook that throws switches this module off for the page; CSS keeps working,
//    so nothing below relies on throwing: every lookup is null-checked and every
//    column degrades to "—".
//
// The popup becomes a text-mode UI built only from what the reader rendered: the
// reader's title bar (headword + inline ＼ reading + deinflection trace), a
// candidate list `idx | word▮ | reading | LHL[2] | #rank | senses · dicts`, the
// reader's entries as flat records, and an inverse-video status line.
//
// Keyboard, while focus is inside the popup (click a row or Tab in): j/k, ↑/↓ in
// the list, g/G, Home/End, 1-9 pick a candidate, Enter mines the selected entry
// to Anki, m presses "Show more". The selection also follows the body's scroll
// position, `less`-style, so the reader's own entry keybinds (Alt+↑/↓) move it too.

const SLUG = "retro-terminal";

// Metadata the list and status line absorb. The nodes stay in the DOM (hidden), so
// the reader's own references and later repaints keep working.
const HIDE_IN_TERM_ENTRIES = [
  ".gsm-hoshidicts-primary-metadata-row",   // lookup count (moved to the status line) + frequency capsule
  ".gsm-hoshidicts-metadata",               // frequency / pitch / IPA badges → list columns + status line
];

// Per-popup state. A popup outlives its renders; rows and entries are replaced by
// every onRender, listeners are attached once.
const states = new WeakMap();
const boundPopups = new Set();

const text = node => (node ? node.textContent.trim() : "");

// The renderer labels the headword "<expression>, <reading>" (popup.js
// createEntryHeader); that is the one place the reading exists as plain text.
function headwordOf(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { word: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { word: label, reading: "" };
}

// A pitch contour is a run of .gsm-hoshidicts-pitch-mora spans with
// data-pitch-level (high|low) and data-pitch-transition (rise|drop) — the nodes
// the graph is drawn from — written out as LHL and たべ＼る (NHK notation).
function contourText(morae) {
  let pattern = "";
  let notation = "";
  for (const mora of morae) {
    pattern += mora.dataset.pitchLevel === "high" ? "H" : "L";
    notation += mora.textContent;
    if (mora.dataset.pitchTransition === "drop") notation += "＼";
  }
  return { pattern, notation };
}

// Every pitch the reader rendered for an entry: its pitch badges (all
// dictionaries, deduplicated by the reader), else the furigana contour in the
// header (the user's preferred pitch dictionary).
function pitchesOf(entry, header) {
  const pitches = [];
  for (const tag of entry?.querySelectorAll(".gsm-hoshidicts-pitch-metadata .gsm-hoshidicts-tag-pitch") ?? []) {
    const morae = tag.querySelectorAll(".gsm-hoshidicts-pitch-mora");
    const position = text(tag.querySelector(".gsm-hoshidicts-pitch-position"));
    if (morae.length > 0) pitches.push({ ...contourText(morae), position });
    else if (tag.dataset.pronunciation) {
      // A pattern the reader could not draw (e.g. a raw "LHH" position): keep its text.
      pitches.push({ pattern: "", notation: "", position: tag.dataset.pronunciation.replace(/^\S+\s*/u, "") });
    }
  }
  if (pitches.length === 0 && header) {
    const morae = header.querySelectorAll(".gsm-hoshidicts-pitch-ruby .gsm-hoshidicts-pitch-mora");
    const reading = header.querySelector(".gsm-hoshidicts-pitch-reading");
    if (morae.length > 0 && reading) pitches.push({ ...contourText(morae), position: `[${reading.dataset.pitchPosition}]` });
  }
  return pitches;
}

// Frequency badges: one per dictionary, values already formatted by the reader
// ("142", "12k", "142位" when dictionary names are shown).
function frequenciesOf(entry) {
  const frequencies = [];
  for (const tag of entry?.querySelectorAll(".gsm-hoshidicts-tag-frequency") ?? []) {
    const values = [...tag.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(text).filter(Boolean);
    if (values.length > 0) frequencies.push({ dictionary: tag.dataset.dictionary || "", values });
  }
  return frequencies;
}

// One glossary card per dictionary; the <li> count is the sense count. The cards
// exist at hook time even when their glosses are still being filled in.
function dictionariesOf(entry) {
  return [...entry.querySelectorAll(".gsm-hoshidicts-glossary-card")].map(card => ({
    name: text(card.querySelector(".gsm-hoshidicts-glossary-card-title")),
    senses: card.querySelectorAll(".gsm-hoshidicts-definitions > li").length,
  }));
}

// "Why this matched": the reader's <details> with matched → deinflected endpoints
// and the rule names, flattened to one dim line.
function traceOf(header) {
  const details = header?.querySelector(".gsm-hoshidicts-deinflection");
  if (!details) return null;
  const [from, to] = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint")].map(text);
  const steps = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map(text).filter(Boolean);
  return { details, from, to, steps };
}

function hideAll(root, selectors, api) {
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) api.hide(node);
  }
}

// Reading beside the headword, in ＼ notation when a pitch is known. The furigana
// itself is hidden by theme.css.
function inlineReading(headword, expression, pitches, api) {
  if (!expression || headword.querySelector(":scope > .rt-reading")) return;
  const { word, reading } = headwordOf(expression);
  if (!reading || reading === word) return;
  const pitch = pitches.find(item => item.notation);
  api.move(api.el("span", "rt-reading", pitch ? pitch.notation : reading), headword, expression.nextSibling);
}

// Title bar: the primary headword stays where the reader put it (it is the first
// .gsm-hoshidicts-expression in DOM order); the reading goes beside it and the
// deinflection disclosure becomes a trace line.
function renderTitle(view, header, api) {
  const headword = header?.querySelector(".gsm-hoshidicts-headword");
  if (!headword) return;
  const expression = headword.querySelector(":scope > .gsm-hoshidicts-expression");
  if (!headword.querySelector(":scope > .rt-reading")) inlineReading(headword, expression, pitchesOf(view.entries[0], header), api);
  const trace = traceOf(header);
  if (!trace || headword.querySelector(":scope > .rt-trace")) return;
  const line = api.el("span", "rt-trace");
  line.append("← ", api.el("b", null, trace.from));
  if (trace.steps.length > 0) line.append(` · ${trace.steps.join(" › ")}`);
  api.move(line, headword, null);
  api.hide(trace.details);
}

// One candidate row: idx | word▮ | reading | LHL[2] | #rank | senses · dictionaries.
function buildRow(entry, index, header, pitches, api) {
  const expression = (index === 0 ? header : entry)?.querySelector(".gsm-hoshidicts-expression");
  const { word, reading } = headwordOf(expression);
  const pitch = pitches[0];
  const frequency = frequenciesOf(entry)[0];
  const dictionaries = dictionariesOf(entry);
  const senses = dictionaries.reduce((total, dictionary) => total + dictionary.senses, 0);
  const row = api.el("div", "rt-row");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  row.dataset.rtIndex = String(index);
  const wordCell = api.el("span", "rt-word", word);
  wordCell.append(api.el("span", "rt-cur"));
  row.append(
    api.el("span", "rt-idx", String(index + 1)),
    wordCell,
    api.el("span", "rt-read", reading && reading !== word ? reading : "—"),
    api.el("span", "rt-pitch", pitch ? `${pitch.pattern}${pitch.position}` : "—"),
    api.el("span", "rt-freq", frequency ? `#${frequency.values[0]}` : "—"),
    api.el("span", "rt-dict", `${senses} ${senses === 1 ? "sense" : "senses"} · ${dictionaries.map(item => item.name).join(", ")}`),
  );
  return row;
}

// The reader renders the first entry, appends the rest in 8 ms batches and calls
// onRender after each batch (and after Show more). Rows are built once per entry
// node and the list is kept, so a lookup costs O(n) across all its hook calls.
function renderTerm(view, api, state) {
  renderTitle(view, state.header, api);
  if (!state.list?.isConnected) {          // a fresh render: the reader's clear() removed the old list
    state.list = api.el("div", "rt-list");
    state.list.setAttribute("role", "listbox");
    state.list.setAttribute("aria-label", "Candidates");
    state.rowsByEntry = new Map();
    api.move(state.list, view.popup, view.content);   // between the title bar and the body
  }
  state.rows = state.entries.map((entry, index) => {
    let row = state.rowsByEntry.get(entry);
    if (row) return row;
    const header = index === 0 ? state.header : entry.querySelector(":scope > .gsm-hoshidicts-entry-header");
    const pitches = pitchesOf(entry, index === 0 ? header : null);
    const headword = header?.querySelector(".gsm-hoshidicts-headword");
    if (index > 0 && headword) inlineReading(headword, headword.querySelector(".gsm-hoshidicts-expression"), pitches, api);
    row = buildRow(entry, index, state.header, pitches, api);
    state.list.append(row);
    hideAll(entry, HIDE_IN_TERM_ENTRIES, api);
    state.rowsByEntry.set(entry, row);
    return row;
  });
}

// Kanji view: the essentials from the "Details" disclosure become one line under
// the meanings; the disclosure stays for the other indexes (KANJIDIC has 34).
const KANJI_STATS_LINE = ["strokes", "grade", "jlpt", "freq"];

function renderKanji(view, api, state) {
  state.list?.remove();
  state.list = null;
  state.rows = [];
  for (const entry of state.entries) {
    const stats = entry.querySelector(":scope > .gsm-hoshidicts-kanji-stats");
    if (!stats || entry.querySelector(":scope > .rt-stats")) continue;
    const values = new Map([...stats.querySelectorAll("dt")].map(name => [text(name).toLowerCase(), text(name.nextElementSibling)]));
    const line = api.el("div", "rt-stats");
    for (const name of KANJI_STATS_LINE) {
      if (!values.has(name)) continue;
      if (line.childNodes.length > 0) line.append(" · ");
      line.append(`${name} `, api.el("b", null, values.get(name)));
    }
    if (line.childNodes.length === 0) continue;
    api.move(line, entry, stats);
    if (values.size <= KANJI_STATS_LINE.length) api.hide(stats);   // nothing left to disclose
  }
}

// Status line: mode, position, the selected entry's word/pitch/rank/IPA, the
// reader's own lookup count (moved in, so its later repaint lands here) and keys.
function buildStatus(view, api, state) {
  if (!state.status?.isConnected) {
    state.status = api.el("div", "rt-status");
    state.status.append(api.el("span", "rt-mode"), api.el("span", "rt-info"), api.el("span", "rt-keys"));
    api.move(state.status, view.popup, null);
  }
  const keys = state.status.querySelector(":scope > .rt-keys");
  state.status.querySelector(":scope > .rt-mode").textContent = view.kind === "kanji" ? "KANJI" : "TERM";
  keys.textContent = view.kind === "kanji" ? "Alt+B back · Esc" : "j/k · 1-9 · ⏎ anki · m more";
  const stats = view.popup.querySelector(".gsm-hoshidicts-lookup-stats");
  if (stats && stats.parentNode !== state.status) api.move(stats, state.status, keys);
}

// At most two items, then "+n": the status line is one row of a 560 px screen.
function capped(items) {
  const unique = [...new Set(items)];
  return unique.length > 2 ? `${unique.slice(0, 2).join(" ")} +${unique.length - 2}` : unique.join(" ");
}

function updateStatus(state) {
  const info = state.status?.querySelector(".rt-info");
  const entry = state.entries[state.selected];
  if (!info || !entry) return;
  const parts = [`${state.selected + 1}/${state.entries.length}`];
  if (state.kind === "term") {
    const header = state.selected === 0 ? state.header : entry;
    const { word, reading } = headwordOf(header?.querySelector(".gsm-hoshidicts-expression"));
    const pitches = pitchesOf(entry, state.selected === 0 ? state.header : null);
    parts.push([word, pitches.find(item => item.notation)?.notation || (reading !== word ? reading : "")].filter(Boolean).join(" "));
    if (pitches.length > 0) parts.push(capped(pitches.map(item => `${item.pattern}${item.position}`)));
    const frequencies = frequenciesOf(entry);
    if (frequencies.length === 1) parts.push(`#${frequencies[0].values[0]}`);
    else if (frequencies.length > 1) parts.push(capped(frequencies.map(item => `#${item.values[0]} ${item.dictionary}`.trim())));
    const ipa = text(entry.querySelector(".gsm-hoshidicts-ipa-body"));
    if (ipa) parts.push(ipa);
  } else {
    parts.push(text(state.popup.querySelector(".gsm-hoshidicts-kanji-glyph")), text(entry.querySelector(".gsm-hoshidicts-kanji-dictionary")));
    for (const group of entry.querySelectorAll(".gsm-hoshidicts-kanji-reading-group")) {
      parts.push(`${text(group.querySelector("strong")).toUpperCase()} ${text(group.querySelector("span"))}`);
    }
    const stats = text(entry.querySelector(".rt-stats"));
    if (stats) parts.push(stats);
  }
  info.textContent = parts.filter(Boolean).join(" │ ");
}

// Selection = inverse-video row + gutter mark on the entry + status line. With
// `scroll` (user navigation) the entry is brought to the top of the body, as the
// reader's own scrollToEntry does, and that programmatic scroll is remembered so
// the scroll listener does not re-derive the selection from it. onRender selects
// without `scroll`, so the render path reads no layout and never forces one.
function select(state, index, { scroll = true, focus = false } = {}) {
  const count = state.entries.length;
  if (count === 0) return;
  const next = Math.max(0, Math.min(count - 1, index));
  state.entries.forEach((entry, position) => {
    if (position === next) entry.dataset.rtSelected = "";
    else delete entry.dataset.rtSelected;
  });
  state.rows.forEach((row, position) => {
    row.setAttribute("aria-selected", String(position === next));
    row.tabIndex = position === next ? 0 : -1;
  });
  state.selected = next;
  updateStatus(state);
  const row = state.rows[next];
  if (row && state.list && scroll) {
    // Keep the row inside the six-row window (.rt-list is position: relative).
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < state.list.scrollTop) state.list.scrollTop = top;
    else if (bottom > state.list.scrollTop + state.list.clientHeight) state.list.scrollTop = bottom - state.list.clientHeight;
  }
  if (scroll) {
    const content = state.content;
    const target = Math.max(0, Math.min(state.entries[next].offsetTop, content.scrollHeight - content.clientHeight));
    state.expectedScrollTop = target;
    content.scrollTop = target;
  }
  if (focus && row) row.focus({ preventScroll: true });
}

// `less` model: the current record is the last one whose top is at or above the
// body's top edge, so the reader's own entry keybinds (which scroll) move it too.
function syncFromScroll(state) {
  const top = state.content.scrollTop;
  if (state.expectedScrollTop !== null && Math.abs(top - state.expectedScrollTop) < 1) return;
  state.expectedScrollTop = null;
  let index = 0;
  for (let position = 1; position < state.entries.length; position += 1) {
    if (state.entries[position].offsetTop <= top + 4) index = position;
  }
  if (index !== state.selected) select(state, index, { scroll: false });
}

function onKeyDown(event, state) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const target = event.target;
  if (typeof target?.closest !== "function" || target.closest("input, textarea, select, [contenteditable]")) return;
  const inList = Boolean(state.list && target.closest(".rt-list"));
  const key = event.key;
  let next = null;
  if (key === "j" || (inList && key === "ArrowDown")) next = state.selected + 1;
  else if (key === "k" || (inList && key === "ArrowUp")) next = state.selected - 1;
  else if (key === "g" || (inList && key === "Home")) next = 0;
  else if (key === "G" || (inList && key === "End")) next = state.entries.length - 1;
  else if (key.length === 1 && key >= "1" && key <= "9") next = Number(key) - 1;
  else if (key === "m") {
    const more = state.content.querySelector(".gsm-hoshidicts-show-more");
    if (!more) return;
    event.preventDefault();
    more.click();
    return;
  } else if (key === "Enter" && inList) {
    // IME metaphor: Enter commits the candidate — here, to Anki, through the
    // reader's own mine button for that entry (no-op while it is disabled).
    const scope = state.selected === 0 ? state.header : state.entries[state.selected];
    const mine = scope?.querySelector(".gsm-hoshidicts-mine-button");
    if (!mine) return;
    event.preventDefault();
    mine.click();
    return;
  } else return;
  if (next < 0 || next >= state.entries.length) {
    // j/k past either end are swallowed so the body does not jump; an unused
    // digit is left to whoever else wants it.
    if (key === "j" || key === "k" || inList) event.preventDefault();
    return;
  }
  event.preventDefault();
  select(state, next, { scroll: true, focus: inList });
}

function onClick(event, state) {
  const target = event.target;
  if (typeof target?.closest !== "function") return;
  const row = target.closest(".rt-row");
  if (row && state.list?.contains(row)) {
    select(state, Number(row.dataset.rtIndex), { scroll: true, focus: true });
    return;
  }
  // A click inside a record makes it current, as the reader does for its keybinds.
  const entry = target.closest(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry");
  const index = entry ? state.entries.indexOf(entry) : -1;
  if (index >= 0 && index !== state.selected) select(state, index, { scroll: false });
}

// Listeners live on the popup, which persists across renders; scroll does not
// bubble, so it is captured there (the reader listens the same way).
function bind(popup, state) {
  state.onKeyDown = event => onKeyDown(event, state);
  state.onClick = event => onClick(event, state);
  state.onScroll = event => { if (event.target === state.content) syncFromScroll(state); };
  popup.addEventListener("keydown", state.onKeyDown);
  popup.addEventListener("click", state.onClick);
  popup.addEventListener("scroll", state.onScroll, { capture: true, passive: true });
  boundPopups.add(popup);
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind !== "term" && view.kind !== "kanji") return;
    const popup = view.popup;
    let state = states.get(popup);
    if (!state) {
      state = { popup, content: view.content, kind: view.kind, header: null, entries: [], rows: [], rowsByEntry: new Map(),
        list: null, status: null, selected: 0, expectedScrollTop: null };
      states.set(popup, state);
      bind(popup, state);
    }
    // A new lookup, dictionary tab or Back starts at the first record; "Show more"
    // keeps the current one (its first entry is the same node).
    const fresh = state.kind !== view.kind || state.entries[0] !== view.entries[0];
    state.kind = view.kind;
    state.content = view.content;
    state.entries = [...view.entries];
    state.header = view.chrome?.querySelector(".gsm-hoshidicts-primary-header") ?? null;
    if (view.kind === "term") renderTerm(view, api, state);
    else renderKanji(view, api, state);
    buildStatus(view, api, state);
    select(state, fresh ? 0 : state.selected, { scroll: false });
    api.requestLayout();
  },
  onDeactivate() {
    for (const popup of boundPopups) {
      const state = states.get(popup);
      if (state) {
        popup.removeEventListener("keydown", state.onKeyDown);
        popup.removeEventListener("click", state.onClick);
        popup.removeEventListener("scroll", state.onScroll, { capture: true });
        states.delete(popup);
      }
      for (const node of popup.querySelectorAll(".rt-list, .rt-status, .rt-reading, .rt-trace, .rt-stats")) node.remove();
      for (const node of popup.querySelectorAll(`[data-theme-hidden="${SLUG}"]`)) {
        node.hidden = false;
        delete node.dataset.themeHidden;
      }
      for (const node of popup.querySelectorAll("[data-rt-selected]")) delete node.dataset.rtSelected;
    }
    boundPopups.clear();
  },
};
```

### Accessibility

**Contrast**, WCAG 2.x formula (`contrast.mjs` → `contrast.json`), then **measured on the screenshot pixels** per scanline band (`measure-contrast.py` → `measured-contrast.txt`; both agree to the second decimal):

| Pair | Clear rows | Through the scanline (14 % black, every third pixel row) |
| --- | --- | --- |
| text `#ffb000` on `#0b0a06` (glosses, list) | 10.81:1 | 8.05:1 (`rgb(219,151,0)` on `rgb(9,8,5)`) |
| bright `#ffd166` on `#0b0a06` (headword, glyph) | 13.74:1 | 10.11:1 |
| dim `#d09a1e` on `#0b0a06` (readings, hints, tags) | 7.85:1 | 5.92:1 |
| inverse video `#0b0a06` on `#ffb000` (selected row, status) | 10.81:1 | 8.05:1 |
| dim on hovered row `#241c08` | 6.69:1 | 5.24:1 |
| error `#ff9f1c` on `#0b0a06` | 9.65:1 | 7.22:1 |

Rules and key-cap borders (`#5c4409`, 2.2:1) are decorative and never carry text. The CRT effect never takes a text pair below 5.2:1 and is not drawn under `prefers-reduced-motion` (measured above). The glow is a `text-shadow` on the headword and glyph only.

**Keyboard and focus.** `role="listbox"` / `role="option"`, `aria-selected`, roving `tabIndex` (the selected row is the tab stop), dashed `:focus-visible`. Every reader control stays in the DOM with its label; nothing is hidden without a text replacement (badges → list and status text, disclosure → trace). Theme keys fire only with focus inside the popup and never with a modifier; `j`/`k` at either end are swallowed so the body does not jump.

**Motion.** One animation, the 1.06 s block-cursor blink; the raster is static; both go under `prefers-reduced-motion: reduce`.

**For @bee-san's review:** the status line truncates from the right (key hints first); whether `＼` and `LHL[2]` read well to learners who only know the graph; the six-row window on a 320 px popup; whether `⏎` on a selected candidate meaning "to Anki" fits the IME metaphor.

### Benchmark

No "How to benchmark a theme" guide exists yet, so: the repo harness unchanged. `bench-themes.mjs` makes three copies of the worktree differing in one line — `DEFAULT_OPTIONS.popupTheme` in `extension/reader-options.js` (`default` / `retro-terminal` / `nazeka`) — and runs `benchmark/hover-popup.mjs` on each, interleaved per round:

```sh
git apply docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch   # both slugs registered as nazeka is
HACHIDORI_ROOT=$PWD BENCH_OUT=~/.cache/rt-bench BENCH_ROUNDS=3 node docs/evidence/issue-330/themes/retro-terminal/bench-themes.mjs
```

3 rounds × 3 variants, Chrome for Testing 152.0.7977.75, `hover-popup-fixture.zip` (3 terms incl. the 40-deep gloss), Xeon Platinum 8488C, Node 22.23.1. Harness `firstMs` (pointer move → first frame with the headword) / `completeMs` (→ popup stable), median (p95):

| Group (n) | default | retro-terminal | nazeka |
| --- | --- | --- | --- |
| root, warm (24) | **16.8** / **33.3** (19.9 / 34.6) | **16.8** / **33.3** (27.8 / 50.7) | **16.8** / **33.3** (26.9 / 53.8) |
| deep nesting (24) | 16.9 / 33.3 (23.1 / 49.8) | 17.0 / 33.4 (57.4 / 60.5) | 16.9 / 33.3 (17.1 / 35.6) |
| flat after deep (24) | 16.8 / 33.3 (19.0 / 36.5) | 16.8 / 33.3 (19.1 / 47.5) | 16.8 / 33.3 (16.9 / 33.4) |
| child popup (6) | 18.8 / 42.3 | 17.9 / 34.8 | 16.8 / 33.3 |

Medians are identical to 0.1 ms across the three (cold first opens, 3 per variant, range 43–449 ms, are engine start-up, not rendering): a hover is a 16.8 ms first frame and a 33.3 ms complete popup with or without theme JS. The p95s are machine noise — the box is shared (1-minute load 22–42, 5-minute 336–690 during the rounds); the one 327 ms `retro-terminal` outlier coincides with a 52 ms engine reply (normally 3 ms). `bench-render-phase.json` splits every warm hover (72 per variant) at the `hd_lookup` reply: send → reply is engine + messaging, untouchable by a theme (a load control); reply → first frame is render + layout + paint, where a theme costs:

| Variant | engine send→reply med / p95 / max | reply→first frame med / p95 / max | reply→complete med / p95 / max |
| --- | --- | --- | --- |
| default | 3.4 / 8.7 / 18.1 | 13.3 / 14.7 / 17.1 | 30.3 / 34.0 / 39.9 |
| retro-terminal | 3.9 / 18.2 / 52.1 | **12.9** / 17.4 / 274.5 | 30.0 / 40.5 / 275.8 |
| nazeka | 1.9 / 8.9 / 21.1 | 14.4 / 14.9 / 16.9 | 30.9 / 39.2 / 46.4 |

Reply → first frame: 12.9 ms with this theme, 13.3 default, 14.4 nazeka (medians, inside run-to-run noise); the engine column shows the `retro-terminal` runs drew the noisier minutes, which is where its p95/max come from.

**The hook itself**, timed in the real page by an instrumented host copy (one added line writes each `onRender` wall time to a `data-` attribute; `capture-retro-terminal.mjs`): 59 renders of two-entry popups (40 alternating hovers 食べたかった / 読んだ, each a full re-render) — **median 0.2 ms, p95 0.5 ms, max 0.7 ms** (`evidence.json` → `hookCost`, load average alongside). First themed render on a page 1.3 ms (fixture), 3.6 ms (掛けたかった: six entries, 26-sense primary); later batches 0.3–0.7 ms; kanji 0.1–0.4 ms; never past the host's 8 ms log line. Cheap because the render path reads no layout (no `offsetTop`/`getBoundingClientRect` until a key is pressed), rows are built once per entry node, and the CSS drops the default's `backdrop-filter: blur(16px)`.

Limitations: one shared, loaded machine; 3 rounds × 1 profile per variant; the harness fixture has three short entries, so the 掛けたかった/日本語 renders above are the realistic case, timed per hook rather than end to end.

### Open questions / API gaps

1. **Structured data, not DOM scraping.** Everything the list shows exists in `result.term` (expression, reading, `pitches[].position`, `frequencies[]`, dictionaries, `trace`) but reaches the theme as DOM: reading via `aria-label`, pitch via `data-pitch-*` spans, rank via badge text. A frozen `view.results` (and `view.kanji`) would make this theme a third of its size and immune to class renames.
2. **Why did `onRender` fire?** First entry, each 8 ms batch, Show more, tab, Back and presentation updates all look alike; the theme infers "fresh" from `view.entries[0]` identity. A `view.reason` (`lookup | batch | showMore | tab | back | presentation`) would remove the guess.
3. **Keyboard.** Theme keys need focus inside the popup (the hover popup never takes it) and the reader's entry keybinds are mirrored from `scrollTop`. Cleaner: `api.onEntryChange(cb)` (the reader tracks `currentEntry` already) and/or `api.action("nextEntry")` so a list can drive the reader instead of mirroring it.
4. **The lookup count** is repainted by node reference; moving the node into the status line works, but an `api.slot("lookupStats", target)` would make it a contract rather than a happy accident.
5. **`@keyframes` in the sanitiser.** The proposed sanitiser drops `@keyframes`; the cursor blink is one (`rt-blink`, no `url()`). Allow `@keyframes` whose declarations pass the per-rule checks, or the blink goes.
6. **Skeleton schema vs Ajv strict mode.** `theme.schema.json` does not *compile* under `strict: true` (`strictRequired`: `required: ["css"]` inside `if/anyOf` without `properties`), so `validate.mjs` as written throws for every theme; fix with `"properties": { "css": true }` there or `strictRequired: false`.
7. **Toolbar position.** The design assumes title bar top / status line bottom (`options.popupToolbarPosition: top`); with `bottom` the reader reorders the popup's children and the status line sits above the toolbar — not broken, not the design. A theme should be able to declare a fixed layout.
8. **`onDeactivate`** has to un-hide the theme's own `data-theme-hidden` nodes; the host knows the slug and could do it.
9. Not exercised in the capture, only read: `⏎` → Anki (no Anki in the headless profile) and `m` (all six 掛けたかった entries rendered progressively, leaving no Show more).

To try it: apply `host-prototype.patch`, copy the three files to `extension/vendor/themes/retro-terminal/`, add `"retro-terminal"` beside `nazeka` in `THEME_JS` (`content.js`) and `POPUP_THEME_GROUPS` (`reader-options.js`), pick it in Settings → Design.
