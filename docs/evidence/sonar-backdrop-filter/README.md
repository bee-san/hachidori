# Duplicate popup backdrop-filter declarations

Evidence for removing the static `-webkit-backdrop-filter` / `backdrop-filter`
pair that `extension/render/reader.css` declared before the same properties
through `var(--gsm-hoshidicts-popup-backdrop-filter, …)` (SonarCloud
css:S4656). "Before" is `main` at `5463381`; "after" is
`fix/sonar-duplicate-backdrop-filter` at `8e187bf`.

- `theme-contrast-before.png`, `theme-contrast-after.png`: the
  `node test/run.mjs chrome-theme-contrast` filmstrip (Chrome 152.0.7977.75)
  from each tree. Both files have SHA-256
  `ef5f20c2efd10fbb25a07eb9591425f8aacdbd2883e043c95c127bc34804dff4`, and the
  two `theme-contrast.json` outputs are identical.
- `computed-backdrop-filter.mjs`: compares the popup's computed
  `backdrop-filter` under both stylesheets for every palette, with the custom
  property unset, valid (`blur(4px)`) and invalid (`not-a-filter`).
- `computed-backdrop-filter.txt`: its output in Chrome 128.0.6613.137 and
  152.0.7977.75. Each browser shows 126 cases and 0 differences. An invalid
  custom value computes to `none` in both versions, so the removed static pair
  never acted as a fallback.
