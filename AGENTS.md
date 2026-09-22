# AGENTS.md

These instructions apply to the entire repository.

## Working agreement

- Deliver every repository change through a pull request from a dedicated branch. Never push changes directly to `main`. Do not stop at a local commit or branch: push it and open the pull request.
- Keep each pull request to one coherent outcome that can be understood, tested, and reviewed independently.
- Commit frequently in small, coherent units. Prefer a failing focused contract test followed promptly by its implementation commit when test-first work is practical.
- Prefer the smallest straightforward change that satisfies the request and fits the existing architecture.
- Prefer established, maintained libraries for standard functionality over implementing it from scratch; check existing dependencies first and keep custom code focused on application-specific integration.
- Do not mix requested work with drive-by refactors, renames, formatting churn, dependency updates, or unrelated cleanup.
- Deduplicate an invariant or algorithm when two runtime contexts genuinely need the same behavior; do not introduce a framework for a one-off.
- Read `CONTRIBUTING.md` and the relevant architecture or test documentation before changing an unfamiliar area.

## Scope, tests, and guards

- Implement the requested behavior rather than hypothetical adjacent requirements.
- Do not add speculative abstractions, fallbacks, compatibility layers, validation, resource limits, or safety guards. A new guard should address an explicit requirement, a reproducible failure, or a documented invariant, and its reason should be clear in the pull request.
- Dictionary archives are user-selected local inputs. Do not invent fixed limits for archive bytes, entry counts, expanded size, or compression ratios unless the task explicitly requires them. Preserve existing path and import-staging correctness boundaries.
- Do not add broad or extensive test coverage by default. Add a focused regression test when behavior changes or a bug needs to stay fixed; do not duplicate coverage already provided by a suitable suite.
- Avoid adding test-only dependencies or expanding fixtures unless the changed behavior genuinely needs them.

## Issue #9 scope and phases

