# Evidence for #565 (dictionary update list)

Screenshots of Settings → Dictionaries → Updates on #565's head after its rebase onto main, with the SonarCloud fix: the real extension in Chrome for Testing 152.0.7977.75 (headless, reduced motion). Three fixture dictionaries were imported and given a managed source and a recorded check result (one update available, one failed update, one failed check). There is no network. The first row's **Update** has keyboard focus (Tab from **Update all**; `:focus-visible` true in every palette).

- `shots/updates-{dark,light,high-contrast,forced-colors-dark}.png`. Forced colours is Chrome's emulation, not a real Windows contrast theme.
- `scripts/capture-565.mjs <repo> <out>` regenerates them (it needs `test/tmp/browsers` with Chrome 152).
