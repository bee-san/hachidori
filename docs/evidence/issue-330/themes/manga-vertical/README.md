# Tategaki (`manga-vertical`) — evidence for issue #334

Real-popup screenshots and measurements for the theme proposal posted on
[#334](https://github.com/bee-san/hachidori/issues/334): a `writing-mode:
vertical-rl` popup beside a manga speech bubble, captured in Chrome for
Testing 152.0.7977.75 over a mokuro-style page with Jitendex, KANJIDIC,
Kanjium pitch accents, Innocent Corpus and the test fixture imported through
Settings → Add dictionaries.

| File | What |
| --- | --- |
| `theme/manga-vertical/{theme.yaml,theme.css,theme.js}` | the theme as proposed for `hachidori-themes` |
| `theme/manga-vertical-night/theme.yaml` | the dark-page twin (its css/js are the light files with the slug and palette replaced; `build-night.mjs` does that) |
| `host-anchor.patch` | worktree-only additions on top of the Nazeka `host-prototype.patch`: the two slugs, the proposed `view.anchor`, a timing debug line |
| `mokuro-page.html` | the synthetic manga page (panels, bubbles, screentone drawn in SVG; text boxes in `vertical-rl` as mokuro emits them) |
| `capture-manga-vertical.mjs` | Puppeteer capture: imports the dictionaries, hovers the bubbles, clicks 食, opens the Note form, tabs, Back, reduced motion, a horizontal line, the night theme; writes `evidence.json` |
| `compose.py` | crops the full-viewport shots to the recorded clips and builds the side-by-side PNGs |
| `contrast.py` → `contrast.md` / `contrast.json` | WCAG contrast ratios from the live computed colours |
| `hook-timing.mjs` → `hook-timing.json` | `onRender` duration over 79 term and 8 kanji renders |
| `hover-popup-theme.mjs`, `summarise-hover.mjs` → `hover-benchmark.json` | `benchmark/hover-popup.mjs` with one added line (theme settings from an env var), default vs theme, 3 fresh profiles each |
| `side-by-side-*.png`, `states-*.png`, `night.png`, `placements.png` | the composites embedded in the comment |

Reproduce (from a worktree with the Nazeka host patch, `host-anchor.patch`
and both theme folders under `extension/vendor/themes/`):

```sh
node build-night.mjs extension/vendor/themes
HACHIDORI_ROOT=$PWD EVIDENCE_OUT=/tmp/mv DICTS="jitendex-yomitan.zip,KANJIDIC_english.zip,kanjium_pitch_accents.zip,innocent_corpus.zip,test/fixtures/hachidori-fixture.zip" \
  node docs/evidence/issue-330/themes/manga-vertical/capture-manga-vertical.mjs
python3 docs/evidence/issue-330/themes/manga-vertical/compose.py /tmp/mv
python3 docs/evidence/issue-330/themes/manga-vertical/contrast.py /tmp/mv
HACHIDORI_ROOT=$PWD EVIDENCE_OUT=/tmp/mv node docs/evidence/issue-330/themes/manga-vertical/hook-timing.mjs 8
```
