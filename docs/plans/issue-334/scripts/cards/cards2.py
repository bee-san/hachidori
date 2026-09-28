# Card data part 2 (exec'd after cards.py)

# ---------------------------------------------------------------- Phase 2: hachidori-theme-store
card(id="T-21", phase=2, title="`hachidori-theme-store` skeleton, schema 2 and CI", owner="infra agent", size="M", deps=["T-01", "T-04"], repo="hachidori-theme-store",
     goal="Create the repository layout from themes-repo.md with manifest schema 2, index schema 1, deterministic `build-index`, a validator that never executes theme code, the PR template, CODEOWNERS (bee-san on `themes/**` and `schema/**`, the review c28 relies on) and the `themes.yml` workflow.",
     files=[("new", "`schema/{theme,index,benchmark}.schema.json`", "copied from this package's schemas/ (they compile under Ajv strict)"),
            ("new", "`scripts/validate.mjs`", "YAML `core` schema → Ajv 2020 strict; slug = folder, unique slugs, `renderer` names a theme with `js`, files present and within caps, screenshot 1120×840 PNG; no import()"),
            ("new", "`scripts/build-index.mjs`", "deterministic `dist/index.json` (sha256, bytes, palette values inline), `dist/palettes.css`, `dist/themes/<slug>/renderer.{js,css}`"),
            ("new", "`.github/workflows/themes.yml`, `PULL_REQUEST_TEMPLATE.md`, `ISSUE_TEMPLATE/theme-problem.yml`, `CODEOWNERS`, `CONTRIBUTING.md`, `package.json` (exact pins), `.node-version` 22.23.1, `fixture/HACHIDORI_COMMIT`", "")],
     steps=["Start from the evidence skeleton; apply the fixes listed in themes-repo.md (strictRequired, missing sanitize-css import, no import() of theme files, no benchmark block).",
            "Add one sample palette (`default`) so CI has something green."],
     tests=["`node --test test/validate.test.mjs test/build.test.mjs`: missing yaml, slug/folder mismatch, duplicate, renderer without screenshot, wrong screenshot size, `renderer:` pointing at a palette, unknown tag, `apiVersion: 2`, a schema-1 manifest, a `css:` key (style kind is gone), each with a named message; byte-identical rebuild"],
     accept=["CI red on every negative fixture and green on the sample; `git diff --exit-code dist` after rebuild."],
     short="Repo skeleton + schema 2 + validator + deterministic dist + CI; negatives fail with named messages", src=["body", "c28"])

card(id="T-22", phase=2, title="Migrate the 42 palettes", owner="infra agent", size="M", deps=["T-21", "T-17", "T-23"], repo="hachidori-theme-store",
     goal="Generate `themes/<slug>/theme.yaml` for the 42 palettes from Hachidori's `render/palettes.css` at `fixture/HACHIDORI_COMMIT`; `dist/palettes.css` must come out byte-identical.",
     files=[("new", "`scripts/import-palettes.mjs`", "one-off generator (kept for audits)"),
            ("new", "`themes/<slug>/theme.yaml` × 42", "kind palette; 18 values; mode; tags (dark/light/high-contrast); license GPL-3.0-or-later; credits daisyUI 5 (MIT) where the palette comes from daisyUI (open question 4)")],
     steps=["Labels and groups as today (" + L("extension/reader-options.js", 169, 181, "POPUP_THEME_GROUPS") + ": Dark 18, Light 23, High contrast 1) become `mode` + tags.",
            "The extra Default styling for high-contrast/autumn/girlypop/miku stays in Hachidori's default.css (D21): nothing to migrate."],
     tests=["`test/palettes.test.mjs`: `dist/palettes.css` equals Hachidori's palettes.css at the pin byte for byte (modulo the generated header); `default` equals the reader.css default block"],
     accept=["42 folders, CI green, byte equality proven."],
     short="42 palette folders; compiled palettes.css byte-identical to Hachidori's", src=["body"])

