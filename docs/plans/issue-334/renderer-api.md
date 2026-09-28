# Renderer contract v1 (frozen by T-01)

This is the interface every renderer card (T-31 Default, T-32 Nazeka, T-36 Plain, T-34 Yomitan, T-35 Rikaikun, T-33 Wicked if built, T-70–T-79) and every core card (T-12, T-14, T-15, T-16, T-30) codes against. It implements three comments: [#334 comment 5870917807](https://github.com/bee-san/hachidori/issues/334#issuecomment-5870917807) ("themes should own the actual popup renderer"), [5871156145](https://github.com/bee-san/hachidori/issues/334#issuecomment-5871156145) ("renderer control over dictionary content") and [5872606542](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542) ("i want them to be their own popup, so we save on rendering cost"). Changing anything here needs a `contract` PR that amends this file. A feature PR must not change it. The rules for doing so are in [parallel-plan.md](parallel-plan.md#contract-changes).

```text
Lookup → core (engine, deinflection, cancellation, levels, positioning, keyboard, audio, Anki)
       → result model (frozen, versioned, structured)          render/result-model.js   (T-12)
       → renderer host (registry, guards, fallback, timing)    render/renderer-host.js  (T-14)
       → selected renderer.createView(ctx)                     default-renderer.js (T-31) | vendor/themes/<slug>/renderer.js
             ↳ may compose shared components                   render/components.js     (T-30)
       → popup content DOM inside ctx.root  +  the renderer's CSS layer
```

## 1. Ownership

| Hachidori core owns (never a renderer) | The selected renderer owns | Shared components (optional, created only on request) |
| --- | --- | --- |
| Lookups, deinflection, the structured result data, request generations and cancellation (`lookupToken`, content.js), popup levels and nesting, positioning (`placePopup`/`positionPopup`), dismissal, keybinds (`runKeybinds`), audio (HDAudio) and Anki (HDAnki) actions and their state, lookup statistics, definition-blur state, source highlight, dictionary-style management, options and storage | Everything inside `ctx.root`: headwords, readings, rows or cards, where controls go and how they look, which optional metadata appears, the glossary mode, and its own CSS | Headword with ruby and kanji links, tags, frequencies, pitch, deinflection, **rich or text glossary**, audio / mine / note / custom buttons, tabs, Show more, lookup-stats slot, kanji entry block, back / close. They are built from Default's current builders (T-30) and keep their roles and actions wiring. |

Renderers never duplicate lookup, audio or Anki logic. Dictionary-supplied HTML and CSS stay behind the existing sanitisation (`appendStructuredValue`, `isSafeDictionaryStyle`). Reviewed renderer code does not make dictionary content trusted.

## 2. The renderer file

A renderer is **one classic script** whose single top-level statement is `HDRenderers.register(definition)`. Content scripts cannot be ES modules. The same file also works with `chrome.scripting` injection, registered content scripts, a `<script>` tag in extension pages, and dynamic `import()`, so T-05 can choose any of them. The file lives at `hachidori-theme-store/themes/<slug>/renderer.js` and is vendored to `extension/vendor/themes/<slug>/renderer.js`. The Default renderer is part of Hachidori itself (`extension/render/default-renderer.js`, T-31).

```js
HDRenderers.register({
  id: "nazeka",                 // = theme slug that defines the renderer
  apiVersion: 1,                // the host refuses any other value → Default + store note
  version: "2.0.0",             // = theme.yaml version
  glossary: ["text"],           // modes it may use: "rich" | "text" | "none"; must equal theme.yaml js.glossary
  components: ["kanjiLink"],    // shared components it may create; must equal theme.yaml js.components
  layout: { size: "content" },  // "fixed" (user width/height; default) | "content" (sized to content, bounded by width/height)
  needs: [],                    // optional model extensions: "placement" | "headwordKanji" | "sentenceSegments" (backlog T-60/T-64/T-65)
  createView(ctx) {             // once per popup level and renderer
    return {
      renderTerms(model) {},    // required — TermModel
      renderKanji(model) {},    // required — KanjiModel
      renderState(state) {},    // required — StateModel: empty | no-dictionaries | failure | notice
      update(event) {},         // optional — see §5
      focusEntry(target) {},    // optional — host default walks [data-hd-entry]
      snapshot() {},            // optional — opaque Back state (scroll, open disclosures)
      restore(snapshot) {},     // optional
      destroy() {},             // required — the host has already removed listeners/timers it owns
    };
  },
});
```

`check-renderer.mjs` (T-24) checks that `id`, `apiVersion`, `glossary`, `components`, `layout` and `needs` equal the `js` block in `theme.yaml`.

## 3. `ctx` (frozen; the only capability surface the contract offers)

| Member | Meaning |
| --- | --- |
| `root` | Renderer-owned `div[data-hd-renderer=<id>]` inside the level's `.gsm-hoshidicts-popup`. The host empties it between renderers. |
| `depth`, `options` | Popup level. A frozen copy of the Design keys (`DESIGN_OPTION_KEYS`, reader-options.js:183-188) plus metadata keys. Read-only. |
| `env` | Frozen `{ reducedMotion, forcedColors, colorScheme, pageZoom, apiVersion }`. Changes arrive as `update({type:"env"})`. |
| `el(tag, props?, ...children)`, `text(string)` | The only sanctioned way to create DOM. `props` sets properties, attributes, `data-*` and `aria-*`. `on*` and HTML strings are refused. |
| `on(node, type, handler, options?)` | Listener on a node inside `root`. Wrapped in the failure guard and removed on destroy. |
| `schedule.frame(cb)`, `schedule.after(ms, cb)`, `schedule.idle(cb)` | Host-owned timers. Guarded, cancelled on destroy and on renderer switch. Answers RPG Dialogue's `api.onFrame/after` ask ([5825608102](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825608102)). |
| `setVariable(name, value, node = root)` | `--theme-*` custom properties only, on `root` or a node inside it. Per-node, as Kanji Atlas asked ([5815804995](https://github.com/bee-san/hachidori/issues/334#issuecomment-5815804995)). |
| `requestLayout()` | Re-place the popup on the next frame. With `layout.size: "content"` the core measures the renderer's content, which also fixes hit-testing on the empty frame ([5817632133](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817632133) gap 5). |
| `reportRendered({ complete })` | Progress for incremental rendering. `complete: true` sets `data-hd-render-state="complete"` and the `hd:render:complete` mark that the benchmark waits on. |
| `setCurrentEntry(index)` | Tells the core which entry keybinds act on (Yomitan-style current entry). |
| `actions` | §4. Work with or without any button. |
| `components` | §6. Optional building blocks. |
| `glossary` | `toPlainText(handle, { separator?, maxLength? }) → string` (data-level; no DOM) and `render(handle, { mode: "rich" }) → Node` (the structured-content renderer; also requests dictionary CSS). Only modes declared in `glossary` are allowed. `none` means neither is called. |
| `log(...args)` | Prefixed `console.debug`, rate-limited. |

**Not provided, and flagged by the renderer lint (T-24):** `document`, `window`, `globalThis`, `chrome`, `fetch`/`XMLHttpRequest`/`WebSocket`/`navigator`, storage, raw timers, observers, `eval`/`Function`, `import`, `innerHTML`-style HTML strings, `addEventListener` (use `ctx.on`), `getRootNode`/`ownerDocument`. This is **contract hygiene, not security**. Anything outside `ctx` escapes the host's clean-up, fallback and timing, and breaks when Hachidori refactors. Trust comes from bee-san reviewing every theme PR ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)). A renderer runs like Hachidori's own popup code.

## 4. `ctx.actions` (core-owned; addressed by result `index`)

`playAudio(index, { source? })` · `openAudioMenu(index, anchorNode)` · `mine(index, "add" | "view")` · `openNote(index)` · `customButton(index, buttonId)` · `lookupKanji(character, sourceNode)` · `lookupText(text, sourceNode)` (nested popup) · `back()` · `close()` · `selectTab(tabId)` · `showMore()` · `revealDefinitions()` · `openExternal(url)` (through `hd_open_external`) · `retry()` · `state(index) → { audio: "idle"|"loading"|"playing"|"unavailable", mining: { state: "unknown"|"ready"|"adding"|"added"|"duplicate"|"error", canView } }`.

Keybinds (`addNote`, `viewNotes`, `playAudio`, `playAudioFromSource`, `historyBackward`, entry navigation), autoplay and custom Anki buttons go through the same actions. So **omitting or moving a button never breaks them** (T-16, T-15). Today they are coupled to Default elements: `level.entryMining[entry].actions.querySelector(".gsm-hoshidicts-mine-button…")` and `level.entryAudio[entry].button` in `runKeybindAction` (content.js:3800-3841), `playButton(button)` in audio-content.js:286, and the mine button injected by anki-content.js `controls()` (465). `copyText` is backlog T-62.

## 5. Update events (`view.update(event)`)

| `type` | Payload | When |
| --- | --- | --- |
| `options` | `{ options }` | Design options changed. A renderer switch is **not** an update: the host destroys the view and creates the new renderer's view. |
| `presentation` | `{ dictionaries, tabs }` | Dictionary presentation or aliases changed (`updateDictionaryPresentation`). |
| `blur` | `{ state }` | Definition-blur state (`setDefinitionBlurState`). The core reveals on hover over `[data-hd-blur]`. |
| `lookupStats` | `{ payload }` | Lookup count. The `components.lookupStats()` slot paints itself. Renderers without it may use the payload. |
| `actionState` | `{ index, audio, mining }` | Audio or mining state changed. Replaces the CSS-animation detectors in Geocities and Tango ([5821454752](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821454752), [5822316614](https://github.com/bee-san/hachidori/issues/334#issuecomment-5822316614)). |
| `customButtons` | `{ buttons }` | Custom button templates changed. |
| `env` | `{ env }` | Reduced motion, forced colours, colour scheme or page zoom changed. |
| `placement` | `{ side, anchor }` | Backlog T-60, delivered only with `needs: ["placement"]`. |

## 6. Shared components (`ctx.components`)

Each call returns a detached Node that already carries its roles (§7) and actions wiring. Nothing is built until it is called. Component CSS (`render/components.css`) is adopted only when the renderer declares at least one component.

`headword(result, { ruby = true, kanjiLinks = true })` · `kanjiLink(character)` · `tags(tags)` · `frequencies(result, { names, average })` · `pitch(result, { furigana, badge })` · `deinflection(result)` · `glossary(definition, { mode: "rich" | "text" })` · `audioButton(index)` · `mineButton(index)` · `noteButton(index)` · `customButtons(index)` · `tabs(model)` · `showMore(model)` · `lookupStats()` · `kanjiEntry(entry)` · `backButton()` · `closeButton()`.

## 7. Semantic roles (read by core; replace Default class selectors)

| Attribute | Core behaviour that reads it | Default class it replaces (content.js line on main 3c7e9df) |
| --- | --- | --- |
| `data-hd-scan` | Hover over it starts a nested lookup | `.gsm-hoshidicts-glossary-content, .gsm-hoshidicts-compact-definition-summary` (1071) |
| `data-hd-blur` | Blurred when blur is on, revealed on hover | `.gsm-hoshidicts-definitions, …compact-definition-summary` (2155) |
| `data-hd-role="entry"` + `data-hd-entry="<index>"` | Entry navigation, current entry | `.gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry` (popup.js:2267-2274) |
| `data-hd-role="kanji-link"` | Focus restore after Back | `.gsm-hoshidicts-kanji-link` (2777-2783) |
| `data-hd-role="back"` / `"close"` | Focus, `historyBackward`, mine-button placement | `.gsm-hoshidicts-kanji-back`, `.gsm-hoshidicts-popup-close` (3831; popup.js:2509-2510; anki-content.js) |
| `data-hd-role="tab"` | Retained focus on re-render | `[role="tab"]` (popup.js:2509) |
| `data-hd-role="audio"`, `"mine"` | Painted state only. Actions are index-based. | `.gsm-hoshidicts-audio-control` (audio-content.js:40), `.gsm-hoshidicts-mine-button` (3834-3835) |
| `a[data-hoshidicts-query]` | Internal links open child popups | unchanged (glossary.js structured links) |

## 8. Lifecycle, reasons, incremental results

1. Selection is resolved **before** any result content is built. When Nazeka is selected, the Default renderer does not run.
2. `createView` runs once per level and renderer. `renderTerms`/`renderKanji`/`renderState` run for every render. `model.reason` says why: `lookup | show-more | tab | back | presentation | options | replay | fallback`. This covers the "why did I run?" gap reported by five proposals.
3. Show more, tabs and Back re-render with a new model. The renderer decides how much to draw. It can draw progressively with `ctx.schedule` and `reportRendered`, or use `components.showMore` (Default keeps its current 8 ms batches, popup.js:3619).
4. **Stale work is dropped**: the host passes `request.generation` and ignores renderer output for an older generation, including late `ctx.schedule` callbacks.
5. Back: the host calls `snapshot()` before showing the kanji view and `restore()` after re-rendering the terms. Only renderer-owned disclosures are restored, which fixes the Tategaki report ([5817966878](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817966878) gap 6).
6. Focus: a focused popup pauses hover scanning (`popupHasFocus`, content.js:2670). Theme authors must know this. Escape stays a core keybind (close).
7. Switching theme calls `destroy()` on every level's view, releases `ctx.on`/`ctx.schedule`, removes the renderer's stylesheet, creates the new renderer's views, and re-renders visible levels from their last models (`reason: "options"`).

## 9. Failure and fallback

A throw from any renderer entry point, `ctx.on` handler or `ctx.schedule` callback triggers this sequence:

1. The host calls `destroy()` inside a try block.
2. It releases everything the renderer owns (listeners, timers, the adopted renderer and theme sheets).
3. It re-renders **the current model with Default and Default's CSS** (`reason: "fallback"`).
4. It keeps `options.popupTheme` unchanged and records the failure for this page, so the failed renderer is not retried until reload.
5. It logs **one** `console.warn` with the error and shows a one-line "<Theme> failed on this page — showing Default" notice in the first fallback render.

The prototype's "keep the theme's CSS" behaviour is withdrawn, because keeping the failed renderer's CSS over Default is not a reliable fallback (c26).

## 10. CSS layers (popup shadow root, in cascade order)

```text
1. render/infra.css + icons.css         host reset, frame box, size/opacity/zoom vars, scroll root, resize handle, [inert], palette→semantic vars
2. vendor/themes/palettes.css           all bundled palette blocks (+ one locally compiled sheet for stored palettes/variants) — variables only
3. render/components.css                only when the renderer declares components (Default always)
   dictionary <style> elements          only after a rich glossary was rendered (tree order, before adopted sheets; @scope)
4. renderer CSS                         render/default.css  OR  vendor/themes/<slug>/renderer.css — never both, never layered
5. user Custom CSS                      last, unchanged (createCustomPopupStyle, popup.js:42-59)
```

Default's card, toolbar and layout rules live only in `default.css` (T-17), so they never apply under Nazeka or any other renderer. Palette themes use Default on purpose. A theme never adds CSS on top of another renderer ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)). A renderer's CSS styles only the DOM that renderer built. Dictionary `<style>` elements precede adopted sheets in cascade order, but `@scope` proximity wins over unscoped rules of equal specificity. T-17 adds a test that pins the resulting order in real Chrome.

## 11. Compatibility and versioning

- `apiVersion` (renderer) and `modelVersion` (model) are integers, and the host supports exactly `{1}`. Additive changes (a new optional model field, update event, component or `reason` value) keep version 1, and renderers must ignore anything they do not know. Anything else is version 2, and the host then supports 1 and 2 for at least one release.
- `minHachidoriVersion` in the manifest hides a theme from older releases. A renderer requiring an unsupported `apiVersion` or `needs` renders Default with the theme's palette, and the Store says "Requires Hachidori ≥ x.y.z".
- Theme slugs are a stable public contract, and so are the `gsm-hoshidicts-*` classes of shared components. Default's own layout classes are not a contract for other renderers, because renderers must not scrape Default DOM. Custom CSS written against Default keeps working while Default is selected.

## 12. Loading (decided by the T-05 spike and implemented in T-20)

Bundled files only. The candidates are `chrome.scripting.registerContentScripts` for the active renderer (with `executeScript` into open tabs on change), `chrome.scripting.executeScript` on request, or `import(chrome.runtime.getURL(…))` through `web_accessible_resources`. The chosen mechanism must meet three requirements:

- It loads at **content-script start**, not at the first popup. The prototype paid +19.7 ms first frame and +34.3 ms complete on a cold hover when it loaded at the first popup.
- It adds no cold-first-hover regression beyond budget with `all_frames: true` (manifest.json:91).
- It works in overlay hosts, or they get a `rendererThemes: false` capability (overlay-mode.js HOST_CAPABILITIES) and use Default.

The host waits for the selected renderer to register with `HDRenderers.whenReady(id, timeoutMs)`. On timeout it follows §9, so Default runs instead and only as a fallback.
