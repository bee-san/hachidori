# Testing plan and acceptance criteria

## Suites (Hachidori)

| Layer | How it runs | Used by |
| --- | --- | --- |
| Unit / jsdom | `node --test` over every `test/*.test.mjs` and `benchmark/*.test.mjs`, auto-discovered ([test/run.mjs:54-58](https://github.com/bee-san/hachidori/blob/main/test/run.mjs#L54-L58)). New files are `test/theme-*.test.mjs`. | T-01, T-10, T-12, T-13, T-14, T-16, T-17, T-18, T-19, T-23, T-30, T-50 |
| Extension smoke | `node test/make-fixture.mjs && node test/extension-smoke.mjs`: render stages, content.js instrumentation, catalogue assertions | every runtime/renderer card (AGENTS.md:99) |
| Chrome e2e | `node test/chrome-e2e.mjs` (Chrome for Testing 152.0.7977.75, `PLANNED` list). Theme checks live in `test/theme-e2e/<card>.mjs` (T-01 anchors). | manifest, content-script or visible popup changes (AGENTS.md:102) |
| Overlay | `node test/chrome-overlay.mjs` | T-05, T-20 |
| Settings first frame | `test/chrome-settings-first-frame.mjs` | T-17, T-40, T-51 |
| Benchmark | `benchmark/hover-popup.mjs` (+ T-26 additions), before/after, 5 profiles per side | T-15, T-17, T-20, T-26, T-31, T-52 |
| Themes CI | validate · lint · AST · jsdom contract · render · benchmark ([themes-repo.md](themes-repo.md)) | T-21–T-27, every renderer and palette PR |

## Acceptance per phase

**Phase 0 (decisions, contracts, spikes)**

- [ ] Contract, schemas, stubs and test anchors merged with bee-san's approval (T-01).
- [ ] AGENTS.md rules, CWS remote-content section, privacy and daisyUI credit merged; architecture.md drift fixed (T-02).
- [ ] Store mock-up posted and reviewed (T-03).
- [ ] `hachidori-theme-store` exists (T-04).
- [ ] Loading decision recorded with numbers (T-05).

**Phase 1 (core seams)**

- [ ] With Default selected, every existing suite passes and screenshots are unchanged after each seam PR (T-10, T-11, T-14/T-15, T-16, T-17).
- [ ] The Default hover benchmark stays within the budget before/after T-15 and T-17.
- [ ] A test renderer registered at runtime renders a lookup with **zero Default content DOM**.
- [ ] Nested scanning, blur reveal, Back focus, keybind mining and audio work with a role-only renderer and no Default buttons (T-11, T-16).
- [ ] A throwing renderer is replaced by Default and Default CSS on the same model, with one warning, no retry, and no leftover listeners or sheets (T-14).
- [ ] Theme slugs survive normalisation and backup; strict writes accept only known themes; the flag is off by default (T-18).
- [ ] `themes` record CAS and backup round-trip (T-19). Renderer ready at content-script start with cold-first-hover parity (T-20).

**Phase 2 (themes repository)**

- [ ] CI fails on every negative fixture (missing manifest, slug mismatch, duplicate, schema-1 manifest, `css:` key, renderer without screenshot, `apiVersion: 2`, unknown tag, stale `dist/`) and passes the 42 palettes (T-21, T-22).
- [ ] `dist/palettes.css` is byte-identical to Hachidori's palettes (T-22/T-23).
- [ ] The hostile renderer fails lint and contract; first-party renderers pass (T-24).
- [ ] Renders compare with the committed screenshots (T-25).
- [ ] Every theme has CI-generated benchmark numbers, and over-budget or Default-DOM-building renderers fail (T-26, T-27).

**Phase 3 (renderers)**

- [ ] Default is a registered renderer, the legacy adapter is gone, and behaviour and screenshots are unchanged (T-30, T-31).
- [ ] Nazeka, Plain, Yomitan and Rikaikun pass the contract/render/benchmark gates (T-32, T-36, T-34, T-35). Plain has the fewest nodes and earns ⚡Lighter.

**Phase 4 (Settings and Store)**

- [ ] The select comes from the catalogue, and an unavailable slug is shown and kept (T-40).
- [ ] The Store matches the approved mock, passes the a11y checks, and makes zero requests before Refresh (T-41).
- [ ] The preview equals the popup for every renderer (T-42).
- [ ] One-revision suggestions with exact Undo, and ignored controls labelled (T-43).
- [ ] Refresh plus using, updating and removing catalogue palettes and variants, with **no CSS or JS request ever** in the request log (T-44).

**Phase 5 (vendoring, acceptance, release)**

- [ ] Vendoring is reproducible (T-50). Palettes and counts come from the index (T-51).
- [ ] The c26/c27/c28 list below is proven on main, and the comparative benchmark is published (T-52).
- [ ] Released, with the flag decision recorded (T-53).

## c26 / c27 / c28 acceptance items, mapped

| Item (quoted or condensed) | Proven by |
| --- | --- |
| Selecting Nazeka constructs no Default content DOM and applies no Default-specific layout stylesheet; unused components are never created (c26) | T-52 e2e (`.gsm-hoshidicts-result-chrome`, `.gsm-hoshidicts-glossary-card` absent; `default.css` not adopted; component constructors not called), T-27 benchmark counters |
| Default and Nazeka use the same core lookup/actions and pass term, kanji, keyboard, audio, mining, nested-popup, incremental-update and cleanup tests (c26) | T-52 e2e matrix per bundled renderer |
| Shared glossary helpers preserve dictionary content and sanitisation; intentionally omitted UI is documented; Nazeka stays faithful, and the raw/fast experiment is separate: Plain, plus Wicked if built (c26) | T-13 tests, T-30, the `ignores` list in theme.yaml and the Store's "Doesn't use" line, T-32 screenshot vs Nazeka's reference, T-33 |
| Palette-only themes and existing palette choices stay compatible; renderer selection works in the popup and the Design preview (c26) | T-17/T-22/T-51 byte and pixel equality, T-42 |
| Theme switching and renderer failures clean up and fall back with no duplicate listeners or stale updates (c26) | T-14 jsdom, T-15 e2e (stable listener count), T-52 fallback check |
| Benchmark Default, the Nazeka transformation prototype and the direct Nazeka renderer with identical inputs: DOM construction, style/layout/paint, nodes, memory, cold first hover, end-to-end hover and kanji (c26) | T-26 harness, T-52 report |
| Revise benchmark reporting for full renderers: the onRender budget is retired, end-to-end checks and renderer baselines are established (c26) | benchmarking.md budgets, T-27 |
| A renderer can render a lookup without the structured glossary renderer (c27) | T-24 contract (text/none), T-52 |
| Plain-text mode produces no structured DOM, images, links or dictionary CSS (c27) | T-13 unit (zero elements), T-52 e2e (zero `hd_styles`, `.structured-content`, `<img>`, `<a>`) |
| None mode produces no definition DOM, while the result data stays available (c27) | T-24 contract (glossary handle never read), T-33 (`none` option) |
| Default keeps its rich-content behaviour (c27) | existing extension-smoke structured/deep stages, chrome-e2e `checkDictionaryStyles` |
| Benchmarks verify that omitted dictionary work is really not performed (c27) | T-26 dictionary work counters, T-27 budget "omitted work is not done" |
| Themes are their own popup, not JS/CSS over the normal one, to save rendering cost (c28) | Schema 2 has no `css`/style kind (T-21 negative fixture). T-52/T-27 prove that no Default DOM or CSS is built under any renderer and report the saving. |
| Nazeka behaves like Nazeka: no rendering, text only (c28) | T-32 manifest `glossary: [text]`, T-24 contract, T-52 e2e |
| All themes are benchmarked (c28) | T-27 PR gate + weekly full-catalogue run; `benchmarks/<slug>.json` for every theme |
