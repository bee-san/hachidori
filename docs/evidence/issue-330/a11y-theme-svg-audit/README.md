# Evidence: dictionary images across every Hachidori palette (issue #330 follow-up to #322)

Everything here was produced by `audit.mjs` (real extension, Chrome for Testing
152.0.7977.75, real Yomitan dictionaries imported through Settings → Add
dictionaries, hover lookups, per-image pixel sampling) and `controlled.mjs` (a
plain page with the reader's mask rule and candidate fixes under
`Emulation.setEmulatedMedia`). `results.json` and `controlled-results.json` are
the raw numbers; `matrix.md` is the PASS/FAIL table derived from them.

| file | what it shows |
| --- | --- |
| `sheet-stroke-order-every-palette.png` | the 漢検-style 格 strip (tagged monochrome, untagged, opaque-white monochrome, currentColor) in all 42 palettes, AUTO both ways, forced colours, prefers-contrast, custom CSS |
| `sheet-bees-kanjivg-every-palette.png` | Bee's Ultimate Kanji Dictionary KanjiVG diagram (blue ink + white halo) in the same rows |
| `popup-*.png` | full popups for the key rows |
| `preview-*.png` | the enlarged hover preview of the tagged monochrome glyph |
| `controlled-forced-colors-mask-variants.png` | the #329 mask rule versus candidate fixes under forced colours |
| `proposed-accessibility-review.*` | the workflow, script and test proposed for the merge gate |

Dictionaries used (all free to redistribute; see the issue for the ones that
were deliberately not downloaded): Bee's Ultimate Kanji Dictionary (CC BY-SA
4.0, KanjiVG CC BY-SA 3.0), Japanese Kanji Phonetic Families, Japanese Kamon
Encyclopedia (CC BY-SA 4.0), Japanese Yōkai Encyclopedia (CC0 / CC BY-SA 4.0 /
PD), Japanese Traditional Colours (CC BY-SA 4.0), the repository's
`monochromeImageFixture()`, and an audit fixture built from KanjiVG's 格 paths.
