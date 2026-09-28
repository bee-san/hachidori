# Card data for #334 plan. Single source of truth rendered by render.py.
B = "https://github.com/bee-san/hachidori/blob/main/"
ISSUE = "https://github.com/bee-san/hachidori/issues/334"
CID = {
    "c00": "5810638099", "c01": "5811238798", "c02": "5812092045", "c03": "5813324725", "c04": "5813363843",
    "c05": "5814079578", "c06": "5814181505", "c07": "5814188170", "c08": "5814298846", "c09": "5814536263",
    "c10": "5815804995", "c11": "5816340659", "c12": "5817632133", "c13": "5817632143", "c14": "5817634699",
    "c15": "5817966878", "c16": "5821454752", "c17": "5821458937", "c18": "5821461298", "c19": "5822316614",
    "c20": "5822319262", "c21": "5825608102", "c22": "5825617147", "c23": "5825619739", "c24": "5827621889",
    "c25": "5827623571", "c26": "5870917807", "c27": "5871156145",
    "c28": "5872606542",
}


def C(key, label=None):
    return f"[{label or key}]({ISSUE}#issuecomment-{CID[key]})"


def L(path, a=None, b=None, label=None):
    url = B + path + (f"#L{a}" if a else "") + (f"-L{b}" if b else "")
    if label is None:
        label = path.split("/")[-1] + (f":{a}" if a else "") + (f"-{b}" if b else "")
    return f"[{label}]({url})"


EVB = "https://github.com/bee-san/hachidori/tree/"


def EV(branch, folder, label):
    return f"[{label}]({EVB}{branch}/{folder})"


PHASES = [
    (0, "Phase 0 — Decisions, contracts, spikes"),
    (1, "Phase 1 — Core seams in Hachidori (behaviour-preserving)"),
    (2, "Phase 2 — `hachidori-theme-store` repository and CI"),
    (3, "Phase 3 — Renderers"),
    (4, "Phase 4 — Settings → Design and the Theme Store"),
    (5, "Phase 5 — Vendoring, acceptance, release"),
    (6, "Backlog — API extensions and the ten community renderer proposals"),
]

CARDS = []


def card(**kw):
    kw.setdefault("col", "Backlog")
    kw.setdefault("locks", [])
    kw.setdefault("notes", [])
    kw.setdefault("src", [])
    kw.setdefault("repo", "hachidori")
    CARDS.append(kw)


# ---------------------------------------------------------------- Done
card(id="T-00", phase=0, col="Done", title="Research, prototypes and this plan", owner="agents + bee-san", size="—", deps=[],
     repo="hachidori (evidence branches)",
     goal="Everything #334 learned before implementation: the onRender host prototype with the Nazeka JS theme, its benchmark (runs 1 and 2) and fault isolation; the CSS drafts (nazeka, rikaikun) and the Custom-CSS leak probes; the themes-repo skeleton (schema 1, validate.mjs, lint config, PR template); ten theme proposals (comments 10–25); the direction changes in comments 26–28; this plan package.",
     files=[("evidence", EV("evidence/issue-330-theme-store", "docs/evidence/issue-330/theme-store", "evidence/issue-330-theme-store"), "prototype, benchmark, skeleton"),
            ("evidence", "`evidence/issue-330-theme-<slug>` × 10", "one branch per proposal (see evidence.md)"),
            ("plan", "[plan/issue-334](https://github.com/bee-san/hachidori/tree/plan/issue-334/docs/plans/issue-334)", "this package")],
     steps=["Prototype and measure the post-render engine (done: 0.3 ms p95 hook, cold +34 ms fixed by preloading).",
            "Collect ten proposals and their API gaps (done).",
            "Rewrite #334 as a plan with a parallel kanban (this card)."],
     tests=["—"],
     accept=["11 evidence branches exist; plan published on `plan/issue-334` and in the #334 body."],
     short="Evidence branches + this plan exist",
     src=["body", "c02", "c10", "c12", "c13", "c15", "c16", "c17", "c19", "c21", "c22", "c24"])