card(id="T-23", phase=2, title="Palette compiler (`palette-css.js`)", owner="core agent", size="S", deps=["T-01"],
     goal="One implementation that turns 18 validated palette values into the palette block (`html[data-hoshidicts-theme=X], :host([data-hoshidicts-theme=X]) { --hoshidicts-palette-*: … }`) in exactly the byte format reader.css uses today. Hachidori uses it for palettes and variants stored from a refreshed catalogue (the only CSS ever built from downloaded data, D24); build-index and vendor-themes use it at the pinned commit so `palettes.css` is reproducible.",
     files=[("fill stub", "`extension/render/palette-css.js`", "UMD (`globalThis.HDPaletteCss` / Node export): `validatePalette(values)`, `compilePalette(slug, values)`, `compileAll(themes)`"),
            ("new", "`test/theme-palette-css.test.mjs`", "compiling the 42 current palettes reproduces reader.css:32-959 byte for byte; invalid values (`red; } * {…}`, `url(`, braces) are rejected")],
     steps=["Colour grammar = the schema's `color` pattern; `color-scheme` ∈ {dark, light}; no other characters reach the output."],
     tests=["`node --test test/theme-palette-css.test.mjs`"],
     accept=["Byte-identical round trip of all 42 palettes; injection-shaped values rejected; used by T-22, T-44, T-50."],
     short="Palette values → palette block, byte-identical to today; bad values rejected", src=["c28"],
     notes=["This replaces the theme CSS sanitiser of the first draft: after c28 no downloaded CSS exists, only colour values."])

card(id="T-24", phase=2, title="Renderer lint and contract runner (themes CI)", owner="infra agent", size="M", deps=["T-21", "T-12", "T-14"], repo="hachidori-theme-store",
     goal="Contract hygiene (not security, c28): keep renderers on `ctx` so that fallback, clean-up, benchmarks and Hachidori refactors work, and prove each renderer honours its declarations.",
     files=[("new", "`scripts/renderer.eslint.config.mjs`", "ESLint 9 flat, pinned; `globals: { HDRenderers }`; restricted globals and syntax from security.md §4 / renderer-api.md §3"),
            ("new", "`scripts/check-renderer.mjs`", "espree AST: exactly one top-level `HDRenderers.register({...})`; id = folder; apiVersion 1; glossary/components/layout/needs = theme.yaml"),
            ("new", "`test/contract.test.mjs`", "jsdom: Hachidori's host + fixture models from `fixture/HACHIDORI_COMMIT`; renders term/kanji/state and every `reason`; nothing outside `ctx.root`; zero listeners/timers after destroy; `text` mode creates no glossary DOM, `none` never reads glossary data; fetch/XHR stubs untouched"),
            ("new", "`test/fixtures/hostile-renderer.js`", "the evidence's 16-count module, adapted: must fail")],
     steps=["Run the contract job on `pull_request` with a read-only token (free hygiene, D15)."],
     tests=["`node --test test/contract.test.mjs test/lint.test.mjs`"],
     accept=["nazeka, plain, yomitan and rikaikun pass; the hostile fixture fails every rule."],
     short="Lint + AST + jsdom contract run; hostile fixture fails; first-party renderers pass", src=["body", "c26", "c28"])

card(id="T-25", phase=2, title="Render and screenshot CI", owner="infra agent", size="M", deps=["T-21", "T-42", "T-50"], repo="hachidori-theme-store",
     goal="Render every changed theme in pinned Chrome for Testing through Hachidori's Design preview and compare with the committed `screenshot.png`.",
     files=[("new", "`scripts/render.mjs`", "check out Hachidori at the pin, `vendor-themes.mjs --local`, open the Design preview harness with the fixture dictionary, capture 食べたかった / 漢字 (24 senses) / 食 at 560×420 @2× (1120×840), compare ≤ 2 % pixels, upload")],
     steps=["Use raw CDP `Page.captureScreenshot`: Puppeteer's `clip`/`captureBeyondViewport` resize the page and close the popup (c10, c13).", "`fonts-noto-cjk` on the runner."],
     tests=["CI job output + artifacts"],
     accept=["A layout change without a screenshot update fails; nazeka's render matches its committed screenshot."],
     short="Pinned-Chrome renders for every changed theme; stale screenshots fail", src=["body", "c10", "c13"])

