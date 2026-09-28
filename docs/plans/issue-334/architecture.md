# Architecture

Line links point at `main` and were verified at **3c7e9df** (2026-09-28, after #339 removed Firefox, #341 removed media mining, and #366–#373). The frozen interfaces are in [renderer-api.md](renderer-api.md) and [schemas/](schemas/).

## 1. The two repositories

```text
bee-san/hachidori-theme-store (public, GPL-3.0-or-later)            bee-san/hachidori
  themes/<slug>/theme.yaml  (+ renderer.js/.css for layouts,    scripts/vendor-themes.mjs  (pinned commit → extension/vendor/themes/)
                              README.md, screenshot.png)         extension/vendor/themes/{index.json, catalogue.js, palettes.css,
  scripts/validate · build-index · check-renderer · render ·                              <slug>/renderer.js|renderer.css, SOURCE.json}
          bench · import-palettes                                extension/render/{renderer-contract, result-model, renderer-host,
  dist/index.json, dist/palettes.css, dist/themes/<slug>/…                       components, default-renderer, palette-css}.js
  benchmarks/<slug>.json  (written by CI on main)                extension/render/{infra, palettes*, components, default}.css
  CI: schema · lint/AST · jsdom contract · render · benchmark    extension/theme-state.js · renderer-loader.js · theme-store-ui.js
                                                                 (* replaced by vendor/themes/palettes.css in T-51)
        ── vendored at release (renderers + all bundled data) ──▶
        ── Store Refresh at runtime (data only: index JSON with palette colour values, screenshots) ──▶
```

Hachidori **never parses YAML, never fetches code and never downloads CSS**. `build-index.mjs` compiles every `theme.yaml` into JSON (and `palettes.css` for vendoring). At runtime Hachidori only `JSON.parse`s the catalogue and compiles palette colour values into palette blocks itself.

## 2. What a theme is (schema 2)

A theme is **never CSS or JS over the normal popup** ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)). It is either a set of colours for a popup, or its own popup.

| Kind | Contents | Renderer | Delivery |
| --- | --- | --- | --- |
| **palette** | 17 colours + `color-scheme` | Default | bundled (the 42 today), or used from a refreshed catalogue (colour data) |
| **renderer** | palette + `renderer.js` + `renderer.css`: **its own popup** (`nazeka`, `plain`, `yomitan`, `rikaikun`, the community proposals) | its own; Default never runs | **release only**: vendored, reviewed by bee-san, never fetched |
| **variant** | palette for another theme's renderer (e.g. `sentence-context-dark`, `manga-vertical-night`) | the parent's | used from a refreshed catalogue when the parent renderer is bundled in the running release |

Manifest: [schemas/theme-manifest.v2.schema.json](schemas/theme-manifest.v2.schema.json), examples in [examples/themes/](examples/themes/). Catalogue: [schemas/theme-index.v1.schema.json](schemas/theme-index.v1.schema.json).

## 3. Hachidori today (what the plan changes)

