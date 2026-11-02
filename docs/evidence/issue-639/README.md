# Issue #639 evidence: the search page's Clipboard monitor

This branch is not for merging. It holds the screenshots, ad-hoc scripts and
raw results behind the pull request for #639, with Chrome for Testing
152.0.7977.75 and the suites' fixture dictionaries only. The screenshots are
from PR head `9e7f0cc0` (on `main` at `3b7730f1`), whose screenshot runs wait
for the switch's 120 ms colour transition after a theme change; the earlier
set, from `0401d0f1`, caught it halfway in the themed pictures. The scripts and
results ran on `0401d0f1` (on `main` at `63060a7a`), whose runtime code
`9e7f0cc0` changes only in the search page's startup order and the 1,000-character cut.

After audit-hachi-issue-639 (NOT_OK on `9e7f0cc0`), `ee5ab8a7`..`c4c20ba7` on
`3b7730f1`, rebased unchanged onto `main` at `f5c48e82` as `a9e8ac88`..`59abf2c5`,
send only the searched 1,000 characters from the offscreen document. The
`fix1-*` results and the mutations of `59abf2c5` in `results/mutants.md` are
from those heads.

## Screenshots

```sh
HACHIDORI_SEARCH_SCREENSHOTS=docs/evidence/issue-639 node test/run.mjs chrome-e2e
python3 docs/evidence/issue-639/compose.py docs/evidence/issue-639 composite.png
```

`test/chrome-e2e/search.mjs` takes the `search-page*`, `popup-window`,
`toolbar-menu` and `settings-search-page` pictures, with the Clipboard monitor
off as it is by default; `test/chrome-clipboard-monitor.mjs` takes the
`search-clipboard-monitor*` pictures, with it on. `compose.py` is #610's.

| file | what it shows |
| --- | --- |
| `composite.png` | the search page, the toolbar menu and the popup window, the switch off (`docs/assets/search-page.png`, pixel-identical) |
| `search-clipboard-monitor.png` | the monitor on, 読む searched after it was copied in another tab (`docs/assets/search-clipboard-monitor.png`, pixel-identical) |
| `search-clipboard-monitor-girlypop.png`, `-high-contrast.png`, `-default.png` | 漢字, copied in another tab, after a live change to Girlypop, High contrast and Default |
| `search-clipboard-monitor-forced-colors.png` | the same page with `forced-colors: active` emulated |
| `search-page.png`, `search-page-default.png`, `search-page-dracula.png`, `search-page-high-contrast.png` | #610's pictures, now with the switch in the header |
| `popup-window.png`, `toolbar-menu.png`, `settings-search-page.png` | the popup window, the toolbar menu and Settings → Reading → Search page |
| `keyboard-focus.png` | the switch's focus ring after Shift+Tab from the search box (`scripts/keyboard-check.mjs`) |

## Scripts and results

Each script loads the extension in its own headless Chrome profile and writes
scratch copies under `/tmp/hachi-639/`; `HACHIDORI_CHROME` names the browser.
The benchmarks import the fixture dictionary and use a copy of the extension
that holds `clipboardRead` from the start, because headless Chrome cannot
answer the permission prompt.

| script | what it checks | results |
| --- | --- | --- |
| `scripts/bench-lookup.mjs <repo> [--main]` | `hd_lookup` latency from Settings for 5 s back to back, in three rounds of: no search page open, a search page polling an unchanged 1,000-character clipboard, and one whose monitor's read never returns | `results/fb-lookup-{main-1,head-1,head-2,main-2}.txt`, run in that order |
| `scripts/bench-clipboard.mjs <repo>` | the same lookups in one session; one `hd_clipboard_read` round trip by clipboard size; copy-to-query time | `results/fb-clipboard-{1,2}.txt` |
| `scripts/bench-rate.mjs <repo>` | reads in 10 s with the search page in a visible tab and in a background tab | `results/fb-rate-1.txt` |
| `scripts/keyboard-check.mjs <repo> <png>` | with the extension as shipped: Shift+Tab from the box reaches the switch, which shows its focus ring and is named "Clipboard monitor"; Space asks for `clipboardRead`; a refusal leaves it off | `results/keyboard-1.txt` |
| `scripts/grant-check.mjs <repo>` | with the extension as shipped and `clipboardRead` already in Chrome's runtime-granted set (so the click is granted without a prompt): switching on reads and searches a copy from another tab, switching off removes the permission and stops reading, and switching on again searches again | `results/grant-3.txt` |
| `scripts/contrast-check.mjs <repo>` | WCAG contrast of the switch's label, off border, off knob, on track and on knob in every palette of Design → Popup theme, beside the same switch in Settings, with transitions disabled | `results/contrast.md` |
| `scripts/diag-clipboard.mjs <repo>` | one Chrome clipboard read inside the offscreen document by clipboard size (`DIAG_LENGTHS` picks the sizes), timed with the reader of the tree it is given | `results/diag-before-4d4d32d2.txt` and `results/diag-before-early.txt` (the first reader, which read the text area's value, as Yomitan does; the early run, at 07:06Z before that reader was committed, also timed variants of the text area), `results/diag-0401d0f1.txt` |
| `scripts/bench-lookup-tail.mjs <repo> [--main]` (audit-hachi-issue-639's variant of `bench-lookup.mjs`) | `hd_lookup` latency and its tail with `BENCH_CLIP_LEN` characters on the clipboard: no search page, then one polling | `results/fix1-table.md` and `results/fix1-<revision>-<size>-<run>.txt`: `main` `3b7730f1`, `9e7f0cc0` (before the fix) and `c4c20ba7` (after) |
| `scripts/bench-clipboard-cut.mjs <repo>` | `bench-clipboard.mjs` for heads whose reads return at most 1,000 characters; a lookup reply that never comes is counted, not timed | `results/fix1-clipboard-2.txt`, `results/fix1-clipboard-4.txt` (`c4c20ba7`) |

Mutations of the head and the suite that catches each: `results/mutants.md`.