# ---------------------------------------------------------------- Phase 0
card(id="T-01", phase=0, col="Ready", title="Freeze the v1 contracts", owner="architect agent + bee-san sign-off", size="M", deps=[],
     goal="Write down and freeze the interfaces every other card codes against so they can proceed in parallel: renderer definition and lifecycle, `ctx` (actions, components, glossary, schedule, on, el, setVariable, requestLayout, reportRendered, setCurrentEntry, env, options, log), result/kanji/state models, semantic roles, CSS layer order, manifest schema 2, index schema 1, `themes` storage 1, benchmark result 1, message names (`hd_themes_read`, `hd_themes_cas`), capability `rendererThemes`. Also create the `experimental.themeStore` flag now (owner decision 2026-09-28: all Hachidori-side work merges straight into `main` behind this flag, with no long-lived feature branch), so every later card can gate user-visible behaviour from day one, and create the conflict-free test anchors other cards fill in.",
     files=[("new", "`docs/themes/contract.md`", "from this package's renderer-api.md"),
            ("new", "`docs/themes/schemas/*.json`", "the five schemas from this package"),
            ("new", "`extension/render/renderer-contract.js`", "frozen constants only (API_VERSION, MODEL_VERSION, ROLES, CSS_LAYERS, GLOSSARY_MODES, REASONS, UPDATE_EVENTS); classic script publishing `globalThis.HDRendererContract`"),
            ("new stubs", "`extension/render/{result-model,renderer-host,components,palette-css}.js`", "each publishes its frozen namespace with functions that throw `not implemented`, so later cards only fill their own file"),
            ("edit", L("extension/manifest.json", 85, 109, "manifest.json content_scripts"), "register the new classic scripts before `render/popup.js` (one-time manifest edit)"),
            ("edit", "`extension/design-preview.html`", "same scripts, same order"),
            ("edit", L("extension/reader-options.js", 28, 39, "EXPERIMENTAL_FEATURES"), "`themeStore` entry + `false` default under `options.experimental` (AGENTS.md:78; no parallel key); `experimental-settings.js` renders the switch with no extra code"),
            ("new", "`test/fixtures/models/{term-short,term-long,term-deep,kanji,state-empty,state-failure}.json`", "from the hover fixture; shapes = schemas/result-model.v1"),
            ("new", "`test/theme-e2e/index.mjs` + one stub module per e2e-owning card (`T-11`, `T-15`, `T-16`, `T-17`, `T-20`, `T-41`, `T-42`, `T-43`, `T-44`, `T-52`)", "each exports `CHECKS = []` and `run()`; cards fill only their own file"),
            ("edit", L("test/chrome-e2e.mjs", 233, None, "chrome-e2e.mjs PLANNED"), "one `...THEME_E2E_CHECKS` spread + one `await runThemeE2E(ctx)` call (PLANNED already spreads module arrays)"),
            ("new", "`test/theme-contract.test.mjs`", "fixtures carry modelVersion 1; constants frozen; stubs throw")],
     steps=["Copy renderer-api.md → docs/themes/contract.md; copy schemas; resolve every \"T-05 decides\" note as a placeholder.",
            "Add renderer-contract.js and the four stub modules; register them in manifest.json and design-preview.html.",
            "Write the model fixtures (hand-written from the shapes in renderer-api.md; T-12 later proves its builder produces them).",
            "Create the e2e stub modules and wire the aggregator into chrome-e2e once.",
            "bee-san reviews and approves; label the PR `contract` and the card `contract-frozen`."],
     tests=["`node --test test/theme-contract.test.mjs`",
            "`node test/make-fixture.mjs && node test/extension-smoke.mjs` (manifest/content-script change)",
            "`node test/chrome-e2e.mjs` (AGENTS.md:102; stubs add zero checks)"],
     accept=["Contract doc and schemas merged with bee-san's approval.",
             "`experimental.themeStore` exists, off by default, listed under Settings → Advanced → Experimental.",
             "Stubs and e2e anchors merged; every existing suite green; no runtime behaviour change (stubs are never called)."],
     short="Contract + schemas approved; `experimental.themeStore` flag (off); stubs/anchors; suites green",
     src=["c26", "c27", "c28"], notes=["Only a `contract` PR may change these files afterwards (parallel-plan.md)."])

