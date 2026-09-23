<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# The Hachidori extension

This folder is the shared extension source and the Manifest V3 package exactly
as Chrome 128 or newer loads it, with no build step. The JavaScript is plain ES
modules and classic scripts, the dictionary engine is committed WebAssembly
under `vendor/`, and everything runs inside the browser. To run it in Chrome
from a checkout, open `chrome://extensions`, turn on **Developer mode**, choose
**Load unpacked** and select this folder. `scripts/package-store.py` zips this
same folder, with the licence files, for the Chrome Web Store.

`manifest.firefox.json` is the reviewed Firefox MV2 manifest. The same
packager writes the Firefox XPI from these sources minus the Chrome-only files
listed in `scripts/firefox-package.json`, with that manifest in place of
`manifest.json`; `scripts/prepare-firefox.mjs` stages the same layout in an
ignored directory for lint and the Firefox smoke test. See the
[Firefox guide](../docs/firefox.md) to build and temporarily install the
unsigned XPI.

[The architecture guide](../docs/architecture.md) explains how the pieces
work together and lists every runtime message and stored key. This page says
where things are.

## Entry points

Drag a lookup popup's bottom-right corner to resize it. The size is shared by
subsequent and nested lookups in that page, including after closing and reopening
the popup. Reloading or navigating the page (or restarting the browser) starts a
new reading session with the saved Design dimensions. Dragging does not change
those saved settings or other tabs.

The popup action row is one non-wrapping keyboard and visual group: a nested
Close or Back control first, then Anki, pronunciation, personal-dictionary
edit, and custom buttons in saved order. A custom button opens a URL template
or mines with a chosen Anki Template. Actions share a 36-pixel height and a
5-pixel gap. At narrow popup widths the whole action row scrolls horizontally
instead of wrapping, clipping, or overlapping controls. Browser mode opens link
buttons in a Chrome tab; overlay mode asks its embedding host to open the same
validated URL in the system browser.

`manifest.json` names them.

| File | Runs as | Role |
| --- | --- | --- |
| `background.js` | the service worker | Routes every runtime message and owns everything in `chrome.storage.local`: dictionary metadata, options, the personal dictionary, update schedules, lookup counts, automatic-backup metadata, first-run and sharing state. It also owns the alarms, the Anki gateway and the sharing host and client. It holds no engine state, so Chrome may stop it whenever it is idle. |
| `firefox-background.html`, `firefox-background.js` | Firefox’s persistent MV2 background page | Loads the shared background module and hosts `offscreen.html` in one authenticated hidden iframe so the engine remains warm. |
| `content.js`, with the classic scripts listed under `content_scripts` | every web page | Scans the Japanese text near the pointer, renders the popup in a closed shadow root through `render/popup.js` and `render/glossary.js`, and adds the popup's Anki and pronunciation controls (`anki-content.js`, `audio-content.js`). Chrome also injects `capture-content.js`; Firefox does not. `content.css` is the only style the page itself receives: the source highlight. |
| `offscreen.html`, `offscreen.js` | Chrome’s offscreen document or Firefox’s hidden background iframe | Owns the dictionary engine. `engine-worker.js` runs the pthread build with direct OPFS once `opfs-capability-worker.js` has proved the browser can, and imports each archive in a short-lived second instance, `import-worker.js`, so lookups keep working; `engine-worker-idbfs.js` runs the pthread build on IDBFS when the browser has shared memory but no OPFS access handles (Electron), both through `engine-worker-runtime.js`; `engine-service.js` is also the single-thread IDBFS fallback. `engine-recycler.js` decides when Low memory mode replaces the worker ([docs/memory.md](../docs/memory.md)). Pronunciation, Anki and the first-run installer load here on demand. Chrome also hosts media capture here. |
| `settings.html`, `settings.js` | the options page | Dictionaries, groups, updates, the personal dictionary, Reading, Design, pronunciation, Anki, keybinds, backup and sharing, with media capture where supported and global search. The larger sections have their own `*-settings.js` controller; `design-preview.html` is the live preview inside Design. |
| `startup.html`, `startup.js` | a tab opened once after install | First-run setup: recommended dictionaries, Anki detection, a practice lookup, and the offer to use a Hachidori that another browser on this computer already shares. Overlay mode skips it. |
| `toolbar.html`, `toolbar.js` | the toolbar button's popup | Turns lookups on and off, shows the sharing state and opens Settings. Chrome also exposes the recording action here. |
| `capture.html`, `capture.js` | a Chrome-only tab opened from the toolbar or Settings | Controls media capture. The recorder itself, `capture-host.js`, runs in the offscreen document and keeps going when this tab closes. Firefox does not expose this entry point. |

