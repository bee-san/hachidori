# Data model, storage, backup and migration

## Options (`chrome.storage.local` `options`, service-worker-owned)

| Key | Today | After |
| --- | --- | --- |
| `popupTheme` | `"default"`; fresh installs `"auto"` (setup-state.js FIRST_INSTALL_OPTIONS). Values must be in `POPUP_THEME_IDS` ([reader-options.js:181](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L169-L181)). An unknown stored id normalises to `default` ([552](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L546-L565)). | Any slug-shaped id `^auto$\|^[a-z0-9][a-z0-9-]{1,40}$` survives normalisation. **Strict writes** (`hd_options_write`, [background.js:1250-1258](https://github.com/bee-san/hachidori/blob/main/extension/background.js#L1250-L1258)) accept only `auto`, a bundled slug (vendored catalogue) or an installed slug. Rendering falls back as in architecture.md §4, and the stored value is kept (T-18). |
| `experimental.themeStore` | — | New `EXPERIMENTAL_FEATURES` entry ([reader-options.js:31-38](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L28-L39), AGENTS.md:78), default `false`. It gates the Store section and selecting renderer themes. Palettes are always selectable (T-18). |
| `customPopupCss`, `customPopupJavascript` | User layers | Unchanged. They stay last and apply on top of any theme. |
| Design keys ([DESIGN_OPTION_KEYS](https://github.com/bee-san/hachidori/blob/main/extension/reader-options.js#L182-L187), 24) | Reset Design resets them ([settings.js:3258](https://github.com/bee-san/hachidori/blob/main/extension/settings.js#L3258)) | Unchanged. `suggestedOptions` writes a subset once on "Use this theme" (T-43). A renderer's `ignores` list only changes Settings' hints. |

No new option key holds theme data. Theme data lives in its own record.

## `themes` record (T-19)

Schema: [schemas/themes-storage.v1.schema.json](schemas/themes-storage.v1.schema.json); example [examples/themes-storage.json](examples/themes-storage.json).

- **Writer:** only the service worker, through `hd_themes_cas { baseRevision, patch }`. It uses the same conflict semantics as `hd_options_write` ([optionsWriteResult](https://github.com/bee-san/hachidori/blob/main/extension/background.js#L1341-L1358)) and runs inside `serialiseStorage` ([1546](https://github.com/bee-san/hachidori/blob/main/extension/background.js#L1546)). `hd_themes_read` exists for pages that need a consistent snapshot with the revision. Content scripts read `chrome.storage.local.get("themes")` directly, as they do for `options`.
- **Contents:**
  - `installed[slug]`: palettes and variants used from a refreshed catalogue. Each entry holds version, kind, renderer, meta, the 18 palette values, installedAt and the source commit. These are **colour values only**: Hachidori compiles them into a palette block locally, and no CSS or code is stored.
  - `catalogue`: the last refreshed index plus `etag`/`commit`/`fetchedAt`, or `null`.
  - `schedule`: `off | daily | weekly`.
- **Caps:** 200 stored themes, a few hundred bytes each. The record lives under the existing `unlimitedStorage` ([manifest.json:20](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L14-L22)). Palette values are pattern-checked on write and on read, and an invalid entry is dropped.

## Backup and restore

| Item | Rule |
| --- | --- |
| Snapshot keys ([backup-state.js:13-18](https://github.com/bee-san/hachidori/blob/main/extension/backup-state.js#L13-L18): `state, options, document, updates, lookupStats`) | Add `themes` with `installed`. `catalogue` is a cache and is excluded. |
| Older backups without `themes` | Restore as today, with no installed themes. |
| `popupTheme` naming a theme that is not installed | Restores, because it is slug-shaped ([validBackupReaderOptions](https://github.com/bee-san/hachidori/blob/main/extension/backup-state.js#L71-L90) accepts it after T-18). It renders Default and Settings shows "(not installed)". |
| An `installed[slug]` entry with an invalid palette value | That entry is rejected with a named error. The rest of the backup restores (T-19 test). |
| Newer backup into an older Hachidori | Unsupported, as today. An older release rejects unknown theme ids. docs/backup-format.md says so. |

## Sharing and overlay

- Sharing ([SHARED_STATE_KEYS](https://github.com/bee-san/hachidori/blob/main/extension/background.js#L190)) keeps carrying only `options`, so the slug travels and `themes` does not. A linked browser without the theme renders Default until the same catalogue entry is used there (palettes and variants) or the release that bundles it is installed (renderers).
- Overlay hosts (GSM vendors the whole extension, [docs/overlay-mode.md:17-28](https://github.com/bee-san/hachidori/blob/main/docs/overlay-mode.md#L17-L28)) share the theme choice ([overlay-mode.md:108-111](https://github.com/bee-san/hachidori/blob/main/docs/overlay-mode.md)). A host that cannot load renderer scripts sets `rendererThemes: false` in `HOST_CAPABILITIES` ([overlay-mode.js:8-19](https://github.com/bee-san/hachidori/blob/main/extension/overlay-mode.js#L8-L19)) and gets Default with the theme's palette (T-20).

## Migration

**Stateless. No stored data is rewritten.**

1. **T-17**: reader.css is split into infra/palettes/components/default. The concatenation equals the old rule list, and screenshots are identical.
2. **T-22**: the palettes become `hachidori-theme-store/themes/<slug>/theme.yaml`, and the compiled `dist/palettes.css` is byte-identical to `render/palettes.css`. The extra Default rules for high-contrast, autumn, girlypop and miku stay in Hachidori's `default.css`, because they are part of the Default renderer.
3. **T-50/T-51**: Hachidori vendors `palettes.css`, `index.json` and `catalogue.js`, and `POPUP_THEME_GROUPS` is derived from the index. Hard-coded counts in the tests read the index.
4. **T-18**: slug-shaped normalisation. `"unknown"` is now kept, where it used to become `default`. The extension-smoke assertion at [4709-4715](https://github.com/bee-san/hachidori/blob/main/test/extension-smoke.mjs#L4703-L4715) and architecture.md:1786-1787 are updated in the same PR.
5. Existing Custom CSS written against Default's classes keeps working while Default (or any palette) is selected. Under a renderer theme it applies to that renderer's DOM. Hachidori does not migrate Custom CSS or Custom JS into themes (out of scope).