card(id="T-02", phase=0, col="Ready", title="Policy and documentation fixes", owner="docs agent", size="S", deps=[],
     goal="Record the rules and fix documentation drift found while planning, independent of code.",
     files=[("edit", L("AGENTS.md", 7, 28, "AGENTS.md"), "new \"Themes and renderers\" rules: a theme is its own popup, never CSS/JS over Default (c28); renderer JS is bee-san-reviewed extension code vendored from a pinned hachidori-theme-store commit, never fetched/eval'd/imported from the network (Web Store rule); renderers never scrape Default DOM; dictionary content stays sanitised; hotspot locks and test anchors (parallel-plan.md)"),
            ("edit", "`docs/chrome-web-store.md`", "\"Remote content\" section quoting the MV3/RHC lines (security.md); add the missing `scripting` and `userScripts` rows to the permission table"),
            ("edit", "`docs/privacy.md`", "a Custom JavaScript paragraph (missing today); placeholder for the theme endpoints (filled by T-44)"),
            ("edit", "`extension/render/ATTRIBUTION.md`, `distribution/THIRD_PARTY_NOTICES.md`", "credit daisyUI 5 (MIT) for the palettes (not credited today; reader.css:25-31 names it)"),
            ("edit", "`docs/architecture.md`", "\"closed shadow root\" → open (lines 12, 825, 1114, 1129, 1505, 1612, with the prefix-secrecy caveat); \"19 Design reset keys\" → 24 (1786-1787); link to docs/themes/"),
            ("edit", L("extension/settings.html", 816, 839, "settings.html Custom CSS hints"), "\"Applied on top of the theme\" (819)")],
     steps=["Write the AGENTS.md section.", "Fix the four docs.", "Adjust the hint text."],
     tests=["`node test/extension-smoke.mjs` (hint text is not asserted today; confirm)"],
     accept=["Rules and credits present; architecture.md matches the code (open shadow root, 24 keys); CWS permission table complete."],
     short="AGENTS.md rules, CWS remote-content + permission rows, privacy, daisyUI credit, architecture drift fixed",
     src=["body", "c26", "c28"])

card(id="T-03", phase=0, col="Ready", title="Theme Store mock-up screenshots", owner="design agent", size="S", deps=[],
     goal="bee-san asked for a mock UI of the Store with screenshots, names, descriptions and speed (c08). Build a static mock from ui.md with the real Settings stylesheet and palettes, render it in Chrome for Testing 152.0.7977.75 at 1280×900 @2×, and post it to #334.",
     files=[("new branch", "`evidence/issue-334-store-mockup` → `docs/evidence/issue-334/store-mockup/`", "mockup.html, mockup.css, capture.mjs, store-grid.png, store-detail-renderer.png, store-detail-style.png")],
     steps=["Grid with the card states and the Palette/Layout/Variant and tag filters; thumbnails from the evidence screenshots.",
            "Detail pane for a layout (Nazeka: layout note, Doesn't use, Suggests + Undo, speed line) and for a palette from a refreshed catalogue (Use; Remove).",
            "Dark and light Settings palettes; one shot with keyboard focus visible.",
            "Post the PNGs in a #334 comment; record bee-san's feedback in ui.md (T-41 builds the approved version)."],
     tests=["—"], accept=["Three PNGs posted; feedback captured."],
     short="3 PNGs posted to #334; owner feedback recorded in ui.md", src=["c08"])

card(id="T-04", phase=0, col="Ready", title="Create `bee-san/hachidori-theme-store`", owner="maintainer (bee-san)", size="S", deps=[], repo="github",
     goal="The repository does not exist yet (`gh repo view` → \"Could not resolve to a Repository\").",
     files=[("github", "`bee-san/hachidori-theme-store`", "public, GPL-3.0-or-later, default branch `main`")],
     steps=["`gh repo create bee-san/hachidori-theme-store --public --license gpl-3.0 --description \"Community themes for Hachidori\"`",
            "Branch protection on `main`: PR required, green checks, 1 review; CODEOWNERS enforced.",
            "Actions: default `GITHUB_TOKEN` read-only; allow bot commits only from `benchmark-main.yml`.",
            "Labels: `new-theme`, `palette`, `style`, `renderer`, `agent-ready`, `blocked`."],
     tests=["—"], accept=["Repo exists with protection; agents can open PRs (fork or branch)."],
     short="Repo exists, protected, labels created", src=["body"])