`overlay-mode.js`, its `browser-api.js` dependency, `render/reader.css` and
`icons.css` are the only files web pages may fetch
(`web_accessible_resources`). The popup and its Anki controls load the two
stylesheets; overlay hosts use the shared mode contract.

## Modules by feature

Files share a prefix with the feature they belong to. A rule that more than
one context needs lives in a module with no Chrome dependency, so Settings,
the service worker and both engine runtimes run the same code.

- **Dictionaries and stored state.** `reader-options.js` is the one stored
  options view every context reads. `dictionary-group-state.js` and
  `dictionary-groups.js` hold the group rules and their Settings controls,
  `dictionary-name-drafts.js` the autosaved names, `dictionary-progress.js`
  the import progress. `managed-dictionary-source.js` and
  `recommended-dictionaries.js` define the trusted update sources and the
  starter set; `custom-dictionary.js` the personal dictionary's source format
  and archive; `setup-state.js` the first-run stages and initial selections;
  `setup-installer.js` the offscreen recommended installer, observed from startup
  and Settings by `recommended-install-client.js`. `json-value.js` and `response-limits.js`
  are the comparison and size rules the transaction boundaries share.
- **Lookup statistics.** `lookup-stats-identity.js`, a classic script so the
  content script can use it, and `lookup-stats.js`.
- **Sentences.** `sentence.js` is Yomitan's sentence extraction: the content
  script cuts the text around a match at terminators, matching quotes and line
  breaks before it becomes the Anki sentence, the Note prefill and the `%s`
  of a custom link.
- **Anki.** `anki.js` is the AnkiConnect gateway and `anki-setup.js`
  recognises an existing mining setup. `anki-templates.js`, `anki-values.js`,
  `anki-glossary.js`, `anki-pitch.js`, `anki-resources.js` and `anki-audio.js` build the note
  fields and media. Stored Anki Templates group each destination, note type,
  field mapping and duplicate policy; the first powers the built-in action and
  custom Anki buttons select the others by stable ID. Settings edits every
  field mapping through an accessible marker combobox while retaining the
  mapping string exactly. `anki-duplicates.js` and
  `anki-enrichment.js` handle a
  note that already exists; `anki-digest.js` hashes media.
  `anki-client-media.js` validates final screenshot, capture and browser-speech
  media crossing a linked-browser boundary. `anki-mining.js` and
  `anki-worker.js` are the mining service in the
  service worker. `anki-index.js` and `anki-index-cache.js` provide the shared
  scoped duplicate and maturity index, including cache-only View readiness and
  click-time live ID repair. `anki-offscreen.js` launches
  `anki-index-worker.js` for complete refreshes without moving note fields
  through the service worker.
- **Pronunciation.** `audio-sources.js`, `audio-repository.js`,
  `audio-cache.js` and `audio-player.js` fetch, keep and play audio in the
  offscreen document (`audio-offscreen.js`); `speech.js` wraps the browser's
  text-to-speech.
- **Media capture.** `capture-host.js` is the offscreen recorder.
  `capture-session.js`, `capture-buffer.js`, `capture-timeline.js` and
  `capture-speech.js` are its bounded buffers, occurrence timeline and speech
  detection. `capture-audio-worklet.js`, `capture-frame-client.js` with
  `capture-frame-worker.js`, and `capture-encoder-client.js` with
  `capture-encoder-worker.js` move audio sampling, frame grabbing and animated
  AVIF encoding (`avif-sequence.js`) off the main thread.
  `texthooker-protocol.js` parses the text a texthooker sends.
- **Backup.** `backup-archive.js` is the manual ZIP format, `backup-state.js`
  the shared snapshot rules, `backup-automatic.js` the two-record daily
  retention, cadence and age rules, `backup-downloads.js` the pending downloads,
  and `backup-settings.js` the manual and automatic restore controls.
