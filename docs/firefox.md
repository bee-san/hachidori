# Firefox

Hachidori runs in Firefox 153 or newer on Windows, macOS and Linux (desktop).
The Firefox build is the same `extension/` folder as the Chrome extension, with
a manifest generated for Firefox: the same reader, popup, dictionaries and
WebAssembly engine, Settings, Anki mining, pronunciation, keybinds, backups,
updates, themes and Sharing. A backup made in Chrome restores in Firefox and
the other way round. The few places where Firefox cannot do what Chrome does
are listed under [Differences](#differences).

## Install

Each [release](https://github.com/bee-san/hachidori/releases) has a
`hachidori-<version>-<commit>-firefox.zip` beside the Chrome ZIP; the release's
`SHA256SUMS.txt` lists its checksum. It is not on addons.mozilla.org yet, and
release Firefox only installs extensions Mozilla has signed, so:

- **Try it in any Firefox:** open `about:debugging#/runtime/this-firefox`,
  choose **Load Temporary Add-on…** and select the ZIP. Firefox removes a
  temporary add-on, and its data, when it closes.
- **Keep it installed:** in Firefox Developer Edition, Nightly or ESR, set
  `xpinstall.signatures.required` to `false` in `about:config`, then open
  `about:addons`, choose **Install Add-on From File…** from the gear menu and
  select the ZIP.

To run a checkout, write the Firefox build with
`python3 scripts/build-firefox.py --output-dir /tmp/hachidori-firefox` and load
`/tmp/hachidori-firefox/manifest.json` as a temporary add-on.

## How the Firefox build differs inside

`scripts/firefox_manifest.py` turns `extension/manifest.json` into the Firefox
manifest. Everything else in the manifest is shared, and a Node test fails if
anything else differs.

| Chrome manifest | Firefox manifest | Why |
| --- | --- | --- |
| `background.service_worker` | `background.page: background.html` | Firefox has no extension service workers. `background.html` runs `background.js` as a module, as Chrome's worker does |
| `offscreen` permission | none | Firefox has no offscreen documents; `background.html` holds `offscreen.html` in a frame |
| `tabCapture` permission | none | Firefox has no tab capture for extensions |
| `userScripts` permission | `optional_permissions: ["userScripts"]` | Firefox grants it only on request |
| `minimum_chrome_version`, `cross_origin_*_policy` | `browser_specific_settings.gecko`: ID `hachidori@bee-san`, `strict_min_version` 153.0, no data collection | Firefox cannot isolate extension pages; the ID keys Firefox's storage for the add-on |

`background.html` also loads `event-page.js`, which calls
`runtime.getPlatformInfo()` every 20 seconds. Firefox stops an idle event page
after 30 seconds, and the engine frame with it, which would unload every
dictionary until the next request reloaded them from IndexedDB. Any extension
API call from the page restarts Firefox's idle timer, so the page lives as long
as Chrome's offscreen document does. The Chrome ZIP leaves out both files.

Two runtime rules keep one source for both browsers:

- Content scripts read the `HD*` namespaces and `chrome` through `globalThis`.
  Firefox runs content scripts in a sandbox whose `window` is the page's window,
  where a namespace another content script put on `globalThis` is not visible;
  in Chrome both names are the same object.
- `browser-api.js` names the background sender from the manifest
  (`expectedBackgroundUrl`) and tells Firefox apart by its `moz-extension:`
  pages (`isFirefox`). Settings uses that for Firefox's wording and controls.

## Differences

- **Engine.** Firefox cannot cross-origin isolate extension pages, so there is
  no shared WebAssembly memory. The engine is the single-thread build in a
  worker, on IndexedDB (`hd_status` reports `threaded: false`,
  `storageBackend: "idbfs"`), the path Chrome uses without isolation. Imports
  run on one thread: the full Pixiv dictionary (387 MB, 776,724 terms) took
  16 seconds to import in Firefox 159 on Linux in `firefox-large` below. Low memory mode and the entry and index
  storage choices are hidden, as on other single-thread hosts
  ([memory.md](memory.md)).
- **Netflix mining (experimental).** Firefox has neither tab capture nor
  `MediaStreamTrackProcessor`, so notes get no line audio or GIF; they still get
  the subtitle line as the sentence and the page screenshot, with a warning
  that says why.
- **Local files.** Firefox's switch is **Access local files on your computer**
  in `about:addons` → Hachidori → **Permissions and data**, off by default.
  Extensions cannot open that page, so **Read saved pages too** says where it
  is instead of offering a button.
- **Custom JavaScript.** Settings → Design → Custom JavaScript has an **Allow
  user scripts** button; Firefox asks once, and the saved script runs from then
  on.
- **Browser shortcuts.** **Change in Firefox** opens Firefox's add-on shortcut
  manager.
- **Backups.** Export follows Firefox's **Always ask you where to save files**
  setting rather than always showing a Save dialog.
- **Sharing.** Needs Hachidori Relay 0.0.6 or newer, the first to accept
  Firefox's `moz-extension://` origin. Settings → Sharing downloads it.

## Packaging and addons.mozilla.org

`python3 scripts/package-store.py --output-dir DIR` writes the Chrome ZIP, the
Firefox ZIP, the matching source ZIP and `SHA256SUMS.txt` from the committed
tree, and the Release workflow uploads all of them. The Firefox ZIP is the
Chrome upload with `background.html`, `event-page.js` and the Firefox manifest,
ready to upload to addons.mozilla.org with the source ZIP. Nothing submits it:
an AMO listing and its review are the owner's decision. Before a first upload,
check that the manifest's `data_collection_permissions` (`none`: Hachidori
sends nothing to its publisher) matches the listing.

`web-ext lint` (the addons.mozilla.org validator) reports no errors and five
warnings, all in code shared with Chrome: `innerHTML` in `anki-glossary.js` and
`theme-host.js`, zip.js's dynamic worker import in `vendor/zip.js`, and the two
`chrome.offscreen` calls in `chrome-offscreen.js`, which Firefox never reaches
because it has no `chrome.offscreen`.

## Tests

`node test/run.mjs install-firefox` installs the pinned Firefox
(`config.firefox` in `test/tooling/package.json`; `config.minimumFirefox` is the
manifest minimum). Then:

- `node test/run.mjs firefox-lint` runs `web-ext lint` on the Firefox build.
- `node test/run.mjs firefox-e2e` runs the real-Firefox suite.
- `HACHIDORI_BENCH_DATA=DIR node test/run.mjs firefox-large` imports the full
  Pixiv dictionary.

[The test guide](../test/README.md#firefox-suites) says what they prove.
