# PR #559: the pending Anki action, before and after

These captures are for [#559](https://github.com/bee-san/hachidori/pull/559). They live on this branch so the feature branch doesn't carry them (#533).

`anki-spinner-palettes.png` shows the pending Anki action, the Arrow Clockwise shown while the duplicate check runs. Each row is a palette. The columns are:

1. `main` 3834ff99, where the pending action is disabled.
2. #559 at cad4b960, where the pending action is enabled.
3. The same, hovered.
4. The same, with keyboard focus (`:focus-visible`).

`capture.mjs` renders the production popup and Anki controller (`render/popup.js`, `anki-content.js`, `render/reader.css` and `icons.css`) from each revision. Its fake worker never answers the duplicate check, so the action stays pending.

Capture settings:

- Chrome for Testing 152.0.7977.75, headless, device scale factor 2.
- `prefers-reduced-motion: reduce`, which the stylesheet uses to stop the spin.
- Page background `#121212` for dark schemes and white for light ones.
- Forced colours are Chrome's emulation through `Emulation.setEmulatedMedia`, not a real Windows contrast theme.

The contrast ratio is the action's colour against its composited background. The icon is painted in `currentColor`. `before.json` and `after.json` hold the raw values.

| Palette | Icon contrast on `main` (disabled) | Icon contrast with #559 (enabled) | Border, both | Focusable on `main` → #559 |
| --- | --- | --- | --- | --- |
| Hachidori (dark) | 4.36:1 | 5.51:1 | 5.51:1 | no → yes |
| Light | 3.85:1 | 7.90:1 | 7.90:1 | no → yes |
| High contrast | 12.12:1 | 14.31:1 | 14.31:1 | no → yes |
| Forced colours, dark | 13.98:1 (GrayText) | 21:1 | 13.98:1 → 21:1 | no → yes |
| Forced colours, light | 14.02:1 (GrayText) | 21:1 | 14.02:1 → 21:1 | no → yes |

The pending action is now drawn like the resolved Add: accent icon and border, accent-soft hover, and the standard focus ring. Its accessible name is "Checking Anki card status — click to add anyway", and `aria-busy` stays `true`. Under forced colours it uses ButtonText instead of GrayText, like every other enabled popup button.
