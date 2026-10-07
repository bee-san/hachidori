# Custom dictionary append root-cause analysis

## Result

A custom append recompiles and reimports the complete custom dictionary. Its cost
therefore grows with the number of existing entries. The baseline diagnosis was
only partly correct about lookup behavior: lookups do not wait in the engine
promise queue and then complete. The offscreen router rejects them immediately
with `engine-mutating` for the full mutation window. If that admission gate were
removed alone, the engine's shared `serialise()` queue would put the lookups
behind the append. In addition, the import transaction unloads the currently
loaded generation before importing, so merely making lookup message types
unqueued would be unsafe.

The user-visible result is the same: no successful term, selected-dictionary, or
kanji lookup is possible until the append's full rebuild, durable import, commit,
and reload have completed.

## Baseline evidence

The measurement used Node 22.23.1, Chrome for Testing 152.0.7977.75, and commit
`a018e1b11b6ec10c27bd43bce0ece36dead33621` on Linux. Each size ran in a fresh
Chrome profile through the unpacked MV3 extension, service worker, offscreen
document, production threaded WASM/OPFS engine, `hd_custom_save`, and
`hd_custom_append`. One warmup was excluded, followed by five measured appends.
Every append reply was checked for success, a new document revision,
`rebuilt: true`, and a successful lookup of the new entry after commit. The raw
JSONL evidence, including the excluded warmups, is attached to the task as
`custom-append-baseline-raw.jsonl`.

| Existing entries | Measured append wall times (ms) | Median (ms) | Range (ms) |
| ---: | --- | ---: | ---: |
| 0 | 50.030, 43.435, 44.795, 44.320, 43.320 | 44.320 | 43.320–50.030 |
| 100 | 56.035, 52.320, 53.105, 52.105, 53.020 | 53.020 | 52.105–56.035 |
| 1,000 | 75.715, 69.610, 77.020, 71.860, 72.370 | 72.370 | 69.610–77.020 |
| 10,000 | 196.790, 200.645, 197.740, 188.100, 192.500 | 196.790 | 188.100–200.645 |

The 10,000-entry median is 4.4 times the empty-dictionary median. The fixed
startup, routing, persistence, and reload costs make the relationship nonzero at
N=0, while the growing parse, hash, ZIP-build, and native-import work establishes
the expected O(N) component.

For every measured append, three lookups were submitted only after `hd_status`
reported `loading: true`. All 60 lookup attempts failed with
`errorCode: "engine-mutating"` and `error: "the dictionary engine is busy
mutating"`; none returned dictionary results. Rejection itself was fast (pooled
median 2.21 ms), but lookup availability did not return until the append ended.
The unavailable interval is therefore the append wall time shown above, rather
than a lookup request whose recorded latency equals that wall time. This
correction matters to the implementation contract and benchmark assertion.

The source fixture was deterministic (`基準NNNNN, きじゅんNNNNN, benchmark
definition NNNNN`), and each measured append added one distinct entry. Timings
are a focused baseline on one host, not a cross-host throughput claim.

## Code path

1. `extension/engine-service.js:2143-2150` implements `hd_custom_append`. It
   enters the mutation path, reads the latest custom source, appends one row with
   `appendCustomDictionaryEntry`, and calls `saveCustomDictionary`.
2. `extension/engine-service.js:1750-1768` reparses the complete source with
   `parseCustomDictionary`, computes `customDictionarySemanticRevision` over all
   parsed entries, checks the semantic no-op case, and calls
   `buildCustomDictionaryZip` for the complete entry list.
3. `extension/custom-dictionary.js:157-184` parses the source document;
   `extension/custom-dictionary.js:206-215` normalizes and hashes the ordered
   entry set; `extension/custom-dictionary.js:298-337` builds all term banks and
   the complete deterministic Yomitan ZIP.
