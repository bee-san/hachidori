<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Hachidori test harness

This page is an index: each file below with what it proves, plus what the code
does not say on its own (setup, environment, conventions). The checks themselves
are named in the code, and for the two largest suites the spec reporter that
`test/run.mjs` passes prints each test's name as it runs.

## Run the checks

Use Node **22.23.1** (`.node-version`) and npm **10.9.8**. The bridge suite needs
Node 22.15 or newer. Sharing tests invoke `python3`; CI pins **Python 3.13.2**.
The add-on repository tests each packaged release on **Python 3.9**.
Ordinary JavaScript tests use the committed WASM bundles and need no build or
submodule checkout.

From the repository root, these are the same commands CI runs:

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run lint             # ESLint: undeclared names, unused bindings, redeclarations
npm --prefix test/tooling test                 # all test/*.test.mjs and benchmark/*.test.mjs
npm --prefix test/tooling run test:smoke        # both WASM variants, bridge, extension
npm --prefix test/tooling run install:chrome    # Chrome for Testing 152.0.7977.75
npm --prefix test/tooling run test:chrome       # primary OPFS path and UI
npm --prefix test/tooling run test:sharing      # two browsers and the Python relay
npm --prefix test/tooling run test:fallback     # IDBFS path
npm --prefix test/tooling run test:overlay      # GameSentenceMiner overlay mode
HACHIDORI_CHROME_BUILD=128.0.6613.137 \
  node test/run.mjs chrome-e2e                   # manifest-minimum Chrome
