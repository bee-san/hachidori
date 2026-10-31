# Evidence for #618: Dark Reader and the closed popup root

Produced at d349e247 (the PR branch rebased on main f419b926) by
`node test/run.mjs chrome-e2e` and `node test/chrome-theme-contrast.mjs`.
Chrome for Testing 152.0.7977.75, headless, Node 22.23.1, Linux 6.12.

- `dark-reader-palettes.png`: the `reader > Dark Reader popup isolation` step's
  `test/tmp/ci/dark-reader-*.png` screenshots, cropped to the hovered word and
  its popup and scaled to 48%. Each row is one palette (Default, Light, Dark,
  High contrast, and Default with Custom CSS); the left column is before
  Dark Reader 4.9.134 (API build, Dynamic mode) is enabled, the right after.
  The page darkens; the step asserts that the popup's computed colours and
  borders are identical in both columns.
- `theme-contrast.png`: the `chrome-theme-contrast.mjs` filmstrip (45/45 rows
  passed).
