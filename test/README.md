<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# test harness

Five pieces, run in this order. Everything up to step 3 is zero-dependency: node
built-ins, `/bin/sh`, cmake. Step 4 needs jsdom and step 5 needs Chrome plus
`puppeteer-core`, all three installed outside the repo — see the jsdom section
below and the `chrome-e2e.mjs` one.

```sh
cd /local/home/skerraut/hoshidicts-web

./wasm/build.sh                  # 1. produces extension/vendor/hoshidicts.{mjs,wasm}
node test/make-fixture.mjs       # 2. writes test/fixtures/
node test/node-smoke.mjs         # 3. the C ABI contract test
node test/extension-smoke.mjs    # 4. the extension's own JS against that wasm
node test/chrome-e2e.mjs         # 5. the extension in a real Chrome
./test/baseline.sh               # 6. optional native cross-check
```

Step 2 is optional on its own: `node-smoke.mjs` imports the generator and builds
the fixture bytes in memory, and also writes them to `test/fixtures/` as a side
effect so `baseline.sh` has files to work with. Run it alone when you want to
inspect the zip or hand it to another tool.

Everything either script writes goes to `test/fixtures/` and `test/tmp/`. Neither
touches `third_party/hoshidicts`; `baseline.sh` configures it out-of-tree and
fails if `git status` in the submodule comes back dirty.

---

## `make-fixture.mjs`

Generates `test/fixtures/hdw-fixture.zip`, a Yomitan format-3 dictionary,
`test/fixtures/hdw-fixture-trained.zip` (the same format with enough term rows to
push the importer over its zstd-training floor — see below), plus two deliberately
broken archives for the error-path tests. The ZIP container is
written by hand with `node:zlib` — the engine's reader only needs local file
headers, a central directory and raw deflate streams, and that is about 80 lines.

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

Two negative fixtures:

- `no-index.zip` — a valid archive with no `index.json`.
- `not-a-zip.txt` — plain text, so the EOCD scan has to bottom out.

`buildTitledZip(title, {banks})` builds a third kind on the fly, in memory: the
same `index.json` with the title replaced, optionally with no term bank so the
import fails *after* the importer has read the title and derived a directory from
it. That is the only moment a title can do damage, so it is what the import
staging checks are driven with.

Exports `EXPECTED` (the import counts, derived from the bank arrays rather than
hardcoded) and `EXPECTED_GLOSSARIES` (the exact raw glossary strings, keyed by
`termKey(expression, reading)`). `node-smoke.mjs` asserts against those, so
editing a bank cannot silently desync the expectation.

### fixture counts

`hdw_import` on `hdw-fixture.zip` must report exactly:

