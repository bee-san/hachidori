# Custom dictionary append performance contract

## Scope and baseline

This contract defines the behavior shared by the lookup-unblocking and
append-lifecycle changes. The baseline and root-cause analysis were measured at
`a018e1b11b6ec10c27bd43bce0ece36dead33621` with Node 22.23.1 and Chrome for
Testing 152.0.7977.75. Each dictionary size used a fresh Chrome profile, one
excluded warmup, and five measured appends through the unpacked MV3 extension,
offscreen document, production threaded WASM/OPFS engine, `hd_custom_save`, and
`hd_custom_append`.

The measured append medians were 44.320 ms at 0 existing entries, 53.020 ms at
100, 72.370 ms at 1,000, and 196.790 ms at 10,000. The worst measured
10,000-entry append was 200.645 ms. Every one of the 60 lookups submitted after
`hd_status.loading` became true was rejected with `engine-mutating`; successful
lookup availability did not return until the append completed. The detailed
samples and source-path analysis are recorded in `CUSTOM-APPEND-RCA.md` and the
baseline raw JSONL retained with that benchmark task.

## Target behavior

Clicking **Add definition** may begin an asynchronous mutation. While the full
custom dictionary is rebuilt, imported, persisted, and committed, the user must
be able to continue term, selected-dictionary, and kanji lookups against the
last fully committed loaded generation. `hd_lookup`, `hd_lookup_dictionary`, and
`hd_kanji` must neither receive `engine-mutating` solely because a custom append
is in progress nor wait behind that append's mutation queue entry.

For this contract, an append is **accepted** only when the offscreen service has
validated the request and placed it in its live ordered mutation queue. That is
not a durable-success acknowledgement. The popup must label it pending until
the existing durable result arrives. Closing or losing the offscreen service
may terminate a pending operation; after restart it is not reported as success
unless the committed source/state readback proves it landed.

The acceptance bar on the baseline host and workload is:

- all lookup requests issued during each measured 10,000-entry append succeed
  with a generation-consistent response;
- the worst lookup-during-append round trip is at most **20 ms**, less than
  one-tenth of the baseline's 200.645 ms worst unavailable interval; and
- the first lookup sent after the harness observes both the accepted/pending
  state and `hd_status.loading: true` completes within the same **20 ms**
  request-to-reply bound, independent of whether the background append has
  committed.

The 20 ms threshold is a user-visible availability threshold, not a claim that
ordinary lookup execution is constant-time for every dictionary corpus or
machine. The convergence benchmark compares the same host, browser, fixture,
request mix, and concurrency as the baseline.

The append's rebuild/import runtime may remain O(N) and is reported separately
as informational evidence. Eliminating that O(N) work, adding an incremental
native import ABI, or making durable completion constant-time is not an
acceptance requirement. If the popup acknowledges acceptance before durable
completion, it must present that per-request pending state rather than success.
Durable success may be reported only after the transaction commits. Failure or
offscreen termination removes the pending state and remains observable through
the existing status/error path; a later popup instance must be able to read
that outcome rather than depending only on the lifetime of the original reply.

## Correctness contract

A lookup during an append reads one fully loaded committed generation. It may
see the pre-append generation. It may begin seeing the added word only after the
candidate generation has been persisted, revision-checked, strict-loaded, and
published. It must never observe an empty, partially imported, staged, or mixed
generation.

The asynchronous behavior does not alter the transaction contract:

- the fixed-ID managed custom package remains enabled, first, unique, and
  protected from ordinary import/removal;
- a semantic source change and dictionary state commit together in one
  revision-checked storage write;
- a stale Settings save is refused;
- a Note append reads the latest source only after entering the mutation queue;
- mutations remain ordered, including concurrent appends and Settings saves;
- a lost CAS reply is resolved by reading back the exact expected source/state
  pair before success, failure, or generation deletion is decided;
- the committed candidate is strict-loaded before publication;
- the superseded generation is cleaned only after successful publication; and
- failure restores or retains the last committed loaded generation and is not
  translated into append success.

After a successful durable commit, a subsequent lookup eventually reflects the
added word. Rapid appends must preserve source order and duplicates and must not
lose an entry reported durably successful, create a second managed package, or
publish more than one current generation. A pending entry may be terminated,
but it must never be silently promoted to success or omitted from a successful
coalesced result. Existing custom-dictionary, transaction, stale-save, and
CAS/lost-reply tests must remain green.

## Split of work

### FIX-A: lookup availability and generation isolation

FIX-A owns the read-serving boundary:

- offscreen admission for `hd_lookup`, `hd_lookup_dictionary`, and `hd_kanji`
  during a custom mutation;
- dispatch/queue classification for those read-only handlers in
  `extension/engine-service.js`; and
- the serving/import engine or generation-swap mechanism needed to keep the
  last committed generation readable while the candidate is rebuilt and
  imported.

