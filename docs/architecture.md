# Hachidori architecture

Hachidori is the browser extension and user interface. [hoshidicts](https://github.com/Manhhao/hoshidicts) remains the name of the upstream dictionary engine and the bundled `hoshidicts.{mjs,wasm}` module.

## Runtime design

```text
content script (any page)          service worker            offscreen document
  hover -> scan text       --->  ensure offscreen exists --> hoshidicts.wasm
  popup in shadow DOM      <---      relay reply         <-- MEMFS + IDBFS at /dicts
                                     owns chrome.storage       ^
  settings.html  -- blob: URL of the picked .zip ---------------
```

The engine lives in an **offscreen document**, the only extension context that both persists across service-worker restarts and can compile WebAssembly. A service worker dies after roughly 30 seconds idle, which would require every dictionary to reload on the next lookup. A content script cannot compile the module because the host page's Content Security Policy applies.

Offscreen documents receive `chrome.runtime` but not `chrome.storage`. The service worker therefore owns configuration and sends it to the offscreen document. Reading `chrome.storage.local` from the offscreen document prevents the engine from booting.

Dictionaries persist through Emscripten's **IDBFS** mounted at `/dicts`: `FS.syncfs(false)` runs after an import and `FS.syncfs(true)` at boot. The engine memory-maps the imported dictionaries just as it does natively.

The archive itself never crosses `chrome.runtime.sendMessage`, which JSON-serializes its payload. The settings page creates a `blob:` URL and the offscreen document fetches it from the same `chrome-extension://` origin. A 50 MB archive therefore costs one copy instead of becoming a 50-million-element JSON array.

## Building the WebAssembly module

The build needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html) and CMake. It was developed against Emscripten 6.0.9.

```sh
git clone --recurse-submodules https://github.com/bee-san/hachidori.git
cd hachidori
. ./wasm/env.sh && ./wasm/build.sh
```

`wasm/env.sh` sources `emsdk_env.sh` and puts Python 3.10 or newer first on `PATH`, because emsdk's launchers reject older interpreters.

The build compiles hoshidicts and `wasm/bindings.cpp` with `-fwasm-exceptions` and without pthreads, then copies the output into `extension/vendor/`. The single-threaded build avoids `SharedArrayBuffer` and the corresponding COOP/COEP manifest requirements.

The binding uses the engine's C++ API directly and serializes results with [glaze](https://github.com/stephenberry/glaze) into the JSON shape expected by the ported renderer.

## Engine portability changes

`third_party/hoshidicts` tracks the [`wasm` branch](https://github.com/bee-san/hoshidicts/tree/wasm), which is upstream `main` plus two portability fixes. Neither changes native behavior.

### Deferred imports

`importer.cpp` spawned threads through `std::async(std::launch::async)`. An Emscripten build without `-pthread` stubs `pthread_create` to return `EAGAIN`, so libc++ throws and every import fails. Each future in that file is awaited before its result is read, making `std::launch::deferred` equivalent there.

### Memory-mapped file lifetime

`memory.cpp` closed a file descriptor immediately after `mmap`. That is valid on POSIX, but Emscripten flushes `MAP_SHARED` writes through the descriptor during `msync` or `munmap`. As a result, `hash::linear::build_to_file` and `hash::bloom::build_to_file` silently produced zeroed files even though the import reported success. A recycled descriptor number could also write into an unrelated file.

The descriptor now lives in `mapped_file` and is closed by `unmap()`. `test/node-smoke.mjs` verifies that `hash.table` and `bloom.filter` are non-empty and contain real data.

## Import boundary

An imported dictionary's directory name comes from the `title` in its archive. `wasm/bindings.cpp` validates that title and stages the import in a scratch directory before the engine sees it. Only import dictionaries you trust: their content, media, and CSS are supplied by the archive.

## Further reading

The [test harness guide](../test/README.md) documents the ABI contract, IndexedDB persistence checks, renderer coverage, browser restart test, and native baseline in detail.
