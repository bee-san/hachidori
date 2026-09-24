# Dictionary image contrast matrix

Chrome for Testing 152.0.7977.75, run 2026-09-24T07:53:03.198Z – 2026-09-24T08:10:53.241Z (UTC). Popup 720×900 px at 85 % opacity over a white page, `lookupMode: hover`, compact summary on.

Legend: ✅ PASS (≥ 3:1, WCAG 2.1 SC 1.4.11), ❌ FAIL (visible but < 3:1), ⬛ INVISIBLE (< 1 % of the image box differs from its background). The number is the lowest contrast ratio measured for that class in that palette (ink vs the surface it sits on).

Image classes: F1/F2 = the repository's own `monochromeImageFixture()` black square, tagged `monochrome` / `auto`. K1–K4 = the audit's 漢検-style 格 stroke-order SVG (KanjiVG paths, CC BY-SA): K1 black-on-transparent tagged `monochrome`; K2 the same untagged; K3 black on an opaque white canvas tagged `monochrome`; K4 `stroke="currentColor"` untagged. B1 = Bee's Ultimate Kanji Dictionary KanjiVG stroke SVG (blue ink with a white halo, untagged); B2 = its reading-frequency pie PNG. P = Japanese Kanji Phonetic Families component PNG/JPEG (opaque). M = Japanese Kamon Encyclopedia crest WebP. Y = Japanese Yōkai Encyclopedia JPEG. C = Japanese Traditional Colours swatch WebP (white label on the swatch colour).

