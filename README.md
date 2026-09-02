# hoshidicts-web

A Chrome extension that runs the [hoshidicts](https://github.com/Manhhao/hoshidicts)
dictionary engine as WebAssembly, entirely in your browser. Import Yomitan `.zip`
dictionaries, hover Japanese text on any page, get a definition.

No native helper, no local server, no network calls. The engine, your dictionaries and
every lookup stay inside the browser.

## Scope

Two features, on purpose:

- **Import** Yomitan `.zip` dictionaries from the settings page.
- **Look up** by hovering text on any page.

Deliberately absent: Anki mining, audio, texthooker integration, and Firefox support.

## How it works

```
content script (any page)          service worker            offscreen document
  hover -> scan text       --->  ensure offscreen exists --> hoshidicts.wasm
  popup in shadow DOM      <---      relay reply         <-- MEMFS + IDBFS at /dicts
                                     owns chrome.storage       ^
  settings.html  -- blob: URL of the picked .zip ---------------
```

The engine lives in an **offscreen document**, which is the only extension context that
both persists across service-worker restarts and can compile WebAssembly. A service worker
dies after ~30 s idle, which would mean reloading every dictionary on each lookup; a
content script cannot compile wasm at all, because the host page's CSP applies.

Offscreen documents are granted `chrome.runtime` and nothing else — no `chrome.storage`.
So the service worker owns configuration and messages it in. This is not a stylistic
choice; reading `chrome.storage.local` from the offscreen document silently kills the
engine at boot.

Dictionaries persist through Emscripten's **IDBFS** mounted at `/dicts`: `FS.syncfs(false)`
after an import, `FS.syncfs(true)` at boot. Imported dictionaries are memory-mapped by the
engine exactly as they are natively.

The zip never travels over `chrome.runtime.sendMessage`, which JSON-serialises its payload.
The settings page creates a `blob:` URL and the offscreen document `fetch`es it — same
`chrome-extension://` origin, so a 50 MB archive costs one copy instead of a
50-million-element JSON array.

## Install

Requires Chrome 118 or newer (`@scope`, used by dictionary-supplied CSS).

```sh
git clone --recurse-submodules https://github.com/bee-san/hoshidicts-web
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
`extension/` directory.

`extension/vendor/hoshidicts.{mjs,wasm}` is committed, so loading it unpacked needs no
build step.

Open the extension's options page, import a Yomitan `.zip`, and hover some Japanese.

A large dictionary takes a while to import and the settings page must stay open while it
runs — closing it revokes the `blob:` URL out from under the import.

## Building the WebAssembly yourself

Needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html) (developed
against 6.0.9) and CMake.

```sh
. ./wasm/env.sh && ./wasm/build.sh
```

`wasm/env.sh` sources `emsdk_env.sh` and puts a Python ≥ 3.10 on `PATH` first — emsdk's
launchers reject older interpreters, and some distributions still ship 3.9 as `python3`.

The build compiles the engine and `wasm/bindings.cpp` with `-fwasm-exceptions` and no
pthreads, then copies the output into `extension/vendor/`. Single-threaded is what lets
this avoid `SharedArrayBuffer`, and therefore the COOP/COEP manifest keys.

`wasm/bindings.cpp` uses the engine's C++ API directly rather than its C FFI, and
serialises results with [glaze](https://github.com/stephenberry/glaze) into the same JSON
shape GameSentenceMiner's overlay already speaks — which is what lets the ported renderer
work unchanged.

## Tests

```sh
node test/make-fixture.mjs      # synthesise Yomitan dictionaries covering every rendered shape
node test/node-smoke.mjs        # 73 checks: the engine under node -- import, lookup, contract, error paths
node test/extension-smoke.mjs   # 68 checks: extension logic against a stubbed chrome and DOM
node test/chrome-e2e.mjs        # 27 checks: the real thing, in a real Chrome
./test/baseline.sh              # native build, to prove the engine patches changed nothing
```

See [`test/README.md`](test/README.md) for what each one proves and what it cannot.

`chrome-e2e.mjs` needs a Chrome binary and `puppeteer-core`; point `HDW_CHROME` and
`HDW_PUPPETEER` at them. `extension-smoke.mjs` needs `jsdom`, via `HDW_JSDOM` or
`NODE_PATH`. Install both outside the repo so a checkout does not carry a browser.

The browser test is the only one that can prove Chrome accepts the manifest, that the CSP
permits compiling the wasm, that a real `caretRangeFromPoint` hover renders a popup, and
that dictionaries survive a browser restart. Everything else runs against fakes, and fakes
are how the worst bug in this project's history hid: the offscreen document's stub `chrome`
had a `storage` that the real one does not.

Two things the harness does deliberately, both learned the hard way:

- **The check count is fixed up front.** A check that never runs is a failure, not a
  smaller denominator — "14/15 passed" reads like success and is how a regression hides.
- **Each assertion has been watched fail.** They were broken on purpose, one at a time, to
  confirm they can go red. An assertion nobody has seen fail is not known to work; one of
  the original checks turned out to be incapable of failing at all.

The popup lives in a **closed** shadow root, which `pierce/` selectors cannot enter — the
harness reads it through a CDP `DOM.getDocument({pierce: true})` session instead.

## Engine changes

`third_party/hoshidicts` tracks the [`wasm`
branch](https://github.com/bee-san/hoshidicts/tree/wasm), which is upstream `main` plus two
portability fixes. Neither changes native behaviour, and both are upstreamable:

- **`importer.cpp`** spawned threads via `std::async(std::launch::async)`. An Emscripten
  build without `-pthread` stubs `pthread_create` to return `EAGAIN`, so libc++ throws
  and every import fails. Every future in that file is waited on before its result is
  read, so `std::launch::deferred` is equivalent there.
- **`memory.cpp`** closed the file descriptor immediately after `mmap`. That is fine on
  POSIX, but Emscripten flushes `MAP_SHARED` writes *through* the descriptor at
  `msync`/`munmap`, so `hash::linear::build_to_file` and `hash::bloom::build_to_file`
  silently produced zeroed files — the import still reported success, and every subsequent
  lookup found nothing. Worse, a recycled descriptor number would have written into an
  unrelated file. The descriptor now lives in `mapped_file` and is closed by `unmap()`.

`test/node-smoke.mjs` asserts `hash.table` and `bloom.filter` come out non-empty, which is
the regression test for the second one.

Only import dictionaries you trust. An imported dictionary's directory name comes from the
`title` inside the archive, so `wasm/bindings.cpp` validates that title and stages the
import in a scratch directory before the engine sees it.

## Attribution

The popup renderer, structured-content renderer, furigana segmentation and CSS are ported
from [GameSentenceMiner PR #549](https://github.com/bpwhelan/GameSentenceMiner/pull/549),
which in turn adapts [Hoshi Reader](https://github.com/Manhhao/Hoshi-Reader) and
[Yomitan](https://github.com/yomidevs/yomitan). See
[`extension/render/ATTRIBUTION.md`](extension/render/ATTRIBUTION.md).

The dictionary engine is [hoshidicts](https://github.com/Manhhao/hoshidicts) by Manhhao.

## License

GPL-3.0-or-later, matching hoshidicts and the ported GameSentenceMiner code. See
[`LICENSE`](LICENSE).
