# The `bee-san/hachidori-theme-store` repository

The repository was created at 18:23 UTC on 2026-09-28 as **`bee-san/hachidori-themes`**. It has a README and the ten proposal issues #1–#10 moved out of #334. The owner then named it `hachidori-theme-store`, which does not exist yet, so T-04 renames the existing repository and GitHub redirects the old links. The evidence skeleton lives on [`evidence/issue-330-theme-store`](https://github.com/bee-san/hachidori/tree/evidence/issue-330-theme-store/docs/evidence/issue-330/theme-store/hachidori-themes-skeleton): schema, validate.mjs, lint config and PR template. It is the starting point, with the fixes listed in "Skeleton fixes" below.

## Layout

```text
hachidori-theme-store/
├── README.md · CONTRIBUTING.md (author guide) · LICENSE (GPL-3.0-or-later) · CODEOWNERS
├── .node-version (22.23.1) · package.json + package-lock.json (exact pins: ajv, ajv-formats, yaml, eslint, espree, jsdom, @puppeteer/browsers, puppeteer-core)
├── schema/theme.schema.json        # manifest schema 2  (= docs/plans/issue-334/schemas/theme-manifest.v2.schema.json)
├── schema/index.schema.json        # catalogue schema 1
├── schema/benchmark.schema.json    # benchmark result schema 1
├── fixture/HACHIDORI_COMMIT        # the Hachidori commit CI tests against (harness, host, fixtures, theme-css.js)
├── themes/<slug>/
│   ├── theme.yaml                  # required: palette (+ js block for a renderer, + renderer: for a variant)
│   ├── renderer.js + renderer.css  # renderer themes only: the theme's own popup (bundled-only)
│   ├── screenshot.png              # 1120×840 PNG, required for renderers and variants
│   └── README.md                   # credits, what it looks like, known limits
├── benchmarks/<slug>.json          # written by CI on main (schema benchmark 1)
├── dist/index.json · dist/palettes.css · dist/themes/<slug>/{renderer.js,renderer.css}   # committed build output
├── scripts/
│   ├── validate.mjs                # schema + cross-file checks, no code execution
│   ├── build-index.mjs             # deterministic dist/ (sha256, bytes); palettes.css via Hachidori's palette-css.js at the pin; embeds benchmark summaries
│   ├── import-palettes.mjs         # one-off: Hachidori render/palettes.css → themes/<slug>/theme.yaml (T-22)
│   ├── check-renderer.mjs          # AST contract (single HDRenderers.register, declarations = theme.yaml)
│   ├── renderer.eslint.config.mjs  # renderer lint (security.md)
│   ├── render.mjs                  # screenshots in Chrome for Testing via Hachidori's Design preview (T-25)
│   └── bench.mjs                   # fixtures | run <slug> | summarise | check  (T-27)
├── test/{validate,build,contract,lint,bench}.test.mjs + test/fixtures/{hostile-renderer.js, …}
└── .github/
    ├── PULL_REQUEST_TEMPLATE.md
    ├── ISSUE_TEMPLATE/theme-problem.yml   # target of the Store's "Report a problem"
    └── workflows/themes.yml · benchmark-main.yml
```

## `themes.yml` (pull requests and pushes)