card(id="T-05", phase=0, col="Ready", title="Spike: renderer loading and preload", owner="perf agent", size="M", deps=[],
     goal="Decide how bundled renderer code reaches the content-script world with no Default-first render and no cold regression: `import(chrome.runtime.getURL(…))` via web_accessible_resources; `chrome.scripting.executeScript({files})` on request; `chrome.scripting.registerContentScripts` for the active renderer (+ executeScript into open tabs on change); or an always-listed content script. Measure with 30 KB and 120 KB dummy renderers.",
     files=[("new", "`docs/themes/loading.md`", "decision record with raw numbers"),
            ("spike branch", "`spike/T-05-renderer-loading`", "throwaway code, not merged")],
     steps=["Cold first hover (first frame, complete) vs Default with hover-popup.mjs, ≥5 profiles per side, per mechanism.",
            "Per-frame cost with `all_frames: true` (" + L("extension/manifest.json", 85, 109, "manifest.json:91") + ") on an iframe-heavy page.",
            "Overlay host: does `chrome.scripting` exist under `test/chrome-overlay.mjs`? Else specify `rendererThemes: false`.",
            "Theme switch on an already-open tab; Design preview path (`<script>`); fingerprinting exposure of each option."],
     tests=["hover-popup.mjs runs recorded in loading.md"],
     accept=["Chosen mechanism: cold-first-hover Δ within the benchmark budget vs Default; works in overlay mode or has a capability fallback; T-20 unblocked."],
     short="Decision record with numbers; chosen loader keeps cold first hover within budget; overlay answer",
     src=["body", "c26"], notes=["Prototype evidence: loading at the first popup cost +19.7 ms first / +34.3 ms complete on a cold hover; loading at content-script start restored parity."])

# ---------------------------------------------------------------- Phase 1
card(id="T-10", phase=1, title="Semantic roles in the Default DOM", owner="core agent", size="S", deps=["T-01"], locks=["render/popup.js"],
     goal="Additive only: Default's DOM carries the `data-hd-*` roles (renderer-api.md §7) next to its classes, so core code (T-11) and other renderers stop depending on Default class names.",
     files=[("edit", L("extension/render/popup.js", 3150, 3267, "createEntryHeader"), "back/close/audio roles"),
            ("edit", L("extension/render/popup.js", 3361, 3365, "appendResult"), "`data-hd-role=entry` + `data-hd-entry`"),
            ("edit", L("extension/render/popup.js", 3292, None, "renderResultPanel"), "glossary content `data-hd-scan` + `data-hd-blur`; lookup-stats slot"),
            ("edit", L("extension/render/popup.js", 3732, 3888, "renderKanji"), "entry/back roles"),
            ("edit", L("extension/render/popup.js", 3890, 4212, "renderResults"), "tab roles"),
            ("edit", L("extension/render/glossary.js", 386, 491, "appendExpressionRuby"), "kanji links `data-hd-role=kanji-link`")],
     steps=["Add attributes where the T-11 selector table needs a twin.", "No class, text or order changes."],
     tests=["new `test/theme-roles.test.mjs` (jsdom via createPopupView: every Default control carries its role)",
            "existing progressive-results / custom-buttons-renderer / pitch-badges tests", "`node test/extension-smoke.mjs`"],
     accept=["Every selector in renderer-api.md §7 has a role twin; screenshots unchanged; suites green."],
     short="Every core-read Default element carries its role; no visual change")

card(id="T-11", phase=1, title="Core behaviour reads roles, not Default classes", owner="core agent", size="M", deps=["T-10"], locks=["content.js"],
     goal="Replace the Default-class selectors core behaviour depends on with roles, so a renderer without Default's DOM keeps nested lookups, blur reveal, Back focus and keybinds.",
     files=[("edit", L("extension/content.js", 1050, 1071, "resolveDefinitionCandidate"), "scan roots → `[data-hd-scan]`"),
            ("edit", L("extension/content.js", 2101, 2160, "buildLevelUi"), "blur reveal (2154) → `[data-hd-blur]`"),
            ("edit", L("extension/content.js", 2758, 2780, "focusPopupControl/focusKanjiLink"), "→ roles"),
            ("edit", L("extension/content.js", 3794, 3850, "runKeybindAction"), "`historyBackward` (3824-3825) → back role"),
            ("edit", L("extension/render/popup.js", 2490, 2512, "retained focus"), "tab/back roles"),
            ("edit", L("extension/anki-content.js", 465, 530, "anki-content controls"), "placement after the back/close role"),
            ("edit", L("extension/audio-content.js", 40, None, "audio-content.js:40"), "audio control role"),
            ("edit", "`extension/design-preview.js`", "kanji-link/back selectors")],
     steps=["Switch selectors; keep a table of any remaining Default-class reads with the reason."],
     tests=["extension-smoke render + keybind stages; chrome-e2e `checkNestedLinks`, `checkDefinitionBlur`, `checkKanjiGroup`",
            "a smoke stage with a fake view that renders roles but no Default classes: nested scan, blur reveal, Back focus and `historyBackward` still work"],
     accept=["No behaviour selector in content.js/anki-content.js/audio-content.js uses a Default layout class (documented exceptions only); suites green."],
     short="Core selectors use roles; fake role-only view keeps nested scan, blur, Back focus, keybinds")

