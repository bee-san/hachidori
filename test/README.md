<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Hachidori test harness

## Reproducible setup and CI

Use Node **22.23.1** (`.node-version`) and npm **10.9.8**. The bridge suite needs
Node 22.15 or newer. Sharing tests invoke `python3`; CI pins **Python 3.13.2**
and runs the relay socket suite separately on **Python 3.9.25**.
Ordinary JavaScript tests use the committed WASM bundles and need no build or
submodule checkout.

From the repository root, these are the same commands CI runs:

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling test                 # all test/*.test.mjs and benchmark/*.test.mjs
npm --prefix test/tooling run test:smoke        # both WASM variants, bridge, extension
npm --prefix test/tooling run install:chrome    # Chrome for Testing 152.0.7977.75
npm --prefix test/tooling run test:chrome       # primary OPFS path and UI
npm --prefix test/tooling run test:sharing      # two browsers and the Python relay
npm --prefix test/tooling run test:fallback     # IDBFS path
npm --prefix test/tooling run test:overlay      # GameSentenceMiner overlay mode
```

`test/tooling/package-lock.json` locks jsdom **30.0.1**, Puppeteer **25.10.0**,
the browser installer **3.2.2**, and their transitive dependencies. The small
`test/run.mjs` launcher supplies the existing environment overrides, generates
fixtures, runs each existing suite in a separate Node process, and propagates
every nonzero exit or signal. It selects the exact Chrome build from
`test/tooling/package.json` rather than whichever browser happens to be newest
in a developer's cache. Dependencies are isolated from the extension under
`test/tooling/node_modules`; the browser is ignored under `test/tmp/browsers`.
The launcher ignores a machine-wide `CHROME_BIN` (GitHub runners set it to their
system browser). Use `HACHIDORI_CHROME` for an intentional browser override.

On Ubuntu/Debian, install the browser's system dependencies with
`sudo "$(command -v node)" test/run.mjs install-chrome --install-deps` and install
`fonts-noto-cjk` for Japanese text. CI uses Ubuntu 24.04 with these dependencies.
For a Linux container that cannot run Chrome's sandbox, set
`HACHIDORI_ALLOW_NO_SANDBOX=1` for the browser commands. Sharing needs a usable
non-loopback network address for its other-computer checks.

`.github/workflows/runtime-tests.yml` runs the Node contracts, smoke tests, and
all four browser suites on every PR and push to `main`, or manually. The browser
matrix runs independently so one failing suite cannot hide the others. Logs are
saved to `test/tmp/ci`; failing CI jobs upload them, the available screenshots,
and the browser profiles retained by failed suites, for seven days. The same
commands reproduce the failure locally. The optional native/submodule checks
below and headful media-capture suites remain separate checks for their domains.

Direct `node test/...` commands below still support the external cache and
`HACHIDORI_JSDOM`, `HACHIDORI_PUPPETEER`, and `HACHIDORI_CHROME` overrides. To run a
focused jsdom test with the locked tooling directly:

```sh
HACHIDORI_JSDOM="$PWD/test/tooling" node --test test/sharing-settings.test.mjs
```

`node --test test/settings-search.test.mjs test/toolbar.test.mjs` checks global
settings search, keyboard navigation, disclosure focus and draft preservation,
plus the toolbar toggle, revision conflicts and recording shortcut. Search uses
the same external jsdom dependency described below. The toolbar tests do not
start a capture session.

`node --test test/frequency-presentation.test.mjs` checks compact numeric
frequency defaults, the neutral primary-result `Freq:` pill, visible kana
markers, tabs-only lower chrome, concise typed harmonic averages, preserved
explicit display choices, source details, and live grammar/name controls without
replacing definitions or Note drafts. It uses the same external jsdom dependency.

`node --test test/note-editor.test.mjs` checks the shared personal-dictionary
pencil on term, kanji and missing-word views, selected-word prefills and a single
pending save. The extension smoke suite also verifies that selected missing
words refresh into their personal definition after the save, including when no
dictionaries were installed. It uses the same external jsdom dependency.

`node --test test/keybind-settings.test.mjs` checks Yomitan's default keybinds for
supported actions, keybind normalisation and strict option patches, key
combination capture, action/argument/scope editing, Clear, Reset, Remove, Add and
Reset to defaults. It uses the same external jsdom dependency. The extension smoke
suite drives the content script's keybind dispatch and the real popup view's entry
navigation. `audio-content.test.mjs` covers keybind audio playback. The keybind
settings suite also lists Chrome's browser shortcuts and refreshes them when the
window regains focus.
`node --test test/browser-commands.test.mjs` runs the worker's command listener
against the manifest: the toggle makes one queued revisioned `hoverEnabled`
write, and the settings command opens Settings. Each argument-free keybind
action has a manifest command that the worker forwards to the active tab. The
extension smoke suite runs forwarded commands through the reader's keybind
dispatch. The Chrome suite checks that Chrome registers the suggested Alt+Delete
(reported as `Alt+Del`) and the popup-action commands, and that Keybinds lists
them.

`node --test test/sharing-protocol.test.mjs test/sharing-relay.test.mjs
test/sharing-settings.test.mjs test/anki-addon.test.mjs` checks the sharing
wire contract (addresses as a person types them, browser names, the forwarding
table, frame validation), drives the Anki add-on's `extension/anki-relay/server.py`
as a `python3` process over raw sockets (`test/anki-relay-server.mjs` starts
it): the `Origin` rule, the loopback-only host, clients refused without a host,
a second host turned away, large UTF-8 frames relayed whole in both directions,
broadcast, pings, closes, host loss, and the network listener opened on the
host's `network` frame, linked through this machine's own address, closed
again and dropped with the host. It also pauses a real client during 16 MiB
UTF-8 replies, checks healthy requests and pings, resumes to verify frame order,
and interrupts stalled writes on network disable and host loss. The idle accept
timeout is checked on Python 3.9 as well as the CI interpreter.
`sharing-settings.test.mjs` covers the
Settings → Sharing section with jsdom: the dictionaries, waiting, refused and
sharing states, the add-on download, the network switch with the addresses it
lists and copies, the offer to use the Hachidori found on this computer, an
address for another computer, the linked state and unlinking.
`anki-addon.test.mjs` builds the `.ankiaddon` the page hands out and reads it
back with zip.js and with Python's `zipfile`. The extension smoke suite's
sharing-host and sharing-client stages cover the service worker's side,
including hosting that waits for dictionaries, the network exchange, linking
that turns hosting off and a linked install's kept state.

`node test/chrome-sharing.mjs` launches two real Chromes and the add-on's
relay on a test-only port (`HACHIDORI_SHARING_PORT`, default 18771): the host
imports the fixture, saves the add-on from its Sharing page and moves its
sharing to that port; the second browser's startup page offers the shared
Hachidori and links with one click, looks a word up through the link, writes
an option and a personal entry that the host commits and pushes back, loses the
host when it closes and reconnects when it relaunches, unlinks back to its own
empty state, and links again through this machine's network address (the
machine needs one beyond loopback) until the host stops sharing on the
network. Two Settings tabs then issue overlapping Link and Unlink requests,
preserving a compiled local personal dictionary and settings. Nine predeclared
checks; profiles are kept on failure.
`HACHIDORI_SHARING_SCREENSHOTS=<dir>` saves the documentation screenshots from
that real run.

`node --test test/custom-links-renderer.test.mjs` checks named toolbar links,
current word/reading/sentence expansion, background-tab clicks, live editing
without replacing cards or Note drafts, and stale-control navigation rejection.

The lower-level checks can also be run individually in this order. Node suites
use built-ins and the DOM suites use jsdom. Browser checks need Chrome and
`puppeteer-core`; the launcher above supplies the locked tooling automatically.

```sh
cd /path/to/hachidori

