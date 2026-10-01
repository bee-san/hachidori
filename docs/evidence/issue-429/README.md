# Evidence for #429 (Compact glossaries)

Screenshots and measurements for bee-san/hachidori#429, made with Chrome for
Testing 152.0.7977.75 on Linux against `fix/issue-429-compact-glossaries`.

- `extract.mjs` reads the 食べる, 見る and 掛ける rows from Jitendex.org
  [2026-08-11] (`jitendex-yomitan.zip`) into `/tmp/hd429/jitendex-rows.json`;
  `styles.css` from the same archive is saved as `/tmp/hd429/jitendex-styles.css`.
- `shots.mjs` renders a three-gloss plain row and Jitendex's 食べる through the
  production `createPopupView` and `reader.css` and captures each palette in
  both layouts (`compact-glossaries-<palette>.png`).
- `palettes.mjs` captures the compact plain card in every palette with the
  bar's measured contrast against the card (`compact-glossaries-palettes.png`).
- `bench-css.mjs` times render plus style and layout with the base commit's
  `reader.css` and this branch's, and the live layout switch.
- `theme-contrast.png` is the `node test/run.mjs chrome-theme-contrast` filmstrip.

Run each script with `REPO=/path/to/hachidori node <script>`.