card(id="T-12", phase=1, title="Result model builder", owner="core agent", size="M", deps=["T-01"],
     goal="`extension/render/result-model.js` (`HDResultModel`): `buildTermModel(results, candidate, context)`, `buildKanjiModel`, `buildStateModel`; deep-frozen, `modelVersion: 1`, with the data every prototype scraped from DOM: reading, furigana segments, pitch position/morae, frequencies with mode and display value, tags, trace, `source` (sentence/offset from " + L("extension/content.js", 690, 695, "refineSentence") + "), dictionaries, tabs, `reason`, opaque glossary handles.",
     files=[("fill stub", "`extension/render/result-model.js`", "pure functions, no DOM"),
            ("new", "`test/theme-result-model.test.mjs`", "builder output = T-01 fixtures; frozen; no document access; handles opaque")],
     steps=["Map the objects `renderResults` receives (" + L("extension/render/popup.js", 3890, None, "popup.js:3890") + ") and the kanji shape onto the schema.",
            "Furigana segments at data level (the split appendExpressionRuby does in DOM).",
            "Frequency display values via the existing formatters (" + L("extension/render/popup.js", 403, 466, "popup.js:403-466") + ")."],
     tests=["`node --test test/theme-result-model.test.mjs`"],
     accept=["Fixtures reproduced exactly; runs under plain Node (no jsdom); builds a 32-result model in ≤ 0.2 ms median (reported)."],
     short="Builder reproduces fixtures; pure; fast")

card(id="T-13", phase=1, title="Glossary modes and `glossaryToPlainText`", owner="core agent", size="M", deps=["T-01"], locks=["render/glossary.js"],
     goal="c27: a data-level `glossaryToPlainText(raw, options)` that walks structured-content JSON without DOM; `renderGlossary(handle, {mode})` for components (rich → the existing structured path, text → one text node); `none` never touches glossary data; dictionary CSS is requested only when a rich glossary was rendered.",
     files=[("edit", L("extension/render/glossary.js", 1256, 1318, "glossary.js"), "new functions beside appendTextOnlyGlossary (kept, not renamed) + exports"),
            ("new", "`test/theme-glossary-text.test.mjs`", "structured fixtures, 500-deep nesting, images/links/tables/details")],
     steps=["Rules: block → line break or `; `, list items numbered/joined, ruby → base (+ optional reading), images → alt or omitted, links → text, details → summary + content, tables → cells joined. Reference: the data-level walker in " + L("extension/render/popup.js", 1963, None, "extractCompactDefinitionSummary") + " and Yomitan's `_getText`.",
            "Expose a `requireDictionaryStyles` signal consumed by T-15 (replaces the unconditional " + L("extension/content.js", 1610, None, "ensureDictionaryStyles") + " call for non-rich renderers)."],
     tests=["`node --test test/theme-glossary-text.test.mjs`", "anki-glossary tests unchanged (Anki output must not change)"],
     accept=["Text mode creates zero elements (spy); none mode never reads glossary data; 24-sense entry flattens in ≤ 0.3 ms p95; Anki output unchanged."],
     short="Data-level plain text; text mode builds no DOM; rich unchanged; Anki unchanged", src=["c27"])

