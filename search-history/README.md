<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Search history: GIFs, screenshots and benchmark

Media and evidence for the search history pull request (branch
`feat/search-history`); kept off that branch so its diff stays code.

## GIFs

Recorded with `scripts/capture-search-history-gifs.mjs` in headless Chrome
152.0.7977.75 on Linux from the PR's `extension/` at `531b7f0c`: one screenshot
per step at 960 × 600, held for its time, joined by ffmpeg n8.1.3
(`fps=10,scale=800:-1`, a 96-colour palette). The dictionary is a small one
the script builds, with glosses written for it; the lines arrive through the
Clipboard monitor from another tab, in a copy of the extension that holds
`clipboardRead`, as the Chrome suite does. The captions are the script's, laid
over the page; the red dot marks a click, which headless screenshots do not
show. `531b7f0c` is `32e49e85` on the branch rebased onto main at `353ce324`. The GIFs
predate two changes to the neighbour rows: in them the rows are the text's
size and mixed toward the page, where now they are smaller (`009cb180`) and in
the palette's dim text (`67246e75`).

| File | Shows |
| --- | --- |
| `search-history-recall.gif` | Copied and typed lines kept; Up and Down in the box walk them and bring the draft back |
| `search-history-words.gif` | The searched text's cursor: Right and Left by word with the popup, Up past the top row to earlier lines between their dimmed neighbours, Down back with the cursor where it was |
| `search-history-texthooker.gif` | `userscripts/texthooker.js`: the list, new lines at the bottom, a click lookup, Times, the clipboard pause, an edit and a delete |

```sh
HACHIDORI_CHROME=<chrome 152> node scripts/capture-search-history-gifs.mjs <repo> <ffmpeg> <out-dir>
```

## Screenshots

`HACHIDORI_SEARCH_SCREENSHOTS=DIR node test/chrome-search-history.mjs` on the
PR at `10d4715a`: an earlier line's visit (the searched text with its cursor,
the neighbour rows and the keys) in the default, Girlypop (light), Solarized
Light and High contrast palettes and with forced colours emulated, and
Settings → Reading → Search page. The neighbour rows are set smaller than the
searched text in every palette, and in the palette's dim text, which is dimmer
than its text only in Default, Autumn and High contrast; Girlypop and
Solarized Light show rows told apart by size alone. The Chrome suite checks
the rows at 4.5:1 or more, smaller, and dimmer where the palette has a dim
text, in all 42 palettes.

## Benchmark

`scripts/bench-history.mjs <repo> <extension> <rounds> <prefill>` in headless
Chrome 152 on a shared Linux host (64 cores, load average about 40 from other
jobs), main `4c14c92d` against the PR at `531b7f0c`'s `extension/`, alternated
main, PR, main, PR with 3 rounds each, then the PR twice more with 10,000 lines
kept beforehand. Each round opens a new search page and searches five words of
the test fixture. Raw samples are in `benchmark/`; medians and 90th percentiles
in milliseconds:

| | main | PR, 0 lines | PR, 10,000 lines |
| --- | ---: | ---: | ---: |
| page open to ready (n = 6) | 187 / 223 | 193 / 224 | 201 / 255 |
| Enter to the result in the popup (n = 30) | 11.0 / 34.9 | 11.2 / 28.1 | 11.4 / 27.4 |
| Enter to the line kept (`line` event, n = 30) | – | 6.2 / 26.5 | 12.6 / 40.3 |
| Up in the box to the recalled line (n = 6) | – | 9.4 / 16.1 | 9.2 / 16.5 |
| Right to the next word's result (n = 6) | – | 15.6 / 17.9 | 16.8 / 18.1 |
| Up past the top row to the earlier line shown and looked up (n = 6) | – | 14.6 / 15.3 | 14.9 / 17.7 |

The line is kept alongside the lookup, not before it. The first line of a page
opens the database (the 90th percentiles). With 10,000 lines kept, Enter to
the line kept took about 6 ms longer at the median, off the lookup's path. The
independent audit timed the store's own `add()` at the limit at 0.9–1.0 ms and
`count()` at 0.3 ms with 10,000 lines (its probe A2), so most of that 6 ms is
elsewhere between Enter and the `line` event; it has not been broken down.

## Arrow keys on a long text

`scripts/probe-longtext.mjs` (the audit's probe I, which pastes a text of
100 to 20,000 characters outside a field and times one key's synchronous
handling in the searched text) in headless Chrome 152, load average 40–45,
alternating `a765b36f` (each key measures every character) and the PR at
`4856496b` (rows read once for each text and size), two runs each. A first
press after the text appears, then the medians of four more Rights and three
Downs per run, in milliseconds (raw samples in `benchmark/long-text/`):

| characters | first press, `a765b36f` / PR | a later Right | a later Down |
| ---: | ---: | ---: | ---: |
| 100 | 2.3–2.4 / 2.2–2.4 | 1.3–1.4 / 0.7 | 1.0–1.2 / 0.5–0.7 |
| 1,000 | 6.9–7.2 / 6.7–7.3 | 8.4–9.5 / 0.4–0.5 | 6.5–6.8 / 0.4–0.5 |
| 5,000 | 35–49 / 37–52 | 35–50 / 0.4 | 34–35 / 0.5–0.6 |
| 20,000 | 222–228 / 180–227 | 202 / 0.4 | 186–216 / 0.5–0.7 |

The first press still measures the whole text, as before, and varies as much
between runs of one head as between the heads.
