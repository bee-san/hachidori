# Evidence for #645: Dark Reader and saved Custom JavaScript

Produced at dde40d82 (the PR branch rebased on main 63060a7a) and on main
9b17fb0b, Chrome for Testing 152.0.7977.75, headless, Node 22.23.1, Linux.

- `dark-reader-custom-javascript.png`: the fixture dictionary's 食べる popup with
  the reporter's own saved Custom JavaScript (copied unchanged from the debug
  log attached to #645), user scripts allowed, Colours set to Automatic under a
  dark preference. The top row runs Dark Reader 4.9.134 (the API build the test
  tooling pins), `enable({brightness: 100, contrast: 100})`; the bottom row runs
  the Dark Reader build Immersion Kit bundles for its dark theme, with its own
  `enable({brightness: 100, contrast: 70, sepia: 0})`. Columns: Dark Reader off,
  on with main (open root: text `rgb(191, 235, 255)` and `rgb(0, 0, 0)`), and on
  with this PR (closed root: every sampled colour unchanged). The popup body is
  85% opaque, so the darker page shows through it in both on columns.
- `theme-contrast.png`: the `node test/run.mjs chrome-theme-contrast` filmstrip
  at dde40d82 (45/45 rows passed).