card(id="T-14", phase=1, title="Renderer host, registry and fallback", owner="core agent", size="L", deps=["T-01"],
     goal="`extension/render/renderer-host.js`: `HDRenderers.register/get/whenReady`; `createLevelView` returning a guarded proxy that exposes the view API content.js uses today and maps it onto renderer v1; the `ctx` implementation; guarded sync calls, `ctx.on` handlers and `ctx.schedule` callbacks; the fallback protocol (renderer-api.md §9); generation guard; `performance` marks and `data-hd-render-state`; a legacy adapter that registers `default` by wrapping `HDPopup.createPopupView` until T-31.",
     files=[("fill stub", "`extension/render/renderer-host.js`", "no dependency on content.js internals"),
            ("new", "`test/theme-renderer-host.test.mjs`", "jsdom"),
            ("new", "`test/fixtures/renderers/throwing.js`, `minimal.js`", "tiny test renderers")],
     steps=["Registry + declaration checks (apiVersion, glossary, components).",
            "ctx: el/text (no HTML strings, no on*), on, schedule, setVariable (`--theme-*` only), requestLayout, reportRendered, setCurrentEntry, log.",
            "Fallback: destroy in try, release listeners/timers/sheets, re-render last model with Default + Default CSS, memo per page, one warning, `data-hd-renderer-fallback`."],
     tests=["throw in renderTerms / in a ctx.on handler / in a schedule callback → Default renders the same model; renderer sheet and listeners gone; one warning; the next lookup does not retry",
            "renderer switch destroys the old view once; stale generation output ignored; apiVersion 2 refused; whenReady timeout → Default"],
     accept=["All host tests green; the legacy adapter is behaviour-neutral (proved in T-15)."],
     short="Host + ctx + fallback + marks; failure → Default with clean-up, proven in jsdom", src=["c26"])

card(id="T-15", phase=1, title="Wire the host into content.js", owner="core agent", size="L", deps=["T-11", "T-12", "T-14", "T-16"], locks=["content.js"],
     goal="Every level view is created through the host and fed models; renderer switching on options change; actions-based keybinds; dictionary CSS only on request; layered stylesheets. Behaviour with Default must be identical.",
     files=[("edit", L("extension/content.js", 2101, 2210, "buildLevelUi"), "`createPopupView` call (2161-2208) → `HDRendererHost.createLevelView`"),
            ("edit", L("extension/content.js", 2843, 2925, "renderTerms"), "TermModel"),
            ("edit", L("extension/content.js", 3103, 3205, "executeKanjiRequest"), "KanjiModel"),
            ("edit", L("extension/content.js", 1798, 1860, "handleLookupFailure/handleRenderFailure"), "StateModel"),
            ("edit", L("extension/content.js", 2211, 2248, "bindResultActions"), "action registration by result index"),
            ("edit", L("extension/content.js", 3794, 3850, "runKeybindAction"), "playAudio/addNote/viewNotes/history → `actions.*` with the current entry"),
            ("edit", L("extension/content.js", 4082, 4207, "adoptOptions"), "resolve theme → renderer; destroy/recreate views; re-render visible levels"),
            ("edit", L("extension/content.js", 2022, 2039, "readerStyleSheet"), "layer list (T-17 files) as separate constructed sheets"),
            ("edit", L("extension/content.js", 1610, None, "ensureDictionaryStyles"), "only after a rich render")],
     steps=["Keep internal names used by " + L("benchmark/hover-popup-probe.js", 45, 55, "hover-popup-probe.js") + " and the extension-smoke instrumentation (`buildUi`, `levels`, `rootLevel`, `resolveDefinitionCandidate`, `showKanji`, `restoreTermRender`), or update them in this PR.",
            "Benchmark Default before/after (AGENTS.md:108-111)."],
     tests=["make-fixture, extension-smoke, chrome-e2e (all green)",
            "e2e (T-15 module): a test renderer registered at runtime renders a lookup with zero Default DOM; switching renderers twice leaves a stable listener count",
            "`benchmark/hover-popup.mjs` Default before/after within the budget"],
     accept=["Identical behaviour with Default; runtime renderer switch works on open popups; no stale listeners or updates; benchmark within budget."],
     short="All levels through the host; switching works; Default identical; benchmark within budget", src=["c26"])

