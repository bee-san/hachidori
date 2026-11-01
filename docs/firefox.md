# Firefox

Hachidori runs in desktop Firefox 153 or newer; the tests run on Linux. The
Firefox build is the same `extension/` folder as the Chrome extension, with a
manifest generated for Firefox: the same reader, popup, dictionaries and
WebAssembly engine, Settings, search page, Anki mining, pronunciation,
keybinds, backups, updates, themes and Sharing. A backup made in Chrome
restores in Firefox, which the Firefox suite tests, and a Firefox backup
restores in Chrome, which was checked by hand. The few places where Firefox
cannot do what Chrome does are listed under [Differences](#differences).

## Install

Each [release](https://github.com/bee-san/hachidori/releases) after 0.3.2 has a
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
| `minimum_chrome_version`, `cross_origin_*_policy` | `browser_specific_settings.gecko`: ID `hachidori@bee-san`, `strict_min_version` 153.0, `data_collection_permissions` | Firefox cannot isolate extension pages; the ID keys Firefox's storage for the add-on; the data types are explained under [Packaging](#packaging-and-addonsmozillaorg) |

`background.html` also loads `event-page.js`, which calls
`runtime.getPlatformInfo()` every 20 seconds. Firefox stops an idle event page
after 30 seconds, and the engine frame with it, which would unload every
dictionary until the next request reloaded them from IndexedDB. An extension
API call that Firefox answers in its parent process, as it does
`getPlatformInfo()`, restarts that idle timer, so the page lives as long as
Chrome's offscreen document does. The Chrome ZIP leaves out both files.

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
- **Sharing.** Needs Hachidori Relay 0.0.6 or newer, the first to accept
  Firefox's `moz-extension://` origin. Settings → Sharing downloads it.

## Packaging and addons.mozilla.org

`python3 scripts/package-store.py --output-dir DIR` writes the Chrome ZIP, the
Firefox ZIP, the matching source ZIP and `SHA256SUMS.txt` from the committed
tree, and the Release workflow uploads all of them. The Firefox ZIP is the
Chrome upload with `background.html`, `event-page.js` and the Firefox manifest.
Nothing submits it to addons.mozilla.org: an AMO listing and its review are the
owner's decision. Before a first upload:

- **Data collection.** The manifest declares `websiteContent` and
  `browsingActivity` as required, and Firefox shows them when the add-on is
  installed. Mozilla counts data that leaves the browser for another program
  as transmitted, and Hachidori sends some to programs the user sets up: Anki
  notes carry the page's sentence, screenshot and title, word highlighting asks
  Anki about the words on a page, pronunciation sources get the looked-up word,
  and a linked browser sends its lookups to the sharing host
  ([privacy.md](privacy.md)). Nothing goes to Hachidori's publisher.
- **User scripts.** AMO's policy allows the `userScripts` API only in user
  script managers. A listed version may have to leave Custom JavaScript out of
  the Firefox manifest.

`web-ext lint` (the addons.mozilla.org validator) reports no errors and five
warnings, all in code shared with Chrome:

- `anki-glossary.js` sets `innerHTML` on an inert document to read glossary HTML
  it has escaped.
- `theme-host.js` and `vendor/zip.js` import a module whose path is a variable:
  a packaged theme, and zip.js's worker.
- `chrome-offscreen.js` tests for `chrome.offscreen.createDocument` and calls it
  when it exists. Firefox has no offscreen API, so it never makes the call.

## Tests

`node test/run.mjs install-firefox` installs the pinned Firefox
(`config.firefox` in `test/tooling/package.json`; `config.minimumFirefox` is the
manifest minimum). Then:

- `node test/run.mjs firefox-lint` runs `web-ext lint` on the Firefox build.
- `node test/run.mjs firefox-e2e` runs the real-Firefox suite.
- `HACHIDORI_BENCH_DATA=DIR node test/run.mjs firefox-large` imports the full
  Pixiv dictionary.

The Firefox suite restores backups that Chrome releases exported. A Firefox
backup restoring in Chrome is not part of a suite; it was checked by hand.

[The test guide](../test/README.md#firefox-suites) says what they prove.
