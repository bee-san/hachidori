# Parallel execution plan (many agents at once)

bee-san asked for a plan that several AI agents can implement at the same time. The work is split into 55 cards. Each card is one mergeable PR with a declared file boundary, explicit dependencies, and contracts frozen before anyone depends on them. The board is in [kanban.md](kanban.md) and the cards are in [tasks/](tasks/).

## 1. Principles

1. **Contract first.** T-01 freezes the renderer API, result model, roles, CSS layers, manifest/index/storage/benchmark schemas and message names ([renderer-api.md](renderer-api.md), [schemas/](schemas/)). After that, core, renderer, UI and themes-repo work proceed against the contract without waiting for each other.
2. **Seams before features.** The first core cards are behaviour-preserving: roles (T-10/T-11), the model (T-12), the host with a legacy adapter around today's Default (T-14/T-15), and the CSS split (T-17). Every suite stays green, and renderer work never needs Default to be extracted first.
3. **New modules over shared files.** Each feature lives in a new file owned by one card: `result-model.js`, `renderer-host.js`, `components.js`, `palette-css.js`, `theme-state.js`, `renderer-loader.js`, `theme-store-ui.js`, `docs/themes/*.md`, `test/theme-*.test.mjs`. Shared hotspots get only small registration edits.
4. **One PR per card, small and fast.** Mechanical moves (T-17, T-30, T-31) are announced, done in one sitting under a lock, and merged quickly.
5. **Cross-repo work is pinned.** Hachidori pins `hachidori-theme-store` in `extension/vendor/themes/SOURCE.json` (T-50). The themes CI pins Hachidori in `fixture/HACHIDORI_COMMIT`. Either side moves only by a PR that bumps its pin.

## 2. What T-01 freezes (and what may start the day it merges)

| Frozen artefact | Consumers that can start immediately |
| --- | --- |
| `docs/themes/contract.md` + `extension/render/renderer-contract.js` (constants) | T-10, T-11, T-14, T-16, T-30 (core); T-32–T-35 (renderers, against fixtures + the host test harness) |
| `docs/themes/schemas/result-model.v1.schema.json` + `test/fixtures/models/*.json` | T-12 (builder must reproduce the fixtures), T-24 (contract runner), renderers |
| manifest v2 / index v1 / benchmark v1 schemas | T-21, T-22, T-27, T-41 (Store UI against a fixture index), T-50 |
| `themes-storage.v1` + message names `hd_themes_read`, `hd_themes_cas` | T-19, T-41, T-44 |
| Stub modules registered in `manifest.json` and `design-preview.html` | Each card later fills only its own file, so nobody edits the manifest's script list again |
| Test anchors: `test/theme-e2e/<card>.mjs` stubs aggregated once into chrome-e2e's `PLANNED` (which already spreads module arrays, [chrome-e2e.mjs:233](https://github.com/bee-san/hachidori/blob/main/test/chrome-e2e.mjs#L233)) | Cards add e2e checks without touching `chrome-e2e.mjs`. Unit tests named `test/*.test.mjs` are auto-discovered ([test/run.mjs:54-58](https://github.com/bee-san/hachidori/blob/main/test/run.mjs#L54-L58)). |

### Contract changes

A card that needs a contract change stops and opens a **`contract` PR**. The PR amends `docs/themes/contract.md` and the schemas, says whether the change is additive (the versions stay 1) or breaking (version 2, with the host supporting both for one release), and needs bee-san's approval. Feature PRs must not change contract files, and CI enforces this with CODEOWNERS on `docs/themes/**` and `extension/render/renderer-contract.js`.

## 3. Lanes and hotspot files

A **lock** is a label on the card that currently owns the file (`lock:content.js`). At most one open PR per locked file. Other cards that need the file wait for the merge or get a one-line change folded into the lock holder's PR by agreement.

| Hotspot (size on main 7ff01b1) | Card order holding the lock | Rule for everyone else |
| --- | --- | --- |
| `extension/content.js` (4,261 lines) | T-11 → T-15 → T-20 | T-19 needs only a read of `themes` at start: fold it into T-15 or do it after T-15 merges |
| `extension/render/popup.js` (4,293 lines) | T-10 → T-30 → T-31 | Nobody else edits it. Renderers never do: they use the components T-30 extracts. |
| `extension/render/reader.css` → split files | T-17 (split) → T-30 owns `components.css` → T-31 owns `default.css` | `palettes.css` is replaced only by T-51 (from vendor) |
| `extension/render/glossary.js` (shared with Anki export) | T-13 | Anki output must not change (anki-glossary tests) |
| `extension/reader-options.js`, `extension/backup-state.js` | T-18 → T-19 | `DESIGN_OPTION_KEYS` and the experimental registry change only in T-18 |
| `extension/background.js` (2,855 lines) | T-18 (write validation) → T-19 (register handlers) → T-44 (refresh handler) | Logic lives in `theme-state.js`. background.js gets registration lines only. |
| `extension/settings.js` (3,652), `settings.html`, `settings.css` | T-40 (select) · T-41 (Store section, new module) · T-43 (hints) | settings.js gets one `mountThemeStore()` call. UI code goes in `theme-store-ui.js`. |
| `extension/design-preview.js` | T-17 (links) → T-42 (host) | — |
| `extension/manifest.json` | T-01 (script list, once) → T-17 (WAR CSS) → T-20 (loader) | — |
| `test/extension-smoke.mjs` (22,747 lines) | T-11, T-15, T-18, T-51 only (catalogue assertions and internal names) | New tests go in `test/theme-*.test.mjs` |
| `test/chrome-e2e.mjs` (14,228 lines) | T-01 only (aggregator) | Checks go in your card's `test/theme-e2e/<card>.mjs` |
| `benchmark/hover-popup*.{mjs,js}` | T-26 | — |
| `docs/architecture.md` | T-02 (links + drift fixes) | Details go in `docs/themes/<topic>.md` owned by the card |
| `extension/vendor/themes/**` | generated by `scripts/vendor-themes.mjs` (T-50) only | Never hand-edited; CI compares against `SOURCE.json` |

