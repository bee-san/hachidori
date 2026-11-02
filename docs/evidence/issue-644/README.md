# Issue #644 evidence: Custom JavaScript on the search page

This branch is not for merging. It holds the screenshots, ad-hoc probes and
raw results behind the pull request for #644. Unless a row says otherwise they
were taken with Chrome for Testing 152.0.7977.75, the suites' fixture
dictionaries and, for the reproduction, dictionaries built in the probe. The
reporter's script and CSS come from the debug log attached to #644 and are not
copied here; `reporter-probe.mjs` reads them from `REPORTER_JS` and
`REPORTER_CSS`.

## Screenshots

| file | what it shows |
| --- | --- |
| `reporter-script-before-after.png` | The reporter's own pitch filter and CSS on the search page, 嵐 with four pitch dictionaries that agree. Left, `main` (37bb0a86): all four rows, as in the issue's first screenshot. Right, this PR: NHK alone, as in the issue's "should look like this" |
| `reporter-script-main.png`, `reporter-script-this-pr.png` | the two halves at full size |
| `parity-web-page.png`, `parity-search-page.png` | the same lookup (食べたかった, Default theme, a red Custom CSS outline) as a web page's popup and as the search page's docked result |
| `palettes-this-pr.png` | the search page in this PR: Automatic under a light and a dark preference, Default, High contrast, Dracula, and Chrome's forced-colors mode |
| `palettes/*-main.png`, `palettes/*-this-pr.png` | each palette on `main` and on this PR, for the pixel comparison in `results/accessibility.txt` |

## Reproducing #644 on `main`

`scripts/probe-userscripts.mjs` allows user scripts for the extension, as a
user does on `chrome://extensions`, and tries every way to run code in
`search.html` from the service worker:

```text
"register own-extension pattern": "ERROR: Script with ID 'probe-ext' has invalid value for matches[0]: Invalid scheme."
"userScripts.execute USER_SCRIPT": "ERROR: Cannot access contents of the page. Extension manifest must request permission to access the respective host."
"userScripts.execute MAIN": "ERROR: Cannot access contents of the page. ..."
"scripting.executeScript": "ERROR: Cannot access contents of the page. ..."
```

`<all_urls>` does not cover the extension's own pages, so the registration the
worker makes for web pages never reaches the search page. `reporter-probe.mjs`
shows the user-visible result: 4 of 4 pitch groups visible on `main`, 1 of 4
with this PR.

```sh
REPORTER_JS=reporter.js REPORTER_CSS=reporter.css HACHIDORI_CHROME=… \
  node scripts/reporter-probe.mjs "$REPO" out.png
# main: {"groups":4,"visible":4}   this PR: {"groups":4,"visible":1}
```

## Parity audit: the popup against the search page

Each probe runs the same lookup in a web page's popup and in the search page,
with the same options, and compares them.

| probe | what it compares | result on this PR |
| --- | --- | --- |
| `audit-probe.mjs` | the popup's DOM, computed style, theme and renderer in 15 scenarios: defaults; scale 150 % and opacity 70 %; toolbar at the bottom; two columns; Dracula; JL; Nazeka; Plain; Bee; Crystal Retro blue; compact glossary with the summary and grammar tags hidden; overline furigana pitch with graph and colours, no badge, names or text; average frequency with tags, names and compact numbers; no audio button and no lookup counts; a custom link button | identical HTML in all 15 apart from the resize grip, which a docked result does not have, and the lookup count, which each lookup raises (`results/parity-rendering-diff.txt`); Custom JavaScript ran on both and reached both popups |
| `audit-probe2.mjs` | Alt+ArrowDown/ArrowUp entry moves, the kanji view from the headword, Alt+B and Alt+F history, Back, a browser shortcut delivered with `tabs.sendMessage`, word highlighting and click-to-reveal blur | the same on both; the search page's entry moves scroll further only because its result is taller |
| `anki-probe.mjs` | recorded audio from a URL source, and Add to Anki with `{screenshot}` against a fake AnkiConnect | the same on both: audio plays and ends, and both notes arrive with a screenshot |
| `nested-probe.mjs` | a child popup from a word in the definitions, an internal link, dictionary images and the dictionary's `styles.css` | the same on both |
| `focus-probe.mjs` | the box has focus when the page opens, in a tab and in a popup window | focused in both |
| `scripts/sandbox-prototype-run.mjs`, `scripts/firefox-sandbox-prototype-*` | what a sandboxed frame may load and do in Chrome 152 and Firefox 159 | Chrome serves it every extension file; Firefox only web-accessible stylesheets and modules (classic scripts and images load either way), which is why the Firefox manifest adds one entry |
| `chrome128-probe.mjs` | the manifest-minimum Chrome 128, where Developer mode gates user scripts | the search frame runs the script there too |

The only gap found was Custom JavaScript itself.

## Accessibility

The search page now lives in a frame, so `results/accessibility.txt` compares
it with `main`: every palette, the keyboard order from the box, focus on open
and the accessibility tree. Light, dark, Default, Dracula and Chrome's own
forced-colors mode are pixel-identical; High contrast differs only on
antialiased edges, by at most 4/255. The Tab order is unchanged, and the tree
holds the same landmarks and names, inside a frame titled "Hachidori Search".


## Performance

`scripts/bench-search.mjs` opens new search pages and searches five words in
each, on one build, with the fixture dictionary and Chrome 152, on a shared
host (load average about 37 on 64 cores). Three sessions per build ran
alternately, five pages each: `results/bench-08d68d7a.jsonl` (`main` 3b7730f1
against 08d68d7a) and `results/bench-4f023308-parallel-read-experiment.jsonl`
(against 08d68d7a's successor with the user script read alongside the frame's
load, an experiment that was reverted because it changed nothing).
`scripts/startup-split.mjs` splits a page's start-up on one clock.

| measure (median ms, n) | main | this PR |
| --- | --- | --- |
| a new search page until it takes a search | 111 (15), 104 (15) | 139 (15), 142 (15) |
| a page's first search, Enter to the result in the popup's DOM | 18.7 (15), 20.6 (15) | 21.9 (15), 19.4 (15) |
| later searches | 6.3 (60), 6.7 (60) | 7.6 (60), 7.5 (60) |

The split (8 pages each): `main`'s page is ready at 95-97 ms. Here the frame's
document starts 37-42 ms after `search.html` does, once `search.html` has
parsed its own `reader-options.js`, `settings-theme.js` and `settings.css`,
which paint its background in the saved theme until the frame shows; the frame
is then ready about 85 ms later, the same as `main`'s whole page. A module
marked `async` and the parallel script read changed nothing measurable.
Without those three files the page was ready about 15 ms sooner, but its
window would show the browser's colour before the frame paints (#296).