card(id="T-26", phase=2, title="Benchmark harness: renderer-aware and end-to-end", owner="perf agent", size="L", deps=["T-15"], locks=["benchmark/"],
     goal="Make `benchmark/hover-popup.mjs` benchmark any theme by slug and report what c26/c27 ask for, with readiness that does not depend on Default's DOM.",
     files=[("edit", L("benchmark/hover-popup.mjs", 19, 29, "hover-popup.mjs"), "`HACHIDORI_HOVER_OPTIONS` merged into the written settings (21-23); kanji-view step; per-scan host measures + CDP metrics + dictionary work counters"),
            ("edit", L("benchmark/hover-popup-probe.js", 13, 55, "hover-popup-probe.js"), "readiness from `data-hd-render-state` + model headwords instead of `.gsm-hoshidicts-expression`/`.gsm-hoshidicts-show-more`"),
            ("new", "`benchmark/theme-fixture.mjs`, `benchmark/theme-summary.mjs`", "24-sense 漢字 + kanji bank; summary.json/md with verdict and label (benchmarking.md)"),
            ("edit", "`benchmark/README.md`", "the guide")],
     steps=["Upstream the evidence `harness-benchmark.patch` idea.", "Record Default numbers before and after the harness change (AGENTS.md:108-111)."],
     tests=["`benchmark/theme-summary.test.mjs`: budget edges (6 ms/12 % fails, 6 ms/8 % passes, heap +3 MiB fails, a text-mode renderer with hd_styles > 0 fails, Default DOM under a renderer fails)"],
     accept=["Default numbers unchanged within noise; one command benchmarks any slug; work counters and nodes reported."],
     short="Harness selects any theme; renderer-neutral readiness; c26/c27 metrics; Default unchanged", src=["body", "c26", "c27", "c28"])

card(id="T-27", phase=2, title="Benchmark every theme: PR gate, weekly catalogue run, published numbers", owner="perf agent", size="M", deps=["T-26", "T-21", "T-20"], repo="hachidori-theme-store",
     goal="c28 \"i want all themes benchmarked\": CI benchmarks every changed theme against Default on each PR and fails on the budgets; a weekly (and on pin bump) sharded job re-measures the whole catalogue, palettes included; results are published into the index for the Store.",
     files=[("new", "`scripts/bench.mjs`", "`fixtures`, `run <slug>`, `summarise`, `check` over Hachidori's harness at `fixture/HACHIDORI_COMMIT` (5 fresh profiles per side; never fewer than 3)"),
            ("new", "`.github/workflows/benchmark-main.yml`", "push to main + weekly cron + pin bump; shards; writes `benchmarks/<slug>.json`; rebuilds `dist/index.json`; bot commit (only job with contents: write)")],
     steps=["Renderer themes also assert the saving: zero Default DOM, no default.css, zero dictionary work in text/none mode (benchmarking.md)."],
     tests=["an over-budget fixture theme fails the PR; a renderer that builds Default DOM fails"],
     accept=["Every published theme has a current benchmarks/<slug>.json and index summary; no author-pasted numbers."],
     short="All themes measured (PR + weekly); budgets enforced; numbers in the index", src=["c28", "c26", "body"])

# ---------------------------------------------------------------- Phase 3: renderers
card(id="T-30", phase=3, title="Extract the shared components", owner="core agent", size="L", deps=["T-10", "T-13", "T-16"], locks=["render/popup.js"],
     goal="Move Default's reusable builders into `extension/render/components.js` (renderer-api.md §6), each returning a Node wired to actions and roles; Default keeps using them with no DOM change.",
     files=[("fill stub", "`extension/render/components.js`", "headword/kanjiLink, tags, frequencies, pitch, deinflection, glossary (rich/text), audio/mine/note/custom buttons, tabs, showMore, lookupStats, kanjiEntry, back/close"),
            ("edit", L("extension/render/popup.js", 3150, 3267, "createEntryHeader"), "→ headword/buttons"),
            ("edit", L("extension/render/popup.js", 403, 665, "createTag…createPronunciationTag"), "tags, frequency, pitch builders"),
            ("edit", L("extension/render/popup.js", 261, 323, "deinflection builders"), "deinflection"),
            ("edit", L("extension/render/popup.js", 2566, 2675, "createNoteControls"), "note/custom buttons"),
            ("edit", L("extension/render/popup.js", 1486, 1544, "createDictionaryTabs"), "tabs"),
            ("edit", L("extension/render/popup.js", 2832, None, "setLookupStats"), "lookupStats slot")],
     steps=["No class renames, no DOM changes; serialise fixture renders before/after and compare."],
     tests=["new `test/theme-components.test.mjs` (each component: roles, actions wiring, nothing built until called)", "existing render suites; screenshots identical"],
     accept=["A non-Default test renderer can compose the components in the host harness; Default's serialised DOM is byte-identical before/after."],
     short="Shared components extracted; Default DOM byte-identical", src=["c26"])