card(id="T-16", phase=1, title="Button-less audio and Anki actions", owner="core agent", size="M", deps=["T-01"], locks=["audio-content.js", "anki-content.js"],
     goal="c26: keyboard mining, autoplay and audio must not break when a renderer omits or moves a control. Actions work by result, with state events; buttons are optional views of that state.",
     files=[("edit", L("extension/audio-content.js", 226, 290, "audio-content.js"), "`play(owner, result, {source})`, autoplay without a button, state subscribe; `bind` stays for painting"),
            ("edit", L("extension/anki-content.js", 465, 580, "anki-content.js"), "`mine(owner, result, mode)`, `state()`, subscribe; `controls()` only when a mine-button component is requested; custom Anki buttons by descriptor id (520-521)"),
            ("edit", L("extension/render/reader.css", 1481, None, "reader.css:1481"), "`showPopupAudioButton=false` → the button is not rendered (instead of CSS-hidden); autoplay and keybind unaffected")],
     steps=["Keep the current Default behaviour byte-identical when buttons exist."],
     tests=["extend `test/audio-content.test.mjs`, `test/anki-content.test.mjs` (play/mine without buttons, state events)",
            "chrome-e2e `checkPopupAudio`, `checkAnkiSubmission`, keybind checks"],
     accept=["With no buttons rendered: autoplay plays, add/view-note keybinds work, playAudio keybind plays; with Default: unchanged."],
     short="Audio/Anki work with no buttons; Default unchanged", src=["c26"])

card(id="T-17", phase=1, title="Split reader.css into layers", owner="styles agent", size="M", deps=["T-01"], locks=["render/reader.css"],
     goal="c26 CSS split, behaviour-preserving: palettes, infra, shared components and Default's own layout become separate files; their concatenation in the old order equals today's rule list.",
     files=[("new", "`extension/render/palettes.css`", "reader.css:25-959 verbatim (html + :host selectors)"),
            ("new", "`extension/render/infra.css`", "host reset (15-23), highlight (961-995), popup frame + semantic derivation (997-1131 minus Default layout), scroll root, resize handle, [inert]"),
            ("new", "`extension/render/components.css`", "tags, pitch, frequency, buttons, audio menu, note form, tabs, kanji link, glossary + structured content (`gloss-*`), image preview"),
            ("new", "`extension/render/default.css`", "result chrome/top bar, cards, glossary grid (2356-2365), metadata strip, compact summary (1730-1745), palette-specific Default rules (1147-1229, 2050-2060)"),
            ("delete", L("extension/render/reader.css", 1, 2860, "reader.css"), "after all loaders move"),
            ("edit", L("extension/content.js", 2022, 2039, "readerStyleSheet"), "concatenate the four files in the old order (one sheet, until T-15 splits)"),
            ("edit", L("extension/design-preview.js", 5, 18, "design-preview.js"), "`<link>`s"),
            ("edit", L("extension/settings.html", 11, None, "settings.html:11") + ", `extension/startup.html:9`", "links"),
            ("edit", L("extension/manifest.json", 119, 131, "manifest.json WAR"), "the four files"),
            ("edit", "`test/autumn-theme.test.mjs`, " + L("test/extension-smoke.mjs", 4703, 4715, "extension-smoke cssThemes"), "read palettes.css")],
     steps=["Move rules without editing them; keep comments and SPDX headers (render/ files keep upstream copyright lines, extension/README.md)."],
     tests=["new `test/theme-css-split.test.mjs`: concatenation equals the old reader.css rule by rule (parse both)",
            "chrome-e2e design/theme screenshots identical (default, autumn, high-contrast, solarized-light, miku, girlypop); `test/chrome-settings-first-frame.mjs` unchanged",
            "e2e (T-17 module): dictionary `@scope` styles vs renderer/theme/custom CSS order pinned in real Chrome"],
     accept=["Rule-by-rule equality; identical screenshots; Settings first frame unchanged."],
     short="Four layer files; rule-by-rule equal; screenshots identical", src=["c26"])