node test/submodule-identity.mjs # 1. submodule/runtime identity is internally consistent
./wasm/build.sh                  # 2. produces threaded OPFS and fallback IDBFS bundles
node --test test/custom-dictionary.test.mjs # 3. custom source and ZIP contract
node test/make-fixture.mjs       # 4. writes test/fixtures/
node test/node-smoke.mjs         # 5. threaded C ABI contract test
HACHIDORI_WASM_VARIANT=fallback node test/node-smoke.mjs # 6. fallback C ABI contract test
node test/threaded-bridge-smoke.mjs # 7. both-backend bridge admission/control test
node test/extension-smoke.mjs    # 8. the extension's own JS against that wasm
node --test benchmark/*.test.mjs # 9. fail-closed benchmark framework tests
node test/chrome-e2e.mjs         # 10. pthread/OPFS path in a real Chrome
HACHIDORI_CAPTURE_HEADFUL=1 xvfb-run -a node test/chrome-capture.mjs # 11. real display capture, audio, timing and Anki path on Linux
node test/chrome-fallback.mjs    # 12. capability fallback through IDBFS in real Chrome
node test/chrome-overlay.mjs     # 13. overlay mode's glyph selection and host events in real Chrome
./test/baseline.sh               # 14. optional native cross-check
```

Step 4 is optional on its own: `node-smoke.mjs` imports the generator and builds
the fixture bytes in memory, and also writes them to `test/fixtures/` as a side
effect so `baseline.sh` has files to work with. Run it alone when you want to
inspect the zip or hand it to another tool.

Everything either script writes goes to `test/fixtures/` and `test/tmp/`. Neither
touches `third_party/hoshidicts`; `baseline.sh` configures it out-of-tree and
fails if `git status` in the submodule comes back dirty.

---

## `issue-template.test.mjs`

Run `node --test test/issue-template.test.mjs` for changes to issue templates or their enforcement workflow. This dependency-free suite uses the production validator and mocked GitHub issue calls to check completed and incomplete submissions, Markdown comments and code fences, the acknowledgement, closure feedback, and stale issue events. It never closes real issues. The Issue template workflow runs this check on relevant pull requests and pushes to `main`; its separate issue-event job enforces the template on opened, edited, and reopened issues.

---

## `submodule-identity.mjs`

Guards that the `third_party/hoshidicts` submodule's declared tracking branch in
`.gitmodules` stays consistent with the runtime gitlink the superproject pins. 3
checks: the declared url resolves to the engine repository, the pinned gitlink is
reachable from the declared tracking branch, and the gitlink is that branch's
tip. If the tracked branch drifts off the runtime branch, a
`git submodule update --remote` would silently rewind the engine to an older
commit; this check fails closed instead. Uses Node built-ins and the local git
clone only. Prints `<n> passed, <n> failed`.

---

## `make-fixture.mjs`

Generates `test/fixtures/hachidori-fixture.zip`, a Yomitan format-3 dictionary,
`hachidori-fixture-trained.zip` (enough term rows to cross the zstd-training floor),
`hachidori-fixture-many-banks.zip` (twenty banks for the bounded scheduler), and
`hachidori-generic-kanji-fixture.zip` (a term-only dictionary with single-kanji
entries). It also writes malformed, missing-index, non-ZIP, and parent-title
archives for the error and path-safety checks. The ZIP container is written by
hand with `node:zlib` — the engine's reader only needs local file headers, a
central directory and raw deflate streams, and that is about 80 lines.
The exported `buildRecommendedZip()` helper builds the small in-memory archives
used when tests intercept the five recommendation URLs; it does not contact the
publishers.

The `.zip` is checked against `third_party/hoshidicts/src/json/yomitan_parser.cpp`
and `src/importer.cpp`, not guessed. `python3 -m zipfile` and the native CLI both
read it.

| file | what it covers |
| --- | --- |
| `index.json` | `format: 3`, title, revision, `sequenced`, language and attribution fields |
| `term_bank_1.json` | plain string glossary; a `structured-content` glossary with nested tags, a `ul`, a `table` and an `img`; an inflected-verb target (`食べる`, `rules: "v1"`); a kana-only entry with an empty reading; `definition_tags` and `term_tags` on every row; two rows sharing one (expression, reading) so the term has two glossaries |
| `term_meta_bank_1.json` | `freq` in both accepted shapes (nested `{"frequency":{…}}` and flat `{"value":…}`), a `pitch` entry exercising int position, string position (pattern), bare-int `nasal` and array `devoice`, and an `ipa` entry |
| `kanji_bank_1.json` | `食` with onyomi, kunyomi, tags, three definitions and three stats |
| `tag_bank_1.json` | seven tags across four categories |
| `styles.css` | ends up in the imported `index.json`'s `styles`, which is what `hdw_styles` returns |
| `media/kanji.png` | a real 16×16 PNG, the target of the `img` path above |
| `media/` | a bare directory record; `get_files()` has to skip it or `mediaCount` is wrong |

Negative fixtures include:

- `malformed-index.zip` — `index.json` cannot be parsed during title preflight.
- `no-index.zip` — a valid archive with no `index.json`.
- `not-a-zip.txt` — plain text, so the EOCD scan has to bottom out.
- `parent-title.zip` — declares `..`; the native baseline proves that direct use
  of Hoshidicts cannot escape and recursively delete its output directory.

`buildTitledZip(title, {banks, terms, termMeta, mediaEntries})` builds a third kind on the fly, in memory: the
same `index.json` with the title replaced, optionally with no term bank so the
import fails *after* the importer has read the title and derived a directory from
it. That is the only moment a title can do damage, so it is what the import
staging checks are driven with. Optional term and metadata rows also build the
lookup-byte-boundary fixtures without changing the ordinary fixture counts.
Optional `[path, bytes]` media entries exercise fetch bounds independently of
archive importability.

Exports `EXPECTED` (the import counts, derived from the bank arrays rather than
hardcoded) and `EXPECTED_GLOSSARIES` (the exact raw glossary strings, keyed by
`termKey(expression, reading)`). `node-smoke.mjs` asserts against those, so
editing a bank cannot silently desync the expectation.

### fixture counts

`hdw_import` on `hachidori-fixture.zip` must report exactly:

```
title           hachidori-fixture
termCount       6
metaCount       4
frequencyCount  2
pitchCount      2
kanjiCount      1
mediaCount      1
```

and the imported directory must be:

```
       0  .hoshidicts_3
    1307  blobs.bin
      32  bloom.filter
     260  hash.table
     719  index.json
     160  media.bin
      12  media.idx
```

### the trained fixture, and why there are two markers

The importer trains a zstd dictionary from the **first** term bank when it can
sample at least eight glossaries out of it, and then compresses every glossary
against it. That changes the directory: the marker becomes `.hoshidicts_4` and a
`dict.zstd` appears next to `blobs.bin`. Below the floor it writes `.hoshidicts_3`
and no `dict.zstd`, which is byte-for-byte what every dictionary imported by a
pre-`.hoshidicts_4` engine looks like.

`hachidori-fixture.zip` has six term rows, deliberately under that floor, so it stays
the compatibility case; `TRAINING_SAMPLE_FLOOR` pins that, and `node-smoke.mjs` fails
loudly if `TERMS` grows past it instead of silently retiring the coverage.
`hachidori-fixture-trained.zip` (`buildTrainedZip()`, 49 rows with deliberately
repetitive glossaries so the training has structure to find) is the other side.
Both markers are then loaded together, from one query object, because that is the
state of a profile after an engine upgrade.

`dict.zstd` is mandatory when the marker is `_4`.
`dictionary_files_present()` rejects an absent or empty file, and `query.cpp`
loads non-empty bytes in Zstd's full-dictionary mode so arbitrary bytes cannot
masquerade as a trained dictionary. Both layers are asserted in
`node-smoke.mjs`.

`index.json`'s size varies with `importDate`, which is a wall-clock millisecond
timestamp; the rest is deterministic. If the counts above change, check whether a
bank was edited before assuming a regression — `node-smoke.mjs` prints the actual
report and the expected counts on every run.

---

## `custom-dictionary.test.mjs`

Five focused checks pin the context-independent custom source and archive
contract. They cover first-two-comma parsing, comments and blank lines, ordered
duplicates, every malformed-line report, CRLF-preserving append, and exact
round trips for escaped newlines, literal backslashes, and literal
backslash-plus-`n`. The production ZIP builder must be byte-deterministic, use
UTF-8 classic ZIP metadata, and split more than 1,000 entries into successive
term banks. The resulting multibank archive is then imported and queried through
the real WebAssembly engine by `extension-smoke.mjs`.

---

## `node-smoke.mjs`

The real test. Loads the threaded bundle by default or the fallback bundle when
`HACHIDORI_WASM_VARIANT=fallback`, mounts plain MEMFS, and drives the frozen C ABI end to end.
117 checks, ordered by dependency. Exits 0 on success,
1 on assertion failure, 2 when the wasm module has not been built.

What it proves, in order:

1. **`hdw_import`** — success, the exact counts above, the title, that
   `hdw_last_error` is cleared, and that the output directory holds a version
   marker plus every file `hdw_add_dict` checks for. Marker-agnostic on purpose:
   which marker the importer writes depends on whether it trained a zstd
   dictionary, so a test that pins one pins the branch the fixture happened to
   take.
2. **The Emscripten mmap regression.** `hash.table` and `bloom.filter` are
   non-empty *and* not zero-filled. The distinction matters: `memory::map_rw`
   `ftruncate`s to the final length before mmapping, so before the submodule's
   `wasm`-branch fd fix these files had exactly the right *size* and were full of
   zeros — the import still reported success and every lookup then returned
   nothing. So this reads the bytes and checks the `capacity` / `num_bits` /
   `num_hashes` headers and that at least one hash slot and one bloom byte are
   set. A size-only check would sail straight past the bug.
3. **`hdw_add_dict`** for all four kinds. The fixture carries term, meta and kanji
   banks in one zip and `DictionaryQuery` keeps a vector per kind, so the same
   imported directory is registered four times — that is what makes one zip
   exercise the term, frequency, pitch and kanji query paths.
4. **`hdw_lookup`**, validated two ways. Structurally: every documented field of
   `LookupResult` present, right type, exact camelCase, **and no extra keys** —
   that last part is the one that catches a binding that grew a field the
   renderer will not know about. By value: exact match; deinflected match
   (`食べたかった` → `食べる`, trace `["-た", "-たい"]`, plus a five-step chain);
   kana-only entry; reading-only query reaching the kanji headword; katakana,
   half-width kana, decomposed dakuten, and supported kanji variants retaining
   the raw matched input while counting preprocessing; and two misses. Glossaries are asserted
   byte-for-byte against the raw JSON in the term bank, which is what pins down
   "the renderer parses it, nobody else".
5. **`hdw_kanji`** (including the `{"character":"","entries":[]}` miss sentinel and
   the binding's sort of `stats` by name), **`hdw_styles`**, and **`hdw_media`**
   (byte length, PNG signature, and the full bytes equal to the fixture file).
6. **Error paths.** An uncaught C++ exception aborts the wasm instance and takes
   the extension's offscreen document with it, so these matter as much as the
   happy path: importing a text file and an index-less zip and a missing path;
   `hdw_add_dict` with an empty path, a directory with no version marker, a
   nonexistent directory, and out-of-range kinds; `hdw_lookup` with four kinds of
   malformed `options_json`; `hdw_media` with a null argument. Each asserts the
   documented return value *and* `hdw_last_error`, then the suite re-runs a real
   lookup, kanji query and media fetch to prove the module is still alive.
   Archives are not subject to fixed compressed-byte, member-count, expanded-byte,
   or compression-ratio caps. Regression fixtures cross each former threshold and
   must complete import, reload from the installed files, and answer a lookup. The
   expanded-size fixtures carry valid raw-deflate streams while keeping their
   physical ZIPs small. Structurally inconsistent local and central headers and
   impossible zero-byte deflate streams remain rejected.
7. **`hdw_reset`** — every dictionary dropped (lookup, kanji, styles and media all
   return their empty forms), then reloaded from the same MEMFS directory.
8. **Import staging.** `dictionary_importer::import` builds its output directory
   out of the title inside the archive and `remove_all()`s that directory when
   anything later throws, so `hdw_import` never points it at the directory the
   installed dictionaries live in: it stages every import in `<out_dir>/.hdw-import`
   and moves the result into place only once it is complete. Asserted from both
   ends — titles of `..`, `../../..`, `../escaped`, `sub/dir`, `.` and `""` are
   refused with nothing deleted anywhere (the filesystem root is compared before
   and after, and no staging debris is left behind), and a re-import that fails
   after the title is parsed leaves the installed copy complete, loadable and
   answering lookups.
9. **Both on-disk layouts, side by side.** The 6-row fixture lands in the pre-4
   layout and the 49-row one trains a zstd dictionary, so `.hoshidicts_3` with no
   `dict.zstd` and `.hoshidicts_4` with one are both imported, both loaded — at
   the same time, from one query object, which is the state of a profile after an
   engine upgrade — and both asserted through a real lookup whose glossary bytes
   only come back if the dictionary the importer trained was found. Then the other
   direction: a `_4` directory whose `dict.zstd` is missing, empty, or not a
   valid trained dictionary must be *refused* by `add_dict`.
10. **Interrupted installation recovery.** Synthetic transaction trees cover a
    partial old-dictionary backup, a committed backup beside a partial new
    destination, a complete new destination beside its retained backup, and an
    interrupted first install. Initialization restores the complete previous
    files when needed, preserves a fully published replacement, removes
    incomplete destinations, and leaves no transaction debris.
11. **`hdw_lookup_dictionary`.** A dictionary-scoped lookup refuses a path that
    is not loaded, preserves the normal lookup response contract and global
    capability count, and returns definitions from only the selected term path.
12. **Lookup response bounds.** Both term endpoints accept exact 8 MiB raw
    glossaries and reject one extra UTF-8 byte, aggregate copied strings above
    32 MiB, and JSON escaping that expands a response above 32 MiB. Query and
    option strings retain their exact 4 KiB UTF-8 boundary, including kanji
    queries. Frequency display control bytes survive valid escaped JSON, and
    the loaded dictionary remains usable after each refusal.
13. **Media response bounds.** Exact 1 KiB dictionary and 4 KiB path references
    are accepted as well-formed misses, while one extra UTF-8 byte fails. Media
    at 4 MiB and one byte larger both import and load; the exact fetch preserves
    all bytes, the oversized fetch reports a native error, and healthy media
    and term lookups still work afterward.

Two behaviours worth knowing, both asserted so they cannot drift silently:

- The `hdw_lookup` failure fallback is the literal
  `{"results":[],"dictionaryCount":0}`, so `dictionaryCount` reads 0 even when
  dictionaries are loaded. Do not treat it as a dictionary count.
- `hdw_media` returning 0 for a path or dictionary that is simply absent leaves
  `hdw_last_error` **empty**. Null arguments, oversized references, and oversized
  payloads set the native error. Callers must inspect it before interpreting a
  zero length as a successful miss.

---

## `threaded-bridge-smoke.mjs`

Imports the real offscreen bridge with controlled worker and fallback-service
endpoints. It verifies the existing 128-request admission bound during capability
selection, fallback module loading, and active dispatch; responsive status;
mutation exclusion; slot reuse; and exactly-once replies after dispatch, local
handler, engine selection, and worker failures. Lookup/media failure framing
still includes oversized correlation IDs.

The fallback endpoint uses Node's built-in
[`module.registerHooks`](https://nodejs.org/download/release/v22.22.3/docs/api/module.html#moduleregisterhooksoptions)
loader seam, requiring Node 22.15 or newer. It does not boot a fake native engine
or alter the production bridge source. Actual WASM/IDBFS behavior remains covered
by `extension-smoke.mjs` and `chrome-fallback.mjs`.

## `extension-smoke.mjs`

The layer above the ABI. Loads the real `background.js`, `offscreen.js` and
`render/*.js` against the real `extension/vendor/hoshidicts.wasm` and drives one
full request→reply round trip per contract-C message type. 506 checks, all of
which have to run: the renderer stage needs jsdom and **failing to load jsdom is
a failure, not a skip** (see below). Exits 0 on success, 1 on assertion failure,
2 when the wasm module or the fixtures are missing.

The fakes cover only the Chrome surface the extension actually touches:

| fake | why |
| --- | --- |
| message bus | models the two rules `background.js` depends on — `sendMessage` never delivers to the sender, and an extension context never reaches a content script. That is what makes the `relayed: true` guard testable. |
| `chrome.storage.local` | in-memory, with `onChanged`, so revision conflicts, legacy migration, and the service worker's ownership of `dictionaryState` are real. Given to the worker and the settings page only: an offscreen document has no storage. |
| `indexedDB` | one object store keyed by path plus a `timestamp` index, which is all Emscripten's IDBFS uses. Enough to prove `FS.syncfs(false)` actually wrote something. |
| `fetch` | serves `blob:` URLs out of a map (the import path), `chrome-extension://` URLs off disk (`render/reader.css`), and deterministic catalogue and managed-update responses |

Each script gets its own `chrome` object. The harness concatenates the shared
custom-dictionary, JSON-value, and managed-source modules into `background.js`,
strips those ES-module boundaries,
and runs the worker and render code in `node:vm`; `offscreen.js` is a real ES
module and reads the shared global, which is the one wired to the bus as
`"offscreen"`.

What it proves, in order:

0. **Reader options.** Static checks keep the shared `reader-options.js` ranges
   aligned with HTML inputs and the independent engine request bounds. Actual
   worker requests verify strict supported-field validation, unknown-field
   projection, sparse legacy repairs/no-ops, revision conflicts, and options
   pruning in dictionary CAS. Complete UTF-8 request and response boundary tests
   include multibyte/escaped text, invalid/oversized correlation IDs, and a
   9→10 revision change; an oversized prospective success must fail before
   storage changes. Settings and content harnesses load the same shared script.
   Activation cases cover legacy mode/key migration, strict new fields, delayed
   stationary keydown, physical-code release and repeats, transfer/Note ownership,
   interaction-only resource retention, focused-control pointer protection, and
   cancellation of the first pending popup on departure/click/Escape/blur/scroll.
   A successful hover expands its initial one-glyph placement range to the
   complete matched word before rendering. Text moved outside the source during
   a pending lookup retains the original glyph anchor.
   Hidden cleanup skips scroll writes; visible term, kanji and notice renders
   reset scrolling. Master disable cancels scans and
   stale replies without rolling back or refreshing a successful Note append.
1. **Managed custom dictionary.** The source document and package state commit
   as one revision-checked write, ordinary state reads leave the potentially
   large source off their hot path, stale Settings saves fail without merging,
   queued Note appends read the latest source, and lost replies need an exact
   pair readback. Real-WASM compilation covers multibyte text, escapes,
   duplicates, multiple 1,000-row banks, semantic no-op repair, zero-row
   removal, presentation-conflict retry, fixed-ID/title protection, and cleanup.
   Settings and popup harnesses cover lazy newest-only source adoption,
   coalesced complete malformed-line reporting, immediate-save validation,
   pinned controls, lazily constructed shared term/kanji Note behavior,
   exact-view refresh and Back context, Escape/hover guards, and successful
   append followed by failed refresh.
2. **Boot and relay.** `hd_status` has exactly the eleven documented envelope
   keys, echoes its `requestId`, and reaches `ready`. `createDocument` runs once
   and never concurrently. `background.js` stamps `relayed` on its forwarded copy
   and senders never do.
3. **Storage ownership and import.** The offscreen document's fake `chrome` has
   `runtime` only, as a real one does, so a storage call from `offscreen.js` fails
   here the way it fails in Chrome; a static check backs that up for the paths
   this file does not exercise, and `hd_state_read` is answered by the worker
   without ever being relayed. Then `hd_import` of `hachidori-fixture.zip` succeeds,
   `hd_import_result` carries all nine `ImportReport` fields, the counts match the
   baseline above, `chrome.storage.local.dictionaryState` gets one logical package
   with generated-index metadata and its exact stable ID, four legacy kind rows
   migrate once, stale CAS writes are rejected, invalid selectors are pruned in
   the same worker-owned transaction, and IndexedDB is non-empty afterwards. The
   Settings fixtures also cover normalized dictionary search, stable visible
   selection, bulk state changes, every reorder path, queued moves, external
   selection pruning, alias-edit preservation, conflict rollback, the removal
   control barrier, global group naming and ordering, stable ordered memberships
   and removal pruning. The shared group-state contract preserves normalized
   names, disabled installed members, ordered deduplication, and worker metadata
   without mutating its input. A three-archive batch verifies that a failed
   middle import does not stop the last one.
   Frequency controls cover paired source/direction patches, explicit Auto,
   preserved manual choices, unavailable selections, and focused native drafts
   across newer options and capability changes. Alias writes retain frequency
   mode metadata.
   Metadata controls cover strict options, focused preferred-pitch drafts,
   stable-ID source rename/removal, numeric unit-separated harmonic averages,
   independent IPA and grammar, metadata-only storage updates, and focused ruby
   deferral without replacing Note, cards, definitions or unchanged metadata.
   IPA overflow builds tags only on first expansion, preserves every ordered
   transcription and uses the current source aliases.
   Compact-summary controls cover strict opt-in/count/source options, remembered
   unavailable sources, disabled-value retention and focused input drafts through
   an external off update. Renderer checks pin ordered bullet/semantic extraction,
   lazy fragment production without per-empty-bullet normalization and bounded
   matching/normalization on long text, split Unicode pairs and raw block boundaries,
   duplicate skipping with a partially filled preview without per-character matcher
   calls, per-point boundary checks or unnecessary point arrays,
   trailing-whitespace trimming, mixed
   plain/structured top-level senses, shared fallback discovery and no empty-child
   block checks without losing a later useful sense, line-break separators,
   wrapper-selected payloads, ruby without annotation/fallback delimiters, and
   exclusion of unrendered child lists/text,
   leading-image dispatch, no default-off summary, unchanged full definitions and
   Note controls, partial presentation no-ops, and independent image ownership.
   A collapsed source image stays expanded only in the compact preview. Missing,
   rejected and decode-failed media remove its wrapper but retain full-card errors.
   Combined state delivery invalidates changed contents before summary work, or applies
   current labels and summary preferences together once.
   Image-source options preserve Automatic, canonical dictionary titles and stable
   group IDs through strict, idempotent CAS, rejecting malformed known shapes.
   Their native chooser retains disabled/missing sources and exact focused options
   through aliases/group renames, then surfaces a stale draft's revision conflict.
   The existing detached-child regression also rejects new summary/media work
   before its obsolete anchor chain can be retired by later positioning.
   The batch assertion pins sequential requests, completed/total progress, one
   retained outcome and revoked object URL per file, a cleared picker, and one
   final dictionary-state/status refresh. The recommendation stage separately
   pins the four catalogue entries and publisher links, download/import phases,
   atomic source validation, immediate starter-card hiding, failure continuation,
   and a retry containing only missing entries.
4. **Managed dictionary updates.** Manual checks cover every managed package,
   including disabled packages, without downloading an archive; per-package and
   global results persist. Manual installs and the one global alarm both recheck
   before replacing a generation, preserve presentation and groups, commit
   successful status atomically, and retain a working generation after failure.
   Generic and
   catalogue-pinned source rules, final URLs, rotating HTTPS archives, stale
   fingerprints, title collisions, lost replies, concurrent group-only state,
   injected blob archives, cleanup, and alarm recreation are all exercised.
5. **Every read path** with the logical fixture package expanded to all four native kinds:
   `hd_lookup` and selected-dictionary `hd_lookup_dictionary` (payload keys,
   deinflection trace, glossary still a raw string,
   frequencies, pitches), `hd_kanji` (including the string `onyomi`/`kunyomi`/
   `tags` of contract B and the `null` for a miss), `hd_styles`, `hd_media` (a
   `data:` URL matching the pattern `glossary.js` accepts, and `null` for an
   absent path).
   Two temporary rank/occurrence archives exercise actual native ranking before
   one- and three-result truncation, selected ascending/descending directions,
   disabled and all-dictionary ordering, and stable glossary identity. Their
   generated index metadata also repairs older stored packages on reload.
   A committed package whose files no longer load is skipped on reload: the
   other dictionaries keep answering lookups, `hd_status.failedDictionaries`
   names it with its load error, and removing it clears the report.
6. **A no-match lookup still reports the real `dictionaryCount`.** `content.js`
   renders "no dictionaries imported" on 0, and 0 is also what the engine's error
   fallback returns, so `offscreen.js` reads `hdw_last_error` after every
   string-returning call and fails the request rather than forwarding an
   ambiguous empty.
   Focused boundary checks reject C-string NUL and oversized UTF-8 inputs,
   malformed native envelopes, and complete replies above 32 MiB. They retain
   exact-boundary replies and correlated bounded errors, including multibyte
   request IDs and early service-worker relay failures. The next healthy lookup
   keeps the same engine generation.
7. **Error paths.** An unknown type is answered as `<type>_result` with
   `ok: false` rather than dropped; a non-zip import fails with a report attached
   and leaves the previously loaded set intact; an import with no blob URL is
   rejected rather than thrown. A valid import with a declared length above the
   former byte cap succeeds, and a counting filesystem sink receives an actual
   streamed body one byte beyond that boundary.
8. **The renderer against the engine's own bytes.** This is the check that a
   hand-written payload cannot make: the actual `hd_lookup` / `hd_kanji` /
   `hd_media` replies go into the real `createPopupView`, and the
   headword, the parsed structured content, the `data-hoshidicts-dictionary`
   attribute `@scope` keys off, the frequency tags, the `<img>` resolved through
   `resolveMedia`, and `renderKanji`
   are all asserted on the resulting DOM. `glossary` is the whole glossary *array*
   of one term-bank row, so each of its elements must land in its own
   `li.gloss-item` — appending them into one parent runs two senses together with
   no separator, which is asserted against the fixture's own two-sense entry.
   Deinflection disclosures expose the real engine's ordered trace, retain raw
   duplicate/whitespace/literal-text cases, and use English/Japanese/Ukrainian
   browser labels without replacement-string interpretation. Missing/malformed
   traces are safe even with grammar tags enabled. Secondary headers stay lazy;
   tab projection resets the disclosure, and stale toggles after replacement,
   clear, request supersession, or destruction cannot request positioning.
   Focused boundary checks accept depth 24 and reject 25; seed the exported
   traversal's node counter to test exact capacity without a million-node DOM;
   and include containers, wrappers, nulls, and ignored tags in that budget.
   Deferred, tab, and Show more failures reach the current view owner. Replaced,
   cleared, destroyed, or request-superseded fills do no rendering, media, or
   layout work, and the actual content callbacks cannot clear a newer request.
   External links preserve safe native hrefs while routing current primary,
   keyboard and middle activation exactly once, including mixed nested links.
   Worker checks reject invalid URLs/senders before tab creation and bypass held
   storage writes without waking the engine. Failed or missing navigation replies
   do not retry, replace the lookup or discard an open Note draft.
   Internal anchors preserve exact linked query/reading and share connected/current
   ownership checks; an enclosing structured anchor cannot dispatch a second lookup.
   Level-aware content checks cover same-link reuse, descendant-only pruning,
   child-local kanji Back, viewport/depth changes, protected pointer transfer,
   retired callbacks and replies, and non-monotonic engine generations. Parent
   and child Note appends complete with reversed replies/storage events without
   losing drafts, duplicating appends, or reviving a retired depth. Queued shared
   media remains live while any owning popup still needs it.
   Same-view refresh keeps the actual mounted Note form, pending save and
   response-time focus; held failures/misses preserve protected drafts. Repeated
   stale tab/Show-more actions share the current replay without reviving old
   resources or leaking transient control preservation into ordinary Back.
   Four real renderer resize/observer callbacks retain per-pane masonry but
   position the chain once per deferred pass. Narrow-width recomputation,
   root-only timing, owner retirement and shared-frame cancellation are pinned.
   Media tests also pin exact UTF-8 reference and 6 MiB complete-reply boundaries,
   embedded-NUL prefix rejection, bounded correlation on early relay failures,
   and actual oversized native errors without capping archive imports.
   Queued media checks its required generation before native extraction.
   Controlled content replies cover old/new and repeated numeric generations,
   pending dedupe, missing/failure retries, Back snapshot refresh, and style
   request identity. Successful resources survive repeat hovers, completion
   while hidden, and alias/favourite edits. Connected but obsolete image
   fulfillment, rejection and load/error callbacks cannot mutate or reposition
   an old panel; current failure keeps accessible alt text and a readable label.
   Scheduler checks pin four dispatched jobs, 128 total admitted jobs (including
   active jobs), dedupe at capacity, FIFO progress, and dispatch-only deadlines.
   Controlled timeout/late-reply cases protect retry and active-count accounting;
   new views can claim matching queued jobs without obsolete work blocking
   admission. Invalidation and teardown settle every job before more dispatch.
   LRU checks accept 64 entries and exactly 16 MiB of decoded media, promote hits,
   evict on one extra entry/byte, and reset byte accounting on invalidation.
   Preview checks cover lazy closed-shadow ownership, exact source reuse without
   another media request, viewport corners, unchanged inline dimensions,
   combined hover/focus retention and failure cleanup, tab/clear/destroy, and
   dismissal before new term/kanji replies or settings invalidation. Late loads
   cannot steal newer preview intent or revive a dismissed preview. Keyboard scroll retains its
   focused owner; keyboard focus cancels hover dismissal, while ordinary blur
   rearms it and content replacement does not hide a refreshed Note result.
   An ad-hoc format-3 fixture imports genuine AVIF and SVG through the real WASM
   engine and checks their complete returned data URLs, not merely file headers.
   Image-sizing checks keep the existing bounded sizer authoritative, preserve
   ordinary/preferred/em dimensions, and recover intermediate width arithmetic
   overflow/underflow while retaining valid original rounding and display clamps.
9. **`hd_remove`** — generation root gone, logical package gone, nothing loaded,
   and removing an unknown title does not bump `generation`. Removal loads
   the remaining manifest and commits it before deleting the old root. The
   failure case injects a `chrome.storage.local.set` rejection: the original
   generation and live engine must remain intact. Startup recovery also preserves
   a legitimate legacy dictionary whose title is `.hdw-remove`.
10. **A trained (`.hoshidicts_4`) dictionary through the extension layer.**
   Everything above imports the 6-row fixture, which is under the zstd training
   floor, so nothing outside `node-smoke.mjs` had ever seen the layout the current
   engine writes for a real dictionary. `buildTrainedZip()` goes through
   `hd_import`, and then its exact manifest path must strict-load, the IndexedDB
   fake has to contain both the marker and `dict.zstd` under that generation root
   — those are the files IDBFS repopulates after a restart — and `hd_lookup` has
   to return the glossary bytes, which only decompress if `dict.zstd` was found
   and loaded. The restart case also proves an explicitly unreferenced generation
   is deleted rather than adopted from disk.
11. **First-run setup.** A worker context receives `onInstalled` with reason
   `install` and must create exactly one `startup.html` tab, seed the setup
   record and the first-install options in one storage write, and leave a
   later user edit alone through `update`, `onStartup` and a restarted worker
   context; a profile that already carries options keeps them. `hd_setup_cas`
   is answered only for the startup page URL, refuses a stale base revision with
   the current state, rejects invalid stages, missing revisions and any move
   back to an earlier or finished stage, and records `completedAt` and
   `continued`. `hd_setup_record` is answered for the offscreen document only:
   it stores each outcome, accumulates installation durations once per run (a resent
   record confirms rather than recounts), and settles the Jitendex
   summary source and Bee's clicked-kanji route once from the committed titles,
   in one write with the setup record, without overwriting an option the user
   already changed. A fresh jsdom `startup.html` shows its short setup invitation,
   Bee credit and GitHub-star call to action without any runtime request, contains
   no privacy-policy link, keeps the welcome screen after a failed Start save, and begins
   installation only after that stage write succeeds. Reopening the accepted
   stage resumes installation, while **Set up manually** reaches practice
   without dictionary or Anki requests. An accepted startup page attaches to the installer with the
   untouched sources, shows an unanswered request once with Retry instead of
   re-requesting, renders **Already installed** only for trusted
   `sourceId`/index identity, mirrors determinate and indeterminate download
   rows, installation, installed and failed phases for its own run identity and
   sequence only, announces settled outcomes but not bytes, shows Retry and
   Continue on failure, requests only the missing source on retry, ignores the
   superseded run, advances the all-installed result immediately with a
   conflict retry, keeps focus on its controls
   through inventory events, ignores an older setup revision,
   defers rendering while a
   write is in flight, moves focus to the heading on a stage change, adopts a
   conflict reply's newer state, and closes its own tab after Finish. The
   Settings harness shows **Resume setup** only for an incomplete, readable
   setup record. The restarted fallback engine imports a recommended source
   from its catalogue archive URL with no blob and no fingerprint, reporting
   download bytes with no total (the fake response declares none) and one
   installation phase under the request ID, and refuses a non-catalogue archive
   URL, a URL-only request without a source, and an unexpected final URL;
   `declaredResponseLength` ignores encoded, zero, and header-less responses.
   With `OVERLAY_MODE` on, a worker instead seeds hover lookups without a page
   highlight on top of the first-install options when it starts. It creates no
   setup record or tab, and leaves later edits and carried options alone (see
   [overlay mode](../docs/overlay-mode.md)).

### Definition blur and Anki maturity

`node --test test/anki-maturity.test.mjs` exercises the production snapshot
extractor with an injected gateway. It pins one `notesInfo` query for the
configured note type across all decks, review state excluding relearning,
an interval of at least 21 days, and the 25-second refresh timeout. Cases cover
eligible expression fields and source identity, exact stored HTML, ASCII-only
case folding, Anki's default query NFC normalization, deduplication, empty
results and rejection of malformed replies without publishing partial words.

`node --test test/anki-maturity-cache.test.mjs` checks local worker membership
without Anki calls, cold-cache behavior, retained snapshots during failed or
pending refreshes, successful empty replacements, and failed persistence.
Controlled clocks, alarms and serialized storage exercise the 30-minute
schedule, worker restart, concurrent triggers, configuration changes and
disable/re-enable publication rules. The offscreen service test also verifies
refresh-worker termination after successful, failed and worker-error replies.
These focused suites never contact an
Anki collection.

The extension smoke harness checks maturity blur with counts disabled, the OR
decision when both criteria are enabled, autoplay held until the hover reveal
and never replayed by later tab bindings, first-count retention, stale replies, mapping changes,
lookup before initial options, and pending/completed evidence retained for Back
across Anki mapping edits. Settings exercises the Off / Lookup count / Mature
Anki cards / Either condition selector, its mapping to the existing booleans,
conditional controls, paused-count explanation and revision-bound drafts.
The Design preview uses fixed maturity data and the shared reveal behavior.
The existing count-only tests retain timed reveal, navigation, Note and audio
ownership coverage.

The Chrome E2E suite intercepts the entire AnkiConnect endpoint on both the
service-worker target (mining controls) and offscreen target (including its
dedicated maturity refresh worker). It checks
source persistence, a responsive cold-cache popup during a held refresh,
cached mature results without repeated Anki calls, and pronunciation that
waits for the hover reveal.
Real alarm delivery verifies that a refresh changes new lookups while keeping
the open popup intact; disable/re-enable refuses pending publication, and
unavailable Anki retains the last successful snapshot. A real worker restart
restores cached membership and a missing alarm without retrying a recent
failure. Independent count blur and autoplay remain covered. These are
fixtures, never the user's actual notes or scheduling data.
`HACHIDORI_DEFINITION_BLUR_SCREENSHOT` captures the updated Settings controls.

### jsdom

The renderer integration stage needs jsdom. The reproducible setup above installs
it in `test/tooling`. Direct commands can also use an external dependency tree:

```sh
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$CACHE_ROOT/hachidori-e2e"
cd "$CACHE_ROOT/hachidori-e2e"
npm install --save-exact jsdom@30.0.1 puppeteer-core@25.10.0 @puppeteer/browsers@3.2.2
./node_modules/.bin/browsers install chrome@152.0.7977.75 --path "$CACHE_ROOT/hachidori-browsers"
```

That path is the built-in default, so `node test/extension-smoke.mjs` finds it
without an environment variable. To use another location, point
`HACHIDORI_JSDOM` at the directory above a `node_modules` that has jsdom in it, or
`NODE_PATH` at the `node_modules` itself:

```sh
HACHIDORI_JSDOM=/path/to/tree node test/extension-smoke.mjs
NODE_PATH=/path/to/tree/node_modules node test/extension-smoke.mjs
```

ESM ignores `NODE_PATH`, which is why the loader resolves jsdom through
`require()` before importing it, and why `NODE_PATH` works here at all.

A jsdom that cannot be loaded is a **failed check**, printed with the paths that
were searched and the command that fixes it. It used to print `SKIP` and leave
the count at "44 passed, 0 failed", which is how the whole renderer stage sat
unexercised without anyone noticing: a suite that answers a missing dependency by
quietly testing less reports success either way.

What it cannot prove: anything about Chrome itself. No manifest validation, no
`chrome.offscreen`, no real IndexedDB or `unlimitedStorage` quota, no MV3 CSP, no
layout (so no popup positioning, masonry or `@scope`), and no `blob:` URL crossing
from the options page to the offscreen document. That is what `chrome-e2e.mjs` is
for.

---

## `chrome-e2e.mjs`

Audio adds three browser assertions: default reading TTS plus ordered/disabled
custom sources survive save/reload; encoded JSON discovery tries an undecodable
candidate before naturally completing a one-second PCM WAV; no-result, HTTP
failure and Stop have distinct feedback. A stopped fetch cannot change the UI,
and the same offscreen document and engine survive 31 seconds of audio silence.
`HACHIDORI_AUDIO_SCREENSHOT` captures the Audio Settings page.

Popup audio adds four browser assertions for default-off silence, enabled-source
and decode fallback, source/name choice with native cached replay, once-per-view
autoplay, and cancellation on dismissal, source edits and navigation. The chooser
is checked against visible popup bounds and selected with a real mouse click;
Escape restores Audio focus without hiding definitions.
`HACHIDORI_AUDIO_POPUP_SCREENSHOT` captures the chooser. Test instrumentation
observes native Audio instances without replacing decoding or completion events.

The harness uses Chromium's `--disable-audio-output` clocked fake output device.
This runs native fetching, decoding, playback progression and `ended` without
requiring audio hardware; it does not bypass autoplay or synthesize completion.
Without it, this headless macOS host accepts playback but stalls its audio clock
at 64 ms. Audible hardware output and installed speech voices are not proved.

`node --test test/audio-{sources,player,offscreen,cache,repository,content}.test.mjs
test/anki-{audio,offscreen-audio}.test.mjs test/capture-speech.test.mjs`
runs the focused tests for strict source options, defaults versus explicit empty
lists, template encoding, candidate order, native callback ownership, cleanup,
TTS supersession, first-use voice loading, automatic Japanese voice selection,
unavailable selected voices, captured-TTS WAV export and silent preflight,
document-scoped cancellation,
Test and fallback deadlines, LRU/TTL/byte accounting, leased URL cleanup, exact
candidate identity, stale controls, chooser focus/failure recovery and autoplay,
including delayed initial options without repeating a manual play, quiet success
feedback, and controls hidden when no source is configured. Extension
checks exercise the actual worker's cancelled startup retries and Settings draft
conflicts rather than duplicating their storage machinery.

```sh
node test/chrome-e2e.mjs
```

The primary-path test runs 200 predeclared checks in a browser. The reproducible
launcher uses the pinned Chrome and `puppeteer-core`. For direct execution, the
external setup above installs Chrome for Testing in the default cache; the harness also checks
`CHROME_BIN` and common system locations. Override with `HACHIDORI_CHROME`,
`HACHIDORI_PUPPETEER`, and `HACHIDORI_PROFILE`; the run aborts with a message
naming the variable if either is missing.

It launches Chrome with `--load-extension`, intercepts the four production
recommendation URLs with deterministic ZIP fixtures, proves failure continuation,
trusted source metadata, reload/restart hiding, and missing-only retry, then clears those
fixtures. It next uses the real `#import-file` on `settings.html` for a valid
archive and drops a three-file batch containing a term-only kanji dictionary, a
malformed ZIP, and a same-title reimport. It verifies the drop target feedback,
the shared startup-style progress rows, elapsed import times, ordered per-file
outcomes and failure continuation, then exercises filtered bulk management, a real
pointer drag, keyboard position movement, capability-aware chooser migration,
and clicked-kanji navigation, and hovers real
text with a real mouse on a page served over `http://127.0.0.1` (content scripts do not run on
`chrome-extension://`, `about:blank`, or `file://` without a per-extension
opt-in). A wrapped cross-inline match proves the popup sits outside the complete
matched range rather than positioning against only the hovered glyph. The test
then relaunches against the same profile and hovers again with no
re-import — which is the only test that proves direct OPFS persistence through a
full Chrome restart.

The clean profile also fires `chrome.runtime.onInstalled` with reason `install`,
so the extension itself opens `startup.html`, whose installer immediately asks
the engine for the first catalogue archive. Those downloads happen inside the
offscreen engine worker, so the harness attaches a Fetch interception to the
offscreen target as soon as that target is named (`targetcreated` and
`targetchanged`), before the engine can boot: the first Jitendex request is
held until the clean-profile Settings checks have run, jmnedict's publisher
answers 503 once, Jitendex and Jiten declare `Content-Length`, and Bee's does
not; the padded 4 MiB fixtures come from `buildRecommendedZip({ paddingBytes })`.
Eight assertions cover the tab: exactly one startup page at the dictionary
stage with the Settings palette, Jitendex held in an indeterminate
**Downloading… 0 KB** row and the seeded first-install options (compact
summaries on at two, TTS and the dark popup defaults untouched); the Settings
sidebar's **Resume setup** link outside the section navigation; a reload that
rejoins the same run without a second archive request; the released run, whose
recorded broadcasts and every rendered row prove waiting → downloading →
installing → installed for the declared-length and the indeterminate archive,
the 503 failure with its reason beside three installed rows, Retry and
Continue, durable outcomes and no all-installed claim; Retry fetching only
jmnedict, the all-installed heading with the accumulated total, and the
Jitendex summary source and Bee's clicked-kanji route settled once while the
user's compact-summary edit stands; the result advancing immediately to
**Finding your Anki setup…** with focus on the new heading; the unavailable
Anki connection settling into **Could not find Anki** for three seconds after
exactly one AnkiConnect
attempt, which the harness refuses on the worker target for that stage so a
real Anki or another suite's mock server on port 8765 cannot decide the
outcome, and whose recorded outcome carries the gateway's reason and moves
setup to **You’re ready.** with the outcome sentence
and its Settings link, where the real reader immediately demonstrates the
answerable word before keyboard and hover checks, Finish closes the tab and the completed record
hides the link; and, after the in-run service-worker restart and the full
pass-2 relaunch, no reopened startup tab, no further archive request, the same
completed record, and the earlier edit still in force. Both Anki headings are
transient, so the page records every heading it paints through a
`MutationObserver` instead of relying on a poll landing inside them. The four
setup-installed packages are removed afterwards so the Settings installer below
still starts from an empty library.

One further check drives the recognised case. With setup returned to the Anki
stage and a mocked AnkiConnect answering on the service-worker target, a new
startup page must detect the busiest of three note types (`Kiku v2` beside
`Basic` and the non-matching `My Kiku`), choose the deck holding the most of
its distinct notes, save that model, deck and the resolved preset templates
through the revisioned options write, record the `configured` outcome, and
issue only the fixed read-only actions in ranking order at protocol version 6.
The page visibly advances through finding the most popular mining card, finding
its most popular deck and applying both. Each step holds for two seconds and
shows its chosen card or deck as that step is reached, then the settled result
holds for three seconds before practice.
The mock is detached and the previous setup record and Anki options are
restored, so the Anki Settings checks below still begin with a lazy, offline
connection and an unconfigured mapping.
`HACHIDORI_STARTUP_SCREENSHOT`/`_DARK_SCREENSHOT` capture the held download,
`HACHIDORI_STARTUP_COMPLETE_SCREENSHOT`/`_DARK_SCREENSHOT` the countdown
result, `HACHIDORI_STARTUP_READY_SCREENSHOT`/`_DARK_SCREENSHOT` the final step
after an absent Anki, and
`HACHIDORI_STARTUP_ANKI_SCREENSHOT`/`_DARK_SCREENSHOT` the automatic Anki
progress with the chosen card complete and the chosen deck current, and
`HACHIDORI_STARTUP_PRACTICE_SCREENSHOT`/`_DARK_SCREENSHOT` the practice step with
a real lookup open. `HACHIDORI_SETTINGS_SCREENSHOT` captures the empty import
drop target and `HACHIDORI_IMPORT_SCREENSHOT` captures its completed shared
progress rows.

The jsdom stage for that step also requires the appended list to match the
manifest's own `content_scripts` order, that the exact **辞書** selection is
probed first and the sentence is then probed offset by offset only if needed,
that a prefix-only shortcut hit keeps the button hidden while another passage
word can still enable the exercise, and that the exact-selection length remains
two when the hover scan length is one. It also checks that removing the package
which answered retires the invitation and probes again while a group-only
revision does not, and covers every state that must not invite a
hover: a frequency-only library, a library that answers nothing, an engine that
refuses the first pass and is retried after a failed status, a long loading
recovery and then an idle engine, an engine that
never answers, and lookups switched off. The group-only step also requires the
sentence to be the same node afterwards, which is what keeps an in-flight lookup
anchored.

Two further checks cover that practice step. The first waits for the reader
scripts the page appends for itself, requires their manifest order, aims the
real mouse at **辞書** inside the reviewed street-scene passage, and requires
the closed-shadow popup to show 辞書 with the definition from the Jitendex fixture this run
installed, then to close on leave. The second loads those same scripts into
Settings, hovers Japanese text there with the real mouse, and requires the
renderer to be present but no reader host to exist, which is what proves the
page restriction rather than the absence of an injection.

The keyboard/hover practice check first reloads `startup.html#setup-heading`,
the URL its native skip link can create before the module attaches a handler,
then requires the ordinary reader to answer from the real installed fixture.
The internal-page exclusion check also injects the same scripts into query
variants (including one with the known fragment) and an unknown fragment,
requiring no reader host or selection lookup there.

Four further assertions cover the real practice and saved-page flow. The
keyboard lookup button selects 辞書 from the scene and the ordinary reader
returns the just-installed catalogue fixture's glossary; pointer lookup works
too. An options update preserves the connected scene and selection. Using
**Skip to setup** keeps the exact startup URL, while explicitly injecting the
reader into Settings, the design preview or a query-suffixed startup URL still
produces no lookup. The file-access control opens this extension's own Chrome
details page. At the end of the browser suite, it returns without enabling,
then flips the real switch in its isolated profile. Chrome closes extension
tabs during the reload, so the test opens **Extension options** and follows
**Resume setup** to the persisted practice stage. It confirms access on resume
and page reload, then looks up 辞書 in a local HTML fixture. Access is disabled
again before **Not now** and **Finish**. The Anki success screen, after fixture
removal, proves dictionary recovery keeps Finish and Settings available.
`HACHIDORI_STARTUP_LOOKUP_SCREENSHOT` captures the actual practice popup.
The startup screenshot check uses Chrome’s live extension document context to
capture that tab, since packaged extension pages cannot answer content-script
messages and their runtime sender has no tab.
The native-switch scenario enables Developer mode in its isolated profile:
Chrome 152 otherwise disables a command-line extension when it reloads as an
unpacked extension. No personal browser settings are changed.

`node --test test/recommended-dictionaries.test.mjs` checks that
`recommended-dictionaries.js` is the only place the recommended set is described:
first-install selections and the count and topics the startup page and Settings
show come from its entries, and no other extension page or script repeats a
catalogue source ID, archive or index URL, or a written-out count.

`node --test test/local-file-access.test.mjs test/startup-practice.test.mjs`
covers the optional prompt's initial query, return/reload lifecycle, stale
replies, skip and Settings shortcut, plus practice selection, retained nodes,
reader load failure and missing/disabled-dictionary recovery with accurate
headings and direct recovery actions. The startup smoke scenarios also cover
pausing/resuming the success countdown, continuing immediately, and continuing
while Anki detection is pending without a late reply reversing that decision.
The startup extension-smoke assertion also checks selection and focus through a same-stage
options event; audio routing covers startup document/request ownership.

An in-memory external-reference fixture also passes through real WASM. Real Enter
on its closed-shadow anchor must create exactly one worker-routed browser tab,
with the exact local HTTP destination, no opener/frame and an unchanged source
page. An invalid direct gateway request opens nothing; returning to the page
still permits lookup. This fixture is removed before the remaining checks.

The same run lazily opens the custom source editor, saves through the production
ZIP compiler and real pthread WASM importer, and checks the fixed package's
state and generation. It then drives the closed-shadow Note form through term
and kanji views, including projected prefill, hover/Escape draft protection,
exact-view refresh, Back restoration, source adoption in the already-open
Settings page, and retirement of each superseded OPFS generation.

Settings layout checks cover the eight-destination primary rail, Library's five
local views, selection-aware bulk actions, native keyboard section and skip
links, Back/Forward, same-hash focus, short-window sidebar scrolling, and mounted
source drafts. All twelve task views are checked at 320px and desktop widths in
light and dark mode, including palette text/control contrast and visible-control
overflow. Empty live regions stay available for their first announcement. The
extension harness pins hidden-view save failures, aggregated Library notices,
unseen completions, draft retention without extra requests, and stable-ID
Details expansion/focus across rerenders and filtering.
Two real Settings pages exercise debounced option patches with one held reply:
a newer external commit cannot be rolled back, and a stale queued draft surfaces
a conflict with explicit discard. Revisioned options also survive the full
browser restart. The extension harness covers no-op revisions, atomic selector
pruning, failed-save retry, first-input draft ownership, and old/repeated content
storage events. `HACHIDORI_OPTIONS_SCREENSHOT` captures the saved Lookup section.

Design adds three browser assertions: lazy production-rendered sample content
and keyboard kanji/Back highlighting, live presentation edits with retained
cards/Notes and no sample source mutation, and Fit/Actual geometry at desktop
and 320px. `HACHIDORI_DESIGN_SCREENSHOT` captures the Design view after layout
settles. The extension harness also checks shared Reading/Design save feedback,
unsaved preview updates, unchanged-echo render skips, unavailable image routes,
preferred-source draft retention, and exact tab/disclosure restoration.

Three further appearance assertions cover all 42 grouped theme IDs and real
dark/light/high-contrast palette overrides, immediate unsaved opacity/dimension
preview and scoped reset, and live reader/child geometry with exact highlight
restoration and retained Note/cards/resources. Unit coverage checks strict
option ranges and no-op CAS, first-layout width ordering, and native/term
clicked-kanji preview switching without losing Note or Back state. Unrelated
dictionary changes retain the current clicked-kanji cards and disclosures.

Three custom-CSS assertions check immediate unsaved preview, character count,
persisted source and scoped reset; real CSS cascade after built-in and late
dictionary styles, invalid-rule handling and page isolation; and live parent/
child styling with retained Notes, Back context and zero extra engine requests.
`HACHIDORI_CUSTOM_CSS_SCREENSHOT` captures the editor beside the live sample.
Focused extension checks cover exact-string options CAS (including source over
32 KiB), malformed types, sheet ownership/no-op work, a stylesheet load before
the first preview update, one queued CSS placement and revision-bound editor
conflicts. jsdom's constructed-sheet double proves ownership only; real Chrome
proves parsing and cascade.

Two toolbar assertions check Automatic/Top/Bottom persistence and live preview
updates with mounted Note/cards, plus root/child overrides and fixed-edge resize
without lost focus, draft selection, or extra lookup/media/style requests. The
extension harness covers the placement matrix, strict sparse CAS, focused
Settings conflicts and remote/reset reconciliation, combined reader-disable
and Automatic reset, and focused-subtree/no-op DOM mutation contracts.

Temporary rank/occurrence dictionaries connect the actual Settings controls to
one-result popup lookups. The browser checks inferred and manual directions,
explicit Auto, metadata-preserving alias edits, and unchanged engine generation;
it removes those packages before continuing. A manual direction also survives
the full browser restart. `HACHIDORI_FREQUENCY_SCREENSHOT` captures these controls.

The initial real inflected-verb popup exposes the exact native endpoints and
ordered descriptions in a closed disclosure. Chrome focuses its native summary,
opens with Enter and closes with Space, and checks its marker, raw whitespace
styling, horizontal containment, and stable Note-button position at 360px width.
Scrolling reaches the last step and glossary without the expanded toolbar
covering them; opening Note keeps its focused input visible. The viewport and
focus are restored before the remaining hover tests.
`HACHIDORI_DEINFLECTION_SCREENSHOT` captures the expanded desktop popup.

One assertion covers the dictionary cards on a popup rendered from a fresh hover.
Every card must be a plain `div` outside any `details`, with a non-interactive
title (no pointer cursor, no `::before` marker) carrying the display name and
dictionary, a laid-out definition body, and the same geometry after a real mouse
click on the title.

The exported `nestedLinksFixture()` supplies three linked term rows and one
shared deterministic PNG without changing the ordinary fixture counts. The
real-WASM Chrome chain assertion exercises mouse return versus keyboard focus,
independent parent/child Note drafts and Escape, same-level kanji Back followed
by child Back, live depth lowering/zero, and narrow-window geometry. Reimports
and held service-worker replies also prove top/bottom Note forms stay mounted,
focused and reachable, and a still-focused tab survives same-view refresh.
`HACHIDORI_NESTED_SCREENSHOT` captures the three-pane chain;
`HACHIDORI_OPTIONS_SCREENSHOT` also includes the saved child-depth setting.

`dictionaryTabsFixture()` extends that linked source with three unequal glossary
cards, without changing the generated fixture files. Four Chrome projections
cover All, ordered nonempty groups and an ungrouped favourite from the complete
native result; ordinary contributors and grouped favourites receive no duplicate
dictionary tabs. Warmed tab changes must issue no lookup, media or style
requests. Linked-child, clicked-kanji and Back retain their semantic selection.
Back restores an expanded, scrolled child with its prior tab, highlight and
toolbar and identical dictionary cards, without another native lookup;
its next Back still closes the child. Extension checks cover native-source fallback and
terminal misses, cached versus changed-generation restoration, lazy IPA and
structured disclosures, and cancellation by newer projections or deliberate
scroll. A focused scroll-read assertion prevents forcing layout while a retained
Note's replacement panel is empty.
Live labels and group order preserve keyed focus, and changed membership waits
for protected Note forms and child anchors to retire before local projection.

The same scenario saves columns one through four through Settings, compares
actual card rectangles for shortest-column packing and non-overlap, then resets
all one-column inline styles. Narrow/wide resizing, a held real PNG reply and
genuine child Show more retain complete results, mounted drafts and anchors.
Readiness includes the deferred generic-prefix definition before freezing the
expanded DOM oracle. A nondefault column count also survives the existing full
browser restart. `HACHIDORI_TABS_SCREENSHOT` captures the two-column reader;
`HACHIDORI_OPTIONS_SCREENSHOT` and `HACHIDORI_OPTIONS_DARK_SCREENSHOT` capture
the Reading controls in light and dark themes.

`compactSummaryFixture()` adds two temporary suppliers through the real WASM
importer without changing generated fixture counts. Its single predeclared
Chrome check proves persisted summary controls, one shared cold image request,
exact PNG bytes and 36px thumbnail geometry, complete unchanged cards and a
focused Note during live changes. The source image is collapsed in its full
definition but remains visible in the compact thumbnail. Tab fallback, a child's
non-leading image, genuine prefix Show more, failed-media text-only fallback with
no empty thumbnail and a readable full-card error, and a held valid lookup
using newer summary options are included. Focused control drafts survive a real
external off CAS and then surface their old-revision conflict; only the initial
input-before-change seed is synthetic. `HACHIDORI_SUMMARY_SETTINGS_SCREENSHOT`
and `HACHIDORI_SUMMARY_SETTINGS_DARK_SCREENSHOT` capture Reading in both themes.
`HACHIDORI_SUMMARY_POPUP_SCREENSHOT` captures the summary beside the complete
definitions after the shared leading image has loaded.

The real browser also changes hover enablement and activation controls from
Settings while the reading tab remains open. It proves close/re-enable without
engine reload, stationary printable-key activation with open delay, delayed hide
on release, and cancellation of a quick press/release. A non-default key is kept
when switching back to Hover and checked with mode, enablement and hide delay
after the full browser restart.

Exact-selection checks use a real cross-inline mouse drag, verify the complete
highlighted text, and reject prefix-only matches despite a one-character scan
setting. They distinguish visible selection text from hidden DOM text and block
separators, retain the popup while selecting its closed-shadow glossary, and
observe real worker lookup relays while toggling Japanese-only scanning in the
open tab. Native input, textarea and contenteditable typing stays intact; direct
and spanning selections exclude visible editing controls, including boxless
`display:contents` editors, without treating a hidden control as visible.
Nested open-shadow editors suppress printable activation typing and cancel
pending scans when focused. A local Japanese example link beside an autofocused
search field supports both hover and stationary Shift lookup while preserving
the field's focus. Visibility-restored descendants are treated as visible even
inside a hidden editor.
The extension suite separately holds replies through selection cancellation,
retry and storage invalidation; checks exact Note/Back/internal-link descriptors;
and pins same-candidate pending lookup deduplication.

Seven source-highlight assertions cover selected-text DOM replacement/stale
cleanup without selection changes, native ancestor Range identity and fallback
owner retention across child closure, and exact cross-inline fallback paint
through clipping, scrolling, resize, visibility, opacity and final cleanup.
An overlapping child must uncover the surviving source paint when closed.
CSS source transitions, animated ancestors and focus-resumed paused motion keep
exact geometry between DOM notifications.
Sibling style/text mutations move the source inside an unchanged fixed-size
container; that case parks the pointer away from the source so synthesized
pointer boundary events cannot mask missing layout observation.
Page-cover checks compare the remaining paint area and exact bounds under fixed
and sticky headers, a small centred overlay, pointer-transparent paint, clipped
header borders, fixed boxes escaping ancestor overflow, and moving overlays.
Position-keyframe cases begin as ordinary static elements and become fixed
covers, both after forwards-filled completion and when paused midway.
They include an effect started before the fallback and overlapping effects whose
first completion must not retire the remaining position-changing effect. Paused
source effects also repaint their final/base transform on finish or cancellation.
Programmatic effects begin after the catalogue settles, without a CSS DOM start
event: ancestor transforms and new position-changing covers must wake the
fallback, and direct finish/cancel events repaint paused source effects.
Removing covers restores the exact source paint; a box behind the source leaves
it unchanged.
Style-only checks settle an offscreen cover before CSSOM rule insertion,
declaration replacement, same-count adopted-sheet replacement, or releasing an
intercepted late stylesheet response. No DOM notification accompanies those
edits; bounded fallback refresh must discover the new fixed header and restore
the source after removal.
Changing colour-scheme emulation without resizing also activates sheet-level
and nested media rules; their native change events must refresh cover discovery.
The test disables `Highlight` in Hachidori's content-script CDP execution context,
not the page's main world, and reads the actual closed-shadow paint layer.
`HACHIDORI_HIGHLIGHT_SCREENSHOT` captures the clipped fallback source and popup.
Focused extension checks also cover moved shadow sources, view disposal,
document-root renderer callers, pending geometry delivery, removal-only and
unrelated-animation no-ops, unchanged-owner traversal counts and untouched
page classes/selection. Discovery counters distinguish ordinary text and owned
shadow repaint from CSS membership changes, including stylesheets, empty text,
automatic direction, attributes and element insertion/removal.
Geometry comes from real Chrome, not jsdom's stub rects.
It also recovers a selection drag when the button is released outside the
document and no mouseup arrives, without scanning during a still-held drag.

Managed-update indexes are intercepted on the service-worker CDP target and
archives on the offscreen-document target, which also covers its engine worker;
the harness deliberately does not intercept the dedicated worker directly. The
browser assertions prove check-only behavior for enabled and disabled packages,
persisted Settings status, atomic Update all replacement, the one global periodic
alarm, scheduled installation for a disabled package, failure rollback without
OPFS debris, and alarm recreation after the exact worker version stops.

### the profile

`/tmp/hachidori-e2e-profile-<pid>` unless `HACHIDORI_PROFILE` says otherwise, and the path is
printed at the top of the run. Per-pid because two runs sharing one profile
deadlock over the extension's leveldb: the second Chrome cannot open
`chrome.storage.local` at all and every read comes back
`IO error: …/LOCK … (ChromeMethodBFE: 15::LockFile::1)`, which surfaces as a
pass-2 failure that reads exactly like a persistence regression. Two concurrent runs
are now fine. A green run deletes its profile; a failing one keeps it and says so,
because the profile is the only place the imported dictionary can be examined
afterwards.

`HACHIDORI_PROFILE` is never deleted, and never created over something that is already
there either: pass 1 has to import the fixture into a clean profile or the restart
check proves nothing, so a non-empty `HACHIDORI_PROFILE` is a hard error naming the
directory rather than an `rmSync` of whatever the reader pointed the variable at.

### the denominator is fixed

`PLANNED` at the top of the file names all 193 assertions, and the summary line
divides by `PLANNED.length`, not by the number of checks that happened to run.
Anything in `PLANNED` that no `check()` reached is reported as
`FAIL … check never ran`, and `check()` refuses a name that is not in the list or
one that runs twice. So an early bail-out — no service worker, an engine that
never becomes ready — costs the whole remaining list rather than shrinking the
total: this file used to print "14/15 checks passed" for a run that abandoned
three assertions, which reads like success. Nothing here is nested under an `if`
that could quietly drop it either; a hover that produced no popup fails the four
assertions about that popup's contents.

A thrown exception is counted the same way. It used to bypass `report()`
altogether, which threw away both the tally and the browser diagnostics in exactly
the case where something crashed; now the top-level handler records
`the run finished without throwing` as a failure — so the exit code is non-zero
even for a throw after the last check — and goes through `report()`, which prints
the stack, every assertion that never ran, and the offscreen document's console.

### no sleeps

There is no fixed sleep standing in for synchronisation. The content script
builds its host lazily on the first hover, so there is nothing in the DOM to wait
for beforehand and a mouse move that lands before its listeners attach is simply
lost; `hoverForPopup()` therefore re-fires `mousemove` (stepping off the word and
back on, because `mousemove` needs a position change) until the popup is
actually visible. Bounded polls wait for observable DOM, storage, OPFS, CDP, or
alarm state. The scheduled-update cases create real near-future Chrome alarms
and wait for both package state and the global completed-check timestamp; the
`<img>` poll likewise stops at the first read that contains the media response.

### what the assertions are pinned to

Dictionary stylesheet installation moved from jsdom to four real-Chrome checks:
jsdom cannot exercise constructed stylesheets, CSS nesting, or `@scope`. The
production `applyDictionaryStyles` runs inside a shadow root with the production
reader stylesheet. Tests verify escaped canonical titles, malformed-brace
containment, nested formatting, duplicate suppression, and generation replacement.
Resource probes intercept and abort a reserved `.invalid` origin; direct and
escaped URLs, image-set strings, shorthand and escaped variables, comment-like
strings, and page-defined fonts/functions/registered properties must neither
apply a resource nor request it. Benign nested gradients and numeric variables
still render through the typed wrappers. A dictionary's own custom properties
drive lengths, colors and fallbacks, and a grammar-card disclosure keeps its
flex summary and block chevron; page-inherited and page-registered values under
the same names reach none of them.
The existing glossary card must contain fixed-position descendants and oversized
shadows without intercepting the reader control above it. The engine's exact
`hd_styles` response remains independently covered by the extension smoke suite.
Set `HACHIDORI_POPUP_SCREENSHOT` to an output PNG path to capture the ordinary
structured-content popup after its media reply, using the same complete run.

Media ownership checks delay a completed real offscreen/WASM media reply at
the service-worker relay while reimporting its package and loading the new
image. Releasing the old reply cannot replace or evict the current image.
A separately injected transient reply failure leaves the definition and a
readable alt/error label intact; another hover performs a fresh successful
fetch. `HACHIDORI_MEDIA_FAILURE_SCREENSHOT` captures that failure state, including
the 16-pixel image case that previously clipped its error text. These controlled
reply faults are correctness diagnostics, not image-latency measurements.
Another browser fixture renders two copies of twelve distinct images. Holding
completed native replies proves only four distinct requests dispatch at once;
hiding before release prevents the other eight obsolete jobs from dispatching.
A new hover reuses the four completed resources and loads the remaining eight,
with exact PNG URLs and decoded dimensions checked for all 24 image elements.

The image-preview fixture adds two genuine AVIF/SVG resources, with a second
use of the SVG below a long glossary to exercise keyboard-induced scrolling.
Chrome verifies exact sources and decoded dimensions, two native media requests
for all three inline images, larger preview bounds outside the card's paint
containment, viewport clamping, original-link keyboard focus, and reduced motion.
The focused preview survives Chrome scrolling its owner into view; hover scroll,
leave and blur close it. Holding a completed real navigation lookup verifies
dismissal before the reply and refuses reopening from the still-connected old
image. `HACHIDORI_IMAGE_PREVIEW_SCREENSHOT` captures the enlarged SVG in the
closed shadow root. `imagePreviewFixture()` keeps these resources separate from
the standard fixtures and their documented counts; its tiny AVIF was encoded
once with FFmpeg/libaom and carries its command/hash in the builder, so tests
need no encoder dependency.

The separate `imageSizingFixture()` imports one PNG used by 14 dimension cases.
Chrome checks exact decoded bytes, unchanged physical geometry for seven
ordinary/preferred/em cases, and bounded geometry for the tall-aspect and
floating-point edge cases. The one-pixel-wide tall case previously reached
roughly 33 million pixels high through raw CSS `aspect-ratio`; it must now use
the existing 10,000% sizer limit (100 pixels). The standard fixture counts and
archive admission rules remain unchanged.

- The popup's **structure**, not just its flattened text. `popupReader()` reports
  `tags`, `lists`, `tables` and `bold` (with the computed `font-weight`, since the
  fixture's bold span is bold through a style object), so the structured-content
  checks name a `ul` with its two `li`, a `table` with the `on`/`kun` rows, a bold
  `span` element and the `img`. A renderer that flattened everything into one text
  node passes every text-based `includes` — that was the old check, and the flatten
  is a two-character edit in `render/glossary.js`.
- The **extension's own** highlight, read back as
  `CSS.highlights.get(HIGHLIGHT_NAME).size` while a Japanese word is hovered and
  again after Escape. The name comes out of `extension/content.js` with a regex
  rather than being copied here, so a rename cannot leave the assertion pointing
  at a dead registry key. Asserting that `CSS.highlights` merely exists tests
  Chrome, not the extension, and passes with the extension uninstalled.
- "No popup for latin text" is **bracketed**: the popup is asserted to be on
  screen the moment before the pointer moves to `hello world`, and the same hover
  routine is asserted to produce a popup again afterwards. On its own that check
  passes against an extension whose hover is completely dead; bracketing keeps
  that negative check from going green by itself.
- `#import-file` is checked for `type="file"`, `multiple`, and an `accept` list
  containing `.zip`, not just for existing. The three-file selection must retain
  success, failure, and success outcomes in order and clear the picker afterwards.
- Reimport in that batch keeps the logical package's stable ID, position, alias,
  enabled/favourite state, and managed update source while clearing stale
  generation-bound check state. The Settings row then exposes its canonical
  title, alias, metadata, and all five capability badges, while the actual
  checkbox is used for both an enable and a
  disable commit.
- Stable IDs are checked against the two fixtures' exact title-derived values,
  not only against a hexadecimal shape, and the two IDs must differ.
- The favourite package's popup tab uses its alias while lookups and stored state
  continue to use the canonical dictionary title.
- The post-restart `hd_status` must report `dictionaryCount === 4`: every kind
  the combined fixture registers, while the deliberately disabled generic
  package stays disabled. `>= 1` also passes for a reload that lost frequency
  and pitch data and would then answer a bare lookup with no tags.
- The OPFS path is imported into a fresh generation, replaced by another fresh
  generation, and killed with `SIGKILL` after the old root is retired. The
  committed generation must be restored, queried again, and removed; removal
  clears settings rows, deletes its root, and turns the same query into a checked
  miss.
- The managed-update block counts both index and archive requests. **Check now**
  must touch both indexes and neither archive; Update all and alarm-triggered
  runs must replace the intended disabled package while preserving its stable
  identity and presentation. A revision mismatch must leave the exact OPFS path
  set unchanged and the engine ready before the service worker is restarted.
- The custom block checks that source is not read before its editor opens, has
  no arbitrary text-length cap, compiles through real WASM, and remains fixed
  first and enabled. Term and kanji Note appends must each publish a new
  generation, refresh the exact view, preserve Back context, and leave only the
  final committed generation before the custom package is removed.

Two things about reading the popup:

- Its shadow root is `mode: "closed"`, and puppeteer's `pierce/` selectors walk
  `element.shadowRoot` from injected script, which is `null` for a closed root.
  They find nothing. CDP's `DOM.getDocument` with `pierce: true` does report the
  closed root and its subtree, so `popupReader()` goes through a session.
- The headword is furigana ruby, so `textContent` interleaves the reading into the
  expression: 食べる with a た over 食 reads `食たべる`. `popupReader()` returns
  both that and a `plain` copy with the `<rt>` removed.

The offscreen document has a permanent CDP session on `Runtime`, because it has no
console anyone reads and a boot failure there is otherwise invisible: its
`consoleAPICalled` and `exceptionThrown` events go into the diagnostics the run
prints after a failure.

---

## `chrome-capture.mjs`

This separate browser test uses Chrome's real `getDisplayMedia()` path in the
extension's shared offscreen document. It serves a visible animated canvas,
changing Japanese DOM text, and a WebAudio tone. A muxed video/audio fixture
supplies the synchronization flash and beep. Chrome's test-only picker flag
selects that tab. The extension imports the real dictionary fixture,
starts capture through the visible controls, links the reading page, and tests:

- compressed frame history through the dedicated JPEG worker and sample-clocked
  audio history;
- full-rate capture while the reading/source tab is foreground, including
  closing and reopening Capture controls;
- recovery of the same recording and linked reader after service-worker restart;
- first-baseline fallback and later observed DOM timing;
- a real loopback plain-text WebSocket, texthooker priority, active state,
  disconnect, and reconnect epoch;
- a full ten-second moving-text export with roughly eighty decoded frames,
  matching AVIF/WAV durations, and responsive lookups during encoding;
- root pinning, bounded delivery drain, animated AVIF encoding, Chrome frame
  decoding and looping playback, non-silent mono WAV samples, and decoded
  flash/beep alignment within 125 ms;
- production Anki preflight, one-at-a-time media uploads, note mutation, and
  readback against a stock Kiku field fixture intercepted at the service-worker
  network boundary: its saved templates contain only `{screenshot}` and a blank
  `SentenceAudio`, a pin routes AVIF/WAV without uploading a JPEG, and an
  unpinned note still uploads the static page screenshot;
- settings-change confirmation, stop/clear behavior, no automatic rearming, and
  absence of raw text/media in extension storage;
- relinking enforcing one current reading document, and linked-page navigation
  clearing only that binding while capture continues;
- stopped-versus-recording dictionary latency, capture throughput, retained
  history, encoding latency, and output sizes.

```sh
HACHIDORI_CAPTURE_HEADFUL=1 xvfb-run -a node test/chrome-capture.mjs
HACHIDORI_CAPTURE_HEADFUL=1 HACHIDORI_CAPTURE_SUSTAINED_SECONDS=70 \
  xvfb-run -a node test/chrome-capture.mjs
HACHIDORI_CAPTURE_HEADFUL=1 HACHIDORI_CAPTURE_SUSTAINED_SECONDS=1800 \
  HACHIDORI_CAPTURE_ASSET_DIR=/tmp/hachidori-capture-assets \
  xvfb-run -a node test/chrome-capture.mjs
HACHIDORI_CAPTURE_HEADFUL=1 HACHIDORI_CAPTURE_FORCE_AUDIO_WORKLET=1 \
  xvfb-run -a node test/chrome-capture.mjs
```

The default measures five seconds of production throughput and then exercises
the full ten-second export and lifecycle checks. A sustained duration greater
than five seconds adds a soak with static, moving, and dense scenes in periods
of up to sixty seconds, an export and lookup measurement after each period,
and retention checks every ten seconds. Use at least seventy seconds to fill
the history; 1,800 seconds requests a thirty-minute soak. The final audio
history must cover 55–61 seconds, compressed frames must stay within 64 MiB,
and retained audio must stay within 61 × 48,000 samples. The duration accepts
finite values of at least five seconds and has no ninety-second ceiling.

The throughput and sustained-export gates use a foreground source tab. Lifecycle
checks temporarily open controls and restore source focus before comparing
capture rates. This keeps the presentation conditions consistent: a separate
controlled probe measured 7.99 fps in front, 6.49 fps behind controls, and
7.99 fps after restoring focus, with every delivered frame encoded. Background
capture remains supported, but the configured frame rate is a ceiling.

`capture-resources.mjs` measures the entire test browser, including the extension
and synthetic source/reader tabs. It samples Chrome process CPU and Linux RSS
each second and at phase boundaries. The initial process snapshot establishes
the CPU baseline; a process first observed later contributes its reported CPU
time from creation. A process that starts and exits between samples is missed.
Repeated capture-off, recording, export, soak, and stopped phases sum only
adjacent intervals in the same phase, excluding intervening phases.

The RSS sum counts shared pages in each process; it is neither unique physical
memory nor the encoder's WASM heap. `sampledPeakRssMiB` is the largest observed
RSS sum, not a continuous peak. On successful completion, the report prints
phase totals and, with an asset directory, saves scope, measurement limitations,
and underlying samples to `resources.json`. A stable ring byte count alone does
not establish stable total process memory. Full-export results separately
report the largest WASM heap size observed by encoder progress updates.

The alignment oracle decodes the final AVIF and finds the first frame where at
least 10% of pixels have every RGB channel at or above 240. The fixture's white
flash occupies at least 20% of the captured layout, allowing the video to sit
away from the canvas center. Its onset comes from the serialized AVIF sample
durations and is compared with the first WAV sample of absolute amplitude at
least 1,000. This checks the exported content against the unchanged 125 ms
bound, independently of delivery callbacks or file-duration equality.

The AudioWorklet command forces the compatibility audio path while retaining
timestamped video-track processing. It runs the same media and alignment gates.
These are test requirements, not a claim that every configuration has passed;
the [acceptance record](../docs/media-capture-review.md) records completed runs
and outstanding gates.

The real chooser path must run headfully. On Linux, Xvfb provides the display;
on a desktop host, omit `xvfb-run -a`. Set `HACHIDORI_CAPTURE_X11=1` to request
Chrome's X11 backend explicitly. A screenshot run can use:

```sh
HACHIDORI_CAPTURE_HEADFUL=1 \
HACHIDORI_MEDIA_SETTINGS_SCREENSHOT=docs/assets/media-capture-settings.png \
HACHIDORI_CAPTURE_SCREENSHOT=docs/assets/media-capture-controls.png \
xvfb-run -a node test/chrome-capture.mjs
```

The same external browser variables as `chrome-e2e.mjs` are accepted, plus
`HACHIDORI_FFMPEG` for the synchronization-fixture encoder and
`HACHIDORI_CAPTURE_PROFILE` to retain a dedicated test profile. With no
override, the temporary profile is removed after the run. Never point this at
a personal browser profile. `HACHIDORI_CAPTURE_ASSET_DIR` saves
`capture.avif`, `capture.wav`, the ten-second `full-capture.avif` /
`full-capture.wav`, and each period's `soak-<index>-<scene>.avif` / `.wav` for
independent playback checks.

The HTTP/WebSocket fixture uses an operating-system-assigned local port.
AnkiConnect requests to port 8765 are intercepted and answered inside this
browser; this test does not send note mutations to an installed Anki collection.

Two of those checks cover the mining screenshot. The first maps `{screenshot}`
into a field, adds a note from the real popup with a real double click, then
decodes the picture Anki received inside the page: it must be the whole viewport,
its samples across the area the popup occupied must be the page's own light
background, the page's dark text must still be somewhere in it, and every pixel
of the hovered word must be dark and neutral rather than carrying the reader's
coloured source highlight. Two installed dictionaries exercise real masonry
cards with explicit `visibility: visible`; the host's observed opacity becomes
`0 !important` for the capture, then restores its prior `0.9 !important` value.
The second makes AnkiConnect refuse the screenshot upload and requires
the note to be added anyway, with an empty picture field and the reason beside
its result. The suite prints `screenshot mining answered in N ms` for the timed
production path, and `HACHIDORI_ANKI_SETTINGS_SCREENSHOT` captures the Anki
settings section for the documentation.
Captured tab audio depends on Chrome and the host share implementation; the
test requires a real captured track and audible fixture samples.

### Application window and monitor checks

`chrome-capture-surfaces.mjs` is an optional Linux/X11 test using an isolated
Xvfb display, `ffplay`, `xdotool`, and `kwin_x11` on a private D-Bus session. It
starts a synthetic application window and tests window selection, reporting
unavailable source audio, resize delivery, minimize/restore, source closure,
monitor selection, and explicit Stop. Use a fresh display, never the personal
desktop; the script rejects `:0`.

```sh
xvfb-run -a sh -c 'HACHIDORI_CAPTURE_TEST_DISPLAY="$DISPLAY" node test/chrome-capture-surfaces.mjs'
```

It accepts `HACHIDORI_CHROME` and `HACHIDORI_PUPPETEER`, defaults to
`/usr/bin/chromium`, and retains `results.json` and temporary profiles under the
printed evidence directory. A passing X11 minimize/restore check does not prove
physical sleep/wake behavior or audio availability on other operating systems.

### Installed Anki Desktop relay

`anki-relay-desktop.py` is an optional check that the Hachidori Relay add-on
starts inside the installed Anki. Run it with the Python interpreter that can
import the installed `anki` and `aqt` packages:

```sh
python3 test/anki-relay-desktop.py
```

Each run creates a fresh temporary Anki base with only `extension/anki-relay/`
installed, configured through the add-on's `meta.json` to a test-only port
(18772, or `--port`), starts a separate Anki instance on it, and connects to
the relay over raw WebSockets: a `/host` handshake with an extension `Origin`
must answer 101 and the `listening` frame with the port; the host's `network`
frame must be answered with this machine's addresses, and a `/link` handshake
over the first of them must answer 101 and reach the host as `client-open`
with that address; a web `Origin` must be refused with 403. The live Anki
profile, its add-ons and AnkiConnect are never opened. It prints a JSON
summary, gives up after 90 s, and exits non-zero on failure.

### Installed Anki Desktop playback

`anki-capture-desktop.py` is an optional Linux check using the installed Anki
Python runtime, Qt WebEngine, Anki's media player, and `pactl` / `parecord`.
Generate assets with the browser harness above, then use the Python interpreter
that can import the installed `anki` and `aqt` packages:

```sh
/usr/bin/python test/anki-capture-desktop.py --assets /tmp/hachidori-capture-assets
/usr/bin/python test/anki-capture-desktop.py --assets /tmp/hachidori-capture-assets \
  --basename full-capture
/usr/bin/python test/anki-capture-desktop.py --assets /tmp/hachidori-capture-assets \
  --basename soak-0-static --static
```

Each run snapshots the input files and hashes, creates a fresh temporary Anki
base/profile and separate application instance, disables add-ons and sync, and
imports an actual note with AVIF and `[sound:...]` fields. The real reviewer
must render changing frames across a second animation loop, then play and
replay the WAV through Anki's media player. A private null sink and monitor
recording distinguishes nonzero source PCM from source silence.
Both playback durations must match the source within half a second. The
explicit `--static` mode instead requires the same rendered scene over at least
two source durations, with the same playback/replay checks. It permits small
lossy-codec differences from the first image: at most 1/255 root mean square
difference across RGB channels. Maximum, mean, and RMS differences are recorded;
the default moving-image assertions stay unchanged. Static rendering cannot
establish a loop boundary; the browser and real libavif tests establish the
static file's timed sequence and infinite repetition.
Only this test's sink is configured; the user's speaker routing is unchanged.

The reviewer blocks remote web requests while allowing Anki's local media
server. The harness never opens the live Anki profile or calls its AnkiConnect
endpoint. It retains version information, asset hashes, rendered samples,
reviewer screenshot, playback events, and recorded PCM under the printed
temporary directory. This establishes local Anki Desktop playback for those
assets and that runtime; it does not test AnkiWeb sync or another device/client.

---

## `chrome-fallback.mjs`

This loads a temporary extension manifest without cross-origin isolation, making
pthreads unavailable. It imports a Yomitan archive, saves custom source through
the production compiler and single-thread IDBFS bundle, closes Chrome, and
launches the same fallback build against the retained profile. Both launches
must report `storageBackend: "idbfs"` and `threaded: false`, return the expected
fixture and custom-dictionary lookups, restore the revisioned source and fixed
package, and leave OPFS empty. The fresh profile also starts the first-run
dictionary run inside the fallback engine; its four catalogue downloads are
answered 503 on the offscreen target so nothing reaches the network, the run
must record one failed outcome per source before the fixture import shares the
same engine lock, and the relaunch must neither reseed the setup record nor
request an archive again.

---

## `baseline.sh`

Builds the engine natively with `-DHOSHIDICTS_CLI=ON`, imports the same fixture
with `hoshidicts-cli`, and dumps the same word list. Output goes to
`test/tmp/baseline.txt`, with `runtime:` lines stripped and no absolute paths, so
it can be diffed run to run.

Two things it buys:

- The submodule's two Emscripten portability patches are `#ifdef __EMSCRIPTEN__`
  guarded. Building and running natively shows they did not change native
  behaviour.
- The wasm results get something independent to be compared against. The native
  import produces byte-identical `hash.table` (260), `bloom.filter` (32),
  `blobs.bin` (1307), `media.bin` (160) and `media.idx` (12), and the same
  glossaries, traces, frequencies and kanji stats that `node-smoke.mjs` asserts.

### compiler requirement

Older default toolchains such as Clang 15 or GCC 11 cannot build the engine. The
engine is C++23 (`std::ranges::to` and
`std::views::as_rvalue` in `src/query.cpp` and `src/lookup.cpp`, `std::format` in
`cli/main.cpp`) and `external/glaze` is v8. You need GCC ≥ 14, or clang ≥ 17 with
libc++ ≥ 17 / libstdc++ ≥ 14 headers.

The script does not hardcode a version test. It probes candidates in order with a
program that uses exactly the three gating features, and uses the first one that
compiles *and* runs:

```
g++-15  g++-14  gcc15-g++  gcc14-g++  g++  clang++-20  clang++-19  clang++-18  clang++
```

Override with `CXX=… CC=… ./test/baseline.sh`; an
explicitly set `$CXX` that fails the probe is a hard error rather than being
silently skipped.

Exit codes: `0` success, `1` build or run failure (the tail of
`test/tmp/{configure,build}.log` is printed), `3` no usable compiler — in which
case it explains what to install. Nothing else in the repo needs a native
compiler, so a `3` costs the native/wasm cross-check and nothing else;
`node-smoke.mjs` still covers the ABI in full.

---

## notes

- Every file in `test/fixtures/` is generated by `make-fixture.mjs`, so
  `.gitignore` ignores the whole directory.
- The fixture's Japanese is deliberately narrow: `食べる` (ichidan verb, the
  deinflection target), `読む` (godan, second frequency shape), `漢字` (structured
  content), `ありがとう` (kana-only), `食` (kanji bank). Adding entries means
  updating nothing by hand — `EXPECTED` is derived from the arrays — but it will
  change the counts printed above, and `baseline.sh`'s word list is a separate
  literal that has to be kept in step with `node-smoke.mjs`'s.
