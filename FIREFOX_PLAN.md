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

- Disable media capture and browser-speech capture while retaining screenshots, pronunciation, backup, sharing, custom links, shortcuts, and local-file reading.
- Hide media navigation, settings search results, and the toolbar recording action.
- Reject crafted media-capture messages with an explicit unsupported response.
- Preserve saved capture configuration and custom template text so moving a backup back to Chrome is lossless.
- Derive extension origins and internal URLs from `runtime.getURL()`.
- Use Firefox wording and `about:addons` for browser-owned extension and shortcut controls.

## Packaging and validation

- Keep `extension/manifest.firefox.json` reviewed beside the Chrome manifest and test shared-field parity.
- Assemble an ignored Firefox directory without modifying `extension/manifest.json`.
- Pin `web-ext`, lint the assembled package with zero errors, and emit an unsigned XPI suitable for temporary installation.
- Extend release packaging later to publish Chrome ZIP, Firefox XPI, one complete matching source archive, and checksums.
- Add Firefox WebDriver coverage incrementally, beginning with temporary installation, engine readiness, import, lookup, hidden capture UI, and fail-closed capture messages.

## Review sequence

1. Browser API seam, Firefox manifest, persistent background/offscreen host, preparation/package command, and core install/import/lookup smoke.
2. Complete non-capture feature parity, Firefox-specific UI copy, and Anki/audio/backup/sharing coverage.
3. Cross-platform CI, release validation, full documentation, performance evidence, and AMO readiness.

This draft PR implements the installable first slice and leaves the later parity and release work explicitly reviewable.
