<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Hachidori test harness

Twelve pieces, run in this order. The JavaScript checks use Node built-ins except
`extension-smoke.mjs`, which needs jsdom. The browser checks need Chrome and
`puppeteer-core`; those dependencies stay outside the repository.

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
node test/chrome-fallback.mjs    # 11. capability fallback through IDBFS in real Chrome
./test/baseline.sh               # 12. optional native cross-check
```

Step 4 is optional on its own: `node-smoke.mjs` imports the generator and builds
the fixture bytes in memory, and also writes them to `test/fixtures/` as a side
effect so `baseline.sh` has files to work with. Run it alone when you want to
inspect the zip or hand it to another tool.

Everything either script writes goes to `test/fixtures/` and `test/tmp/`. Neither
touches `third_party/hoshidicts`; `baseline.sh` configures it out-of-tree and
fails if `git status` in the submodule comes back dirty.

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
used when tests intercept the four recommendation URLs; it does not contact the
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
116 checks, ordered by dependency. Exits 0 on success,
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
full request→reply round trip per contract-C message type. 349 checks, all of
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
2. **Boot and relay.** `hd_status` has exactly the ten documented envelope
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
   and removing an unknown title does not bump `generation`. Removal strict-loads
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

### jsdom

The renderer integration stage needs jsdom. It is not a repo dependency — it lives in the same
out-of-repo tree as `puppeteer-core`, so a checkout carries neither:

```sh
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$CACHE_ROOT/hachidori-e2e"
cd "$CACHE_ROOT/hachidori-e2e"
npm install jsdom puppeteer-core
./node_modules/.bin/browsers install chrome@stable --path "$CACHE_ROOT/hachidori-browsers"
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

```sh
node test/chrome-e2e.mjs
```

The primary-path test runs 114 predeclared checks in a browser. Chrome and `puppeteer-core`
live outside the repo so a checkout does not carry a browser. The setup command
above installs Chrome for Testing in the default cache; the harness also checks
`CHROME_BIN` and common system locations. Override with `HACHIDORI_CHROME`,
`HACHIDORI_PUPPETEER`, and `HACHIDORI_PROFILE`; the run aborts with a message
naming the variable if either is missing.

It launches Chrome with `--load-extension`, intercepts the four production
recommendation URLs with deterministic ZIP fixtures, proves failure continuation,
trusted source metadata, reload/restart hiding, and missing-only retry, then clears those
fixtures. It next uses the real `#import-file` on `settings.html` for a valid
archive and a three-file batch containing a term-only kanji dictionary, a
malformed ZIP, and a same-title reimport. It verifies the ordered per-file
outcomes and failure continuation, exercises filtered bulk management, a real
pointer drag, keyboard position movement, capability-aware chooser migration,
and clicked-kanji navigation, and hovers real
text with a real mouse on a page served over `http://127.0.0.1` (content scripts do not run on
`chrome-extension://`, `about:blank`, or `file://` without a per-extension
opt-in), then relaunches against the same profile and hovers again with no
re-import — which is the only test that proves direct OPFS persistence through a
full Chrome restart.

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

Settings layout checks cover library-first task order, selection-aware bulk
actions, native keyboard section and skip links, Back/Forward, same-hash focus,
short-window sidebar scrolling, and mounted source drafts. All six views are
checked at 320px and desktop widths in light and dark mode, including palette
text/control contrast and visible-control overflow. Empty live regions stay
available for their first announcement. The extension harness pins hidden-view
save failures, unseen completions, draft retention without extra requests, and
stable-ID Details expansion/focus across rerenders and filtering.
Two real Settings pages exercise debounced option patches with one held reply:
a newer external commit cannot be rolled back, and a stale queued draft surfaces
a conflict with explicit discard. Revisioned options also survive the full
browser restart. The extension harness covers no-op revisions, atomic selector
pruning, failed-save retry, first-input draft ownership, and old/repeated content
storage events. `HACHIDORI_OPTIONS_SCREENSHOT` captures the saved Lookup section.

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
cards, without changing the generated fixture files. Four Chrome checks project
every contributing dictionary, aggregate favourites and ordered groups from the
complete native result; warmed tab changes must issue no lookup, media or style
requests. Linked-child, clicked-kanji and Back retain their semantic selection.
Back also restores an expanded, scrolled child with a collapsed dictionary card,
its prior tab, highlight and toolbar, without another native lookup; its next
Back still closes the child. Extension checks cover native-source fallback and
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
Nested open-shadow editors suppress native activation typing and pending scans;
visibility-restored descendants are treated as visible even inside a hidden editor.
The extension suite separately holds replies through selection cancellation,
retry and storage invalidation; checks exact Note/Back/internal-link descriptors;
and pins same-candidate pending lookup deduplication.
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

`PLANNED` at the top of the file names all 114 assertions, and the summary line
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

Dictionary stylesheet installation moved from jsdom to three real-Chrome checks:
jsdom cannot exercise constructed stylesheets, CSS nesting, or `@scope`. The
production `applyDictionaryStyles` runs inside a shadow root with the production
reader stylesheet. Tests verify escaped canonical titles, malformed-brace
containment, nested formatting, duplicate suppression, and generation replacement.
Resource probes intercept and abort a reserved `.invalid` origin; direct and
escaped URLs, image-set strings, shorthand and escaped variables, comment-like
strings, and page-defined fonts/functions/registered properties must neither
apply a resource nor request it. Benign nested gradients and numeric variables
still render through the typed wrappers.
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

## `chrome-fallback.mjs`

This loads a temporary extension manifest without cross-origin isolation, making
pthreads unavailable. It imports a Yomitan archive, saves custom source through
the production compiler and single-thread IDBFS bundle, closes Chrome, and
launches the same fallback build against the retained profile. Both launches
must report `storageBackend: "idbfs"` and `threaded: false`, return the expected
fixture and custom-dictionary lookups, restore the revisioned source and fixed
package, and leave OPFS empty.

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