Adding lookup types to `UNQUEUED` or relaxing the offscreen mutation gate alone
is not sufficient: the current import transaction resets the shared native
engine before import. FIX-A must keep reads on a committed serving engine and
make the handoff atomic. It must not change custom source construction, storage
CAS semantics, append acknowledgement, coalescing, or the order of
`saveCustomDictionary` mutations.

### FIX-B: append acceptance and optional work amortization

FIX-B owns only the append-facing lifecycle:

- the point at which the popup regains control after an append is accepted;
- pending, durable-success, and background-failure reporting through the
  existing status/error flow; and
- if a focused implementation is justified, coalescing adjacent queued appends
  before `saveCustomDictionary` performs a full rebuild. Each request must keep
  an individually queryable pending, durable-success, or failure outcome across
  popup teardown and service-worker restart for as long as the offscreen engine
  remains alive.

FIX-B must not add incremental native import, replace the transaction protocol,
or make removal of the underlying O(N) rebuild/import a requirement. It must not
change lookup admission, read-handler queue classification, serving-engine
ownership, or the atomic generation swap owned by FIX-A. If coalescing is used,
every request keeps an honest pending/failure outcome, source order, latest
in-queue source read, and the same stale-save/CAS guarantees. If those outcomes
cannot be preserved with a small focused change, FIX-B must not coalesce. If
FIX-A alone restores lookup availability without an early popup acknowledgement,
FIX-B should make no protocol change merely to shorten the reported append
duration; the user-visible return-to-lookup metric, not durable import runtime,
is the required result.

### Shared touch-points and landing rule

`extension/engine-service.js` is shared by file, not by ownership:

- FIX-A owns `UNQUEUED`/dispatch, lookup handlers, read-serving state, and the
  import-to-serving handoff inside `runImportTransaction`.
- FIX-B owns `hd_custom_append`, append completion/status reporting, and only the
  invocation/orchestration immediately around `saveCustomDictionary`.
- FIX-A may edit `runImportTransaction` and the loading helpers only to isolate
  candidate import from the committed serving engine. The ordering semantics of
  `saveCustomDictionary`, `commitCustomGeneration`, storage CAS, strict load,
  rollback, and cleanup remain unchanged. FIX-A lands first; FIX-B rebases and
  does not rewrite FIX-A's queue, transaction, or generation-isolation lines.

Each change gets one focused regression test in the existing closest suite.
FIX-A's test holds a custom import open and proves a lookup returns promptly from
the committed generation. FIX-B's test proves its acceptance/pending/failure
semantics and, only if implemented, that a burst preserves all entries and
commits one consistent managed generation. Neither change duplicates the
other's test.

## Convergence verification

The convergence card must run the merged result, not either branch in
isolation, through the exact production browser harness used for the baseline:

1. Use the same deterministic source fixture and existing-entry sizes 0, 100,
   1,000, and 10,000 in fresh Chrome profiles.
2. For every size, exclude one declared warmup and retain five measured appends.
3. After the accepted/pending signal and `hd_status.loading` prove the append is
   in flight, submit one `hd_lookup`, one `hd_lookup_dictionary`, and one
   `hd_kanji` concurrently with every append. Each measured lookup must finish
   before that append's durable completion timestamp; otherwise the sample
   fails the overlap requirement and is retained as a failure, not retried away.
4. Retain every append boundary, acceptance boundary, lookup start/end,
   response, generation, commit boundary, correctness result, and warmup flag
   as raw JSONL. Do not omit rejected, failed, or slow attempts.
5. Record `lookupSentAt` immediately before `chrome.runtime.sendMessage` and
   `lookupRepliedAt` when its promise settles on the same page monotonic clock.
   `lookupRepliedAt - lookupSentAt` is both the lookup-during-append latency and,
   for the first request after pending/loading, the return-to-lookup latency.
   Require every such lookup to succeed and the worst retained 10,000-entry
   value for each message type to be at most 20 ms.
6. Before each append, record the ready status generation and correctness
   signatures for the three requests. Every lookup that replies before the
   append's durable completion must carry that generation and match those
   signatures. After durable completion, require a newer committed generation,
   unchanged signatures for the old requests, and a successful lookup of the
   added word. This is the generation-consistency oracle; timing alone is not.
7. Verify the fixed-ID
   package remains enabled and first with no duplicate, the source contains
   every accepted append in order, and only the committed generation is
   current. Inject the existing transaction/CAS failure cases and require the
   prior committed generation to remain usable while failure is surfaced. These
   injected failure cases are correctness tests; their lookup timings are
   retained but are not included in the 20 ms performance gate.
8. Report append/import duration by size, including whether it still scales
   with N, but do not fail the change for O(N) background runtime.

Run the repository's complete JavaScript test command on the merged revision in
addition to the focused custom-dictionary, transaction, and CAS tests. All tests
must pass. Publish the exact commands, revision, Node and Chrome versions, raw
evidence, excluded warmups, sample counts, full-concurrency schedule, and
computed worst-case values so the threshold can be independently recomputed.