- D1-D9 and E1-E27 are delivered. The user's subsequent request, "work on l2 to l5", authorizes L2 backup/restore, L3 per-dictionary update schedules, L4 lookup/corpus-seen statistics, and L5 definition blur as the current phase. Deliver them in focused pull requests preserving the completed dictionary and reader behavior, using GSM PR #549 as the reference.
- L2 (#62), L3 (#63) and L4 (#65) are merged; L5 is #67. When asked to "do L1-L5", the user confirmed L2-L5 only: L1 profiles stay excluded.
- The dictionary-only contract below limits dictionary-only tasks; it does not prohibit separately authorized E-series or L2-L5 work. L3 intentionally extends D6's original global-only schedule; L5 depends on L4. L1 profiles and L6 configurable/custom popup actions remain excluded, as does localization.

## Dictionary-only issue #9 contract

When implementing the dictionary-only scope from issue #9:

- For a dictionary-only task, D1-D9 are the complete scope. Do not pull E-series or Later features into that task; E-series work requires its own explicit authorization as recorded above.
- The issue owner's later comment overrides the original D6 prose: a scheduled update run checks and automatically installs available updates. Manual Check now still records availability without installing.
- Keep one global update schedule: Off, hourly, daily, weekly, or monthly. Do not add per-dictionary policy, hidden profiles, alternate backends, or due-time machinery.
- Preserve stable package IDs, canonical-title engine keys, order, alias, enabled/favourite state, groups, and trusted source metadata across reimports and updates. A package with several bank kinds remains one package.
- Use the exact five recommended sources: the four named by D2 plus Bee's Ultimate Grammar Dictionary, added on the issue owner's request. Install them sequentially, skip installed sources, continue after a failure, and retry only missing sources. Store catalogue metadata only after final-URL, repository, title, revision, index, and defining-capability validation.
- Keep shared catalogue/source trust rules in one native ES module used by every context that enforces them. Recommended sources remain catalogue-pinned; generic managed sources require complete HTTPS descriptors.
- A generic update index may provide a new HTTPS `downloadUrl`; otherwise retain the installed fallback. Validate the index and archive final URLs, and bind one checked update plan through download and commit.
- Bind a managed update to the exact package ID, generation path, installed revision, and source descriptor that was checked. Revalidate at the commit snapshot so a stale check cannot overwrite a concurrent reimport. Do not key this guard to the broad state revision because presentation-only edits may be preserved.
- Persist a successful update's `up-to-date` status in the same package CAS as the replacement. Apply check/failure status only if the checked generation still matches. Reject a managed title change that collides with another installed package.
- Dictionary groups use stable IDs. Names are unique after case/whitespace normalization and `All` is reserved. Group-only state writes must not invalidate lookups; rerenders must preserve deliberate keyboard focus.

## Transaction boundaries

- `background.js` owns serialized `chrome.storage.local` writes. The engine calls back into its worker handlers during a dictionary commit, so a handler must never hold the background storage queue while awaiting an engine import/update/custom mutation.
- The engine mutation queue owns imports, reimports, managed updates, removals, custom compilation, native reloads, and generation cleanup. Keep status requests available while a long mutation runs.
- Stage and persist a generation, strict-load it, publish state with CAS, then clean the superseded generation. On failure, restore the committed state and loaded set. If a CAS reply is lost, read back the exact expected commit before reporting failure or deleting either generation.
- Reject canonical-title collisions before publication. Title-based lookup/media/style/removal cannot safely represent two packages with the same canonical title.
- Keep options pruning and group-membership pruning in the same state commit as package removal.

## Managed custom dictionary

- Store the source document separately with a monotonic document revision and an ordered-entry semantic revision. A stale Settings save is refused; a Note append reads the latest source only after entering the mutation queue.
- Parse the first two commas, ignore blank/comment lines, retain valid rows, order, and duplicates, and report every malformed line. Preserve CRLF on append. Decode `\\n` as newline and `\\\\` as a literal backslash without corrupting literal backslash-plus-`n`; serialize with the exact inverse.
- Do not add arbitrary source, row, term, reading, definition, archive, or media caps. Checks required by the classic ZIP representation itself are format invariants, not product limits.
- Build the production Yomitan ZIP deterministically with UTF-8 names/data, correct CRC/offset metadata, format 3, and 1,000-row term-bank chunks. Test that production builder through the real WASM importer, including multibyte text, escapes, and more than one bank.
- Use a non-title-derived fixed custom package ID and canonical title. Protect and pin it by ID, enabled and first, in the central background CAS as well as the UI/engine. Public import cannot claim the reserved title; public removal cannot remove the managed package. A pre-existing local package with that title is a collision, not the managed package.
- A semantic no-op skips recompilation only when the committed fixed-ID package and generation already satisfy every invariant. Source-only changes do not bump dictionary state or engine generation. Zero valid rows atomically save the source and remove the managed package.
- Commit a semantic source change and dictionary state together in one revision-checked storage write, with exact-pair lost-reply readback. Retry dictionary-state conflicts against current presentation, but never retry or merge a stale source document.
- Generalize the offscreen import lock to a mutation lock for custom saves/appends. Reuse private staging/import helpers; do not recursively invoke the public queued import handler.
- The fixed Note form is shared by term and kanji views. Treat append success separately from best-effort lookup refresh so a refresh error cannot invite a duplicate retry. Refresh the exact current request/view only if it is still current and anchored, and make reply/state-event ordering harmless by adopting only newer committed revisions.
- While the Note form is open, Escape closes the form before document capture can hide the popup, and hover-hide timers must not discard the draft.

## Lookup statistics and definition blur

- A lookup increments one descriptor plus one term/reading row in a serialized worker write; neither the worker hot path nor the reader scans the collection. The renderer always provides a hidden count slot on the All tab and the reader owns its visibility, so a count setting never reprojects definitions or disturbs a Note draft.
- The reader adopts a row event or a reply for a term only when it is newer than that term's own payload, without rolling the global descriptor back; older generations stay rejected. Unrelated revisions never refresh visible terms.
- Hachidori lookup counts use only local browser storage. The user requested removing the GSM Corpus Seen integration during the standalone Settings/startup refresh; retired corpus connection options are ignored and must not trigger network requests. Preserve source attribution and existing text-protocol compatibility.
- Blur decisions live on the request, so tabs, Show more, Note refresh and Back keep them and a new request starts fresh. The view renders pending before the count and never re-blurs once revealed. One absolute deadline runs from first display; navigating away cancels only the live timer, Back and a persisted `pageshow` re-arm the remainder. The decision waits for the stored options when a lookup renders before the initial storage read.
- Autoplay stays held while a request's definitions are pending or blurred, and every reveal (a non-qualifying decision, hover, the deadline, Back past it, or disabling blur) releases the held first result once. The first count still decides the blur for the whole visit. The audio controller keys held first results by owner, settles them only for the request being revealed, and keeps a retired hold's visit unspent; a manual play consumes every waiting result.

## Experimental features

Settings → Advanced → Experimental features is the one place a feature that is still changing is switched on or off.

- An experimental feature is one entry in `EXPERIMENTAL_FEATURES` in `extension/reader-options.js` (`id`, `label`, `description`, optional `section`) plus its `false` default under `options.experimental`. Add the entry and the default together; do not introduce a parallel storage key, a separate save path, or a second registry. `experimental-settings.js` renders the switches from that registry and needs no per-feature code.
- Flags are booleans under `options.experimental` and travel through the existing revisioned `hd_options_write`, `normaliseOptions`, and backup paths. A patch must carry the complete record with known ids and boolean values, as `mediaCapture` does; stored garbage normalises to the default without throwing.
- A feature's own settings live where they always did. Turning a flag off hides the feature and keeps those settings; it must not clear them. When a feature has an enable switch that keeps runtime work going (Media mining → `mediaCapture.enabled`), the Settings toggle is responsible for switching it off in the same save so nothing stays active behind a hidden section. Runtime code gates on the feature's own enable switch, not on the flag.
- A feature that names a Settings `section` keeps that section, its rail link and its picker option hidden while off, and a hash request for it resolves to `#advanced`. Real-Chrome suites that open a gated section turn its switch on first.
- Migration is stateless and lives in `normaliseOptions`: only a stored record with no `experimental` key derives a flag from legacy state (Media mining from `mediaCapture.enabled`). Once Settings has written the record, the stored value wins.
- Removing a flag means deleting its registry entry and default, dropping its gate, and leaving its feature permanently on or removing the feature; do not keep dead flags.

## Repository map

- `extension/` contains the Chrome MV3 runtime, settings UI, content script, and popup renderer; `extension/README.md` maps its files.
- [hachidori-anki](https://github.com/bee-san/hachidori-anki) develops and releases the Hachidori Relay add-on for Anki. `extension/anki-addon.js` pins the release that Settings → Sharing downloads.
- `wasm/bindings.cpp` is the JavaScript-facing boundary around the hoshidicts engine.
- `third_party/hoshidicts` is a submodule and should move only as an intentional part of the change.
- `extension/vendor/hoshidicts.{mjs,wasm}` is committed build output. Update it with its source change; otherwise leave it alone.
- `test/` contains the fixture generator, smoke suites, real-Chrome E2E test, and optional native baseline. See `test/README.md` for what each suite proves.

## Validation

Run the narrowest existing checks that exercise the change:

- Documentation-only changes: inspect the rendered Markdown, links, and final diff; code tests are not required.
- Fixture, C ABI, or WebAssembly changes: rebuild when needed, then run `node test/make-fixture.mjs` and `node test/node-smoke.mjs`.
- Extension runtime or renderer changes: run `node test/make-fixture.mjs` and `node test/extension-smoke.mjs`.
- Relay source, packaging, socket and installed-Anki checks live in [hachidori-anki](https://github.com/bee-san/hachidori-anki). Run that repository's checks for relay changes.
- Sharing protocol, host, client, Settings, startup-page or pinned add-on version changes: also run `node --test test/sharing-protocol.test.mjs test/sharing-settings.test.mjs test/anki-addon.test.mjs` and `node test/chrome-sharing.mjs`. The browser suite needs `python3`, a network address beyond loopback, and access to the pinned GitHub release; `HACHIDORI_ANKI_ADDON=/path/to/hachidori-relay.ankiaddon` supplies a local artifact for offline or coordinated changes.
- Manifest, service worker, offscreen lifecycle, IndexedDB persistence, content-script, or visible popup changes: also run `node test/chrome-e2e.mjs`.

Do not claim a check that was not run. Report each command and its exact outcome in the pull request.

## Performance

- Benchmark changes that may affect runtime speed using representative inputs and the relevant production path. Compare before and after under the same conditions; use the existing [benchmark harness](benchmark/README.md) where it fits. Documentation-only changes do not need benchmarks.
- Prioritize speed issues introduced or worsened by the change. Fix measured in-scope regressions before merging, then repeat the benchmark and relevant correctness tests; do not stop at reporting the slowdown.
- Prefer small fixes for demonstrated unnecessary work. Preserve correctness, transaction boundaries, and complete results; do not hide performance problems with arbitrary product caps or expand the task into speculative optimization.
- Record the benchmark command or reproducible setup, compared revisions, input size, environment, repeated-sample results, and limitations in the pull request. Distinguish targeted timings from end-to-end latency, including work deferred outside the measured interval; do not claim a speedup from a single noisy run.

## Reviewable pull requests

Before opening the pull request:

- Perform a simplification pass over the complete diff. Look for code that can
  be removed or replaced by existing helpers, transaction paths, state
  machines, and UI primitives. Apply worthwhile reuse when semantics,
  ownership, lifetime, and trust boundaries match; do not force reuse across
  genuinely different boundaries. Summarize the result in the pull request.
- Self-review `git diff --check` and the complete branch diff against its base.
- Remove accidental generated files, fixture output, debug logging, and unrelated edits.
- Use a clear title and a body that explains the problem, the chosen behavior, the important implementation details, and the validation performed.
- Include screenshots for visible UI changes and call out intentional submodule or generated WebAssembly updates.

Before merging a pull request:

- Require a successful completed CI check and a clean merge state for the exact head SHA.
- Fix every substantive review finding and resolve every review thread.
- Query SonarQube Cloud directly and require zero unresolved issues, zero security hotspots, and zero new-code duplication. A green quality-gate badge alone is insufficient when it still reports issues.
- Re-run the gate after every follow-up commit, including documentation-only fixes, then merge through GitHub and fast-forward the local `main` checkout.

For real-Chrome update tests, intercept update-index fetches on the service-worker CDP target and archive fetches on the offscreen-document target, which also covers its dedicated engine worker. Do not attempt Fetch interception directly on the dedicated worker target.

Screenshot clips passed to Puppeteer are page coordinates: it intersects them with the visual viewport, so add `scrollX`/`scrollY` after `scrollIntoView` or a scrolled element yields a zero-height clip.
