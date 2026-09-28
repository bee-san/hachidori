# Design UI: Theme select and Theme Store

bee-san asked for a mock-up screenshot ([c08](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814298846)). It has not been produced yet, so card **T-03** renders one from this spec before T-41 builds the real UI. After [c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542) the Store has three kinds, *Palette*, *Layout* (its own popup) and *Variant* (a layout with other colours), and never offers CSS to download or a JavaScript switch.

## Placement

Settings → Design ([settings.html:621-863](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L621-L863)):

- **Appearance**: the existing Theme `<select id="opt-popup-theme">` ([634](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L629-L686)). It is built from the vendored catalogue plus installed themes (T-40), in groups: *Automatic* · *Palettes: Dark / Light / High contrast* · *Layouts* (renderer themes, only with `experimental.themeStore`) · *Installed*. An unavailable stored slug shows as "<slug> (not installed)" and is kept.
- **Theme Store**: a new `<section>` between Appearance and Definitions ([688](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L688)), shown only with `experimental.themeStore` (T-41).
- **Custom CSS / Custom JavaScript**: unchanged. The hint now says "Applied on top of the theme" ([819](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L820-L843), T-02).

## Wireframe

```text
┌ Design ────────────────────────────────────────────────────────────────────────────┐
│ Appearance  Theme [ Nazeka ▾ ]        grouped: Automatic · Palettes · Layouts · Installed
│ Theme Store   hachidori-theme-store @ 0123abc (bundled) · 48 themes   [🔍 search]   [Refresh]
│   Kind: (all)(Palette)(Layout)(Variant)   Tags: (dark)(light)(compact)(vn)(manga)(kanji)…
│  ┌ ▇▇▇▇  LAYOUT ───┐ ┌ ▇▇▇▇  LAYOUT ───┐ ┌ ▇▇▇▇  PALETTE ──┐ ┌ ▇▇▇▇  LAYOUT ───┐
│  │ Nazeka          │ │ Plain  ⚡Lighter │ │ Catppuccin Latte│ │ Tategaki        │
│  │ bee-san         │ │ bee-san         │ │ new in catalogue│ │ theme designers │
│  │ [ In use ✓ ]    │ │ [ Use ]         │ │ [ Use ]         │ │ Arrives with    │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘ │ Hachidori 0.3   │
│                                                               └─────────────────┘
│  ── Nazeka 2.0.0 · GPL-3.0-or-later · credits: wareya/nazeka (Apache-2.0) ───────────
│     [screenshot 560×420]      "Nazeka's popup as texthook.js draws it — …"
│     Speed  hover → full popup 33.3 ms (Default 33.2 ms) · 37 elements (Default 32) · Hachidori 0.1.6 / Chrome 152
│     Layout  Draws its own popup: <js.summary>. Reviewed by bee-san and bundled with Hachidori 0.2.0.
│             Text only: no rich dictionary formatting, images or links.
│     Doesn't use: Columns · Toolbar position · Pitch badge · Compact summary
│     Suggests: opacity 100 %                [Use this theme]  → then: Applied · [Undo]
│     [Open on GitHub ↗]  [Report a problem ↗]  [Remove] (stored catalogue themes only)
│ Definitions …   Custom CSS "Applied on top of the theme" (unchanged)
└────────────────────────────────────────────────────────────────────────────────────┘
```

The speed line shows the onRender prototype's measured short-entry numbers (evidence run 2). The direct renderer's numbers come from CI (benchmarking.md) and are not known yet. Plain's ⚡Lighter badge only shows where the badge goes: nothing has been measured.

## Card states

| State | Shown for | Button |
| --- | --- | --- |
| **Use** | Bundled (vendored) or installed, not active | Use: writes `popupTheme` + `suggestedOptions` in one revision |
| **In use ✓** | Active slug | (disabled) |
| **Use** (from catalogue) | Palette or variant in a refreshed catalogue, not bundled | Use: stores its colour values and selects it (no download beyond the index) |
| **Update available** | Stored palette or variant; the index has a higher `version` | Update: re-stores the values |
| **Arrives with Hachidori x.y** | Renderer theme, or a variant of one, in a refreshed index but not bundled in this release | none |
| **Requires Hachidori ≥ x.y.z** | `minHachidoriVersion` higher than running, or unsupported `apiVersion`/`needs` | none |

## Behaviour and copy

- **Zero network until the user asks.** The grid renders from the vendored `index.json` and `themes.installed`. Screenshots are fetched only when a detail pane opens. Refresh is explicit. The optional schedule ("Check for new themes", default Off) sits beside Refresh.
- **Use this theme** writes the theme and its suggestions together. A toast offers **Undo**, which restores the exact prior values until the user navigates away. Suggestions are never re-applied (D10). Reset Design is unchanged.
- **Doesn't use** lists the renderer's `ignores`. The same hint appears next to those Design controls while the theme is active ("Nazeka doesn't use this"), so a control never silently does nothing ([c06](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814181505)).
- **Layout note**: a plain description, "Draws its own popup … reviewed by bee-san and bundled with Hachidori x.y" (D3, D24). There is no JavaScript warning and no per-theme JavaScript switch.
- **Speed**: only the positive **⚡ Lighter** badge on cards. The detail pane shows numbers relative to Default. There is no "slow" or "below average" label: over-budget themes fail CI and are never published (D18, [c08](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814298846)).
- **Report a problem** opens `https://github.com/bee-san/hachidori-theme-store/issues/new?template=theme-problem.yml&theme=<slug>` through `hd_open_external` ([background.js:1095](https://github.com/bee-san/hachidori/blob/main/extension/background.js#L1095-L1103)). **Open on GitHub** opens the theme folder at the index commit. **Remove** deletes a stored (non-bundled) palette or variant.
- **Failures:**
  - A catalogue that fails validation shows "Couldn't read the theme catalogue; showing the themes bundled with this version" and stores nothing.
  - Offline: "Couldn't reach GitHub; showing the themes bundled with this version."
  - A renderer that failed on the current page shows a one-line note in the detail pane from the host's failure memo.

## Accessibility

- The grid is a `<ul role="list">` of `<li><article aria-labelledby=…>` cards with **one** primary button each. This reuses the recommended-dictionary list pattern ([settings.html:238-262](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L238-L262), [renderRecommendedCatalogue](https://github.com/bee-san/hachidori/blob/main/extension/settings.js#L1211)).
- Search is a labelled `<input type="search">`. Kind and tag filters are toggle buttons with `aria-pressed`.
- The detail pane is a region with a heading. Opening it moves focus to its heading, and closing it returns focus to the card that opened it.
- State changes (installed, update failed, undo) are announced through one `aria-live="polite"` status.
- Swatches carry text (the palette name) and never rely on colour alone. Focus rings use the Settings tokens and work under `forced-colors: active`.
- Screenshots have `alt` text generated from the theme name and description.

## Design preview

The existing preview iframe (`#design-preview`) renders the selected theme through `HDRendererHost` (T-42). Hovering a card does not switch the preview. "Preview" in the detail pane renders that theme in the preview without saving it, and the preview returns to the saved theme when the pane closes.