card(id="T-18", phase=1, title="Options and compatibility for theme slugs", owner="core agent", size="M", deps=["T-01"], locks=["reader-options.js", "backup-state.js"],
     goal="A stored or restored theme slug survives; strict writes only accept known themes; selecting a renderer theme requires `experimental.themeStore` (the flag T-01 created).",
     files=[("edit", L("extension/reader-options.js", 546, 565, "normaliseField"), "`popupTheme`: slug-shape check instead of the enum (unknown → kept)"),
            ("edit", L("extension/reader-options.js", 536, 544, "ENUMERATED_OPTIONS"), "drop popupTheme from the enum map"),
            ("edit", L("extension/background.js", 1250, 1258, "hd_options_write"), "strict: `auto`, bundled catalogue or installed only"),
            ("edit", L("extension/backup-state.js", 71, 90, "validBackupReaderOptions"), "accept slug-shaped ids"),
            ("edit", L("test/extension-smoke.mjs", 4703, 4715, "extension-smoke catalogue check") + ", `docs/architecture.md:1786-1787`", "\"unknown\" now kept")],
     steps=["No new option keys for theme data (data-model.md)."],
     tests=["`test/reader-options.test.mjs` (slug survives; `\"Nazeka!\"` → default; strict validation with a provided catalogue)",
            "`test/backup-state.test.mjs` (slug restores; malformed rejects)", "`node test/extension-smoke.mjs`"],
     accept=["Existing ids unchanged; slug survives normalise and backup; strict writes enforce catalogue ∪ installed; renderer themes selectable only with the flag on."],
     short="Slug survives; strict write checks catalogue ∪ installed; renderer themes need the flag")

card(id="T-19", phase=1, title="`themes` storage, messages and backup", owner="core agent", size="M", deps=["T-18"], locks=["backup-state.js"],
     goal="SW-owned revisioned `themes` record (schemas/themes-storage.v1): stored palettes and variants as colour values, the refreshed catalogue cache and the schedule; CAS, caps and palette-value checks; backup support.",
     files=[("new", "`extension/theme-state.js`", "normalise, CAS merge, caps, palette-value validation (SW module)"),
            ("edit", L("extension/background.js", 973, None, "WORKER_HANDLERS"), "`hd_themes_read`, `hd_themes_cas` inside " + L("extension/background.js", 1546, None, "serialiseStorage")),
            ("edit", L("extension/backup-state.js", 13, 18, "backupRevisions"), "+ `themes` (installed; not catalogue)"),
            ("edit", "`docs/backup-format.md`", "section"),
            ("edit", L("extension/content.js", 4082, None, "content.js adoptOptions"), "read `themes` at start + onChanged (tiny; coordinate with the content.js lock)")],
     steps=["Sharing stays slug-only (" + L("extension/background.js", 190, None, "SHARED_STATE_KEYS") + " unchanged, documented)."],
     tests=["new `test/theme-state.test.mjs` (CAS conflict, caps, invalid palette value rejected)", "`test/backup-state.test.mjs` (round-trip, invalid entry rejected, old backup without themes)", "extension-smoke handler stage"],
     accept=["Only the SW writes `themes`; CAS like hd_options_write; backups round-trip; old backups restore."],
     short="SW-owned record + CAS handlers + backup round-trip")

card(id="T-20", phase=1, title="Renderer loading and preload", owner="core + perf agent", size="M", deps=["T-05", "T-15"], locks=["content.js", "manifest.json"],
     goal="Implement T-05's decision: the active renderer is available when the content script starts; first render waits ≤ N ms for `whenReady`, else Default fallback; overlay hosts without the capability use Default.",
     files=[("new", "`extension/renderer-loader.js`", "SW side of the chosen mechanism (e.g. registerContentScripts for the active renderer; executeScript into open tabs on change)"),
            ("edit", L("extension/content.js", 2060, 2099, "buildUi"), "preload at start; renderer CSS fetched once"),
            ("edit", L("extension/manifest.json", 119, 131, "manifest.json WAR"), "`vendor/themes/*/renderer.css` (and JS if import() wins)"),
            ("edit", L("extension/overlay-mode.js", 8, 19, "HOST_CAPABILITIES"), "`rendererThemes`")],
     steps=["Load at content-script start, never at the first popup."],
     tests=["e2e (T-20 module): fresh profile with Nazeka selected renders Nazeka on the first hover and never builds Default DOM (MutationObserver probe); theme switch applies to an open tab without reload",
            "`test/chrome-overlay.mjs` green", "cold first hover within the budget vs Default"],
     accept=["Cold-first-hover parity; no Default DOM under a renderer theme; overlay graceful."],
     short="Renderer ready at start; cold parity; overlay capability")
