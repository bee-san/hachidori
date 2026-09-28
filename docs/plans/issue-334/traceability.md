# Traceability: where every part of the original body went

The original body is kept verbatim in [history/original-body.md](history/original-body.md). This table lists each of its sections and where that content lives now, or why it was superseded ([decisions.md](decisions.md#superseded-ideas-kept-for-the-record)).

| Original section / item | Now |
| --- | --- |
| Problem: origin comment from #330 and the reading moment | Issue body *Problem* (kept). [#330 quote](evidence.md#4-external-checks-2026-09-28). |
| Problem: "What exists today" (7 bullets) | [architecture.md §3](architecture.md#3-hachidori-today-what-the-plan-changes), re-verified at 7ff01b1 with corrections (18 properties, one constructed sheet, `<style>` dictionary CSS, Firefox gone, all_frames, open shadow root) |
| Problem: Design settings table ("Movable to a theme?") | Issue body *Problem* (kept, updated to suggestions + `ignores`). [data-model.md](data-model.md) |
| Expected behavior 1–9 | Issue body *Expected behavior* (rewritten for renderers and c28; each item maps to cards) |
| Yomitan's closest behaviour | [evidence.md §3](evidence.md#3-yomitan-checked-for-the-yomitan-theme-ask-and-for-comparison) (display.js lines updated to 67db60d) |
| Environment | Issue body *Environment* (Hachidori 0.1.6 at main 7ff01b1; Firefox removed; Chrome for Testing 152.0.7977.75) |
| Evidence: Nazeka (JS) prototype, fidelity, fault isolation, lint gate, theme.yaml/js/css | [evidence.md §1](evidence.md) (verbatim). The fidelity list became T-32's steps. The manifest became [examples/themes/nazeka/theme.yaml](examples/themes/nazeka/theme.yaml) (schema 2). |
| Evidence: benchmark table, run 1 vs run 2 | [evidence.md §1](evidence.md) (verbatim). The preload finding became T-05/T-20 and renderer-api.md §12. |
| Evidence: CSS drafts and the Custom-CSS leak | [evidence.md §1](evidence.md) (verbatim). The leak now motivates only the Custom CSS hint (open question 1), because after c28 no theme CSS is downloaded (D24). |
| Benefit to the creator | Issue body *Benefit to the creator* (updated) |
| Direct answers to the origin comment and follow-ups | Issue body (updated with c03–c28) |
| Security and policy: rules, JS delivery paths A–E | [security.md §1](security.md#1-the-chrome-web-store-remote-code-rule-a-store-policy-that-review-cannot-waive) (kept, plus path F) |
| Theme JS API (schema 1): `onRender(view, api)`, `view`, `api`, lifecycle, CI lint, store notice | **Superseded** by [renderer-api.md](renderer-api.md) (c26, c28): `view.lookup` → `model.source`; `api.el` → `ctx.el`; `api.setVariable` → `ctx.setVariable` (per node); `api.requestLayout` → `ctx.requestLayout`; `api.hide`/`api.move` dropped; the lint became contract hygiene (T-24) |
| CSS sanitiser (CI, install, adoption) | **Superseded** (D16, D24): no downloaded CSS exists. Renderer CSS is reviewed. Palette values are validated (T-23). Dictionary CSS policy unchanged. |
| Privacy: endpoints, final-URL check, opt-in schedule, docs/privacy.md | [security.md §3](security.md#3-privacy-no-automatic-requests), T-44 (no CSS endpoint any more) |
| The `hachidori-theme-store` repository: layout, schema, index example, workflow, validate.mjs, render.mjs | [themes-repo.md](themes-repo.md), [schemas/](schemas/), [examples/index.json](examples/index.json); T-21, T-22, T-24, T-25 |
| Benchmarking is a rule (budgets, `onRender` p95/max, pasted numbers) | [benchmarking.md](benchmarking.md): kept end-to-end budgets and heap; `onRender` budget and pasted numbers **superseded** (D7); all themes (D26); T-26, T-27 |
| How to benchmark a theme (tested guide) | [benchmarking.md](benchmarking.md#how-to-benchmark-a-theme-tested-guide-from-the-original-body-updated) (kept, updated) |
| Hachidori side: engine, where themes live, options, migration | [architecture.md §4–§8](architecture.md), [renderer-api.md](renderer-api.md), [data-model.md](data-model.md) |
| Theme Store UI wireframe, card states, update flow, offline, backup/sharing | [ui.md](ui.md) (without the JS switch or CSS Install, c28), [architecture.md §5](architecture.md#5-catalogue-fetching-caching-updating-t-44), [data-model.md](data-model.md) |
| Alternatives considered | [decisions.md](decisions.md#alternatives-considered) (kept + new) |
| Implementation plan, Phase 0 (policy decision on JS) | T-01, T-02 |
| Phase 1 (themes repo, schema, CI, 44 themes) | T-04, T-21–T-25, T-27 (plus T-32, T-34–T-36 for the starter renderers) |
| Phase 2 (engine, host, Store on the vendored index) | T-10–T-20, T-30, T-31, T-40–T-42, T-50, T-51 (the renderer model replaces the onRender host) |
| Phase 3 (remote catalogue, CSS-only Install/Update) | T-44 (colour data only after c28) |
| Phase 4 (declarative options) | T-43 |
| Phase 5 (runtime-installed JS themes: blocked by policy) | Still not planned ([security.md](security.md#javascript-delivery-paths), path C) |
| Acceptance criteria (whole issue) | [testing.md](testing.md) |
| Risks | [decisions.md](decisions.md#risks) |
| Open questions 1–5 | [decisions.md](decisions.md#open-questions-for-bee-san) 1–5 (5 is moot after c28) plus 6–15 |
| Out of scope | Issue body *Out of scope* (kept, updated) |