4. `extension/engine-service.js:1771-1784` passes that archive to
   `runImportTransaction`. `extension/engine-service.js:1538-1590` creates a new
   generation, calls `hdw_reset`, imports the archive, persists the filesystem,
   and invokes the commit. `extension/engine-service.js:1707-1747` strict-loads
   the candidate dictionary set, publishes the revision-checked source and
   dictionary state, publishes the loaded generation, and cleans up the old
   generation.

There are two independent lookup blockers:

- `extension/offscreen.js:297-305` rejects every request except release/cancel
  operations while a mutation is active. That is the blocker observed by the
  browser baseline.
- `extension/engine-service.js:215-231` defines the single `tail` promise chain.
  `extension/engine-service.js:80` exempts only `hd_status`,
  `hd_backup_release`, and staged `hd_import`; `extension/engine-service.js:2044-2095`
  defines `hd_lookup`, `hd_lookup_dictionary`, and `hd_kanji`; and
  `extension/engine-service.js:2439-2443` sends every non-exempt handler through
  `serialise()`. Thus, after relaxing the offscreen admission gate, those lookup
  handlers would still wait behind `hd_custom_append`.

Finally, `runImportTransaction` calls `hdw_reset` before import at
`extension/engine-service.js:1545-1549`. Its adjacent invariant explains that
loaded dictionaries share the importer's 32-bit address space. The last
committed generation is therefore not available to this engine during import.
Adding lookup types to `UNQUEUED` without changing this ownership boundary could
race native engine mutation and cannot satisfy the intended behavior.

## Fix levers and risk

### A. Keep lookups available during custom compilation and import

This is the largest felt win and the required behavior. `hd_lookup`,
`hd_lookup_dictionary`, and `hd_kanji` must continue using the last fully
committed loaded generation while custom compilation/import runs. The change
must address all three boundaries above: offscreen admission, engine queueing,
and the native engine reset/shared-address-space lifetime. Relaxing only
`offscreen.js` or only `UNQUEUED` is incorrect.

The smallest safe design must isolate staging import state from the serving
engine (or otherwise preserve a read-only committed engine until candidate
commit), then atomically replace the serving generation only after persistence,
CAS publication, and strict load succeed. Mutation requests must remain ordered.
Risk is high because naive concurrency introduces native races, excess WASM
memory, or a window with no loaded dictionaries. Tests must prove successful
lookups during import, unchanged generation/results before commit, and adoption
of the new generation only after commit.

### B. Reduce append work

Coalescing rapid appends can amortize repeated O(N) work, and an incremental
compiler/import API could remove the whole-dictionary rebuild. Neither is a
requirement for the asynchronous UX fix. Debouncing changes durability and
failure timing; coalescing must preserve append order and per-request outcomes.
Incremental import is substantially broader because the current native ABI,
semantic revision, deterministic archive, generation publication, and rollback
model all describe a complete dictionary.

Risk ranges from medium for carefully ordered coalescing to high for incremental
native mutation. The O(N) import duration may remain informational after lever A
lands.

### C. Acknowledge the popup before durable commit

An optimistic UI can return control after accepting an ordered mutation while
completion continues in the background. It must not report durable success
before the transaction succeeds. Background failure must surface through the
existing status/error path, and a later append must still read the logically
latest ordered source rather than bypass document revision, CAS, stale-save, or
lost-reply protections.

Risk is medium to high: the current response carries the committed document and
dictionary state, and the Note flow uses that response to distinguish append
success from refresh failure. Splitting acceptance from completion requires an
explicit pending/failure lifecycle. Lever A avoids that protocol change and is
preferable unless serving/import isolation alone cannot return control promptly.

## Design contract unblocked by this RCA

The performance acceptance criterion should be successful lookup latency while a
large custom append is in progress, not completion time of the import itself.
Lookups must read only the last fully committed loaded generation. They may begin
seeing the added entry after the candidate generation is durably persisted,
revision-checked, strict-loaded, and atomically published. No design may expose a
partially imported generation, weaken mutation ordering or CAS/stale-save
protection, or translate a background failure into success.