card(id="T-31", phase=3, title="Default as a v1 renderer module", owner="core agent", size="L", deps=["T-30", "T-17", "T-15"], locks=["render/popup.js"],
     goal="Move Default's remaining layout (result chrome, result panel, results/tabs, masonry, toolbar ordering, Back snapshot) into `extension/render/default-renderer.js` registered through `HDRenderers`; popup.js keeps core infrastructure only; the T-14 legacy adapter is retired; `default.css` is adopted only for Default.",
     files=[("new", "`extension/render/default-renderer.js`", ""),
            ("edit", L("extension/render/popup.js", 2846, 4212, "popup.js Default DOM"), "createResultChrome, renderResultPanel, renderKanji, renderResults move out"),
            ("edit", L("extension/render/popup.js", 2320, 2428, "masonry + toolbar ordering"), "move to Default"),
            ("edit", "`extension/design-preview.html`, " + L("extension/manifest.json", 85, 109, "manifest content_scripts"), "load order")],
     steps=["Restore only renderer-owned disclosures on Back (fixes c15 gap 6)."],
     tests=["all suites (make-fixture, extension-smoke, chrome-e2e); screenshots identical; hover benchmark within noise"],
     accept=["popup.js shrinks by about 1,700 lines; Default is just another registered renderer; no behaviour change."],
     short="Default registered like any renderer; legacy adapter gone; no behaviour change", src=["c26"])

card(id="T-32", phase=3, title="Nazeka renderer: text only, its own popup", owner="renderer agent", size="L", deps=["T-12", "T-13", "T-14", "T-16", "T-24"], repo="hachidori-theme-store",
     goal="c28: \"I want the Nazeka theme to behave like Nazeka. No rendering / text only\". `themes/nazeka/` draws Nazeka's popup directly from the model, the way texthook.js `build_div` does, with glossary `text` mode and only the elements its rows need.",
     files=[("new", "`themes/nazeka/{theme.yaml,renderer.js,renderer.css,README.md,screenshot.png}`", "sketch: this package's examples/nazeka.renderer.js")],
     steps=["Fidelity (from the prototype, texthook.js 8b220fb): #111111 box, 1 px #CCCCCC frame, 2 px padding, 2–3 px radii, no shadow, Arial 13 px, content-sized ≤ 600 px; looked-up row at the right at 70 % with three characters of context and the match bold in #99DDFF (from `model.source`).",
            "Rows: `食べる《たべる》～-たい→-た #142 (食べる:たべる)` with 18 px #99DDFF keb / 15 px #99FF99 reb, deconjugation chain, `#rank (keb:reb)` at 80 %; senses as one paragraph `(vt) (1) to eat; to live on; (2) …` via `ctx.glossary.toPlainText`; entries 3 px apart, no separators.",
            "Kanji mode lines: `Currently in individual kanji mode. Press [Back] to cancel.`, Grade, Strokes, Jouyou readings, On'yomi, Kun'yomi (open question 3).",
            "Only audio and Anki: two 24 px borderless buttons calling `ctx.actions`; no top bar, no cards, no pitch graphs, no tags row, no images, no links, no dictionary CSS.",
            "README credits wareya/nazeka (the readme states Apache-2.0; GitHub detects no licence file)."],
     tests=["themes CI: validate, lint, contract (text mode: zero glossary elements), render, benchmark"],
     accept=["Contract + render + benchmark gates green; screenshot close to Nazeka itself (the prototype's reference column); Hachidori-side proof in T-52 (no Default DOM or CSS, zero dictionary work, term/kanji/keyboard/audio/mining/nested/Back/cleanup e2e)."],
     short="Text-only Nazeka popup built from the model; gates green", src=["c28", "c26", "c27", "c05", "body"])

