<!-- hachidori-themes pull request template (skeleton for issue bee-san/hachidori#334) -->

## Theme

- Slug / folder: `themes/<slug>/`
- What changed (new theme, CSS change, JS change, metadata only):
- Screenshot updated (`themes/<slug>/screenshot.png`, 1120 × 840): yes / no (why)

## Benchmark (required for every theme with `css:` or `js:`)

Run from a Hachidori checkout at the tag pinned in `fixture/HACHIDORI_TAG`, following
"How to benchmark a theme" in bee-san/hachidori#334, and paste the `summary.md` table
and the `benchmark:` block you put into `theme.yaml`:

```text
$ npm ci --prefix test/tooling && npm --prefix test/tooling run install:chrome
$ node benchmark/hover-popup-fixture.mjs /tmp/bench/hover.zip
$ HACHIDORI_HOVER_SAMPLES=5 HACHIDORI_CHROME=… HACHIDORI_PUPPETEER=… node benchmark/hover-popup.mjs /tmp/bench/default /tmp/bench/hover.zip
$ HACHIDORI_HOVER_SAMPLES=5 HACHIDORI_HOVER_OPTIONS='{"popupTheme":"<slug>"}' … node benchmark/hover-popup.mjs /tmp/bench/<slug> /tmp/bench/hover.zip
$ node scripts/bench.mjs summarise /tmp/bench/default /tmp/bench/<slug>
```

| Input | Measure | Default | This theme | Δ median |
|---|---|---|---|---|
| short (食べる) | hover → complete result | / | / | |
| long (漢字, 24 senses) | hover → complete result | / | / | |
| deep (深層) | hover → complete result | / | / | |
| kanji (漢) | click → kanji view | / | / | |
| cold | first hover of a fresh profile | / | / | |

- `onRender` p95 / max: … ms / … ms (budget: p95 ≤ 2 ms, max ≤ 8 ms)
- Heap Δ at session end: … MiB (budget ≤ 2 MiB)
- Hover regressions over 5 ms **and** 10 %: none / list them with a reason

CI re-runs the same harness against `main`'s default and fails the PR on a missing
`benchmark:` block, a `harnessCommit` that is not the pinned tag, or any budget above.

## Checklist

- [ ] `node scripts/validate.mjs themes/<slug>` passes (schema, CSS sanitiser, theme.js lint + contract, screenshot size)
- [ ] `node scripts/bench.mjs check themes/<slug>` passes (numbers present, fresh and within budget)
- [ ] `theme.js` (if any) uses only `view`/`api`; no `import`, no globals, synchronous hooks
- [ ] Licence line in `theme.yaml`; third-party colours/layouts credited in `README.md`