## 4. Critical path and waves

These estimates assume working days (S = 1, M = 3, L = 7) and enough agents. The critical path is **T-01 → T-14 → T-15 → T-26 → T-27 → T-52 → T-53**, about **31 working days**. T-11 (after T-10) must also finish before T-15, and T-20 (after T-05, T-15) before T-27.

| Earliest start | Cards that can run in parallel |
| --- | --- |
| day 0 | T-01, T-02, T-03, T-04, T-05 |
| day 3 (T-01 merged) | T-10, T-12, T-13, T-14, T-16, T-17, T-18, T-21 (needs T-04), T-23 |
| day 4 | T-11 |
| day 6 | T-19, T-22, T-30 |
| day 9 | T-41 |
| day 10 | T-15, T-24 |
| day 13 | T-32, T-36, T-34, T-35, T-50 |
| day 16 | T-40, T-43, T-44, T-51 |
| day 17 | T-20, T-26, T-31 |
| day 20 | T-42 |
| day 23 | T-25 |
| day 24 | T-27 |
| day 27 | T-52 |
| day 30 | T-53 |

The backlog cards (T-60–T-65 API extensions, T-70–T-79 community renderers, and T-33 Wicked if bee-san wants it) can start as soon as their dependencies land. They are independent of each other except where one needs an API card (for example T-73 needs T-60).

## 5. Agent protocol

1. **Pick** a card in *Ready*: every "Blocked by" is Done and no lock you need is held. Take one card at a time.
2. **Claim** it: assign yourself (or comment `/claim T-xx` if you cannot be assigned), add `in-progress`, and move it to *In progress*.
3. **Branch** from fresh `origin/main` (or the themes repo's `main`) as `theme/T-xx-short-name`. The name is in each task file.
4. **Stay inside the card's file list.** Touch a hotspot only while your card holds its lock label. If you need a contract change, open a `contract` PR instead (§2).
5. **Tests:**
   - add `test/theme-<topic>.test.mjs`;
   - e2e checks only in your `test/theme-e2e/<card>.mjs`;
   - AGENTS.md validation: `node test/make-fixture.mjs && node test/extension-smoke.mjs` for runtime/renderer changes, plus `node test/chrome-e2e.mjs` for manifest, content-script or visible popup changes;
   - benchmark runtime changes before and after (AGENTS.md:108-111);
   - report every command and its exact outcome.
6. **PR:**
   - title `T-xx: <card title>`;
   - body: the repo PR template plus `Part of #334 · Closes #<card sub-issue>`, the commands and outcomes, and screenshots for UI;
   - one PR per card; open it as a draft early so the lock is visible.
7. **Before merge:**
   - `git fetch origin && git rebase origin/main`, then re-run the validation;
   - green CI on the exact head, all threads resolved, SonarQube with zero issues, hotspots and new duplication (AGENTS.md:118-133);
   - bee-san (or a maintainer) merges;
   - never push to `main`, and never force-push someone else's branch.
8. **After merge:** move the card to *Done*, remove the lock label, and for each dependent card whose blockers are now all Done, replace `blocked` with `agent-ready` and move it to *Ready*.
9. **Stale claims:** after 48 h without a push, comment and unassign. Someone else may take the card over from the existing branch.
10. **Theme cards** (T-32 Nazeka, T-36 Plain, T-34 Yomitan, T-35 Rikaikun, T-22 palettes, T-70–T-79; T-33 if built) are PRs to `bee-san/hachidori-theme-store`. **Hachidori-side cards merge straight into `main` behind `experimental.themeStore`**, and there is no long-lived feature branch (owner update of 2026-09-28). They reach users through a small Hachidori vendor-bump PR (`node scripts/vendor-themes.mjs --commit <sha>`, T-50). That PR is maintainer-run, not a card.

## 6. Running it on GitHub

- **Project**: a GitHub Project (v2) "Theme Store (#334)" with the Status options **Backlog, Ready, In progress, Review, Done**, plus the fields *Card* (T-xx), *Size* (S/M/L), *Owner type*, *Phase* and *Repo*. It has two views: Board by Status, and Table grouped by Phase.
- **Sub-issues**: one issue per card, created from `tasks/T-xx.md` and attached to #334 as a sub-issue. The body keeps the "Blocked by" list, which GitHub renders as tracked issues.
- **Labels**: `theme-store` (all), `agent-ready`, `blocked`, `in-progress`, `contract`, `lock:content.js`, `lock:render/popup.js`, `lock:render/reader.css`, `lock:render/glossary.js`, `lock:reader-options.js`, `lock:backup-state.js`, `lock:settings.js`, `lock:settings.html`, `lock:design-preview.js`, `lock:manifest.json`, `lock:benchmark/`, `lock:audio-content.js`, `lock:anki-content.js`, `repo:theme-store`.
- **Automation**: Project workflows set Status = In progress when an issue gets an assignee, Review when a linked PR is ready for review, and Done when it closes.
- **Bootstrap**: [scripts/create-cards.sh](scripts/create-cards.sh) creates the labels, one issue per card with its labels, and the sub-issue links. It is dry-run by default. bee-san runs it, because it writes to the repository.