card(id="T-33", phase=6, title="Wicked — only if distinct from Plain (bee-san decides)", owner="renderer agent", size="M", deps=["T-36"], repo="hachidori-theme-store",
     goal="c05: \"a new Wicked theme that just takes what's in the dict and show it directly with no processing and show how much faster that is\". The owner's 2026-09-28 update specifies **Plain** (T-36): dictionary content only, no buttons or chrome, as fast as possible. That covers the fast, unprocessed-text part of c05, and T-52 answers \"how much faster\" with Plain. Build Wicked only if bee-san wants a distinct second theme (open question 11), for example the dictionary's own rich content shown with no Hachidori processing (`glossary: [rich]`), so rich and text can be compared. Otherwise close it as covered by Plain.",
     files=[("new", "`themes/wicked/{theme.yaml,renderer.js,renderer.css,README.md,screenshot.png}`", "only if approved")],
     steps=["Wait for bee-san's answer to open question 11 before starting."],
     tests=["theme-store CI gates"],
     accept=["Either closed as covered by Plain, or built as a distinct theme with gates green and added to T-52's comparison."],
     short="Built only if bee-san wants it distinct from Plain; otherwise closed as covered", src=["c05"])

card(id="T-36", phase=3, title="Plain renderer: dictionary content only, as fast as possible", owner="renderer agent", size="M", deps=["T-12", "T-13", "T-14", "T-16", "T-24"], repo="hachidori-theme-store",
     goal="Owner update (2026-09-28): a 'Plain' theme that renders only the dictionary content, with no buttons or chrome, built to be as fast as possible. It ships as a PR to `bee-san/hachidori-theme-store`, next to Nazeka. For each result it draws the headword and reading, then the dictionary's text (glossary `text` mode). There is no top bar, no buttons, no tags, pitch, frequency, tabs, images, links or dictionary CSS, and the kanji view is plain lines. Audio, Anki, Back and entry navigation stay available through the user's keybinds, because core actions work without buttons (T-16).",
     files=[("new", "`themes/plain/{theme.yaml,renderer.js,renderer.css,README.md,screenshot.png}`", "glossary [text]; components []; layout content-sized; system font")],
     steps=["DOM budget: one `article` per result with at most 3 elements (headword line, reading, text), and every result drawn in one pass. No `ctx.on` listeners at all.",
            "Mark the text `data-hd-scan` (nested lookups) and `data-hd-blur` (definition blur); entries carry `data-hd-entry`, so the host's default `focusEntry` and `setCurrentEntry` drive keybinds.",
            "manifest `ignores`: every Design control that adds chrome (toolbar position, audio button, columns, compact summary, frequency/pitch display, custom buttons/links)."],
     tests=["theme-store CI gates (validate, lint, contract, render, benchmark)"],
     accept=["The fewest nodes and lowest renderer build time of all bundled renderers, and the only one that must earn the ⚡Lighter label.",
             "Zero components, zero listeners, zero dictionary work.",
             "Hachidori-side proof in T-52: keyboard add-note and play-audio work with no buttons on screen."],
     short="Dictionary content only, no buttons/chrome; fewest nodes; ⚡Lighter; keybinds still mine/play", src=["c05", "c28"],
     notes=["Owner update given directly to the planner on 2026-09-28 (not a GitHub comment). The same update renamed the repository to `bee-san/hachidori-theme-store` and made flag-on-main delivery final."])

card(id="T-34", phase=3, title="Yomitan renderer (Yomitan DOM + display.css port)", owner="renderer agent", size="L", deps=["T-30", "T-12", "T-24"], repo="hachidori-theme-store",
     goal="c07: \"can we straight up have a yomitan theme\". Its own popup emitting Yomitan's DOM vocabulary (`.entry[data-type=term]` > `.entry-header` (`.actions`, `.headword-list` > `.headword-term`/`.headword-reading`) + `.entry-body-section[data-section-type=frequencies|pronunciations|definitions]` > `.definition-item[data-dictionary]` > `.definition-tag-list` + `ul.gloss-list`; `.tag` > `.tag-label`), styled by a port of Yomitan's display.css, so users' Yomitan Custom CSS snippets work.",
     files=[("new", "`themes/yomitan/{theme.yaml,renderer.js,renderer.css,README.md,screenshot.png}`", "glossary rich (structured content through `components.glossary`, dictionary CSS scoped and also reachable as `[data-dictionary=\"…\"]`)")],
     steps=["Port display.css + structured-content.css + display-pronunciation.css from yomidevs/yomitan `67db60d` (GPL-3.0): `:root` → the renderer root; credit in README and THIRD_PARTY_NOTICES (open question 12).",
            "Mirror Yomitan's layout attributes (glossaryLayoutMode, compactTags, termDisplayMode) from Hachidori options where they exist."],
     tests=["themes CI gates + three popular Yomitan CSS snippets applied unchanged in the render job"],
     accept=["Snippets apply; e2e term/kanji/actions pass in T-52; benchmark within budget."],
     short="Yomitan-compatible popup; Yomitan CSS snippets work", src=["c07"])