```
title           hdw-fixture
termCount       5
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

`hdw-fixture.zip` has five term rows, deliberately under that floor, so it stays
the migration case; `TRAINING_SAMPLE_FLOOR` pins that, and `node-smoke.mjs` fails
loudly if `TERMS` grows past it instead of silently retiring the coverage.
`hdw-fixture-trained.zip` (`buildTrainedZip()`, 49 rows with deliberately
repetitive glossaries so the training has structure to find) is the other side.
Both markers are then loaded together, from one query object, because that is the
state of a profile after an engine upgrade.

`dict.zstd` is the one file whose absence nothing downstream can report:
`query.cpp` builds a `ZSTD_DDict` out of whatever it finds there, an absent or
truncated file yields an empty one, and then every glossary in the dictionary
decompresses to `""` while `add_dict` reports success. So
`dictionary_files_present()` in `wasm/bindings.cpp` requires a non-empty
`dict.zstd` whenever the marker is `_4`, and refuses the directory otherwise —
asserted in both directions in `node-smoke.mjs`.

`index.json`'s size varies with `importDate`, which is a wall-clock millisecond
timestamp; the rest is deterministic. If the counts above change, check whether a
bank was edited before assuming a regression — `node-smoke.mjs` prints the actual
report and the expected counts on every run.

---

## `node-smoke.mjs`

The real test. Loads `extension/vendor/hoshidicts.mjs`, mounts plain MEMFS (not
IDBFS — that needs a browser IndexedDB), and drives the frozen C ABI end to end.
73 checks, one shared module instance, ordered by dependency. Exits 0 on success,
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
   kana-only entry; reading-only query reaching the kanji headword; katakana
   input costing a preprocessor step; and two misses. Glossaries are asserted
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
9. **Both on-disk layouts, side by side.** The 5-row fixture lands in the pre-4
   layout and the 49-row one trains a zstd dictionary, so `.hoshidicts_3` with no
   `dict.zstd` and `.hoshidicts_4` with one are both imported, both loaded — at
   the same time, from one query object, which is the state of a profile after an
   engine upgrade — and both asserted through a real lookup whose glossary bytes
   only come back if the dictionary the importer trained was found. Then the other
   direction: a `_4` directory whose `dict.zstd` is missing or zero-length must be
   *refused* by `add_dict`, because loading it succeeds and returns an empty
   glossary for every term.

Two behaviours worth knowing, both asserted so they cannot drift silently:

- The `hdw_lookup` failure fallback is the literal
  `{"results":[],"dictionaryCount":0}`, so `dictionaryCount` reads 0 even when
  dictionaries are loaded. Do not treat it as a dictionary count.
- `hdw_media` returning 0 for a path or dictionary that is simply absent leaves
  `hdw_last_error` **empty**. Only a null argument sets an error. Callers must
  distinguish "no such media" from "failed" by something other than the error
  string.

---

## `extension-smoke.mjs`

The layer above the ABI. Loads the real `background.js`, `offscreen.js` and
`render/*.js` against the real `extension/vendor/hoshidicts.wasm` and drives one
full request→reply round trip per contract-C message type. 68 checks, all of
which have to run: the renderer stage needs jsdom and **failing to load jsdom is
a failure, not a skip** (see below). Exits 0 on success, 1 on assertion failure,
2 when the wasm module or the fixtures are missing.

The fakes cover only the Chrome surface the extension actually touches:

| fake | why |
| --- | --- |
| message bus | models the two rules `background.js` depends on — `sendMessage` never delivers to the sender, and an extension context never reaches a content script. That is what makes the `relayed: true` guard testable. |
| `chrome.storage.local` | in-memory, with `onChanged`, so the reconcile path and the `settings.js` ↔ `background.js` sharing of the `dictionaries` key are real. Given to the worker and the settings page only: an offscreen document has no storage. |
| `indexedDB` | one object store keyed by path plus a `timestamp` index, which is all Emscripten's IDBFS uses. Enough to prove `FS.syncfs(false)` actually wrote something. |
| `fetch` | serves `blob:` URLs out of a map (the import path) and `chrome-extension://` URLs off disk (`render/reader.css`) |

Each script gets its own `chrome` object. `background.js` and the render modules
have no `import` statements, so they run in a `node:vm` context; `offscreen.js` is
a real ES module and reads the shared global, which is the one wired to the bus as
`"offscreen"`.

What it proves, in order:

0. **Option ranges.** `scanLength` and `maxResults` are clamped in four separate
   places (`settings.html`, `settings.js`, `content.js`, `offscreen.js`) and a
   narrower bound in the content script silently shrinks the result set the
   options page accepted and stored. `content.js` needs a page and is not loaded
   here, so this one check is static: it greps the four literals and fails if they
   disagree.
1. **Boot and relay.** `hd_status` has exactly the eight documented envelope
   keys, echoes its `requestId`, and reaches `ready`. `createDocument` runs once
   and never concurrently. `background.js` stamps `relayed` on its forwarded copy
   and senders never do.
2. **Storage ownership and import.** The offscreen document's fake `chrome` has
   `runtime` only, as a real one does, so a storage call from `offscreen.js` fails
   here the way it fails in Chrome; a static check backs that up for the paths
   this file does not exercise, and `hd_dicts_read` is answered by the worker
   without ever being relayed. Then `hd_import` of `hdw-fixture.zip` succeeds,
   `hd_import_result` carries all nine `ImportReport` fields, the counts match the
   baseline above, `chrome.storage.local.dictionaries` gets one schema-D row per
   kind the archive carries, and IndexedDB is non-empty afterwards.
3. **Every read path** with the fixture registered under all four kinds:
   `hd_lookup` (payload keys, deinflection trace, glossary still a raw string,
   frequencies, pitches), `hd_kanji` (including the string `onyomi`/`kunyomi`/
   `tags` of contract B and the `null` for a miss), `hd_styles`, `hd_media` (a
   `data:` URL matching the pattern `glossary.js` accepts, and `null` for an
   absent path).
4. **A no-match lookup still reports the real `dictionaryCount`.** `content.js`
   renders "no dictionaries imported" on 0, and 0 is also what the engine's error
   fallback returns, so `offscreen.js` reads `hdw_last_error` after every
   string-returning call and fails the request rather than forwarding an
   ambiguous empty.
5. **Error paths.** An unknown type is answered as `<type>_result` with
   `ok: false` rather than dropped; a non-zip import fails with a report attached
   and leaves the previously loaded set intact; an import with no blob URL is
   rejected rather than thrown.
6. **The renderer against the engine's own bytes.** This is the check that a
   hand-written payload cannot make: the actual `hd_lookup` / `hd_kanji` /
   `hd_styles` / `hd_media` replies go into the real `createPopupView`, and the
   headword, the parsed structured content, the `data-hoshidicts-dictionary`
   attribute `@scope` keys off, the frequency tags, the `<img>` resolved through
   `resolveMedia`, `applyDictionaryStyles` into a shadow root, and `renderKanji`
   are all asserted on the resulting DOM. `glossary` is the whole glossary *array*
   of one term-bank row, so each of its elements must land in its own
   `li.gloss-item` — appending them into one parent runs two senses together with
   no separator, which is asserted against the fixture's own two-sense entry.
7. **`hd_remove`** — directory gone, storage row gone, nothing loaded, and
   removing an unknown title does not bump `generation`. Plus the failure case,
   through an injected `chrome.storage.local.set` rejection: `hd_remove` unloads
   every dictionary before it deletes anything, so if a later step throws it has
   to reload what survived, or every tab reports no dictionaries until the user
   next edits a row.
8. **A trained (`.hoshidicts_4`) dictionary through the extension layer.**
   Everything above imports the 5-row fixture, which is under the zstd training
   floor, so nothing outside `node-smoke.mjs` had ever seen the layout the current
   engine writes for a real dictionary. `buildTrainedZip()` goes through
   `hd_import`, and then: `listImported()` has to recognise the directory by its
   marker (a `MARKER_FILES` in `offscreen.js` that does not name `.hoshidicts_4`
   makes `reconcile()` drop the row it just wrote, and `dictionaryCount` is 0), the
   IndexedDB the fake stands in for has to have both the marker and `dict.zstd`
   keyed under it — those are the files IDBFS repopulates from after a restart —
   and `hd_lookup` has to hand back the glossary bytes, which only decompress if
   `dict.zstd` was found and loaded.

### jsdom

Step 6 needs jsdom. It is not a repo dependency — it lives in the same
out-of-repo tree as `puppeteer-core`, so a checkout carries neither:

```sh
cd /home/skerraut/.cache/hdw-e2e && npm install jsdom
```

That path is the built-in default, so on this machine `node
test/extension-smoke.mjs` finds it with no environment at all. Elsewhere, point
`HDW_JSDOM` at the directory above a `node_modules` that has jsdom in it, or
`NODE_PATH` at the `node_modules` itself:

```sh
HDW_JSDOM=/path/to/tree node test/extension-smoke.mjs
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

The only test that runs the extension in a browser. Chrome and `puppeteer-core`
live outside the repo so a checkout does not carry a 290 MB browser; override with
`HDW_CHROME`, `HDW_PUPPETEER` and `HDW_PROFILE`, and the run aborts with a message
naming the variable if either is missing.

It launches Chrome with `--load-extension`, imports the fixture through the real
`#import-file` input on `settings.html`, hovers real text with a real mouse on a
page served over `http://127.0.0.1` (content scripts do not run on
`chrome-extension://`, `about:blank`, or `file://` without a per-extension
opt-in), then relaunches against the same profile and hovers again with no
re-import — which is the only test that can prove IDBFS persistence at all.

### the profile

`/tmp/hdw-e2e-profile-<pid>` unless `HDW_PROFILE` says otherwise, and the path is
printed at the top of the run. Per-pid because two runs sharing one profile
deadlock over the extension's leveldb: the second Chrome cannot open
`chrome.storage.local` at all and every read comes back
`IO error: …/LOCK … (ChromeMethodBFE: 15::LockFile::1)`, which surfaces as a
pass-2 failure that reads exactly like an IDBFS regression. Two concurrent runs
are now fine. A green run deletes its profile; a failing one keeps it and says so,
because the profile is the only place the imported dictionary can be examined
afterwards.

`HDW_PROFILE` is never deleted, and never created over something that is already
there either: pass 1 has to import the fixture into a clean profile or the restart
check proves nothing, so a non-empty `HDW_PROFILE` is a hard error naming the
directory rather than an `rmSync` of whatever the reader pointed the variable at.

### the denominator is fixed

`PLANNED` at the top of the file names all 27 assertions, and the summary line
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

There is no `setTimeout` standing in for synchronisation. The content script
builds its host lazily on the first hover, so there is nothing in the DOM to wait
for beforehand and a mouse move that lands before its listeners attach is simply
lost; `hoverForPopup()` therefore re-fires `mousemove` (stepping off the word and
back on, because `mousemove` needs a position change) until the popup is
actually visible. The only remaining `setTimeout`s are the polls inside
`waitForVisible`/`waitForHidden` and the one that re-reads the popup while
`hd_media` is still answering — the `<img>` can arrive a beat after the glossary
text it sits in, so that loop stops at the first read that has it.

### what the assertions are pinned to

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
  passes against an extension whose hover is completely dead — with a broken
  `mousemove` registration this file reports 13/27, and the negative check is one
  of the ones still green.
- `#import-file` is checked for `type="file"` and an `accept` list containing
  `.zip`, not just for existing.
- The post-restart `hd_status` must report `dictionaryCount === 4`, one per kind
  the fixture registers. `>= 1` also passes for a reload that lost the frequency
  and pitch dictionaries and would then answer a bare lookup with no tags.

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

This host's default toolchain cannot build the engine. `/usr/bin/clang++` is 15
and `/usr/bin/g++` is 11.5; the engine is C++23 (`std::ranges::to` and
`std::views::as_rvalue` in `src/query.cpp` and `src/lookup.cpp`, `std::format` in
`cli/main.cpp`) and `external/glaze` is v8. You need GCC ≥ 14, or clang ≥ 17 with
libc++ ≥ 17 / libstdc++ ≥ 14 headers.

The script does not hardcode a version test. It probes candidates in order with a
program that uses exactly the three gating features, and uses the first one that
compiles *and* runs:

```
g++-15  g++-14  gcc15-g++  gcc14-g++  g++  clang++-20  clang++-19  clang++-18  clang++
```

On this machine that resolves to `/usr/bin/gcc14-g++` (GCC 14.2.1), which builds
clean with no warnings. Override with `CXX=… CC=… ./test/baseline.sh`; an
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
