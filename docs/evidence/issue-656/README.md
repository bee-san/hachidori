# Evidence for #656

Screenshots and ad-hoc scripts for the search page's click lookups, Anki
Template switch and popup window size, taken in Chrome for Testing
152.0.7977.75 (headless) with the extension of the pull request's head.

| File | What it shows |
| --- | --- |
| `search-600x640.png` | The default popup window size with three Templates: the switch fits the header on one line. |
| `search-420x600.png` | A narrow window: the menu is down to 6em, and the title and the Clipboard monitor's label wrap. |
| `header-long-name-600.png`, `header-long-name-480.png` | A 34-character Template name at 600 and 480 px: the menu gives way and cuts the name, and the title and label keep one line. The menu grows from nothing up to its own width into the room they leave, so they shrink only once it is down to 6em (about 467 px with default fonts). `scripts/long.mjs` measures it (also with a 20 px default or minimum font size, through the profile's preferences); `scripts/lines.mjs` counts the lines as the chrome-e2e step does; `scripts/fflayout.test.mjs` measures it in Firefox 159 (one line at 600, 512 and 480 px; the copy under the menu). |

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