card(id="T-35", phase=3, title="Rikaikun renderer (text, its own popup)", owner="renderer agent", size="M", deps=["T-12", "T-13", "T-14", "T-24"], repo="hachidori-theme-store",
     goal="\"make a nazeka / rikaikun theme to start with\" (#330). After c28 Rikaikun is its own popup, not CSS over Default: headword, reading and flattened gloss rows on Rikaikun's blue box, as melink14/rikaikun `extension/css/popup.css` (dd50b08) draws it.",
     files=[("new", "`themes/rikaikun/{theme.yaml,renderer.js,renderer.css,README.md,screenshot.png}`", "glossary text; colours from the evidence rikaikun.theme.css / popup.css:2-13, 86-110")],
     steps=["Credit melink14/rikaikun (GPL-3.0)."],
     tests=["themes CI gates"],
     accept=["Gates green; looks like Rikaikun's blue theme."],
     short="Rikaikun look as a text renderer; gates green", src=["body", "c28"])

# ---------------------------------------------------------------- Phase 4: Settings and Store
card(id="T-40", phase=4, title="Catalogue-driven Theme select", owner="UI agent", size="S", deps=["T-18", "T-19", "T-50"], locks=["settings.js"],
     goal="Build `#opt-popup-theme` from the vendored `index.json` plus stored themes, grouped Automatic / Palettes (Dark, Light, High contrast) / Layouts (with the flag) / From catalogue; keep and label an unavailable stored slug.",
     files=[("edit", L("extension/settings.js", 1653, 1665, "renderThemeChoices"), ""),
            ("edit", L("extension/settings.html", 629, 686, "Appearance fieldset"), "hint for \"(not installed)\"")],
     steps=["Counts come from the index (no hard-coded 43)."],
     tests=["chrome-e2e \"Settings follows every popup theme\" (" + L("test/chrome-e2e.mjs", 11387, None, "chrome-e2e.mjs:11387") + ") green"],
     accept=["Select reflects the index; unavailable slug visible and kept."],
     short="Select from the index; not-installed state shown and kept")

card(id="T-41", phase=4, title="Theme Store grid and detail pane", owner="UI agent", size="L", deps=["T-18", "T-19", "T-03"], locks=["settings.html", "settings.css"],
     goal="Settings → Design → Theme Store per ui.md: header (source commit, count, search, kind and tag filters, Refresh), card grid (swatches or thumbnail, name, author, kind badge, state button), detail pane (screenshot, description, licence and credits, speed line and ⚡Lighter, layout note, Doesn't use, Suggests, Open on GitHub, Report a problem, Remove), zero network for the grid, behind the flag. No JavaScript switch, no Install of CSS (c28).",
     files=[("new", "`extension/theme-store-ui.js`", "ES module; settings.js calls one `mountThemeStore()`"),
            ("edit", L("extension/settings.html", 688, None, "settings.html (between Appearance and Definitions)"), "the Store section"),
            ("edit", "`extension/settings.css`", "Store styles (reuse the recommended-dictionary list pattern, " + L("extension/settings.html", 238, 262, "settings.html:238-262") + ")")],
     steps=["Accessibility per ui.md (list semantics, one button per card, focus return, aria-live status, forced-colors)."],
     tests=["e2e (T-41 module): grid renders from the vendored index with zero network; filters; focus returns on close", "screenshots compared with the approved T-03 mock"],
     accept=["Matches the approved mock; a11y checks pass; zero requests until Refresh."],
     short="Store UI per approved mock; a11y; zero network until Refresh", src=["body", "c08", "c28"])