```

`test/tooling/package-lock.json` locks jsdom, Puppeteer, the browser installer,
ESLint **10.12.0** and `globals` **17.13.0**, plus their transitive dependencies. The small `test/run.mjs` launcher
supplies the existing environment overrides, generates fixtures, runs each
existing suite in a separate Node process, and propagates every nonzero exit or
signal; logs go to `test/tmp/ci/<suite>.log`. It selects the exact Chrome build
from `test/tooling/package.json` rather than whichever browser happens to be
newest in a developer's cache. Dependencies are isolated from the extension under
`test/tooling/node_modules`; the browser is ignored under `test/tmp/browsers`.
The launcher ignores a machine-wide `CHROME_BIN` (GitHub runners set it to their
system browser). Use `HACHIDORI_CHROME` for an intentional browser executable
override, or `HACHIDORI_CHROME_BUILD` to install and select an exact Chrome for
Testing build.

On Ubuntu/Debian, install the browser's system dependencies with
`sudo "$(command -v node)" test/run.mjs install-chrome --install-deps` and install
`fonts-noto-cjk` for Japanese text. CI uses Ubuntu 24.04 with these dependencies.
For a Linux container that cannot run Chrome's sandbox, set
`HACHIDORI_ALLOW_NO_SANDBOX=1` for the browser commands. Sharing needs a usable
non-loopback network address for its other-computer checks.

`.github/workflows/runtime-tests.yml` runs ESLint, the Node contracts, smoke tests and the
five Chrome browser suites on every PR and push to `main`, or manually. It also
runs the primary Chrome suite on the exact Chrome 128 build recorded beside the
current Chrome 152 pin, and creates and checksum-verifies the Chrome/source
release pair. The release contract fails if the tested minimum drifts from the
manifest. The browser matrix runs independently so one failing suite cannot hide
the others. Failing CI jobs upload `test/tmp/ci`, the available screenshots, and
the browser profiles retained by failed suites, for seven days. The same commands
reproduce the failure locally.

`npm --prefix test/tooling run lint` runs ESLint over every JavaScript file except
`extension/vendor/`, `third_party/` and git-ignored output, with only `no-undef`,
`no-unused-vars` and `no-redeclare`. `test/tooling/eslint.config.mjs` gives each
file the globals of the context it runs in: classic content and page scripts with
the `HD*` namespaces they publish, page main-world scripts, the service-worker
module, dedicated workers, extension pages and the modules they share, Node, and
the browser suites' Puppeteer callbacks. Content scripts come from the manifest;
the config lists the rest by hand. Add a classic page script or a registered
isolated-world script to `CLASSIC` and a new `HD*` namespace to `published`. Add
a main-world script to `MAIN_WORLD` and a module that only the service worker or
a worker loads to `SERVICE_WORKER` or `WORKERS`: a file missing from those three
lists gets extension-page globals, so a `chrome` or `document` it cannot use
still passes.

Direct `node test/...` commands below still support the external cache and
`HACHIDORI_JSDOM`, `HACHIDORI_PUPPETEER`, and `HACHIDORI_CHROME` overrides. Unlike
the launcher, a direct `node test/chrome-e2e.mjs` also accepts `CHROME_BIN`: it
takes `HACHIDORI_CHROME`, then `CHROME_BIN`, then the newest Chrome for Testing in
the external cache, then a system Chrome (`/usr/bin/google-chrome` and the like),
and stops with a message naming `HACHIDORI_CHROME` or `HACHIDORI_PUPPETEER` when
the browser or puppeteer-core is missing. To run a focused jsdom test with the
locked tooling directly:

```sh
HACHIDORI_JSDOM="$PWD/test/tooling" node --test test/sharing-settings.test.mjs
```

The lower-level checks can also be run individually, in this order:

```sh
node test/submodule-identity.mjs # 1. submodule/runtime identity is internally consistent
./wasm/build.sh                  # 2. produces threaded OPFS, threaded IDBFS and fallback IDBFS bundles
node --test test/custom-dictionary.test.mjs # 3. custom source and ZIP contract
node test/make-fixture.mjs       # 4. writes test/fixtures/
node test/node-smoke.mjs         # 5. threaded C ABI contract test
HACHIDORI_WASM_VARIANT=threaded-idbfs node test/node-smoke.mjs # 6a. threaded IDBFS C ABI contract test
HACHIDORI_WASM_VARIANT=fallback node test/node-smoke.mjs # 6. fallback C ABI contract test
node test/threaded-bridge-smoke.mjs # 7. both-backend bridge admission/control test
node test/extension-smoke.mjs    # 8. the extension's own JS against that wasm
node --test benchmark/*.test.mjs # 9. fail-closed benchmark framework tests
node test/chrome-e2e.mjs         # 10. pthread/OPFS path in a real Chrome
node test/chrome-fallback.mjs    # 12. capability fallback through IDBFS in real Chrome
node test/chrome-overlay.mjs     # 13. overlay capability Settings, glyph selection and host events in real Chrome
./test/baseline.sh               # 14. optional native cross-check
```

Step 4 is optional on its own: `node-smoke.mjs` imports the generator and builds
the fixture bytes in memory, and also writes them to `test/fixtures/` as a side
effect so `baseline.sh` has files to work with. Everything these scripts write
goes to `test/fixtures/` and `test/tmp/`. None of them touches
`third_party/hoshidicts`; `baseline.sh` configures it out-of-tree and fails if
`git status` in the submodule comes back dirty.

## The extension smoke and real-Chrome suites

`test/extension-smoke.mjs` and `test/chrome-e2e.mjs` run on `node:test`. Each
feature is one file under `test/extension-smoke/` or `test/chrome-e2e/`, one
`describe` per file, and each block of checks is one test. The entry file imports
every feature file in the order the suite runs, in one process.

```sh
node test/extension-smoke.mjs                        # the whole suite
node test/extension-smoke/sharing.mjs                # one file
node --test-name-pattern="Anki" test/extension-smoke.mjs   # tests or describes matching a regex
node --test-name-pattern="^import$" test/chrome-e2e.mjs    # one describe: chrome-e2e/import.mjs
```

- The checks are soft. `check()`, `equal()`, `pass()` and `fail()` in the smoke
  suite and `check()` in the Chrome suite print their `PASS`/`FAIL` or
  `ok`/`FAIL` line, record the result and carry on. A test fails once
  any check inside it has failed, and a test that throws fails on its own: the
  run goes on with the next test, and the summary lists every failed test.
- Some tests share expensive state. The smoke suite's `engine*.mjs`,
  `renderer.mjs` and `engine-restart.mjs`/`engine-storage.mjs` steps share one
  engine and its imported fixtures; every Chrome step shares one browser and its
  profile, in a fixed order, through a browser restart. These are *steps*:
  each such file imports the file before it, so running a file on its own runs
  the earlier steps first. When a name pattern leaves out steps that a selected
  step comes after, the selected step runs them first, printing
  `first the earlier step "…"`. Everything else is independent and runs alone.
- Values shared between steps are module-level bindings, assigned by the step
  that creates them; a step that changes another file's binding calls its
  setter (`setBrowser()`, `setLoseNextStateCasReply()`…).
- `test/run.mjs` passes `--test-force-exit --test-reporter=spec`. The code under
  test leaves timers behind (background.js's emulated alarms), so a direct run
  without `--test-force-exit` is ended by the suite's `after` hook a second
  after its last test, as the old scripts' final `process.exit()` did.

## Index

### Node contracts (`npm --prefix test/tooling test`)

Each `test/*.test.mjs` runs with `node --test`; the jsdom suites need
`HACHIDORI_JSDOM` (above). `benchmark/*.test.mjs` test the benchmark framework;
see [benchmark/README.md](../benchmark/README.md).

| file | what it proves |
| --- | --- |
| `activation-settings` | Reading → Activation key or button: No key first, mouse buttons above keys; **Press to set** records middle/Back/Forward without their native actions, records keys by name, refuses primary/secondary buttons and unlisted keys, ignores repeats, cancels on Escape. |
| `advanced-settings` | Advanced keeps dictionary experiments; Word highlighting's section, rail link, picker option and search results stay hidden until its experimental switch is on, and turning it off stops the marks in the same save. |
| `anki-addon` | The pinned GitHub add-on URL, binary preservation, HTTP and network errors. |
| `anki-audio`, `anki-offscreen-audio` | First decodable pronunciation exported without playback, exact TTS voice capture, linked TTS planned without host capture. |
| `anki-client-media` | Linked screenshot and browser-speech WAV bytes are allowlisted against the request; stale and malformed media are refused. |
| `anki-content` | The reader's Anki action across cold/warm cache, live repair, stale IDs, failures, retries and nested popups; an unresolved action is a disabled, busy Arrow Clockwise; a renderer can name the result owning the custom Anki buttons. |
| `anki-duplicates` | Duplicate options keep Anki's race guard on the configured type; browse searches escape HTML and query syntax. |
| `anki-enrichment` | Audio enrichment applies overwrite modes once and preserves a late external edit. |
| `anki-glossary` | Rich and plain glossary markers: ordered senses, aliases, safe media, `<br>`, one `li[data-dictionary]` per row, image sizes, style escaping, Yomitan's inline structured-content styles at 67db60d, and dictionary CSS scoped by selector prefix (the cascade itself is checked in Chrome). |
| `anki-index`, `anki-index-cache`, `anki-index-integration` | The duplicate index: scopes, note types, exact word keys, compact rows, maturity, deck filters, malformed replies; warm hits without Anki, miss repair, 30-minute refreshes, retained snapshots, worker restart, linked-role suspension; word status from rows in memory; the offscreen refresh worker returns compact rows and terminates. Never contacts an Anki collection. |
| `anki-media` | The media transaction: deduplicated PNG/SVG, deterministic names, valid base64, live inventory confirmation, retries without re-upload; bad media never reaches `addNote`. |
| `anki-mining`, `anki-worker` | Mining readiness, the worker's preflight and submission, deferred audio, Smaller Anki cards, Netflix `{sentence-audio}`/`{gif}` routing and the held media lifecycle. |
| `anki-note-type-compatibility`, `anki-templates`, `anki-setup` | The reviewed Kiku, Lapis and Senren schemas through production preset mapping (order, first field, every mapping and overwrite mode, blanks, markers), drift controls, template mapping and automatic setup's model and deck choice. See [Anki note-type compatibility](../docs/anki-note-type-compatibility.md). |
| `anki-pitch` | Pitch graph markers, kana mora counting, contours and the hollow-particle case. |
| `anki-resources` | Media planning is lazy, deduplicated and bound to the committed generation; plain fields load no CSS. |
| `anki-settings` | Anki Settings: overlay screenshot capability, discovery retries, setup proposals that never rewrite a verified mapping, per-Template discovery, connection status. |
| `anki-values` | Anki values: escaping, furigana, UTF-16 sentence/cloze offsets, `{popup-selection-text}` line breaks, the Netflix values. |
| `anki` | Global Anki configuration validation and the discovery `multi` batch. |
| `api-host` | The relay API contract: every request the relay sends and the extension's version. |
| `audio-*` (`sources`, `player`, `offscreen`, `cache`, `repository`, `content`) | Audio source options, candidate order, the player and its cleanup, TTS voices, Test deadlines, LRU/TTL/byte accounting, leases, exact candidate identity, the pronunciation chooser's placement and focus, autoplay, and named failures (#499, #501). |
| `autumn-theme` | Autumn stays one light theme and keeps text, badges and statuses readable. |
| `backup-archive`, `backup-automatic`, `backup-downloads`, `backup-settings`, `backup-state` | Backup export and restore without stream-to-blob consumption, automatic cadence and schema, download URL lifetime, Settings ages and confirmation, restore revisions. |
| `base64`, `browser-api` | Base64 helpers against `btoa`/`atob`; the extension API module and exact sender URLs. |
| `browser-commands` | The worker's command listener against the manifest: the toggle's revisioned write, Settings, and argument-free keybind actions forwarded to the active tab. |
| `chrome-web-store` | The service-account assertion and its token endpoint. |
| `custom-button-settings`, `custom-buttons-renderer`, `external-link-host` | Link templates and Anki Template selection, button editing, the overlay host request/result boundary, live editing without replacing cards or drafts. |
| `custom-dictionary` | The personal dictionary's source and ZIP contract: parsing, comments, ordered duplicates, malformed-line reports, CRLF append, escape round trips, a byte-deterministic multi-bank ZIP (imported through the real WASM engine by the smoke suite). |
| `custom-javascript` | Custom JavaScript sits beneath Custom CSS with one warning and persists as a Design option. |
| `debug-info`, `debug-log` | The debug report's contents without reader content; the log keeps the newest entries. |
| `definition-blur-frequency` | Frequency blur options and their inclusive boundaries. |
| `dictionary-import`, `dictionary-import-errors` | Revision comparison, MDX loss-count notes, and mmap/writeback failures that cleanup cannot hide. |
| `dictionary-index-storage` | The hash-index budget: smallest tables stay resident, stable ties, enabled packages counted once, 65 MiB with **Use less ram by default** and 32 MiB in Low memory mode. |
| `dictionary-name-drafts`, `dictionary-update-schedule` | Name autosave and external renames; per-dictionary schedules and due times. |
| `engine-recycler`, `memory-settings`, `low-memory-option` | [Low memory mode](../docs/memory.md): the recycle scheduler, the Advanced → Memory readout and per-row *In memory*, and the options' normalisation. |
| `engine-status-settings` | Load failures render as a summary with one literal entry per dictionary. |
| `error-text` | The exact text each `error-text.js` variant gives an Error, an empty-message Error, a string, a plain object with and without a `message`, an Error from another realm, and `null`, `undefined` and `NaN`, so sharing the variants cannot change a log line, status or reply. |
| `experimental-features`, `experimental-settings` | The experimental-features registry and its switches. |
| `fluent-icons`, `settings-fluent-icons` | The vendored Fluent subset, its provenance and use by controls. |
| `frequency-presentation` | Yomitan-style frequency values and tags, abbreviations, averages and live controls. |
| `furigana` | Headword furigana split by KANJIDIC readings. |
| `google-docs` | The Google Docs flag and its main-world script. |
| `issue-template` | The issue template and its validator, with mocked GitHub calls; it never closes real issues. |
| `kanji-click-settings`, `kanji-group-mining`, `reader-options` | The clicked-kanji chooser and groups, `kanjiEntryResult` against the engine's `LookupResult`, and reader option normalisation. |
| `keybind-settings` | Yomitan's default keybinds, capture, Alt+wheel rows and Chrome's browser shortcuts list. |
| `linked-import` | Dictionary uploads from a linked browser: chunk order and limits, replace or install beside, aborts and timeouts. |
| `local-audio-setup`, `local-file-access`, `startup-practice` | Local audio detection, the file-access prompt and the startup practice step's recovery. |
| `lookup-stats` | Canonical lookup-count keys and their row updates. |
| `message-types` | `extension/message-types.js` equals the `hd_*` names written in the code of every extension JavaScript file outside `vendor/`, comments aside: an unlisted or misspelt name fails, as does a listed name nothing uses. It loads the list as a classic script and as an ES module, and checks that blanking comments leaves strings, templates and regular expressions alone. |
| `netflix`, `netflix-subtitles`, `netflix-page`, `netflix-content`, `netflix-capture`, `netflix-gif`, `netflix-preview` | Experimental Netflix mining without Netflix: the flag, WebVTT/TTML parsing from `test/data/netflix/` (lines written for these tests), the page hooks and player replay, hover pause, the recorder's clock fit, WAV and GIF encoding, and the preview helper. Real playback, capture grants and protected video are not covered by any automated suite. |
| `note-editor` | The personal-dictionary pencil on term, kanji and missing-word views. |
| `pitch-accent-colors`, `pitch-badges` | Pitch colours at 3:1 in every palette; Yomitan's pronunciation markup in the popup. |
| `popup-scale`, `popup-theme`, `progressive-results` | Popup scale, AUTO appearance and progressively appended results. |
| `recommended-dictionaries`, `recommended-install-client`, `setup-installer`, `setup-state` | The catalogue as the single description of the recommended set, the installer's runs, the revisioned setup record and mining capabilities. |
| `release-compatibility` | The manifest, minimum Chrome, current Chrome and release tag share one contract. |
| `scan-delay-settings`, `sentence` | Scan delay controls; Yomitan's sentence boundaries. |
| `settings-dom`, `settings-labels`, `settings-search` | Settings live regions, unique visible labels and keybind label polarity, global search. |
| `sharing-protocol`, `sharing-client`, `sharing-host`, `sharing-settings` | The sharing wire contract, link generations, retired relay clients and Settings → Sharing. The relay's own checks live in [hachidori-anki](https://github.com/bee-san/hachidori-anki#develop-and-test). |
| `theme-renderer` | The popup theme renderers (Nazeka, Plain, JL, Bee): their DOM, actions, tabs, Notes and the Design settings each theme declares. |
| `toolbar` | The toolbar toggle and its revision conflicts. |
| `word-highlights`, `word-status-overrides` | Word highlighting with jsdom and a fake engine (#520), and the Mark as known/Ignore record. |
| `yomitan-parity` | The renderer against Yomitan's own output at 67db60d, written inline. |

`anki_note_type_upstream_test.py` is the one Python test. The Anki note-type
compatibility workflow runs it with
`python -m unittest discover -s test -p 'anki_note_type_upstream_test.py' -v`
(after `python -m pip install zstandard==0.25.0`). It tests the bounded read-only
APKG extractor: legacy and modern SQLite, Zstandard collections, dummy legacy
databases, corruption, ambiguous members, unsupported schemas, checksums, URLs and
redirect credential stripping. See
[Anki note-type compatibility](../docs/anki-note-type-compatibility.md) for the
pinned/latest package commands and the schema-only boundary.

### WASM, bridge and fixtures

- **`make-fixture.mjs`** writes `test/fixtures/` (see [the fixture](#the-fixture)).
- **`node-smoke.mjs`** drives the frozen C ABI of the threaded bundle, the threaded
  IDBFS bundle (`HACHIDORI_WASM_VARIANT=threaded-idbfs`) or the fallback bundle
  (`HACHIDORI_WASM_VARIANT=fallback`) on plain MEMFS: import counts, the mmap
  regression, all four kinds, lookups by structure and value, kanji, styles,
  tags, media, error paths, reset, import staging, every on-disk layout,
  interrupted-install recovery, dictionary-scoped lookups, response and media
  bounds, MDX import, definition order and `hdw_segment` against
  `segmentation-reference.mjs`. Exits 0 on success, 1 on a failed check, 2 when
  the wasm module has not been built. See [node-smoke details](#node-smoke-details).
- **`threaded-bridge-smoke.mjs`** imports the real offscreen bridge with
  controlled worker and fallback endpoints (through Node 22.15's
  `module.registerHooks`): the 128-request admission bound, responsive status,
  mutation exclusion, exactly-once replies after failures, and reads during an
  import's installing phase.
- **`submodule-identity.mjs`** checks that `.gitmodules`' tracking branch matches
  the pinned engine gitlink, so `git submodule update --remote` cannot rewind it.
- **`baseline.sh`** builds the engine natively and cross-checks the fixture (see
  [baseline.sh](#baselinesh)).
- `segmentation-reference.mjs` (47 original lines with their expected split),
  `test/legacy/` (`.hoshidicts_3` and `_4` directories written by the engine at
  hoshidicts `1ec66fe`), `test/mdict/` (copies of Hoshidicts' MDict fixtures,
  committed because the smoke suites run without the submodule) and
  `test/data/` are fixture data.

### `extension-smoke.mjs`

The extension's own JavaScript against the real wasm engine: that `background.js`
relays, that `offscreen.js` answers every message type with the documented reply
shape, and that the engine's JSON survives the ported renderer. Exits 2 when the
wasm module or the fixtures are missing.

| file | what it proves |
| --- | --- |
| `harness.mjs` | The checks, `test()` and `step()`. |
| `fakes.mjs` | The fakes below, the script loaders and the wasm/fixture preflight. |
| `reader-options.mjs` | `reader-options.js` ranges match the HTML inputs and the engine bounds. |
| `background.mjs` | The worker in a hosted page, timer alarms with and without `chrome.alarms`, external links, first-run setup (one `startup.html`, the seeded record and options) and overlay mode. |
| `sharing.mjs` | The sharing host and client in the worker and the transitions between them: hosting waits for dictionaries, linking, unlinking, Anki routes and duplicate-index suspension, link generations. |
| `anki.mjs` | First-run Anki detection, the worker's Anki routes, word status and its overrides through the worker's storage queue, screenshots, linked Settings discovery. |
| `backup.mjs` | The backup relay and lifecycle port, automatic backups in the worker, Settings retention. |
| `netflix.mjs` | The recorder port is kept only for the recorder page in a watch tab while the switch is on. |
| `updates.mjs` | The managed-update schedule and checks in the worker, and Settings' update controls. |
| `lookup-stats.mjs`, `audio.mjs` | Lookup statistics and the audio relay in the worker. |
| `custom-dictionary.mjs` | The personal dictionary's storage ownership, its engine transaction through real WASM, and its Settings section. |
| `recommended.mjs` | The five trusted recommendations, the shared dictionary-group module, and the Settings installer. |
| `settings.mjs`, `library.mjs` | Settings navigation, reader controls and autosave; library management, groups, removal, batch and MDX imports. |
| `startup.mjs`, `design.mjs`, `source-highlight.mjs` | The startup page (welcome, installer runs, recovery, practice, visual novel scenes), the Design preview, source highlighting. |
| `content.mjs`, `content-harness.mjs`, `content-*.mjs` | The real `content.js` in jsdom pages: stale kanji replies; popup visibility, fullscreen hosts, failures and option revisions; lookup counts and blur; scanning and selections; activation, scan delays and keybinds; nested popups and media; Notes. |
| `engine.mjs` → `engine-replacement.mjs` → `engine-updates.mjs` → `engine-library.mjs` → `engine-lookup.mjs` → `renderer.mjs` → `engine-restart.mjs` → `engine-storage.mjs` | One scenario on one engine: boot and relay, storage ownership and `hd_import`, atomic replacement, trusted recommended imports and managed updates, library state (migration, CAS ownership, titles, reloads), every read path and error path, the renderer against the engine's replies, `hd_remove`, the trained layout, a restart, then isolated imports, paged dictionaries and blob-backed IDBFS. |

The fakes cover only the Chrome surface the extension actually touches:

| fake | why |
| --- | --- |
| message bus | models the two rules `background.js` depends on — `sendMessage` never delivers to the sender, and an extension context never reaches a content script. That is what makes the `relayed: true` guard testable. |
| `chrome.storage.local` | in-memory, with `onChanged`, so revision conflicts, legacy migration, and the service worker's ownership of `dictionaryState` are real. Given to the worker and the settings page only: an offscreen document has no storage. |
| `indexedDB` | one object store keyed by path plus a `timestamp` index, which is all Emscripten's IDBFS uses. Enough to prove `FS.syncfs(false)` actually wrote something. |
| `fetch` | serves `blob:` URLs out of a map (the import path), `chrome-extension://` URLs off disk (`render/reader.css`), and deterministic catalogue and managed-update responses. |

Each script gets its own `chrome` object. The offscreen document's has `runtime`
only, as a real one does, so a storage call from `offscreen.js` fails here the way
it fails in Chrome. The harness concatenates the shared modules into
`background.js`, strips those ES-module boundaries, and runs the worker and render
code in `node:vm`; `offscreen.js` is a real ES module and reads the shared global,
which is the one wired to the bus as `"offscreen"`.

The renderer, Settings, startup and content stages need jsdom. A jsdom that
cannot be loaded is a **failed check**, printed with the paths that were searched:
a suite that answers a missing dependency by quietly testing less reports success
either way. The loader searches `HACHIDORI_JSDOM` (the directory above a
`node_modules` holding jsdom; `test/run.mjs` sets it to `test/tooling`),
`NODE_PATH`, the repository, and the external default
`${XDG_CACHE_HOME:-~/.cache}/hachidori-e2e`:

```sh
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$CACHE_ROOT/hachidori-e2e" && cd "$CACHE_ROOT/hachidori-e2e"
npm install --save-exact jsdom@30.1.1 puppeteer-core@25.10.0 @puppeteer/browsers@3.2.2
./node_modules/.bin/browsers install chrome@152.0.7977.75 --path "$CACHE_ROOT/hachidori-browsers"
```

ESM ignores `NODE_PATH`, which is why the loader resolves jsdom through
`require()` before importing it.

What it cannot prove: anything about Chrome itself. No manifest validation, no
`chrome.offscreen`, no real IndexedDB or `unlimitedStorage` quota, no MV3 CSP, no
layout (so no popup positioning, masonry or `@scope`), and no `blob:` URL crossing
from the options page to the offscreen document. That is what `chrome-e2e.mjs` is
for.

### `chrome-e2e.mjs`

`chrome-e2e.mjs` loads the unpacked extension into a real Chrome. It is the only
suite that proves what Node cannot reach: that Chrome accepts the manifest, that
the extension_pages CSP permits compiling the wasm in the offscreen document,
that `chrome.offscreen` and `chrome.runtime.getContexts` behave as assumed, that
OPFS survives a browser restart, and that a real `caretRangeFromPoint` hover
produces a rendered popup. `test/run.mjs chrome-e2e` also runs
`chrome-popup-scale.mjs` (fractional popup scale, real pointer hit testing).

Its steps run in this order, in one profile:

| file | what it proves |
| --- | --- |
| `harness.mjs` | `PLANNED`, `check()`, the report and `step()`. |
| `session.mjs` | Shared setup: launching Chrome, the page server, Fetch interception helpers and Settings helpers; then the extension loads, its branding, sharing by default and the browser shortcuts. |
| `popup-reader.mjs` | Reading the closed-shadow popup through CDP, and the hover helpers. |
| `first-run.mjs` | The startup page's first-run setup with intercepted catalogue downloads (held, failed once, with and without `Content-Length`), Resume setup, reconnecting, Retry, the Anki check, practice, the Settings exclusion, then **Remove all imported dictionaries**. |
| `settings.mjs` | First-run Anki detection of an existing Kiku setup, Settings autosave, save feedback and option transport, Design, Audio, Anki Settings and glossary export, dictionary CSS isolation. |
| `recommended.mjs` | Recommended dictionaries on desktop and narrow pages, the offscreen engine (wasm under the CSP, pthreads, one offscreen document), the Settings installer across a reload, a failure and Retry. |
| `import.mjs` | The `.zip` input, import into OPFS and storage, batch import and re-import, the dictionary row. |
| `library.mjs` | Settings navigation and keyboard access, the Google Docs flag, popup themes and the first frame, positions, bulk updates, reordering, aliases, groups, kanji choices. |
| `custom-dictionary.mjs` | Settings saves a personal source through the real importer. |
| `reader.mjs` | The reading tab: popup resizing, hit testing, multiline placement, zoom, glyph boxes, wheels, the first inflected-verb popup. |
| `counts.mjs` | Lookup counts, definition blur, Anki maturity blur, word highlighting. |
| `popup.mjs`, `nested.mjs`, `tabs.mjs`, `layout.mjs` | Frames and fullscreen, staying in place, tab switches, deinflection, cards, links, furigana; nested lookups; dictionary tabs, columns and kanji groups; compact summaries, glossaries, tables, the action row, dynamic headwords, count layout, the audio chooser. |
| `activation.mjs`, `metadata.mjs`, `anki.mjs` | Activation keys and selections, the source-highlight fallback; frequency direction, metadata, popup audio; mining to a fake AnkiConnect. |
| `kanji.mjs`, `popup-content.mjs`, `notes.mjs` | Clicked-kanji navigation; the hover highlight, Escape, structured content, non-Japanese text, Note drafts; term and kanji Notes. |
| `updates.mjs` | Managed updates: scoped checks, Check now, Update all, the global and per-dictionary schedules, real alarms, a failed update, hovering through an update, alarm recreation after a worker restart. |
| `restart.mjs` | Backups and atomic replacement in Chrome, then `SIGKILL` and a relaunch on the same profile: settings, counts, setup, the library, OPFS and lookups survive; removal. |
| `memory.mjs`, `media.mjs`, `file-access.mjs` | Low memory mode, the RAM default, entry and hash storage; lookup bounds, deep structured content and dictionary media; saved-page setup with Chrome's file access. |

#### The profile

`/tmp/hachidori-e2e-profile-<pid>` unless `HACHIDORI_PROFILE` says otherwise, and
the path is printed at the top of the run. Per-pid because two runs sharing one
profile deadlock over the extension's leveldb: the second Chrome cannot open
`chrome.storage.local` at all (`IO error: …/LOCK`), which reads exactly like a
persistence regression. A green run deletes its profile; a failing one keeps it
and says so, because the profile is the only place the imported dictionary can be
examined afterwards. `HACHIDORI_PROFILE` is never deleted, and a non-empty one is
a hard error: pass 1 has to import into a clean profile or the restart check
proves nothing.

#### The denominator is fixed

`PLANNED` in `test/chrome-e2e/harness.mjs` names every assertion, and a complete
run divides by `PLANNED.length`, not by the number of checks that happened to
run. Anything in `PLANNED` that no `check()` reached is reported as
`FAIL … check never ran`, and `check()` refuses a name that is not in the list or
one that runs twice. A step that throws is recorded as
`<step> finished without throwing` with its stack, and the report also prints the
offscreen document's console. A run that leaves steps out (a name pattern, or one
file on its own) counts only the checks that ran. When adding an assertion, add
its name to `PLANNED` before its implementation, so a code path that never runs
cannot look like a smaller successful suite.

#### No sleeps

There is no fixed sleep standing in for synchronisation. The content script
builds its host lazily on the first hover, so `hoverForPopup()` re-fires
`mousemove` (stepping off the word and back on) until the popup is actually
visible. Bounded polls wait for observable DOM, storage, OPFS, CDP, or alarm
state; the scheduled-update cases create real near-future Chrome alarms.

#### What the assertions are pinned to

- The popup's **structure**, not its flattened text: `popupReader()` reports
  `tags`, `lists`, `tables` and `bold` (with the computed `font-weight`), so a
  renderer that flattened everything into one text node fails.
- The **extension's own** highlight, read back as
  `CSS.highlights.get(HIGHLIGHT_NAME).size`. The name is read out of
  `extension/content.js`, so a rename cannot leave the check pointing at a dead
  registry key.
- "No popup for latin text" is **bracketed** by a popup immediately before and
  after, so it cannot pass against an extension whose hover is dead.
- Stable IDs against the fixtures' exact title-derived values, the post-restart
  `dictionaryCount === 4` (every kind the combined fixture registers), and
  index and archive request counts for managed updates.

The popup's shadow root is closed, and puppeteer's `pierce/` selectors find
nothing in it; CDP's `DOM.getDocument` with `pierce: true` does, so
`popupReader()` goes through a session. The headword is furigana ruby, so
`textContent` reads `食たべる`; `popupReader()` also returns a `plain` copy without
`<rt>`. The offscreen document has a permanent CDP session on `Runtime`, because a
boot failure there is otherwise invisible.

Managed-update indexes are intercepted on the service-worker CDP target and
archives on the offscreen-document target, which also covers its engine worker;
do not intercept the dedicated worker directly. The first-run catalogue
downloads are intercepted on the offscreen target as soon as it is named. The
suite intercepts AnkiConnect on both the service-worker and offscreen targets, or
refuses it, so a real Anki on port 8765 cannot decide an outcome; the word
highlight checks use an AnkiConnect fake on the suite's own page server. The
browser uses Chromium's `--disable-audio-output` fake output device, which runs
native fetching, decoding and `ended` without audio hardware; audible output and
installed speech voices are not proved. The native file-access switch is flipped
in the isolated profile only, with Developer mode on (Chrome 152 otherwise
disables a command-line extension when it reloads).

### Other browser suites

These run separately:

- **`chrome-fallback.mjs`** loads a manifest without cross-origin isolation, so
  pthreads are unavailable: import, custom source and restart through the
  single-thread IDBFS bundle, with OPFS left empty and a first-run run whose
  downloads are answered 503.
- **`chrome-overlay.mjs`** runs overlay mode (GameSentenceMiner): capability
  Settings, glyph selection, host events, Anki readiness, links after hovers and
  drags.
- **`chrome-sharing.mjs`** launches two real Chromes and the pinned Hachidori
  Relay (unpacked from the downloaded add-on with Python's `zipfile`, on
  `HACHIDORI_SHARING_PORT`, default 18771), links them, looks up, writes options
  and personal entries through the host, mines through a mocked host AnkiConnect,
  survives the host closing and relaunching, unlinks and relinks over the
  network address, and runs a third overlay-mode browser. It needs `python3`, a
  non-loopback address and the pinned GitHub release, or
  `HACHIDORI_ANKI_ADDON=/path/to/hachidori-relay.ankiaddon` to serve a local
  archive instead.
- **`chrome-theme-contrast.mjs`** samples a monochrome and an untagged SVG in
  every palette plus emulated forced colors (3:1 normally, 20:1 forced) and the
  word-highlight lines on light and dark pages; `test/tmp/ci/theme-contrast.png`
  is its filmstrip. Chrome emulation does not replace a check on a real Windows
  contrast theme.
- **`chrome-netflix-mining.mjs`**, outside the default runs (`xvfb-run -a`;
  headless Chrome records tab audio as silence), mines a fixture page served at a
  Netflix watch address into a fake AnkiConnect: the WAV's beep within 125 ms,
  a decodable looping GIF, restored playback, and hover pause.
- **`chrome-custom-buttons-templates.mjs`** needs an isolated real Anki with
  AnkiConnect on `HACHIDORI_ANKI_URL`; it creates only its `Hachidori I23` decks
  and note types and deletes only notes tagged `hachidori-i23-e2e`.
  `HACHIDORI_CUSTOM_BUTTONS_EVIDENCE_DIR` collects its evidence;
  `HACHIDORI_CUSTOM_BUTTONS_PROFILE` and `HACHIDORI_CUSTOM_BUTTONS_REUSE_PROFILE=1`
  are for diagnosis only.
- **`chrome-theme-store.mjs`** is a focused theme-store check; `electron-backup.cjs`
  is a real-Electron overlay backup regression (see its header).
- `chrome-action-row`, `chrome-audio-chooser`, `chrome-compact-summary`,
  `chrome-dynamic-headword`, `chrome-glossary-layout`, `chrome-lookup-count-layout`,
  `chrome-structured-table`, `chrome-popup-resize`, `chrome-library-navigation`,
  `chrome-settings-first-frame`, `chrome-settings-feedback-scenarios`,
  `chrome-dictionary-management-scenarios`, `chrome-dictionary-rank-scenarios` and
  `chrome-backup-scenarios.mjs` are scenarios `chrome-e2e.mjs` calls; each
  header says what it renders and checks. `backup-engine-scenarios.mjs` is the
  smoke suite's equivalent. `anki-connect-fake.mjs`, `anki-relay-server.mjs`,
  `capture-resources.mjs` and `gif-structure.mjs` are shared helpers.

### The fixture

`make-fixture.mjs` writes `test/fixtures/hachidori-fixture.zip`, a Yomitan
format-3 dictionary, `hachidori-fixture-trained.zip` (enough term rows to cross
the zstd-training floor), `hachidori-fixture-many-banks.zip` (twenty banks for the
bounded scheduler) and `hachidori-generic-kanji-fixture.zip` (a term-only
dictionary with single-kanji entries), plus malformed (`malformed-index.zip`),
index-less (`no-index.zip`), non-ZIP (`not-a-zip.txt`), parent-title
(`parent-title.zip`, which declares `..`) and atomic-replacement archives. The
ZIP container is written by hand with `node:zlib`, checked against
`third_party/hoshidicts/src/json/yomitan_parser.cpp` and `src/importer.cpp`;
`python3 -m zipfile` and the native CLI both read it. Its builders
(`buildTitledZip`, `buildRecommendedZip`, `imagePreviewFixture`, …) make the
in-memory archives the suites need without changing these files, and it exports
`EXPECTED` (the import counts, derived from the bank arrays) and
`EXPECTED_GLOSSARIES`, so editing a bank cannot silently desync an expectation.

| file | what it covers |
| --- | --- |
| `index.json` | `format: 3`, title, revision, `sequenced`, language and attribution fields |
| `term_bank_1.json` | plain and `structured-content` glossaries (nested tags, `ul`, `table`, `img`), an inflected-verb target (`食べる`, `rules: "v1"`), a kana-only entry, tags on every row, two rows sharing one (expression, reading) |
| `term_meta_bank_1.json` | `freq` in both shapes, a `pitch` entry with int and string positions, `nasal` and `devoice`, and an `ipa` entry |
| `kanji_bank_1.json` | `食` with onyomi, kunyomi, tags, three definitions and three stats |
| `tag_bank_1.json`, `styles.css` | seven tags; the stylesheet `hdw_styles` returns |
| `media/kanji.png`, `media/` | a real 16×16 PNG, and a bare directory record that `get_files()` has to skip |

`hdw_import` on `hachidori-fixture.zip` must report exactly `termCount 6`,
`metaCount 4`, `frequencyCount 2`, `pitchCount 2`, `kanjiCount 1`, `mediaCount 1`,
and the imported directory must hold `.hoshidicts_5` (0 bytes), `blobs.bin`
(1447), `bloom.filter` (32), `hash.table` (260), `index.json` (738), `media.bin`
(160) and `media.idx` (12). `index.json`'s size varies with `importDate`; if the
counts change, check whether a bank was edited before assuming a regression.

The importer trains a zstd dictionary from the first term bank when it can sample
at least eight glossaries, which changes the marker to `.hoshidicts_6` and adds a
`dict.zstd`. The six-row fixture stays deliberately under that floor
(`TRAINING_SAMPLE_FLOOR` pins it, and `node-smoke.mjs` fails if `TERMS` grows past
it); the 49-row trained fixture is the other side, and both are loaded together,
as after an engine upgrade. `.hoshidicts_4` and `_3` are the same pair from
engines that stored the score as an int32; `test/legacy/` keeps one directory of
each, so the compatibility check loads bytes the current importer no longer
produces. `dict.zstd` is mandatory with marker `_4`, and arbitrary bytes cannot
masquerade as a trained dictionary.

The fixture's Japanese is deliberately narrow: `食べる` (ichidan verb, the
deinflection target), `読む` (godan, second frequency shape), `漢字` (structured
content), `ありがとう` (kana-only), `食` (kanji bank). `baseline.sh`'s word list is
a separate literal that has to be kept in step with `node-smoke.mjs`'s.

### node-smoke details

- Import is marker-agnostic: which marker the importer writes depends on whether
  it trained a zstd dictionary.
- The Emscripten mmap regression: `hash.table` and `bloom.filter` must be
  non-empty *and* not zero-filled (their headers and at least one set slot are
  read). Before the submodule's fd fix they had the right size and were all zeros,
  and every lookup then returned nothing.
- `LookupResult` is checked field by field with **no extra keys**, and glossaries
  byte for byte against the term bank.
- Error paths matter as much as the happy path, because an uncaught C++
  exception aborts the wasm instance and the offscreen document with it; each
  asserts the return value *and* `hdw_last_error`, then re-runs a real lookup.
- Import staging: titles such as `..` and `sub/dir` are refused with nothing
  deleted, and a re-import that fails after the title is parsed leaves the
  installed copy working.
- Two behaviours worth knowing: the `hdw_lookup` failure fallback is the literal
  `{"results":[],"dictionaryCount":0}`, so `dictionaryCount` reads 0 even when
  dictionaries are loaded; and `hdw_media` returning 0 for an absent path leaves
  `hdw_last_error` **empty**, while null arguments and oversized references set
  it. Callers must inspect it before treating a zero length as a miss.

### baseline.sh

Builds the engine natively with `-DHOSHIDICTS_CLI=ON`, imports the same fixture
with `hoshidicts-cli`, and dumps the same word list to `test/tmp/baseline.txt`
(no `runtime:` lines or absolute paths, so runs diff cleanly). It shows that the
submodule's `#ifdef __EMSCRIPTEN__` portability patches leave native behaviour
alone, and gives the wasm results an independent comparison: byte-identical
`hash.table`, `bloom.filter`, `blobs.bin`, `media.bin` and `media.idx`, and the
same glossaries, traces, frequencies and kanji stats `node-smoke.mjs` asserts.

The engine is C++23 (`std::ranges::to`, `std::views::as_rvalue`, `std::format`)
with glaze v8, so it needs GCC ≥ 14, or clang ≥ 17 with libc++ ≥ 17 / libstdc++
≥ 14 headers. The script probes `g++-15 g++-14 gcc15-g++ gcc14-g++ g++ clang++-20
clang++-19 clang++-18 clang++` with a program using exactly those features and
uses the first that compiles and runs; `CXX=… CC=…` overrides it, and an explicit
`$CXX` that fails the probe is a hard error. Exit codes: `0` success, `1` build or
run failure (with the tail of `test/tmp/{configure,build}.log`), `3` no usable
compiler. Nothing else needs a native compiler.

## Environment variables

| variable | effect |
| --- | --- |
| `HACHIDORI_JSDOM` | directory above a `node_modules` holding jsdom (the launcher sets `test/tooling`) |
| `HACHIDORI_PUPPETEER`, `HACHIDORI_CHROME`, `HACHIDORI_CHROME_BUILD` | the puppeteer-core entry, a Chrome executable, or an exact Chrome for Testing build |
| `HACHIDORI_ALLOW_NO_SANDBOX=1` | run Chrome without its sandbox (containers) |
| `HACHIDORI_PROFILE`, `HACHIDORI_FALLBACK_PROFILE`, `HACHIDORI_SHARING_HOST_PROFILE`, `HACHIDORI_SHARING_CLIENT_PROFILE` | a browser profile to use instead of a fresh per-pid one |
| `HACHIDORI_FALLBACK_EXTENSION` | where `chrome-fallback.mjs` writes its temporary extension copy |
| `HACHIDORI_HEADLESS=shell`, `HACHIDORI_DUMPIO=1` | `chrome-e2e.mjs` on the old headless shell; Chrome's own output |
| `HACHIDORI_WASM_VARIANT` | `threaded-idbfs` or `fallback` for `node-smoke.mjs` |
| `HACHIDORI_SHARING_PORT`, `HACHIDORI_ANKI_ADDON`, `HACHIDORI_RELAY_SERVER` | the sharing relay's port, a local add-on archive, the relay server script to run |
| `HACHIDORI_ANKI_URL`, `HACHIDORI_CUSTOM_BUTTONS_*` | the real-Anki custom-buttons harness |
| `HACHIDORI_AUTOMATIC_BACKUP_BENCHMARK`, `HACHIDORI_AUTOMATIC_BACKUP_BROWSER_BENCHMARK`, `HACHIDORI_SHARING_BENCHMARK` | write benchmark evidence to that path |
| `HACHIDORI_BACKUP_BASELINE=HEAD` | `electron-backup.cjs` against the original Settings files |
| `HACHIDORI_*_SCREENSHOT`, `HACHIDORI_*_SCREENSHOTS`, `HACHIDORI_*_EVIDENCE`, `HACHIDORI_*_FILMSTRIP`, `HACHIDORI_THEME_OUTPUT` | an output path (or directory): the test that renders that state saves its PNG or JSON there. `grep -rn 'process.env.HACHIDORI_' test/` lists them; the launcher sets `HACHIDORI_DEINFLECTION_SCREENSHOT`, `HACHIDORI_SETTINGS_THEME_FILMSTRIP` and `HACHIDORI_SHARING_SCREENSHOTS` under `test/tmp/ci`. |

## Notes

- Every file in `test/fixtures/` is generated by `make-fixture.mjs`, so
  `.gitignore` ignores the whole directory.
- Content scripts do not run on `chrome-extension://`, `about:blank`, or `file://`
  without a per-extension opt-in, so the Chrome suite serves its reading pages
  over `http://127.0.0.1`.
