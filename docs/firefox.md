# Firefox draft

Hachidori has an unsigned Firefox 153+ desktop draft for Windows, macOS, and
Linux. It uses the same dictionaries, popup, settings, Anki integration,
pronunciation, sharing, backup format, and WebAssembly engine as Chrome.

Media recording is intentionally unavailable. Firefox does not show the Media
capture settings or toolbar recording action, does not inject the capture
content script, and rejects capture messages. Ordinary page screenshots and
pronunciation playback remain available. Saved capture settings and custom
template markers are preserved for backup compatibility with Chrome.

## Build the temporary-install XPI

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run package:firefox
```

The command runs `web-ext lint`, assembles the Firefox manifest without editing
`extension/manifest.json`, excludes the Chrome capture controls, recorder, WAV
capture, and animated-AVIF encoder, and writes:

```text
test/tmp/firefox-artifacts/hachidori-0.1.0-firefox-unsigned.xpi
```

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select the generated `.xpi` (or the staged `manifest.json` under
   `test/tmp/firefox-extension`).
4. Finish Hachidori setup and install or import a dictionary.

Firefox removes temporary add-ons when the browser closes. The XPI is unsigned;
normal permanent installation remains gated on AMO review and signing.

Use Firefox’s Add-ons Manager (`about:addons`) for extension permissions and
browser-owned shortcuts. Hachidori’s backup/export and Sharing features are the
supported ways to move state between Chrome and Firefox.

Pull requests also publish the same unsigned XPI as the
`firefox-draft-unsigned-xpi` workflow artifact.

## Lint review

`web-ext lint` reports zero errors. Two warnings are in existing reviewed code
shared with Chrome:

- `anki-glossary.js` assigns generated definition HTML. User and dictionary
  strings pass through an inert element’s `textContent`; the only markup added
  by that path is Hachidori’s fixed line-break separator. The Anki glossary
  tests cover structured content, aliases, media, CSS escaping, and hostile
  style termination.
- `vendor/zip.js` contains zip.js’s dynamic worker import. The vendored
  `zip.js` 2.11.2 bytes are pinned and checked against their source package by
  the existing store-package verification.

The other two warnings identify guarded `chrome.offscreen.createDocument()`
references in `chrome-offscreen.js`. Firefox imports the shared background
module but takes the persistent-iframe branch before this helper can run. The
real Firefox smoke installs the packaged XPI, verifies the authenticated iframe
host, imports a dictionary, performs a lookup, and checks the same iframe and
engine generation after 31 seconds.

None of these warnings adds remote executable code to the Firefox package.