card(id="T-42", phase=4, title="Design preview renders the selected renderer", owner="UI + core agent", size="M", deps=["T-15", "T-20"], locks=["design-preview.js"],
     goal="The Design preview iframe goes through `HDRendererHost` with the selected renderer; renderer scripts load with `<script>`; the fallback notice shows if a renderer throws; Custom CSS stays last.",
     files=[("edit", L("extension/design-preview.js", 91, 247, "design-preview.js"), "createPopupView (91), renderResults (211/227), renderKanji (223) through the host"),
            ("edit", "`extension/design-preview.html`", "renderer script + CSS layers")],
     steps=["\"Preview\" in the Store detail pane previews without saving."],
     tests=["e2e (T-42 module): preview renders Nazeka, then Default after a thrown error; existing checkDesignPreview / checkCustomCssPreview green"],
     accept=["Preview == popup for every bundled renderer (T-25 relies on it)."],
     short="Preview uses the host and the selected renderer", src=["body", "c26"])

card(id="T-43", phase=4, title="Suggested options, Undo, and \"doesn't use\"", owner="UI agent", size="M", deps=["T-41", "T-18"],
     goal="c06: \"change them by default but don't lock them\". `suggestedOptions` (13 allowlisted keys, bounds from " + L("extension/reader-options.js", 145, 163, "NUMBER_RANGES") + ") are written with the theme in one `hd_options_write` revision; Undo restores exact prior values until navigation; never re-applied; Reset Design unchanged; Design shows which controls the active renderer ignores.",
     files=[("edit", "`extension/theme-store-ui.js`", "apply + Undo"),
            ("edit", L("extension/settings.js", 106, None, "APPEARANCE_CHOICES"), "\"<theme> doesn't use this\" hints from `js.ignores` next to the bound Design controls")],
     steps=["Unknown key or out-of-range value rejects the whole object."],
     tests=["unit: one revision; exact Undo", "e2e (T-43 module): Use Nazeka → opacity 100; Undo → 85"],
     accept=["No key outside the allowlist changes; Undo exact; ignored controls labelled."],
     short="One-revision apply + exact Undo; ignored controls labelled", src=["c06", "body"])

card(id="T-44", phase=4, title="Catalogue Refresh and catalogue themes", owner="core agent", size="M", deps=["T-19", "T-23", "T-21", "T-41"],
     goal="Refresh fetches `dist/index.json` (If-None-Match, ≤ 1 MiB, schema, final-URL check) into `themes.catalogue`; palettes and variants from it can be used (colour values stored and compiled locally by T-23), updated and removed; renderer themes show \"Arrives with Hachidori x.y\"; screenshots load only when a detail pane opens; optional weekly check, default Off. No CSS or code download exists.",
     files=[("edit", "`extension/theme-state.js` + a handler in " + L("extension/background.js", 973, None, "WORKER_HANDLERS"), "`hd_themes_refresh`"),
            ("edit", L("extension/background.js", 1803, 1831, "reconcileUpdateAlarm"), "pattern for the opt-in schedule"),
            ("edit", "`docs/privacy.md`", "the two endpoints")],
     steps=["Reuse the final-URL check pattern of " + L("extension/managed-dictionary-source.js", 166, 215, "recommendedAssetUrlMatches") + "."],
     tests=["e2e (T-44 module) with intercepted raw.githubusercontent.com: zero requests before Refresh; Refresh → a new palette appears → Use → popup recoloured; a malformed index is rejected and nothing is stored; a newer version → Update; no request for any .js or .css ever"],
     accept=["Privacy doc lists the endpoints; request log proves zero automatic requests."],
     short="Refresh + use/update catalogue palettes & variants; zero automatic requests; no CSS/JS downloads", src=["body", "c28"])