- **Palettes are hard-coded in the reader stylesheet.** [reader.css:32-959](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L32-L959) has 42 blocks of 18 `--hoshidicts-palette-*` properties (17 colours + color-scheme). Each is selected by `html[data-hoshidicts-theme=X], :host([data-hoshidicts-theme=X])`, and default also matches bare `html`/`:host`. That is 46 KB of the file's 95 KB. Semantic colours are derived once in [reader.css:997-1131](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L997-L1131). Palette-specific Default styling sits at [1147-1229](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L1147-L1229) (high-contrast, autumn, girlypop, miku), [988-995](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L988-L995) and [2050-2060](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L2065-L2075). Settings derives its own tokens from the palette ([settings.css:40-88](https://github.com/bee-san/hachidori/blob/main/extension/settings.css#L40-L88), overrides 94-139).
- **The catalogue and its validation are code.** [`POPUP_THEME_GROUPS`](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L170-L182) is `auto` + 42 ids (groups `[1,18,23,1]`). [`normaliseField`](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L547-L566) turns an unknown id into `default`. Strict `hd_options_write` rejects it ([isValidOptionField](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L651-L662)), and [backup restore](https://github.com/bee-san/hachidori/blob/main/extension/backup-state.js#L71-L90) rejects the whole backup. Settings builds the `<select>` in [`renderThemeChoices`](https://github.com/bee-san/hachidori/blob/main/extension/settings.js#L1654-L1666). extension-smoke and chrome-e2e hard-code 43 ids and `[1,18,23,1]` ([extension-smoke.mjs:4700-4712](https://github.com/bee-san/hachidori/blob/main/test/extension-smoke.mjs#L4700-L4712), [chrome-e2e.mjs:7490](https://github.com/bee-san/hachidori/blob/main/test/chrome-e2e.mjs#L7490)).
- **Applying a palette is one attribute plus four variables.** [`createPopupAppearance`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L62-L118) resolves `auto` through `matchMedia` and sets `host.dataset.hoshidictsTheme` and `--gsm-hoshidicts-popup-{opacity,width,height,scale}`. [`applyPageTheme`](https://github.com/bee-san/hachidori/blob/main/extension/settings-dom.js#L4-L19) does the same on Settings' `<html>`, and [settings-theme.js](https://github.com/bee-san/hachidori/blob/main/extension/settings-theme.js#L10-L24) guards the first frame.
- **Stylesheets in the popup's shadow root.** [`readerStyleSheet`](https://github.com/bee-san/hachidori/blob/main/extension/content.js#L2023-L2040) fetches reader.css and icons.css and concatenates them into **one** constructed sheet. [`buildUi`](https://github.com/bee-san/hachidori/blob/main/extension/content.js#L2061-L2100) attaches an **open** shadow root (2078) and adopts `[reader+icons, custom]`. Dictionary CSS arrives as `<style>` elements wrapped in `@scope` ([applyDictionaryStyles](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L1265-L1318)) after `hd_styles` ([ensureDictionaryStyles](https://github.com/bee-san/hachidori/blob/main/extension/content.js#L1610)). User Custom CSS is a constructed sheet appended last ([createCustomPopupStyle](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L42-L59)). The Design preview loads the same files as `<link>`s ([design-preview.js:5-18](https://github.com/bee-san/hachidori/blob/main/extension/design-preview.js#L5-L18)).
- **One renderer, and core code tied to its DOM.** [`HDPopup.createPopupView`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L2086) is the only way content.js drives the popup. Its closure mixes core infrastructure (about 775 lines: entry navigation, masonry, toolbar ordering, blur, Note form, custom buttons, the async error boundary [`runRenderAction`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L2561)) with Default's DOM builders (about 1,750 lines including module helpers: [`createResultChrome`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L2861), [`createEntryHeader`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L3165-L3282), [`renderResultPanel`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L3307), [`renderKanji`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L3738-L3894), [`renderResults`](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L3896-L4218)). Core behaviour reads Default classes in about a dozen places ([renderer-api.md §7](renderer-api.md#7-semantic-roles-read-by-core-replace-default-class-selectors)). Keybinds reach Default's buttons ([runKeybindAction](https://github.com/bee-san/hachidori/blob/main/extension/content.js#L3800-L3856)). Audio binds to header buttons, and the hide-audio option only hides them with CSS ([reader.css:1481](https://github.com/bee-san/hachidori/blob/main/extension/render/reader.css#L1481)). There is no loading state: a busy view is made `inert`.
- **There is no plain-text glossary.** [`appendTextOnlyGlossary`](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L1129-L1191) parses structured content and builds full DOM. Anki's plain text walks that DOM ([anki-glossary.js:5-10](https://github.com/bee-san/hachidori/blob/main/extension/anki-glossary.js#L5-L10)). The only data-level walker is the truncated compact summary ([extractCompactDefinitionSummary](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L1975)).
- **Custom JavaScript** is a `chrome.userScripts` script in the `USER_SCRIPT` world ([custom-javascript.js:8-26](https://github.com/bee-san/hachidori/blob/main/extension/custom-javascript.js#L8-L26), permission [manifest.json:21](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L14-L22)). It reaches the popup only because the shadow root is open, and it has no render hook.
- **No YAML, no bundler.** `extension/` is loaded as committed ([extension/README.md:5-8](https://github.com/bee-san/hachidori/blob/main/extension/README.md#L5-L8)). Only `vendor/` holds generated files. `package-store.py` ships every tracked `extension/*` file.

## 4. Runtime after the change

| Module (new unless noted) | Context | Responsibility | Card |
| --- | --- | --- | --- |
| `render/renderer-contract.js` | content, pages | Frozen constants: `API_VERSION`, `MODEL_VERSION`, roles, layers, glossary modes, reasons, update events | T-01 |
| `render/result-model.js` | content, pages | `buildTermModel`/`buildKanjiModel`/`buildStateModel`, deep-frozen, opaque glossary handles | T-12 |
| `render/glossary.js` (edit) | content, pages, Anki | `glossaryToPlainText`, `renderGlossary(handle, {mode})`, dictionary CSS only after a rich render | T-13 |
| `render/renderer-host.js` | content, pages | `HDRenderers` registry, `createLevelView`, `ctx`, guards, fallback, generations, perf marks, legacy adapter for Default until T-31 | T-14 |
| `content.js` (edit) | content | Level views through the host, models instead of raw arguments, renderer switching, actions-based keybinds, layered sheets | T-11, T-15, T-20 |
| `audio-content.js`, `anki-content.js` (edit) | content | Button-less `play`/`mine`/`state`/subscribe | T-16 |
| `render/components.js` | content, pages | Shared components extracted from Default (headword, tags, pitch, frequencies, glossary, buttons, tabs, show more, stats slot, kanji entry) | T-30 |
| `render/default-renderer.js` | content, pages | Default as a v1 renderer | T-31 |
| `render/{infra,palettes,components,default}.css` | content, pages | reader.css split into layers | T-17 |
| `render/palette-css.js` | content, SW, pages, vendor script | Compile validated palette values into the `html[…], :host([…])` palette block; the same bytes `build-index` writes | T-23 |
| `theme-state.js` | SW | `themes` storage record, CAS, caps, hashes | T-19 |
| `renderer-loader.js` | SW | Keeps the active renderer's bundled script available to content scripts | T-20 |
| `theme-store-ui.js` | Settings | Store grid, detail pane, install/update, suggestions + Undo | T-41, T-43, T-44 |
| `vendor/themes/*` | all | Vendored catalogue, palettes, bundled theme files, `SOURCE.json` | T-50, T-51 |

**Resolution of `options.popupTheme`:**

1. `auto` means dark or light through `matchMedia`, as today.
2. Otherwise the slug is looked up in the vendored `catalogue.js`. A renderer or variant theme uses its renderer, unless `experimental.themeStore` is off or the host lacks `rendererThemes`. In those two cases it uses Default with the theme's palette.
3. A stored slug (`themes.installed`: palettes and variants from a refreshed catalogue) uses its stored palette values, compiled locally, on its renderer (Default or a bundled parent).
4. Anything else uses Default with the default palette, and **the value is kept**. Settings shows "<slug> (not installed)".

`data-hoshidicts-theme` keeps carrying the slug, so `auto`, palettes on `html`, and the `::highlight` colour ([popup.js:68-79](https://github.com/bee-san/hachidori/blob/main/extension/render/popup.js#L68-L79)) keep working.

**Where themes live:**

- Bundled themes (all palettes; the renderers `nazeka`, `plain`, `yomitan`, `rikaikun`; later the community renderers) are committed under `extension/vendor/themes/` by `scripts/vendor-themes.mjs` at a pinned `hachidori-theme-store` commit, recorded in `SOURCE.json`. This is the precedent of [vendor-fluent-icons.py](https://github.com/bee-san/hachidori/blob/main/scripts/vendor-fluent-icons.py).
- Content scripts get `catalogue.js`, a tiny slug → renderer/files map (D22). Settings reads `index.json`. Renderer CSS files the content script fetches are web-accessible like reader.css ([manifest.json:119-131](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L119-L131)). Hachidori is already detectable through those files, and the choice of theme is not exposed.
- Palettes and variants used from a refreshed catalogue live in the SW-owned `themes` record as colour values ([schema](schemas/themes-storage.v1.schema.json)), read with the options at start and on `storage.onChanged`.

## 5. Catalogue: fetching, caching, updating (T-44)

- **Zero network by default.** The Store renders from the vendored `index.json` and `themes.installed`.
- **Refresh** (button, or the opt-in "Check for new themes" schedule, default Off) runs in the SW:
  - It fetches `https://raw.githubusercontent.com/bee-san/hachidori-theme-store/main/dist/index.json` with `If-None-Match`.
  - It accepts the file only if it is at most 1 MiB, valid against [theme-index.v1](schemas/theme-index.v1.schema.json) (relative paths, 40-hex commit, pattern-checked palette values), and its final URL passes the same check as [`recommendedAssetUrlMatches`](https://github.com/bee-san/hachidori/blob/main/extension/managed-dictionary-source.js#L166-L215).
  - It stores `themes.catalogue`. Nothing changes silently: an active theme keeps its stored values until the user presses Update.
- **Use / Update** of a palette or variant from the refreshed catalogue stores its colour values in `themes.installed`, so it keeps working offline. Hachidori compiles them locally into the palette block (`extension/render/palette-css.js`, T-23). **No CSS or code is downloaded.**
- A detail pane fetches `themes/<slug>/screenshot.png` at the index commit, and only when it opens.
- Renderer themes are never fetched. If a refreshed index lists a renderer theme this release does not bundle, its card says **"Arrives with Hachidori x.y"**. A variant whose parent renderer is not bundled says the same. If a theme needs a newer host, its card says **"Requires Hachidori ≥ x.y.z"**.
- Offline or failed Refresh: the vendored index stays. An active slug without data falls back as in §4.

## 6. Versioning and compatibility

| Thing | Version | Rule |
| --- | --- | --- |
| Renderer API | `apiVersion: 1` | The host refuses other values and uses Default + palette. Additive changes keep 1 (renderer-api.md §11). |
| Result model | `modelVersion: 1` | Same rule. Renderers ignore unknown fields. |
| Manifest | `schema: 2` | Schema 1 (evidence skeleton) is rejected with a migration hint. |
| Index | `schema: 1` | A consumer rejects any other value and keeps the vendored index. |
| Storage `themes` | `version: 1` | Normalised on read. Unknown fields are dropped. |
| Theme | semver `version` + `minHachidoriVersion` | Older releases hide themes they cannot run. Update available = same slug, higher version, `installable: runtime`. |
| Pins | `SOURCE.json` (Hachidori ← themes commit), `fixture/HACHIDORI_COMMIT` (themes CI → Hachidori commit) | Both are bumped by PR. CI in each repo verifies the other side at its pin. |

## 7. Settings, startup, Design preview

- Settings and startup link `infra.css` + `palettes.css` instead of reader.css (T-17). Installed palettes are adopted as one extra sheet, so `html[data-hoshidicts-theme=<installed>]` works on the Settings page too.
- The Design preview (same-origin iframe, [settings.js:587](https://github.com/bee-san/hachidori/blob/main/extension/settings.js#L587)) renders through `HDRendererHost` with the selected renderer (T-42). Renderer JS runs on extension pages only there.
- Theme Store UI: [ui.md](ui.md). Options, storage, backup and migration: [data-model.md](data-model.md).

## 8. Migration of the 42 palettes (stateless)

The 42 palettes keep the same slugs, selectors and values.

1. T-17 moves reader.css:32-959 verbatim into `render/palettes.css`.
2. T-22 generates `themes/<slug>/theme.yaml` from that file and compiles `dist/palettes.css` back, byte-identical.
3. T-51 swaps the file for `vendor/themes/palettes.css`.

The extra Default styling for high-contrast, autumn, girlypop and miku (gradients and token overrides) stays in Hachidori's `default.css`. It is part of how the Default renderer draws those palettes, not a layer over Default, and it keeps working for exactly those slugs. A stored `popupTheme: "dracula"` renders pixel-identically at every step. No stored data changes.
