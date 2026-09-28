# Security and privacy review

## What c28 changed

bee-san: "themes are not random things, they are officially reviewed by me as a pr to the themes repo so it's okay to forgoe security" ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)). This plan therefore drops everything whose only purpose was to distrust theme authors (D24):

- **No theme CSS sanitiser.** Renderer CSS is reviewed and bundled, and `@keyframes`, `@starting-style`, named local fonts, `:has()` and `@container` all work.
- **No CSS downloads at all.** A theme is its own popup (D23), so the only runtime data is catalogue JSON, palette colour values and screenshots.
- **No per-theme "Run this theme's JavaScript" switch** and no permission-style warning in the Store.
- **The renderer lint** stays only as *contract hygiene*. It keeps renderers on `ctx` so they clean up, fall back and benchmark correctly. It is not a sandbox and does not claim to be.

Each item below stays for a reason that has nothing to do with trusting theme authors.

## 1. The Chrome Web Store remote-code rule (a store policy that review cannot waive)

- MV3 requirements, <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>:
  - "the full functionality of an extension must be easily discernible from its submitted code"; "external resources must not contain any logic".
  - Violations include "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data".
  - "Execution of logic from a remote source is permissible only when accomplished through a documented API that explicitly allows this practice … Debugger API, User Scripts API".
  - Allowed: "Fetching a remote configuration file … where all logic for the functionality is contained within the extension package".
- Remote hosted code, <https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>:
  - RHC is "Things like JavaScript and WASM. It *does not* include data or things like JSON or CSS".
  - User scripts "are small code snippets that are usually supplied by the user … If the Chrome Web Store review team thinks that this is being used in a manner other than it is intended for (i.e. code provided by the user), it may be rejected".
- userScripts API, <https://developer.chrome.com/docs/extensions/reference/api/userScripts>:
  - It is for "scripts provided by the user that cannot be shipped as part of your extension package".
  - It needs the per-extension **Allow User Scripts** toggle (Developer mode before Chrome 138).
  - "User scripts are cleared when an extension updates", and they run in the `USER_SCRIPT` or `MAIN` world.
- The extension-pages CSP stays `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` ([manifest.json:110-112](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L110-L112)), and vendored renderer files are `'self'`.

### JavaScript delivery paths

