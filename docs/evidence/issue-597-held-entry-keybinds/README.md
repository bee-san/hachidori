# Evidence for #597: held Alt+ArrowDown/ArrowUp

Produced by `benchmark/entry-keybind.mjs` at 6466b7a7 (the PR branch), comparing
the `extension/` trees of main 5f986e47 (`main`) and 8e80033c (`branch`, the
fix; unchanged at 6466b7a7). Jitendex.org [2026-10-03] (38,831,822 bytes,
sha256 `e914c765…1356`) is imported into a fresh profile per variant and round,
and きかん is hovered (32 results). Chrome for Testing 152.0.7977.75, headless,
`--disable-gpu`, Node 22.23.1, Linux 6.12 on a shared 64-core AMD EPYC 9R14.

- `entry-keybind/`: five alternating rounds, Default palette.
- `entry-keybind-dark/`: one round with `HACHIDORI_KEYBIND_OPTIONS='{"popupTheme":"dark"}'`, for its screenshots.
- `held-alt-down-default.png`, `held-alt-down-dark.png`: the popup after the
  first round's 1.5 s hold of Alt+ArrowDown from the first result, cropped,
  main on the left.

```sh
git archive 5f986e47 extension | tar -x -C /tmp/main
git archive 8e80033c extension | tar -x -C /tmp/branch
HACHIDORI_ALLOW_NO_SANDBOX=1 HACHIDORI_KEYBIND_ARCHIVE=jitendex-yomitan.zip \
HACHIDORI_KEYBIND_SCREENSHOTS=shots/default \
  node benchmark/entry-keybind.mjs out main=/tmp/main/extension branch=/tmp/branch/extension
```

`raw.json.gz` keeps every keydown and frame-matched result; local paths are
replaced by `<repo>`, `<data>`, `<main 5f986e47>` and `<branch 8e80033c>`.
