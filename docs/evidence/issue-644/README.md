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
| `reporter-script-before-after.png` | The reporter's own pitch filter and CSS on the search page, 嵐 with four pitch dictionaries that agree. Left, `main` at 568412b4 (with #651 and #652): all four rows, as in the issue's first screenshot. Right, this PR at d1fed77b: NHK alone, as in the issue's "should look like this" |
| `reporter-script-before-after-3b7730f1.png` | the same against `main` at 3b7730f1 and this PR at 08d68d7a, before #651 |
| `reporter-script-main.png`, `reporter-script-this-pr.png` | the two halves at full size |
| `parity-web-page.png`, `parity-search-page.png` | the same lookup (食べたかった, Default theme, a red Custom CSS outline) as a web page's popup and as the search page's docked result |
| `palettes-this-pr.png` | the search page in this PR (d1fed77b): Automatic under a light and a dark preference, Default, High contrast, Dracula, and emulated forced colors |
| `palettes/*-main.png`, `palettes/*-this-pr.png` | each palette on `main` 568412b4 and on this PR, for the pixel comparison in `results/accessibility.txt`; `forced-colors-real-*` under Chrome's own `--force-high-contrast` |
| `clipboard-monitor/*-main.png`, `*-this-pr.png` | `test/chrome-clipboard-monitor.mjs`'s pictures, switch on: Default, Girlypop, High contrast and forced colors, `main` 568412b4 against this PR |

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
# main 3b7730f1: {"groups":4,"visible":4}   this PR: {"groups":4,"visible":1}
# Since #651 closes the popup's root, main 1afa347b and 568412b4 read {"groups":0} (the probe cannot see
# into the closed root; the picture shows all four rows), and this PR at cdec3b79 and d1fed77b
# {"groups":4,"visible":1}.
```

## Parity audit: the popup against the search page

Each probe runs the same lookup in a web page's popup and in the search page,
with the same options, and compares them.

| probe | what it compares | result on this PR |
| --- | --- | --- |
| `audit-probe.mjs` | the popup's DOM, computed style, theme and renderer in 15 scenarios: defaults; scale 150 % and opacity 70 %; toolbar at the bottom; two columns; Dracula; JL; Nazeka; Plain; Bee; Crystal Retro blue; compact glossary with the summary and grammar tags hidden; overline furigana pitch with graph and colours, no badge, names or text; average frequency with tags, names and compact numbers; no audio button and no lookup counts; a custom link button | identical HTML in all 15 apart from the resize grip, which a docked result does not have, and the lookup count, which each lookup raises (`results/parity-rendering-diff.txt`); Custom JavaScript ran on both and reached both popups |
| `audit-probe2.mjs` | Alt+ArrowDown/ArrowUp entry moves, the kanji view from the headword, Alt+B and Alt+F history, Back, and a browser shortcut delivered with `tabs.sendMessage` | the same on both; the search page's entry moves scroll further only because its result is taller |
| `highlight-blur-probe.mjs` | word highlighting of unknown words (`wordHighlightEnabled`, `wordHighlightUnknown`; a fake AnkiConnect with no notes leaves every word unknown) and definition blur revealed on click only (`definitionBlurCountEnabled`, at least 1 earlier lookup, `definitionBlurReveal: "click"`): the second lookup's state, after a hover, after a click | `results/highlight-blur.json` on d1fed77b (cdec3b79 gave the same): the web page marks 食べたかった, 漢字 and 読む unknown, the search page's echoed query 漢字 and 読む, the only words it shows; both blur the second lookup, stay blurred on hover and reveal on click |
| `anki-probe.mjs` | recorded audio from a URL source, and Add to Anki with `{screenshot}` against a fake AnkiConnect | the same on both: audio plays and ends, and both notes arrive with a screenshot. Text-to-speech was not checked: headless Chrome has no voices (`hd_audio_voices` returns none); it goes through the same `hd_audio_play` request |
| `nested-probe.mjs` | a child popup from a word in the definitions, an internal link, dictionary images and the dictionary's `styles.css` | the same on both |
| `focus-probe.mjs` | the box has focus when the page opens, in a tab and in a popup window | focused in both |
| `scripts/sandbox-prototype-run.mjs`, `scripts/firefox-sandbox-prototype-*` | what a sandboxed frame may load and do in Chrome 152 and Firefox 159 | Chrome serves it every extension file; Firefox only web-accessible stylesheets and modules (classic scripts and images load either way), which is why the Firefox manifest adds one entry |
| `chrome128-probe.mjs` | the manifest-minimum Chrome 128, where Developer mode gates user scripts | the search frame runs the script there too |

The only gap found was Custom JavaScript itself.

## The Clipboard monitor (#652) and the frame

#652 merged while this PR was open. Its switch asks for the optional
`clipboardRead` permission. `scripts/permission-gesture/` (a tiny extension
per browser: a sandboxed frame holding a switch, and its parent page, which
calls `permissions.request` when the frame says it was clicked) shows
(`results/permission-gesture.txt`):

```text
chrome 152 and 128: no click: "This function must be called during a user gesture";
                    after a click in the frame: the request is pending (Chrome's prompt)
firefox 159:        after a click in the frame: "permissions.request may only be called from a user input handler"
```

So the switch and the monitor are `search.html`'s, laid over the end of the
frame's header; both documents lay out the whole header, each keeping
invisible what the other shows. `scripts/layout-probe.mjs`
(`results/layout.txt`, d1fed77b) and `scripts/layout-widths-probe.mjs`
(`results/layout-widths.txt`, ad4bd2aa: 600, 400, 360, 320 and 280 px wide, and
90, 125 and 150 % zoom) find the header, title, switch, form and results at the
same positions as on `main`, to 1/64 px, including below about 380 px, where
the title wraps; d1fed77b's one-line box left the switch over the title there.
`scripts/switch-paint-probe.mjs` with `switch-paint-analyse.py`
(`results/switch-paint.txt`, ad4bd2aa, every painted frame of four page opens,
Default theme) shows the switch never painting before the title: here with
the box, one frame (11-15 ms) after the title, in 4 of 4 opens (the second
audit saw 3 of 4, and title and box together in the fourth); `main` draws it
with the title. An earlier version drew the switch 33-48 ms before the title. `scripts/switch-focus-probe.mjs` (`results/switch-focus.txt`, 818dba12)
shows a click on the switch or its label handing focus to the frame, where on
`main` it stays on the switch in the reader's own document. (After its first
click, which asks for the permission and leaves headless Chrome's prompt
pending, `document.hasFocus()` is false on `main` and here alike, while the
focused element is the switch on `main` and the frame here; after the second
click the page has focus again.) So the reader's
keybinds and activation key work after the click on both
(`test/chrome-clipboard-monitor.mjs` plays the result with Alt+P after the
click). Escape and Ctrl+U pressed on a focused switch select and clear the box,
on `main` and here, and Ctrl+U opens no source view. `scripts/click-detail-probe.mjs`
shows why the hand-back follows the label's `pointerup` rather than the click's
`detail`: Chrome 128 reports a click on the label text with `detail` 0, as
Space.

The user's Custom JavaScript runs in the frame, so `search.html` passes on only
the text the reader would search: text with a Japanese character, the reader's
`isLookupWorthy` test, with `content-scan.js`'s character set. The second audit
found that before that, in Firefox 159, a script registering with
`HDSearchBridge.onClipboard` got every text the monitor read, where a user
script on a web page reads nothing without the user's help;
`test/chrome-clipboard-monitor.mjs` now listens in the frame and fails if a
copied "hello world" reaches it. Text copied while a Note is open still
reaches the frame, which then does not search it.
`scripts/userscript-clipboard-probe.mjs` and its control
(`results/userscript-clipboard.txt`) are Chrome 152 only: there, while
Hachidori holds `clipboardRead`, a user script on any web page reads the
clipboard itself (`execCommand("paste")` and `navigator.clipboard.readText()`
both return the copied text); without the grant neither does.

## Flash on open (round-one audit, FIX 1)

`scripts/flash-probe.mjs` is the first audit's probe, unchanged
(`results/flash.json`, Chrome 152, ad4bd2aa, four page opens per case;
d1fed77b gave the same). A green page is shown first, so each painted frame is
green (the previous page), WHITE or dark:

| case | as is | without `reader-options.js`, `settings-theme.js`, `settings.css` in `search.html` |
| --- | --- | --- |
| dark theme, light preference | green, then dark, 4/4 | WHITE for 16-51 ms, then dark, 4/4 |
| light theme, dark preference | green, then white (the light theme), 4/4; no dark frame | the same |

The white frame on `cdec3b79` came from `search.html` loading `settings.css`
without `render/reader.css`, which defines the palette `settings.css` reads, so
its body was transparent. The dark frame came from the iframe's default colour
scheme differing from the frame root's `light dark`.

## Accessibility

The search page now lives in a frame, so `results/accessibility.txt` compares
it with `main` 568412b4: every palette, the keyboard order from the box, focus
and the accessibility tree. Each palette differs only on the Clipboard monitor
switch, by at most 3/255 (it is composited over the frame), and High contrast
also on antialiased edges, by at most 4/255; Chrome's own forced-colors mode
differs on 16 pixels of the switch, by 1/255. The Tab order is unchanged,
Shift+Tab from the box reaches the switch as on `main`, and the frame's tree
holds the same landmarks and names, inside a frame titled "Hachidori Search".


## Performance

`scripts/bench-search.mjs` opens new search pages and searches five words in
each, on one build, with the fixture dictionary and Chrome 152, on a shared
host (load average about 28-46 on 64 cores). Since #651 `main`'s popup root is
closed, so `main`'s searches were timed on a copy whose `content.js` attaches an
open root (one line; readiness does not depend on it). Three sessions per build
ran interleaved, five pages each (`results/bench-d1fed77b.jsonl`):

| measure (median ms, n) | `main` 568412b4 | `cdec3b79` | this PR d1fed77b |
| --- | --- | --- | --- |
| a new search page until it takes a search | 99 (15) | 123 (15) | 123 (15) |
| a page's first search, Enter to the result in the popup's DOM | 19.4 (15) | 18.5 (15) | 17.1 (15) |
| later searches | 5.8 (60) | 6.1 (60) | 6.0 (60) |

Session medians for readiness ranged 88-102 ms on `main` and 109-135 ms on
each branch build; an earlier batch on the unmodified `main`
(`results/bench-d1fed77b-ready-only.jsonl`) gave 97 against 140. The shell's
Clipboard monitor costs nothing measurable over `cdec3b79`.
`scripts/startup-split.mjs` (`results/startup-split-d1fed77b.txt`, 8 pages
each) puts `main`'s page at ready in 88 ms; here `search.html` has parsed its
theme files at 35 ms, the frame's document starts then, and the frame is ready
at 111 ms (`cdec3b79`: 107). Earlier rounds: `results/bench-08d68d7a.jsonl` and
`results/bench-4f023308-parallel-read-experiment.jsonl`.
