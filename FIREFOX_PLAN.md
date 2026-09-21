# Firefox Desktop Port Without Media Capture

## Product boundary

- Ship a Firefox 153+ desktop edition for Windows, macOS, and Linux without changing Chrome behavior.
- Reuse lookup, popup, dictionaries, settings, Anki, pronunciation, sharing, backup, and the existing WASM OPFS/IDBFS engines.
- Do not ship media recording, animated AVIF capture, captured WAV, capture controls, or browser-speech recording.
- Keep ordinary page screenshots and pronunciation playback.
- Do not target Firefox Android or add automatic Chrome-profile migration.

## Architecture

- Keep Chrome on its existing MV3 service worker and `chrome.offscreen` document.
- Use a Firefox-only MV2 persistent background page with stable ID `hachidori@bee-san` and minimum Firefox `153.0`.
- Host `offscreen.html` in one hidden persistent iframe. The iframe and background page authenticate readiness with the extension ID, exact extension URLs, and sender context before requests are relayed.
- Select `globalThis.browser` for promise-based Firefox calls and `globalThis.chrome` for Chrome. Content-reader callback calls remain unchanged.
- Retain the threaded OPFS capability probe and the existing IDBFS fallback; add no third backend.

## Firefox behavior

- Disable media capture, browser-speech capture, and MV3-only custom JavaScript while retaining screenshots, pronunciation, backup, sharing, custom buttons, custom CSS, shortcuts, and local-file reading.
- Hide media navigation, settings search results, and the toolbar recording action.
- Reject crafted media-capture messages with an explicit unsupported response.
- Preserve saved capture configuration and custom template text so moving a backup back to Chrome is lossless.
- Derive extension origins and internal URLs from `runtime.getURL()`.
- Use Firefox wording for browser-owned controls: `commands.openShortcutSettings()` opens the shortcut manager, and the local-file panel gives the `about:addons` path because Firefox lets no extension open it.

## Packaging and validation

- Keep `extension/manifest.firefox.json` reviewed beside the Chrome manifest and test shared-field parity.
- Assemble an ignored Firefox directory without modifying `extension/manifest.json`.
- Pin `web-ext` and lint the assembled directory with zero errors.
- `scripts/package-store.py` publishes the Chrome ZIP, the unsigned Firefox XPI, one complete matching source archive, and checksums from the same committed tree; `scripts/firefox-package.json` is the single list of Chrome-only files, and `scripts/verify-firefox-package.mjs` re-checks the written XPI.
- Add Firefox WebDriver coverage incrementally, beginning with temporary installation, engine readiness, import, lookup, hidden capture UI, and fail-closed capture messages.

## Review sequence

1. Delivered: browser API seam, Firefox manifest, persistent background/offscreen host, preparation command, and core install/import/lookup smoke.
2. Delivered: non-capture feature parity (custom JavaScript explicitly unavailable), Firefox-specific UI copy, and the release XPI built and verified beside the Chrome ZIP.
3. Follow-up: cross-platform and Firefox-minimum CI, performance evidence, a Firefox path for custom JavaScript, and AMO readiness.
