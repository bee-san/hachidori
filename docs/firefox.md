# Firefox

Hachidori ships an unsigned Firefox 153+ desktop package for Windows, macOS,
and Linux with every GitHub release. It uses the same dictionaries, popup,
settings, Anki integration, pronunciation, sharing, backup format, and
WebAssembly engine as Chrome. It is not on addons.mozilla.org yet.

Media recording is intentionally unavailable. Firefox does not show the Media
capture settings or toolbar recording action, does not inject the capture
content script, and rejects capture messages. Browser text-to-speech plays but
is not recorded into Anki. Ordinary page screenshots and pronunciation playback
remain available. Saved capture settings and custom template markers are
preserved for backup compatibility with Chrome.

Custom JavaScript is also unavailable. Chrome registers it through the MV3
`userScripts` API, which Firefox's MV2 extensions do not offer; Settings hides
the editor and any saved code stays inert. Custom CSS works in both browsers.

Firefox runs the dictionary engine on the single-thread IDBFS backend, because
an MV2 extension page cannot set the cross-origin isolation headers that
`SharedArrayBuffer` needs. Imports and lookups are slower than Chrome's
threaded OPFS engine but use the same dictionaries.

## Install a release

1. Download `hachidori-<version>-<commit>-firefox-unsigned.xpi` from the
   [latest release](https://github.com/bee-san/hachidori/releases). The
   `*-SHA256SUMS.txt` in the same release lists its checksum.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select the `.xpi`.
4. Finish Hachidori setup and install or import a dictionary.

Firefox removes temporary add-ons when the browser closes. The XPI is unsigned;
permanent installation waits on AMO review and signing.

Use Firefox’s Add-ons Manager (`about:addons`) for extension permissions,
local-file access, and browser-owned shortcuts. Hachidori’s backup and Sharing
features are the supported ways to move state between Chrome and Firefox.

## Build from a checkout

```sh
npm ci --prefix test/tooling
python3 scripts/package-store.py --output-dir /tmp/hachidori-release
```

The one packager writes the Chrome ZIP, the Firefox XPI, the matching source
archive, and `SHA256SUMS.txt` from the committed tree. The XPI is the Chrome
upload minus the files in `scripts/firefox-package.json` (the capture
controls, recorder, WAV and speech capture, and animated-AVIF encoder), with
`manifest.firefox.json` in place of `manifest.json`. The packager refuses a
Firefox manifest whose version differs from Chrome's or that references an
excluded file, and `scripts/verify-firefox-package.mjs` re-checks the written
XPI in CI.

For a directory Firefox can load without packaging, and for `web-ext lint`:

```sh
npm --prefix test/tooling run lint:firefox        # stages test/tmp/firefox-extension, then lints it
```

Pull requests run the packager and publish the XPI as the
`firefox-unsigned-xpi` workflow artifact, then install that XPI in the pinned
Firefox for the smoke test (`npm --prefix test/tooling run test:firefox`).

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

## Follow-up

- Cross-platform and minimum-version (Firefox 153) CI.
- AMO submission and signing.
- Custom JavaScript through a Firefox-compatible `userScripts` registration.