| palette / mode | scheme | F1 | K1 | K3 | F2 | K2 | K4 | B1 | B2 | P | M | Y | C | preview (mono) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `auto (light OS)` | light | ✅ 16.7 | ✅ 17.4 | ⬛ 1.0 | ✅ 19.8 | ✅ 20.6 | ✅ 20.6 | ✅ 4.8 | ✅ 3.8 | ✅ 19.7 | ✅ 3.1 | ✅ 3.8 | ❌ 2.5 | PASS 17.72 |
| `auto (dark OS)` | dark | ✅ 15.5 | ✅ 14.2 | ⬛ 1.0 | ⬛ 1.3 | ❌ 1.4 | ❌ 1.4 | ✅ 11.3 | ❌ 2.6 | ✅ 19.7 | ✅ 6.1 | ✅ 11.9 | ❌ 2.5 | PASS 9.15 |
| `default` | dark | ✅ 10.8 | ✅ 11.0 | ⬛ 1.0 | ❌ 1.6 | ❌ 1.5 | ❌ 1.5 | ✅ 10.2 | ❌ 2.6 | ✅ 19.7 | ✅ 4.9 | ✅ 10.7 | ❌ 2.5 | PASS 7.46 |
| `miku` | dark | ✅ 12.3 | ✅ 12.5 | ⬛ 1.0 | ❌ 1.5 | ❌ 1.5 | ❌ 1.5 | ✅ 10.7 | ❌ 2.6 | ✅ 19.7 | ✅ 5.0 | ✅ 11.3 | ❌ 2.5 | PASS 8.64 |
| `catppuccin-mocha` | dark | ✅ 11.5 | ✅ 11.4 | ⬛ 1.0 | ⬛ 1.3 | ⬛ 1.3 | ⬛ 1.3 | ✅ 12.1 | ❌ 2.6 | ✅ 19.7 | ✅ 6.0 | ✅ 12.8 | ❌ 2.5 | PASS 7.76 |
| `solarized-dark` | dark | ✅ 5.0 | ✅ 5.2 | ⬛ 1.0 | ❌ 1.6 | ❌ 1.5 | ❌ 1.5 | ✅ 10.3 | ❌ 2.6 | ✅ 19.7 | ✅ 4.9 | ✅ 10.8 | ❌ 2.5 | PASS 3.54 |
| `dark` | dark | ✅ 15.5 | ✅ 14.2 | ⬛ 1.0 | ⬛ 1.3 | ❌ 1.4 | ❌ 1.4 | ✅ 11.3 | ❌ 2.6 | ✅ 19.7 | ✅ 6.1 | ✅ 11.9 | ❌ 2.5 | PASS 9.15 |
| `synthwave` | dark | ✅ 9.1 | ✅ 9.2 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 13.9 | ❌ 2.6 | ✅ 19.7 | ✅ 7.1 | ✅ 14.8 | ❌ 2.5 | PASS 6.82 |
| `halloween` | dark | ✅ 12.4 | ✅ 11.1 | ⬛ 1.0 | ⬛ 1.2 | ⬛ 1.2 | ⬛ 1.2 | ✅ 12.9 | ❌ 2.6 | ✅ 19.7 | ✅ 7.8 | ✅ 13.8 | ❌ 2.5 | PASS 7.09 |
| `forest` | dark | ✅ 11.2 | ✅ 10.4 | ⬛ 1.0 | ⬛ 1.2 | ⬛ 1.2 | ⬛ 1.2 | ✅ 12.7 | ❌ 2.6 | ✅ 19.7 | ✅ 7.0 | ✅ 13.4 | ❌ 2.5 | PASS 6.82 |
| `aqua` | dark | ✅ 10.8 | ✅ 8.3 | ⬛ 1.0 | ❌ 1.5 | ❌ 1.9 | ❌ 1.9 | ✅ 8.3 | ❌ 2.6 | ✅ 19.7 | ✅ 5.5 | ✅ 8.7 | ❌ 2.5 | PASS 5.37 |
| `black` | dark | ✅ 13.0 | ✅ 13.6 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 14.4 | ❌ 2.6 | ✅ 19.7 | ✅ 6.9 | ✅ 15.4 | ❌ 2.5 | PASS 10.41 |
| `luxury` | dark | ✅ 8.3 | ✅ 8.6 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 13.8 | ❌ 2.6 | ✅ 19.7 | ✅ 6.7 | ✅ 14.7 | ❌ 2.5 | PASS 6.16 |
| `dracula` | dark | ✅ 14.3 | ✅ 12.8 | ⬛ 1.0 | ❌ 1.4 | ❌ 1.5 | ❌ 1.5 | ✅ 10.2 | ❌ 2.6 | ✅ 19.7 | ✅ 5.6 | ✅ 10.7 | ❌ 2.5 | PASS 8.27 |
| `business` | dark | ✅ 10.7 | ✅ 9.9 | ⬛ 1.0 | ⬛ 1.2 | ❌ 1.3 | ❌ 1.3 | ✅ 11.6 | ❌ 2.6 | ✅ 19.7 | ✅ 6.2 | ✅ 12.3 | ❌ 2.5 | PASS 6.42 |
| `night` | dark | ✅ 11.3 | ✅ 10.6 | ⬛ 1.0 | ⬛ 1.2 | ⬛ 1.2 | ⬛ 1.2 | ✅ 12.7 | ❌ 2.6 | ✅ 19.7 | ✅ 6.9 | ✅ 13.4 | ❌ 2.5 | PASS 7.01 |
| `coffee` | dark | ✅ 7.2 | ✅ 6.5 | ⬛ 1.0 | ⬛ 1.3 | ⬛ 1.3 | ⬛ 1.3 | ✅ 11.8 | ❌ 2.6 | ✅ 19.7 | ✅ 6.6 | ✅ 12.6 | ❌ 2.5 | PASS 4.22 |
| `dim` | dark | ✅ 8.7 | ✅ 7.7 | ⬛ 1.0 | ❌ 1.4 | ❌ 1.6 | ❌ 1.6 | ✅ 9.6 | ❌ 2.6 | ✅ 19.7 | ✅ 5.3 | ✅ 10.1 | ❌ 2.5 | PASS 4.9 |
| `sunset` | dark | ✅ 8.9 | ✅ 8.2 | ⬛ 1.0 | ⬛ 1.2 | ⬛ 1.2 | ⬛ 1.2 | ✅ 12.3 | ❌ 2.6 | ✅ 19.7 | ✅ 6.7 | ✅ 13.1 | ❌ 2.5 | PASS 5.37 |
| `abyss` | dark | ✅ 13.9 | ✅ 12.3 | ⬛ 1.0 | ⬛ 1.2 | ⬛ 1.2 | ⬛ 1.2 | ✅ 12.4 | ❌ 2.6 | ✅ 19.7 | ✅ 7.3 | ✅ 13.1 | ❌ 2.5 | PASS 8.16 |
| `girlypop` | light | ✅ 11.2 | ✅ 12.0 | ⬛ 1.0 | ✅ 18.2 | ✅ 19.4 | ✅ 19.4 | ✅ 4.6 | ✅ 3.6 | ✅ 18.5 | ✅ 3.1 | ✅ 3.7 | ❌ 2.3 | PASS 12.38 |
| `solarized-light` | light | ✅ 4.4 | ✅ 4.8 | ⬛ 1.0 | ✅ 17.3 | ✅ 18.8 | ✅ 18.8 | ✅ 4.5 | ✅ 3.5 | ✅ 17.9 | ✅ 3.1 | ✅ 3.6 | ❌ 2.2 | PASS 5.03 |
| `light` | light | ✅ 16.7 | ✅ 17.4 | ⬛ 1.0 | ✅ 19.8 | ✅ 20.6 | ✅ 20.6 | ✅ 4.8 | ✅ 3.8 | ✅ 19.7 | ✅ 3.1 | ✅ 3.8 | ❌ 2.5 | PASS 17.72 |
| `cupcake` | light | ✅ 14.3 | ✅ 15.4 | ⬛ 1.0 | ✅ 17.7 | ✅ 19.1 | ✅ 19.1 | ✅ 4.5 | ✅ 3.5 | ✅ 18.2 | ✅ 3.1 | ✅ 3.7 | ❌ 2.3 | PASS 16.05 |
| `bumblebee` | light | ✅ 16.6 | ✅ 17.6 | ⬛ 1.0 | ✅ 19.3 | ✅ 20.5 | ✅ 20.5 | ✅ 4.8 | ✅ 3.8 | ✅ 19.5 | ✅ 3.1 | ✅ 3.8 | ❌ 2.4 | PASS 18.1 |
| `emerald` | light | ✅ 9.2 | ✅ 10.5 | ⬛ 1.0 | ✅ 17.5 | ✅ 19.9 | ✅ 19.9 | ✅ 4.7 | ✅ 3.7 | ✅ 19.0 | ✅ 3.1 | ✅ 3.8 | ❌ 2.2 | PASS 11.09 |
| `corporate` | light | ✅ 14.3 | ✅ 16.4 | ⬛ 1.0 | ✅ 17.5 | ✅ 19.9 | ✅ 19.9 | ✅ 4.7 | ✅ 3.7 | ✅ 19.0 | ✅ 3.1 | ✅ 3.8 | ❌ 2.2 | PASS 17.21 |
| `retro` | light | ✅ 6.6 | ✅ 7.1 | ⬛ 1.0 | ✅ 14.9 | ✅ 16.1 | ✅ 16.1 | ✅ 3.9 | ❌ 3.0 | ✅ 15.4 | ✅ 3.1 | ✅ 3.4 | ❌ 2.0 | PASS 7.5 |
| `cyberpunk` | light | ✅ 16.6 | ✅ 17.6 | ⬛ 1.0 | ✅ 16.6 | ✅ 17.6 | ✅ 17.6 | ✅ 4.2 | ✅ 3.2 | ✅ 16.8 | ✅ 3.1 | ✅ 3.6 | ❌ 2.1 | PASS 18.37 |
| `valentine` | light | ✅ 5.0 | ✅ 5.3 | ⬛ 1.0 | ✅ 17.5 | ✅ 18.8 | ✅ 18.8 | ✅ 4.5 | ✅ 3.5 | ✅ 17.9 | ✅ 3.1 | ✅ 3.6 | ❌ 2.2 | PASS 5.52 |
| `garden` | light | ✅ 12.9 | ✅ 14.8 | ⬛ 1.0 | ✅ 14.2 | ✅ 16.3 | ✅ 16.3 | ✅ 4.0 | ❌ 3.0 | ✅ 15.6 | ✅ 3.1 | ✅ 3.4 | ❌ 2.5 | PASS 16.09 |
| `lofi` | light | ✅ 19.3 | ✅ 20.5 | ⬛ 1.0 | ✅ 19.3 | ✅ 20.5 | ✅ 20.5 | ✅ 4.8 | ✅ 3.8 | ✅ 19.5 | ✅ 3.1 | ✅ 3.8 | ❌ 2.4 | PASS 21 |
| `pastel` | light | ✅ 17.3 | ✅ 17.9 | ⬛ 1.0 | ✅ 20.1 | ✅ 20.8 | ✅ 20.8 | ✅ 4.9 | ✅ 3.8 | ✅ 19.8 | ✅ 3.1 | ✅ 3.8 | ❌ 2.5 | PASS 18.1 |
| `fantasy` | light | ✅ 12.2 | ✅ 13.9 | ⬛ 1.0 | ✅ 17.5 | ✅ 19.9 | ✅ 19.9 | ✅ 4.7 | ✅ 3.7 | ✅ 19.0 | ✅ 3.1 | ✅ 3.8 | ❌ 2.2 | PASS 14.68 |
| `wireframe` | light | ✅ 16.6 | ✅ 17.6 | ⬛ 1.0 | ✅ 19.3 | ✅ 20.5 | ✅ 20.5 | ✅ 4.8 | ✅ 3.8 | ✅ 19.5 | ✅ 3.1 | ✅ 3.8 | ❌ 2.4 | PASS 18.1 |
| `cmyk` | light | ✅ 15.9 | ✅ 17.5 | ⬛ 1.0 | ✅ 18.4 | ✅ 20.3 | ✅ 20.3 | ✅ 4.8 | ✅ 3.7 | ✅ 19.4 | ✅ 3.1 | ✅ 3.8 | ❌ 2.3 | PASS 18.1 |
| `autumn` | light | ✅ 10.6 | ✅ 11.7 | ⬛ 1.0 | ✅ 16.9 | ✅ 18.7 | ✅ 18.7 | ✅ 4.4 | ✅ 3.4 | ✅ 17.8 | ✅ 3.1 | ✅ 3.6 | ❌ 2.2 | PASS 12.37 |
| `acid` | light | ✅ 18.3 | ✅ 19.4 | ⬛ 1.0 | ✅ 18.3 | ✅ 19.4 | ✅ 19.4 | ✅ 4.6 | ✅ 3.6 | ✅ 18.5 | ✅ 3.1 | ✅ 3.7 | ❌ 2.3 | PASS 19.95 |
| `lemonade` | light | ✅ 14.6 | ✅ 16.6 | ⬛ 1.0 | ✅ 16.8 | ✅ 19.3 | ✅ 19.3 | ✅ 4.6 | ✅ 3.5 | ✅ 18.4 | ✅ 3.1 | ✅ 3.7 | ❌ 2.1 | PASS 17.59 |
| `winter` | light | ✅ 7.9 | ✅ 8.3 | ⬛ 1.0 | ✅ 19.6 | ✅ 20.6 | ✅ 20.6 | ✅ 4.8 | ✅ 3.8 | ✅ 19.7 | ✅ 3.1 | ✅ 3.8 | ❌ 2.5 | PASS 8.5 |
| `nord` | light | ✅ 10.3 | ✅ 10.7 | ⬛ 1.0 | ✅ 17.2 | ✅ 17.9 | ✅ 17.9 | ✅ 4.3 | ✅ 3.3 | ✅ 17.1 | ✅ 3.1 | ✅ 3.6 | ❌ 2.2 | PASS 11.05 |
| `caramellatte` | light | ✅ 8.5 | ✅ 8.9 | ⬛ 1.0 | ✅ 18.3 | ✅ 19.4 | ✅ 19.4 | ✅ 4.6 | ✅ 3.6 | ✅ 18.4 | ✅ 3.1 | ✅ 3.7 | ❌ 2.3 | PASS 9.21 |
| `silk` | light | ✅ 8.0 | ✅ 8.3 | ⬛ 1.0 | ✅ 18.2 | ✅ 19.0 | ✅ 19.0 | ✅ 4.5 | ✅ 3.5 | ✅ 18.1 | ✅ 3.1 | ✅ 3.7 | ❌ 2.3 | PASS 8.54 |
| `high-contrast` | dark | ✅ 18.7 | ✅ 19.6 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 14.3 | ❌ 2.6 | ✅ 19.7 | ✅ 6.9 | ✅ 15.2 | ❌ 2.5 | PASS 15.13 |
| `forced-colors:active theme:default os:dark` | dark | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ✅ 15.3 | ❌ 2.6 | ✅ 19.9 | ✅ 11.8 | ✅ 16.8 | ❌ 2.5 | INVISIBLE 1.39 |
| `forced-colors:active theme:high-contrast os:dark` | dark | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ✅ 15.3 | ❌ 2.6 | ✅ 19.9 | ✅ 11.8 | ✅ 16.8 | ❌ 2.5 | INVISIBLE 1.39 |
| `forced-colors:active theme:light os:light` | light | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ✅ 21.0 | ✅ 21.0 | ✅ 21.0 | ✅ 4.9 | ✅ 3.9 | ✅ 19.9 | ❌ 2.7 | ✅ 4.2 | ❌ 2.7 | INVISIBLE 1.41 |
| `forced-colors:active theme:auto os:dark` | dark | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ⬛ 1.0 | ✅ 15.3 | ❌ 2.6 | ✅ 19.9 | ✅ 11.8 | ✅ 16.8 | ❌ 2.5 | INVISIBLE 1.39 |
| `forced-colors:none prefers-contrast:more theme:default` | dark | ✅ 10.8 | ✅ 11.0 | ⬛ 1.0 | ❌ 1.6 | ❌ 1.5 | ❌ 1.5 | ✅ 10.2 | ❌ 2.6 | ✅ 19.7 | ✅ 4.9 | ✅ 10.7 | ❌ 2.5 | PASS 7.46 |
| `forced-colors:none prefers-contrast:more theme:high-contrast` | dark | ✅ 18.7 | ✅ 19.6 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 14.3 | ❌ 2.6 | ✅ 19.7 | ✅ 6.9 | ✅ 15.2 | ❌ 2.5 | PASS 15.13 |
| `custom-css (#0c0c0c card, #d4d4d4 text) theme:default` | dark | ✅ 13.3 | ✅ 12.8 | ⬛ 1.0 | ⬛ 1.1 | ⬛ 1.1 | ⬛ 1.1 | ✅ 13.9 | ❌ 2.6 | ✅ 19.7 | ✅ 7.6 | ✅ 14.8 | ❌ 2.5 | PASS 8.9 |

## Totals per class (worst verdict per palette/mode row)

| class | PASS | FAIL | INVISIBLE |
|---|---|---|---|
| F1 | 47 | 0 | 4 |
| K1 | 47 | 0 | 4 |
| K3 | 0 | 0 | 51 |
| F2 | 25 | 7 | 19 |
| K2 | 25 | 10 | 16 |
| K4 | 25 | 10 | 16 |
| B1 | 51 | 0 | 0 |
| B2 | 23 | 28 | 0 |
| P | 51 | 0 | 0 |
| M | 50 | 1 | 0 |
| Y | 51 | 0 | 0 |
| C | 0 | 51 | 0 |