- **Sharing.** `sharing-protocol.js` is the wire contract both sides import;
  `sharing-host.js` and `sharing-client.js` are the two roles in the service
  worker; `sharing-settings.js` is the Settings section. `anki-addon.js` pins
  and downloads the compatible `.ankiaddon` release from
  [hachidori-anki](https://github.com/bee-san/hachidori-anki), which owns the
  Python relay, its tests, and packaging.
- **Google Docs.** `google-docs.js` registers `google-docs-flag.js` from the
  service worker while the experimental flag is on: a `document_start`
  main-world script on `docs.google.com` that asks Docs to draw its SVG
  annotation layer, which `content.js` then scans through an SVG `<text>`
  imposter.
- **Pages.** `settings-search.js` and `settings-dom.js` serve Settings;
  `settings-theme.js` is the classic script in its `<head>` that applies the
  saved theme before the first paint, ahead of the `settings.js` module;
  `experimental-settings.js` renders the Advanced → Experimental features
  switches from the registry in `reader-options.js`; `memory-settings.js`
  the Advanced → Memory readout and each Library row's *In memory* line;
  `keybind-settings.js`, `custom-button-settings.js` and `external-links.js`
  the keybinds and custom buttons in the popup; `local-file-access.js` the
  notice about Chrome's *Allow access to file URLs* permission;
  `startup-practice.js` the practice step. `visual-novel.js` and
  `visual-novel.css` draw the background scenes behind the startup page and
  the Design preview from the images in `assets/` (see
  `assets/ATTRIBUTION.md`); `design-preview.js` renders the preview from
  `sample-meal.svg` and local sample data.
- **Renderer.** `render/` is the popup renderer ported from GameSentenceMiner,
  which adapts Hoshi Reader and Yomitan; `render/ATTRIBUTION.md` records what
  came from where.
- **Overlay mode.** `overlay-mode.js` is the one switch a host such as the
  GameSentenceMiner overlay flips in its copy. It also defines the shared
  host-capability policy used by Settings, the toolbar, the reader and the
  service worker; see
  [overlay mode](../docs/overlay-mode.md).
- **Vendored code.** `vendor/hoshidicts-threaded.{mjs,wasm}`,
  `vendor/hoshidicts-threaded-idbfs.{mjs,wasm}` and
  `vendor/hoshidicts.{mjs,wasm}` are the three builds of the hoshidicts engine
  from `wasm/build.sh`, `vendor/avif-encoder.{mjs,wasm}` the AVIF encoder
  from `wasm/avif/`, and `vendor/zip.js` the pinned zip.js runtime. They are
  committed build output: update them with their source change and otherwise
  leave them alone.
- `icons/` holds the extension's icons.

## Conventions

- Every script, stylesheet and page starts with an
  `SPDX-License-Identifier: GPL-3.0-or-later` line; the files under `render/`
  also keep their upstream copyright lines.
- A rule the content script needs as well as the module contexts lives in a
  classic script that publishes one `globalThis.HD…` object
  (`HDReaderOptions`, `HDLookupStats`, `HDDictionaryGroups`, …); modules
  import such a file for its side effect.
- Runtime messages are objects with a `target` and an `hd_*` `type`, and
  they carry explicit ids, revisions or generations so a stale reply fails
  closed. Stored values are revisioned and written only by the service
  worker; a page edits them by compare-and-set. The offscreen document never
  touches `chrome.storage` itself.
- Nothing here is generated except `vendor/`. There is no bundler,
  transpiler or minifier: what is committed is what ships.

## Checking a change

```sh
node test/make-fixture.mjs      # writes the dictionary fixtures once
node test/extension-smoke.mjs   # this folder's JavaScript against the real engine, in Node
node test/chrome-e2e.mjs        # this folder loaded unpacked into a real Chrome
```

[The test guide](../test/README.md) says what each suite proves and how to
install the browser and jsdom they need; the validation list in
[AGENTS.md](../AGENTS.md) says which checks each kind of change requires.
Sharing changes have their own suites, listed in [sharing](../docs/sharing.md).

## More

- [Privacy](../docs/privacy.md): what leaves the browser, and when.
- [Sharing](../docs/sharing.md), [overlay mode](../docs/overlay-mode.md),
  [media capture](../docs/media-capture.md),
  [the backup format](../docs/backup-format.md),
  [update schedules](../docs/update-schedules.md) and
  [lookup statistics](../docs/lookup-statistics.md) describe those features.
- [Building a source archive](../docs/source-build.md) covers `wasm/` and
  the `third_party/hoshidicts` submodule behind `vendor/`.