# ---------------------------------------------------------------- Phase 5
card(id="T-50", phase=5, title="`scripts/vendor-themes.mjs`", owner="infra agent", size="M", deps=["T-21", "T-22", "T-23", "T-24"],
     goal="Vendor `dist/index.json`, `palettes.css`, a tiny content-script `catalogue.js` (slug → renderer/files) and the bundled renderers from a pinned `hachidori-theme-store` commit into `extension/vendor/themes/`, with `SOURCE.json` and licences; `--local <path>` for development.",
     files=[("new", "`scripts/vendor-themes.mjs`", "pattern: " + L("scripts/vendor-fluent-icons.py", None, None, "vendor-fluent-icons.py") + " (REVISION + sources.json)"),
            ("new", "`extension/vendor/themes/{index.json,catalogue.js,palettes.css,SOURCE.json,<slug>/renderer.js,<slug>/renderer.css}`", "generated, committed"),
            ("edit", "`distribution/THIRD_PARTY_NOTICES.md`, `distribution/licenses/`", "credits from theme manifests")],
     steps=["At vendoring, run the themes repo's lint/contract at that commit for the bundled renderers (a reviewed diff is the trust step, c28)."],
     tests=["new `test/theme-vendor.test.mjs`: SOURCE.json hashes match files; bundled set = index entries marked for this release; catalogue.js agrees with index.json"],
     accept=["Re-running at the same commit changes nothing; hand edits fail CI."],
     short="Reproducible vendoring with SOURCE.json and licences")

card(id="T-51", phase=5, title="Palettes and catalogue from the vendored themes", owner="core agent", size="S", deps=["T-50", "T-18", "T-17"],
     goal="Swap `render/palettes.css` for `vendor/themes/palettes.css` (byte-identical) and derive `POPUP_THEME_GROUPS` and all hard-coded catalogue counts from the vendored index.",
     files=[("edit", L("extension/reader-options.js", 169, 181, "POPUP_THEME_GROUPS"), "Settings-side from index; reader-options keeps slug-shape validation"),
            ("edit", L("test/extension-smoke.mjs", 4703, 4715, "extension-smoke catalogue") + ", `extension-smoke.mjs:10050, 12200`, " + L("test/chrome-e2e.mjs", 7416, None, "chrome-e2e.mjs:7416"), "read the index"),
            ("edit", "`docs/architecture.md:1786-1787`", "")],
     steps=[], tests=["all suites; `popupTheme: \"dracula\"` pixel-identical"],
     accept=["No hard-coded 42/43/[1,18,23,1] left; screenshots identical."],
     short="Palettes and counts come from the vendored index")

card(id="T-52", phase=5, title="Acceptance run and comparative benchmark", owner="QA + perf agent", size="M", deps=["T-31", "T-32", "T-36", "T-34", "T-35", "T-27", "T-42", "T-44", "T-40", "T-43", "T-51"],
     goal="Prove every c26/c27/c28 acceptance item on main with the bundled renderers and publish the comparison Default · Nazeka onRender prototype · Nazeka direct · Plain · Yomitan · Rikaikun (+ Wicked if T-33 is built) on identical inputs. The Plain row answers c05's \"show how much faster\".",
     files=[("fill", "`test/theme-e2e/T-52-renderers.mjs`", "for each bundled renderer: no Default content DOM (`.gsm-hoshidicts-result-chrome`, `.gsm-hoshidicts-glossary-card`), no default.css adopted, text mode: zero `hd_styles`, zero `.structured-content`, zero `<img>`/`<a>`; none mode: no definition DOM; term, kanji, keyboard (add/view note, play audio, entry navigation, Back), audio, mining, nested popup, incremental Show more, tab switch, clean switch between renderers (listener count stable), fallback on throw"),
            ("new", "`docs/themes/benchmark-report.md`", "the table + raw links; posted to #334")],
     steps=["Measure with benchmark/hover-popup.mjs (T-26), 5 profiles per side, record load average.",
            "Claim only what the numbers show (c26: no guaranteed speedup)."],
     tests=["`node test/chrome-e2e.mjs`, extension-smoke, benchmarks"],
     accept=["Every c26/c27/c28 checkbox in the issue links to a passing check or a measurement."],
     short="All c26/c27/c28 checks proven; comparison table published", src=["c26", "c27", "c28", "c05"])

card(id="T-53", phase=5, title="Release and flag decision", owner="maintainer (bee-san)", size="S", deps=["T-52"],
     goal="Decide whether `experimental.themeStore` turns on by default; release notes; Chrome Web Store listing check (remote-content paragraph, permissions); tag.",
     files=[("edit", "`.github/release-notes-header.md`, `extension/manifest.json` version", "")],
     steps=["Run the release checklist (scripts/check-release.mjs, package-store.py)."],
     tests=["release workflow"], accept=["Released; #334 closed or split into follow-ups."],
     short="Shipped; flag decision recorded")
