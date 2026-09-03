# Architecture

Hachidori is a Manifest V3 Chrome extension with a native C++ dictionary engine compiled to WebAssembly. Extension pages send typed runtime messages; the service worker routes them to an offscreen document whose lifetime is independent of service-worker idling.

## Runtime layout

```text
web page
  └─ content.js
       ├─ scans Japanese text near the pointer
       └─ renders popup.html in an isolated iframe

settings.html / content.js
  └─ chrome.runtime.sendMessage
       └─ background.js (MV3 service worker)
            ├─ owns chrome.storage.local dictionary metadata
            ├─ creates or reconnects to offscreen.html
            └─ relays requests without holding engine state
                 └─ offscreen.js
                      ├─ probes pthread, shared-memory, and direct-OPFS support
                      ├─ primary: engine-worker.js
                      │    └─ pthread Wasm + WasmFS direct OPFS
                      └─ fallback: engine-service.js
                           └─ single-thread Wasm + IDBFS
```

The service worker can be terminated after an idle period without discarding loaded dictionaries. A later request recreates the routing context while the offscreen engine remains authoritative. Runtime requests carry explicit IDs, generations, and result message types so stale or malformed replies fail closed.

## Primary engine path

On supported Chrome builds, `offscreen.js` starts a dedicated module worker after proving all three capabilities:

- `crossOriginIsolated` and shared `WebAssembly.Memory`;
- module workers;
- a synchronous access handle from the origin-private file system.

`engine-worker.js` loads the pthread WebAssembly build. WasmFS mounts direct OPFS at `/dicts`, so the C++ engine reads its generated indexes without copying them through IndexedDB or the JavaScript heap. The extension manifest supplies the cross-origin isolation policy required by shared Wasm memory and exposes the generated pthread worker asset.

The worker serializes engine mutations and bounds pending requests. Imports reject concurrent work with a busy response rather than letting lookup and dictionary replacement race. The offscreen bridge also bounds its queue and preserves a last-known status response while an import occupies the engine worker.

## Compatibility path

If shared Wasm memory, workers, or direct OPFS are unavailable, `offscreen.js` loads the single-thread WebAssembly module locally. That build mounts IDBFS at `/dicts`, restores it before opening dictionaries, and synchronizes generated files after a successful import.

The fallback is intentionally explicit: `hd_status` reports `threaded: false` and `storageBackend: "idbfs"`. The production benchmark rejects fallback execution when it is measuring the primary Hachidori path.

## Import transaction

Dictionary import follows one logical transaction:

1. `settings.html` receives the ZIP through its real file input and sends `hd_import`.
2. The service worker transfers the archive to the offscreen document.
3. The engine worker imports Yomitan banks through the Hoshidicts C++ importer.
4. Generated files are written under a temporary dictionary path.
5. The old path is moved aside, the completed path is promoted, and recovery markers guard interrupted swaps.
6. Dictionary metadata is committed through a compare-and-set message handled by the service worker.
7. The engine reloads enabled dictionaries and replies with the import report and new generation.
8. The settings page renders success only after that reply.

Startup recovery resolves any interrupted replacement before dictionary discovery. The archive input is not stored after a successful import; only generated indexes and extension metadata remain.

## Storage ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Generated dictionary indexes | engine worker or fallback engine | direct OPFS or IDBFS under `/dicts` |
| Dictionary title, path, kind, order, enabled state | service worker | `chrome.storage.local` key `dictionaries` |
| Scan length, result limit, modifier, delay, frequency ordering | extension pages | `chrome.storage.local` key `options` |

The offscreen document deliberately has no direct `chrome.storage` access. It asks the service worker to read or compare-and-set dictionary metadata. Those writes are serialized so a settings-page edit cannot be silently overwritten by a stale engine write.

## Runtime messages

| Message | Purpose |
| --- | --- |
| `hd_import` | Import one Yomitan ZIP and return an exact report |
| `hd_lookup` | Run a bounded scan/deinflection lookup |
| `hd_status` | Report readiness, loading state, dictionary count, generation, storage backend, and threading mode |
| `hd_reload` | Reload enabled dictionaries from persisted metadata |
| `hd_dicts_read` | Read dictionary metadata through the service worker |
| `hd_dicts_write` | Compare-and-set dictionary metadata through the service worker |

## Build outputs

`wasm/build.sh` produces two runtime variants from the same bindings:

- `extension/vendor/hoshidicts-threaded.mjs` and `hoshidicts-threaded.wasm` for pthread WasmFS/direct OPFS;
- `extension/vendor/hoshidicts.mjs` and `hoshidicts.wasm` for single-thread IDBFS.

`HACHIDORI_PTHREADS` selects the CMake variant. `HACHIDORI_WASM_VARIANT=fallback` selects the fallback artifact in the Node smoke test.

## Test boundaries

The zero-dependency Node suite checks imports, deinflection, normalized kana lookup, media extraction, malformed input, fallback persistence, thread-bridge transfer behavior, extension packaging, and generated runtime assets. Chrome E2E tests exercise both the threaded direct-OPFS path and the forced compatibility path, including restart durability, service-worker idling, bounded concurrency, and transactional replacement recovery.

The browser benchmark records import-to-first-valid-lookup, steady lookup, full-process restoration, process-tree resources, exact storage manifests, and input/runtime hashes. The cross-engine benchmark adds production-path adapters for Yomitan and JL under one rotating schedule; see [Benchmarks](benchmarks.md).
