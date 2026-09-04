# AGENTS.md

These instructions apply to the entire repository.

## Working agreement

- Deliver every repository change through a pull request from a dedicated branch. Never push changes directly to `main`. Do not stop at a local commit or branch: push it and open the pull request.
- Keep each pull request to one coherent outcome that can be understood, tested, and reviewed independently.
- Prefer the smallest straightforward change that satisfies the request and fits the existing architecture.
- Do not mix requested work with drive-by refactors, renames, formatting churn, dependency updates, or unrelated cleanup.
- Read `CONTRIBUTING.md` and the relevant architecture or test documentation before changing an unfamiliar area.

## Scope, tests, and guards

- Implement the requested behavior rather than hypothetical adjacent requirements.
- Do not add speculative abstractions, fallbacks, compatibility layers, validation, resource limits, or safety guards. A new guard should address an explicit requirement, a reproducible failure, or a documented invariant, and its reason should be clear in the pull request.
- Dictionary archives are user-selected local inputs. Do not invent fixed limits for archive bytes, entry counts, expanded size, or compression ratios unless the task explicitly requires them. Preserve existing path and import-staging correctness boundaries.
- Do not add broad or extensive test coverage by default. Add a focused regression test when behavior changes or a bug needs to stay fixed; do not duplicate coverage already provided by a suitable suite.
- Avoid adding test-only dependencies or expanding fixtures unless the changed behavior genuinely needs them.

## Repository map

- `extension/` contains the Chrome MV3 runtime, settings UI, content script, and popup renderer.
- `wasm/bindings.cpp` is the JavaScript-facing boundary around the hoshidicts engine.
- `third_party/hoshidicts` is a submodule and should move only as an intentional part of the change.
- `extension/vendor/hoshidicts.{mjs,wasm}` is committed build output. Update it with its source change; otherwise leave it alone.
- `test/` contains the fixture generator, smoke suites, real-Chrome E2E test, and optional native baseline. See `test/README.md` for what each suite proves.

## Validation

Run the narrowest existing checks that exercise the change:

- Documentation-only changes: inspect the rendered Markdown, links, and final diff; code tests are not required.
- Fixture, C ABI, or WebAssembly changes: rebuild when needed, then run `node test/make-fixture.mjs` and `node test/node-smoke.mjs`.
- Extension runtime or renderer changes: run `node test/make-fixture.mjs` and `node test/extension-smoke.mjs`.
- Manifest, service worker, offscreen lifecycle, IndexedDB persistence, content-script, or visible popup changes: also run `node test/chrome-e2e.mjs`.

Do not claim a check that was not run. Report each command and its exact outcome in the pull request.

## Reviewable pull requests

Before opening the pull request:

- Self-review `git diff --check` and the complete branch diff against its base.
- Remove accidental generated files, fixture output, debug logging, and unrelated edits.
- Use a clear title and a body that explains the problem, the chosen behavior, the important implementation details, and the validation performed.
- Include screenshots for visible UI changes and call out intentional submodule or generated WebAssembly updates.
