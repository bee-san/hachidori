# Evidence for #656

Screenshots and ad-hoc scripts for the search page's click lookups, Anki
Template switch and popup window size, taken in Chrome for Testing
152.0.7977.75 (headless) with the extension of the pull request's head.

| File | What it shows |
| --- | --- |
| `search-600x640.png` | The default popup window size with three Templates: the switch fits the header on one line. |
| `search-420x600.png` | A window narrower than 32em: the menu, the title and the Clipboard monitor's label all give way, and the two wrap. |
| `header-long-name-600.png`, `header-long-name-512.png` | A 34-character Template name at 600 and 512 px (32em): the menu gives way and cuts the name, and the title and label keep one line (`scripts/long.mjs`; `scripts/lines.mjs` counts the lines as the chrome-e2e step does: [1,1] with the 32em rule, [2,2] without it). |
| `search-template-default.png`, `-girlypop.png`, `-dracula.png`, `-high-contrast.png`, `-forced-colors.png` | The switch in a dark, a light and the high-contrast palette, and under Windows' forced colours (emulated). |
| `search-template-focus.png` | Shift+Tab twice from the search box: the switch's 2 px focus ring. |
| `search-click-lookup.png` | Look up words with a click: 読 clicked in the query 漢字を読む shows 読む. |
| `settings-search-page.png` | Settings → Reading → Search page. |

Contrast of the switch (`scripts/contrast.mjs`, computed styles painted on a
canvas, WCAG 2 ratios), text on its background and its border on the page:

| Palette | Text | Border |
| --- | --- | --- |
| default | 11.21:1 | 3.44:1 |
| girlypop (light) | 12.31:1 | 11.64:1 |
| dracula | 13.37:1 | 13.91:1 |
| high-contrast | 21.00:1 | 19.68:1 |

Scripts: `probe.mjs` and `ffprobe.test.mjs` asked Chrome 152 and Firefox 159
which window sizes `windows.create` accepts; `order.mjs` logged, in 8 loads,
that the frame lays out its invisible copy of the menu before it tells
search.html it is shown (copy, then shown, 0.2-3.4 ms apart, every time);
`conflict.mjs` made another write land between the switch's read and its
write: the switch's first write met the conflict, its retry wrote the choice,
and the other write and the AnkiConnect key were kept; a failed write left
the stored Template and the menu went back to it. `preview.mjs`, `keys.mjs`,
`evidence.mjs` and `contrast.mjs` produced the rest.
