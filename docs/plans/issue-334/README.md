# #334 Theme Store: implementation plan package

The plan for [bee-san/hachidori#334](https://github.com/bee-san/hachidori/issues/334), "Theme Store: community themes repo, per-theme popup renderers and Design UI". The issue body carries the core plan and the kanban board. This folder carries the full detail: one file per card, the frozen contracts as JSON Schema, examples, and the history.

Download: [issue-334.zip](https://github.com/bee-san/hachidori/blob/plan/issue-334/docs/plans/issue-334.zip) (this folder). Line links point at `main` and were verified at **7ff01b1** (2026-09-28).

## The plan in one paragraph

A theme is **its own popup**, not CSS or JS over the normal one ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)). It is either a **palette** (colours for the Default popup: the 42 today) or a **renderer**. A renderer is bundled JavaScript that builds the popup from a structured result model, with its own CSS, and Default does not run under it ([c26](https://github.com/bee-san/hachidori/issues/334#issuecomment-5870917807)). A **variant** is a renderer with another palette.

- The core keeps lookups, audio and Anki actions, keyboard, nesting and positioning.
- Renderers choose rich, text or no dictionary content ([c27](https://github.com/bee-san/hachidori/issues/334#issuecomment-5871156145)). Nazeka is text-only, and **Plain** shows only the dictionary content, with no buttons or chrome, as fast as possible.
- Themes live in `bee-san/hachidori-theme-store`, where bee-san reviews every PR.
- Hachidori vendors them at release time (renderer JS is never fetched: Chrome Web Store rule). Palettes and variants can also come from a refreshed catalogue as colour data.
- Every theme is benchmarked end-to-end against Default in CI.
- The Store lives in Settings → Design behind `experimental.themeStore`. Every Hachidori-side card merges straight into `main` behind that flag, with no long-lived feature branch. Theme cards are PRs to `bee-san/hachidori-theme-store`.
- 56 cards, contract first, are built to run in parallel by several agents.

## Reading order

| File | What |
| --- | --- |
| [decisions.md](decisions.md) | Decision log D1–D26 (which comment each came from), superseded ideas, open questions for bee-san, risks, alternatives |
| [renderer-api.md](renderer-api.md) | **The v1 contract**: renderer file, `ctx`, actions, update events, components, roles, lifecycle, fallback, CSS layers, versioning, loading |
| [architecture.md](architecture.md) | Repositories, theme kinds, Hachidori today (with links), runtime modules after the change, resolution, catalogue flow, versioning, migration |
| [security.md](security.md) | What c28 dropped, and what stays and why (store policy, dictionary sanitisation, privacy, robustness, CI hygiene, pre-existing findings) |
| [data-model.md](data-model.md) | Options, the `themes` record, backup/restore, sharing, overlay, migration |
| [ui.md](ui.md) | Theme select and Theme Store: wireframe, card states, copy, accessibility, preview |
| [themes-repo.md](themes-repo.md) | `hachidori-theme-store` layout, CI workflow, contribution flow, skeleton fixes, PR template |
| [benchmarking.md](benchmarking.md) | Harness, inputs, budgets, "all themes", Store labels, the comparative report, the tested guide |
| [testing.md](testing.md) | Suites, acceptance per phase, c26/c27/c28 acceptance items mapped to cards |
| [parallel-plan.md](parallel-plan.md) | Contract freeze, lanes and hotspot locks, critical path and waves, agent protocol, GitHub setup |
| [kanban.md](kanban.md) · [tasks/](tasks/) | The board and one file per card (T-00…T-79) |
| [evidence.md](evidence.md) | The original evidence (verbatim), the ten proposals with all their screenshots, the Yomitan check, external checks |
| [traceability.md](traceability.md) · [history/](history/) | Where every original section went; the original body verbatim; an index of all 29 comments |
| [schemas/](schemas/) · [examples/](examples/) | theme-manifest v2, theme-index v1, result-model v1, themes-storage v1, theme-benchmark v1; valid examples, including an illustrative `nazeka.renderer.js` |
| [scripts/](scripts/) | `validate-examples.mjs` (Ajv 2020 strict: schemas compile, examples pass, 14 negative cases fail) · `create-cards.sh` (dry-run GitHub bootstrap) · `cards/` (card data + renderer that regenerates tasks/, kanban.md and the issue fragments) |

## Regenerating the cards

Edit `scripts/cards/cards*.py`, then run `python3 scripts/cards/render.py . /tmp/out` from this folder. It rewrites `tasks/*.md` and `kanban.md`, and writes the issue-body fragments and the overflow comments to `/tmp/out`.

## Example numbers are labelled

Every number in examples/ and ui.md is either from the evidence branch (the onRender prototype, runs of 2026-09-24) or marked as illustrative. None of this package's numbers measure the direct renderers, because they do not exist yet.