| Path | Policy | Verdict |
| --- | --- | --- |
| **A. Renderer vendored into the release** (`extension/vendor/themes/<slug>/renderer.js`, pinned commit, loaded by the T-05/T-20 mechanism) | The extension's own file, reviewed with the release. Not remote code. | **Chosen.** |
| B. The user pastes code into **Custom JavaScript** (`chrome.userScripts`, [custom-javascript.js:8-26](https://github.com/bee-san/hachidori/blob/main/extension/custom-javascript.js#L8-L26)) | "Code provided by the user". | Stays as the user's own escape hatch (no `ctx`, `USER_SCRIPT` world). |
| C. Fetch `renderer.js` and `import()`/`eval` it | Remote code; a listed violation. | **Never.** This is why a new renderer arrives with a Hachidori release. |
| D. Fetch a JSON "layout script" and interpret it | "an interpreter … fetched as data"; a listed violation. | **Never.** `suggestedOptions` stays a flat map, and the manifest declares capabilities, not behaviour. |
| E. Sandboxed `'unsafe-eval'` page | Exempt, but it has no DOM access to the popup. | Not built. |
| F. Register Store themes as user scripts | Wrong world, needs a user toggle, wiped on update, and "may be rejected". | Rejected. |

**Consequence.** A new or changed renderer ships with a Hachidori release through a one-line vendor bump PR. The Store shows such themes as *Bundled*, *Arrives with Hachidori x.y* or *Requires Hachidori ≥ x.y.z*. Palettes and variants (colour data) can be used from a refreshed catalogue straight away.

## 2. Dictionary content stays sanitised

Dictionaries are third-party data, not reviewed themes. c26: "Preserve dictionary-content sanitisation. Reviewed renderer code does not make dictionary-supplied HTML/CSS trusted."

- Rich glossaries keep going through the structured-content renderer ([appendStructuredValue](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L933)).
- Dictionary styles stay behind [isSafeDictionaryStyle](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L1199-L1213) and [filterDictionaryStyleRules](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L1242-L1260), scoped with `@scope` ([applyDictionaryStyles](https://github.com/bee-san/hachidori/blob/main/extension/render/glossary.js#L1265-L1318)).
- Renderers receive glossaries only as opaque handles (`ctx.glossary`).
- Text mode ([c27](https://github.com/bee-san/hachidori/issues/334#issuecomment-5871156145)) builds no dictionary DOM or CSS at all.

## 3. Privacy (no automatic requests)

- **Endpoints**, all `https://raw.githubusercontent.com/bee-san/hachidori-theme-store/…` and all requested by the service worker:
  - `main/dist/index.json` on **Refresh** or on the opt-in "Check for new themes" schedule (default **Off**, like dictionary updates, [managed-dictionary-source.js:29-35](https://github.com/bee-san/hachidori/blob/main/extension/managed-dictionary-source.js#L29-L35));
  - `<index commit>/themes/<slug>/screenshot.png` when a detail pane opens.
- No identifiers or lookups are sent. The final URL is checked as for recommended dictionaries ([recommendedAssetUrlMatches](https://github.com/bee-san/hachidori/blob/main/extension/managed-dictionary-source.js#L166-L215)).
- docs/privacy.md gets the paragraph (T-44), plus the missing Custom JavaScript paragraph (T-02).
- **Downloaded data is only JSON and colour values.** The index is schema-checked (it is ≤ 1 MiB and uses relative paths only). Palette values must match the colour pattern before Hachidori compiles them into a palette block locally. That is correctness (a malformed value must not break the popup's CSS), not distrust of bee-san's repo.
- **No new permissions.** `scripting`, `userScripts`, `storage`, `unlimitedStorage` and `alarms` already exist ([manifest.json:14-22](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L14-L22)). T-02 adds the missing `scripting`/`userScripts` rows to docs/chrome-web-store.md.
- **web_accessible_resources.** Renderer CSS that content.js fetches must be web-accessible, like `render/reader.css` today ([manifest.json:119-131](https://github.com/bee-san/hachidori/blob/main/extension/manifest.json#L119-L131)). Pages can already detect Hachidori, and the files reveal the release's theme set, not the user's choice.

## 4. Robustness (renderer bugs must not leave a blank popup)

The failure fallback (renderer-api.md §9) is kept: re-render with Default and Default's CSS, one warning, no retry on that page. So are the contract checks in the themes CI: the renderer draws only inside `ctx.root`, cleans up on `destroy`, honours its declared glossary mode, and has no stray timers or listeners. These guard against bugs, not malice, and they are what makes renderer switching and benchmarking reliable.

## 5. CI hygiene (free)

The themes workflows run on `pull_request` with `permissions: contents: read`, no secrets, and actions pinned by SHA. Only the `benchmark-main` job commits, and only on `push` to `main`. CODEOWNERS makes bee-san the required reviewer for `themes/**` and `schema/**`, which is the review c28 relies on.

## 6. Pre-existing findings (not caused by themes; recorded for bee-san)

| Finding | Detail |
| --- | --- |
| **The popup's shadow root is open** | [content.js:2078](https://github.com/bee-san/hachidori/blob/main/extension/content.js#L2061-L2100) is pinned by test/custom-javascript.test.mjs:82 so Custom JS can reach it. Page scripts can therefore read popup content. docs/architecture.md says "closed" (lines 12, 828, 1120, 1135, 1521, 1628) and relies on that for the dictionary CSS prefix secrecy. T-02 fixes the docs, and open question 13 asks whether to close the root when Custom JS is empty. |
| **User Custom CSS can fetch** | `url()` rules in Custom CSS can request resources and learn looked-up words, as the body's leak probe showed. It is user-provided, and the hint at [settings.html:831](https://github.com/bee-san/hachidori/blob/main/extension/settings.html#L831) says so (open question 1). |
| **Custom JS runs on every page** | `chrome.userScripts` with `<all_urls>` ([custom-javascript.js:18-24](https://github.com/bee-san/hachidori/blob/main/extension/custom-javascript.js#L8-L26)). docs/privacy.md has no paragraph on it yet (T-02). |