```yaml
name: Themes
on: { pull_request: {}, push: { branches: [main] } }
permissions: { contents: read }
jobs:
  static:                       # no contributor code executes here
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1 (same pin as Hachidori's workflows)
        with: { persist-credentials: false }
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci
      - run: node scripts/validate.mjs --all                  # schema 2, slug=folder, unique, tags, files, sizes, screenshot 1120×840
      - run: npx eslint -c scripts/renderer.eslint.config.mjs "themes/*/renderer.js"
      - run: node scripts/check-renderer.mjs --all
      - run: node scripts/build-index.mjs && git diff --exit-code -- dist   # committed dist/ must be fresh
  contract:                     # contributor JS runs only here: jsdom, read-only token, no secrets
    needs: static
    runs-on: ubuntu-24.04
    steps:
      - (checkout, setup-node, npm ci as above)
      - run: node scripts/fetch-hachidori.mjs "$(cat fixture/HACHIDORI_COMMIT)"   # host, model fixtures, palette-css.js
      - run: node --test test/contract.test.mjs test/lint.test.mjs
  render-and-bench:
    needs: contract
    runs-on: ubuntu-24.04
    steps:
      - (checkout, setup-node, npm ci as above)
      - run: sudo apt-get install -y fonts-noto-cjk
      - run: npx @puppeteer/browsers install chrome@152.0.7977.75 --path .cache/browsers
      - run: node scripts/render.mjs --changed --compare --tolerance 0.02 --out render     # T-25
      - run: node scripts/bench.mjs ci --changed --sessions 5 --out bench                  # T-27: end-to-end vs Default, budgets
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with: { name: theme-artifacts, path: "render/\nbench/", retention-days: 30 }
```

`benchmark-main.yml` runs on `push` to `main` only, with `permissions: contents: write`. It runs `bench.mjs run` for the changed themes, writes `benchmarks/<slug>.json`, rebuilds `dist/index.json` with the summaries and commits as a bot. No PR code runs with write permission.

## Contribution flow

1. Fork, then `themes/<slug>/` with `theme.yaml` (+ `renderer.js`/`renderer.css` for a layout) and `screenshot.png`. A theme is never CSS over another popup ([c28](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542)): new colours are a palette or a variant, and a new look is a renderer.
2. `npm ci && node scripts/validate.mjs themes/<slug> && npx eslint … && node --test test/contract.test.mjs`.
3. Locally: `node scripts/render.mjs themes/<slug>` and `node scripts/bench.mjs run <slug>`. The PR template asks for the `summary.md` table and the commands. CI re-measures, and its numbers are the published ones.
4. Review: bee-san reviews every theme PR (CODEOWNERS on `themes/**` and `schema/**`). This review is the trust decision (c28).
5. After merge:
   - **palette and variant** themes are available to Store users after Refresh (colour data from the index);
   - **renderer** themes wait for Hachidori's vendor bump: `node scripts/vendor-themes.mjs --commit <sha>` in a small Hachidori PR reviewed with the release.

## Skeleton fixes (found while planning)

- `theme.schema.json` does not compile under Ajv `strict: true` (`strictRequired`, [c17](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821458937) gap 6; reproduced with ajv 8.17.1). Schema 2 puts `properties: {x: true}` beside every conditional `required`. The schemas in this package compile in strict mode, and `scripts/validate-examples.mjs` checks this.
- `validate.mjs` imports `scripts/sanitize-css.mjs`, which is not on the branch, so the validator cannot run. The sanitiser is no longer needed (c28: reviewed themes, no downloaded CSS), and the import goes.
- `validate.mjs` `import()`s `theme.js` (D15). This is replaced by static checks plus the jsdom contract job, which runs the renderer anyway.
- There is no `package.json`, README or `themes/` on the branch. T-21 creates them.
- All 10 proposal manifests omitted the required `benchmark:` block, and two exceeded the 200-character `js.summary` cap. The block is gone (D7). Summaries must be ≤ 200.

## PR template (replaces the skeleton's)

```markdown
## Theme
- Slug / folder: `themes/<slug>/` · kind: palette | renderer | variant
- What changed:
- Screenshot updated (1120 × 840): yes / no (why)
- Credits (third-party colours, layouts) and their licences:

## Checks run locally (paste commands and exact outcomes)
- [ ] `node scripts/validate.mjs themes/<slug>`
- [ ] `npx eslint -c scripts/renderer.eslint.config.mjs themes/<slug>/renderer.js` (renderer themes)
- [ ] `node --test test/contract.test.mjs` (renderer themes)
- [ ] `node scripts/render.mjs themes/<slug>` — renders attached
- [ ] `node scripts/bench.mjs run <slug>` — paste summary.md (CI re-measures; its numbers are published)

## Accessibility
- Contrast pairs (text/background, ratio), forced-colors, prefers-reduced-motion, keyboard/focus notes
```
