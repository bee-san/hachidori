# Architecture

Hachidori is a Manifest V3 Chrome extension with a native C++ dictionary engine compiled to WebAssembly. Extension pages send typed runtime messages; the service worker routes them to an offscreen document whose lifetime is independent of service-worker idling.

## Runtime layout

```text
web page
  └─ content.js
       ├─ scans Japanese text near the pointer
       ├─ renders popup.html in an isolated iframe
       └─ appends popup Note entries to the managed custom source

settings.html / content.js
  └─ chrome.runtime.sendMessage
       └─ background.js (MV3 service worker)
            ├─ owns chrome.storage.local dictionary metadata
            ├─ atomically owns the revisioned custom source document
            ├─ checks managed update indexes and owns one periodic alarm
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

The worker serializes engine mutations and bounds pending requests. Imports,
reimports, managed replacements, custom saves and Note appends, removals, and
reloads cannot race each other.
The offscreen bridge also bounds its queue and preserves a last-known status
response while a mutation occupies the engine worker.

## Compatibility path

If shared Wasm memory, workers, or direct OPFS are unavailable, `offscreen.js` loads the single-thread WebAssembly module locally. That build mounts IDBFS at `/dicts`, restores it before opening dictionaries, and synchronizes generated files after a successful import.

The fallback is intentionally explicit: `hd_status` reports `threaded: false` and `storageBackend: "idbfs"`. The production benchmark rejects fallback execution when it is measuring the primary Hachidori path.

## Import transaction

Each dictionary import follows one logical transaction:

1. `settings.html` takes the next local ZIP, or downloads the next missing entry from the built-in recommendation catalogue, and sends `hd_import`.
2. The service worker transfers the archive to the offscreen document.
3. The engine worker imports Yomitan banks through the Hoshidicts C++ importer into a fresh `/dicts/.hdw-generation-<UUID>/<title>` root. A committed root is never overwritten in place.
4. The generated files are flushed to the storage backend before metadata can reference them.
5. The candidate's exact manifest path is strict-loaded, including disabled packages, before the service worker compare-and-set commits it.
6. Only a confirmed commit publishes the new dictionary count and generation.
7. The engine re-reads authoritative state before garbage-collecting unreferenced generation roots.
8. The settings page renders success only after that reply.

Multiple selected archives remain separate transactions. The settings page runs
them sequentially, keeps an outcome for each file, continues after a failed
archive, and refreshes dictionary state and engine status once after the batch.
Recommended downloads use that same sequence. Settings passes only the frozen
catalogue ID and the response's final URL; before committing the candidate, the
engine resolves the ID itself and validates the final URL, title, update index,
revision, and defining capability. Only then does the package gain its optional
`sourceId` and catalogue-owned update URLs.

If a compare-and-set result is unknown because both the commit reply and its readback fail, both the previous and candidate roots are retained. Revisioned manifest paths are authoritative on restart: the engine strict-loads those paths and removes unreferenced generations rather than adopting them from disk. The IDBFS startup path also resolves imports left by the older `.hdw-import` protocol. The archive input itself is not retained.

Removal first strict-loads the remaining manifest, then commits it, publishes the
new state, and finally garbage-collects the removed generation. The
`/dicts/.hdw-remove` handling remains only for recovery of dictionaries stranded
by the older removal protocol, including a legacy dictionary whose real title
was `.hdw-remove`.

## Managed update cycle

The service worker derives managed candidates from `dictionaryState`, including
disabled packages. Recommended candidates use the source pinned in the built-in
catalogue; generic candidates need complete credential-free HTTPS index and
archive descriptors. These trust and schedule rules live in one native ES
module shared by the worker, engine, and Settings page.

**Check now** fetches each candidate's index and records `up-to-date`,
`update-available`, or `check-failed` against that package generation. It does
not download archives. There is one global Off/hourly/daily/weekly/monthly
setting and one Chrome alarm. An alarm runs the same checks and automatically
installs available revisions, including revisions for disabled packages.

An install carries the checked package ID, generation path, installed revision,
source descriptor, check time, expected remote revision, and selected archive
URL into the engine mutation queue. Recommended archives remain
catalogue-pinned; a generic index may select a different credential-free HTTPS
archive URL. The engine validates the response's final URL and generated index,
then revalidates the complete fingerprint at the commit snapshot. The fresh
generation and its `up-to-date` status are published in the same package CAS;
an ordinary reimport clears generation-bound check state. A stale check or
failure status is applied only while its captured fingerprint still matches.

The background storage queue is not held while the offscreen engine downloads,
imports, or commits. Presentation-only edits may advance state during that work,
so the engine cleans generations against the latest authoritative package paths
after publication. A title collision, changed fingerprint, wrong archive
revision, or failed import leaves the working generation loaded and reports the
failure without publishing the candidate.

## Settings interface

Settings is one document with native section links: the installed library comes
first, followed by import, updates, groups, custom source, and lookup preferences.
The navigation becomes a wrapping link list in narrow windows; it does not need
a router or duplicate views. Dictionary rows keep their stable controls across
the existing focus-aware rerenders. Bulk actions appear when a selection exists,
including selections outside the current search. Source editing remains lazy,
and lookup preferences apply immediately; custom source still requires Save.

Reader options carry a worker-owned monotonic `revision` in the existing
`options` storage value. Legacy values start at revision zero. Settings coalesces
control changes for 150 ms and sends only edited fields with their base revision;
one request is in flight at a time. The background storage queue compare-and-sets
that patch against current options. No-op patches keep their revision, while
dictionary-selector pruning increments it in the same dictionary commit.

Settings keeps committed, in-flight, and pending values separate. Storage events
and replies adopt only higher committed revisions without replacing a draft, and
numeric editing captures its base before a later blur. Conflicts and failed
saves retain the draft for explicit retry or discard; a failed reply triggers a
current-state read before retry is offered. Content scripts use the same
highest-revision rule, including a delayed initial storage read. Options never
trigger a native dictionary reload.

## Managed custom dictionary

`custom-dictionary.js` is a context-independent ES module shared by Settings,
the service worker, and both engine runtimes. It parses the first two commas of
each nonblank, non-comment line, preserves ordered duplicates, reports every
malformed line, and implements the inverse escaping rules for definition
newlines and literal backslashes. It also builds a deterministic Yomitan
format-3 ZIP with UTF-8 entries, classic ZIP CRC/offset metadata, and 1,000-row
term-bank chunks. The normal Hoshidicts importer consumes that production ZIP;
there is no separate test-only or in-memory dictionary backend.

The source document is stored separately with a monotonic document revision and
an ordered-entry semantic hash. Settings loads it only when the editor opens. A
typing burst defers full-source validation until 150 ms of inactivity; dirty
state updates immediately, and Save cancels the preview and validates the exact
submitted source. Unchanged diagnostics retain their DOM nodes. A stale editor
save is refused, while a popup Note append enters the engine
mutation queue before reading the latest source. A semantic no-op skips
compilation only when the committed fixed-ID package and generation still match
every invariant; otherwise the same source repairs the package. No valid rows
atomically saves the source and removes the generated package.

Compilation stages and strict-loads a fresh generation, then the service worker
compare-and-sets the exact source document and dictionary state in one storage
write. The commit binds the source hash and valid-row count to the fixed package,
which is protected by a non-title-derived ID, canonical title, enabled state,
and first position. Presentation-only conflicts are retried against current
state without merging a stale source revision. A lost reply is accepted only
after an exact source/state-pair readback.

The term and kanji popup views share one fixed Note form, constructed only when
opened so ordinary lookups do not build hidden editor controls. Its prefill comes from
the currently projected primary result, and a successful append refreshes only
the exact still-current request descriptor and page anchor. Dictionary storage
events adopt only newer revisions; editing defers popup invalidation until close
or until that exact refresh consumes it. Saving is the transactional boundary,
so a later best-effort lookup failure cannot make the already-appended row
retryable.

## Storage ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Generated dictionary indexes | engine worker or fallback engine | direct OPFS or IDBFS under `/dicts` |
| Revisioned logical-package inventory, order, presentation, capabilities, source metadata, and global dictionary groups | service worker | `chrome.storage.local` key `dictionaryState` |
| Revisioned custom-dictionary source text and semantic hash | service worker | `chrome.storage.local` key `customDictionarySource` |
| Global managed-update schedule and last completed check time | service worker | `chrome.storage.local` key `dictionaryUpdates` |
| Scan length, result limit, modifier, delay, frequency ordering, and dictionary selectors | service worker writes; extension pages read | `chrome.storage.local` key `options` |

The offscreen document deliberately has no direct `chrome.storage` access. It asks the service worker to read or compare-and-set dictionary metadata. Those writes are serialized so a settings-page edit cannot be silently overwritten by a stale engine write. Dictionary-state commits prune removed package IDs from global groups and invalid selectors in the same storage transaction, and every Settings option write is revalidated there so a stale page cannot restore them.

Dictionary-group normalization and controls live in `dictionary-groups.js`; the
Settings entrypoint owns imports, package management, and the shared commit
queue. Groups remain in `dictionaryState` so package removal and membership
pruning are one compare-and-set transaction rather than two coordinated writes.

## Runtime messages

| Message | Purpose |
| --- | --- |
| `hd_import` | Import one Yomitan ZIP and return an exact report; optionally validate a built-in catalogue source in the same transaction |
| `hd_apply_state` | Load an engine-affecting package change, then compare-and-set it atomically |
| `hd_lookup` | Run a bounded scan/deinflection lookup |
| `hd_status` | Report readiness, loading state, dictionary count, generation, storage backend, and threading mode |
| `hd_reload` | Reload enabled dictionaries from persisted metadata |
| `hd_remove` | Stage a package's files, commit its removal, then delete the staged copy |
| `hd_state_read` | Read revisioned dictionary state through the service worker |
| `hd_state_cas` | Compare-and-set revisioned dictionary state through the service worker |
| `hd_options_write` | Compare-and-set an edited-field options patch using `baseRevision`; prune invalid dictionary selectors and return the current revisioned options on success or conflict |
| `hd_custom_read` | Read the revisioned custom source and matching dictionary state |
| `hd_custom_cas` | Atomically compare-and-set the source document and bound package state |
| `hd_custom_save` | Parse and save Settings source, compiling or repairing its fixed package when needed |
| `hd_custom_append` | Append one validated popup Note entry to the latest queued source and compile it |
| `hd_updates_schedule` | Save the one global update interval and reconcile its Chrome alarm |
| `hd_updates_check` | Check every managed index and persist per-package availability without downloading |
| `hd_updates_install` | Recheck and install the requested available managed packages |

## Build outputs

`wasm/build.sh` produces two runtime variants from the same bindings:

- `extension/vendor/hoshidicts-threaded.mjs` and `hoshidicts-threaded.wasm` for pthread WasmFS/direct OPFS;
- `extension/vendor/hoshidicts.mjs` and `hoshidicts.wasm` for single-thread IDBFS.

`HACHIDORI_PTHREADS` selects the CMake variant. `HACHIDORI_WASM_VARIANT=fallback` selects the fallback artifact in the Node smoke test.

## Test boundaries

The zero-dependency Node suite checks imports, custom parsing and deterministic
ZIP compilation, deinflection, normalized kana lookup, media extraction,
malformed input, fallback persistence, thread-bridge transfer behavior,
extension packaging, and generated runtime assets. Chrome E2E tests exercise
both the threaded direct-OPFS path and the forced compatibility path, including
custom source compilation and restart durability, service-worker idling,
bounded concurrency, and transactional replacement recovery.

The browser benchmark records import-to-first-valid-lookup, steady lookup, full-process restoration, process-tree resources, exact storage manifests, and input/runtime hashes. The cross-engine benchmark adds production-path adapters for Yomitan and JL under one rotating schedule; see [Benchmarks](../benchmark/README.md).
