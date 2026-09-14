<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Overlay mode

Overlay mode is for apps that load Hachidori into their own window instead of a
browser tab, such as the [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner)
in-game overlay. The overlay floats over a game and passes clicks through, so:

- Lookups start on **hover**. Holding an activation key over a game is awkward.
- The **word highlight** starts off. A highlight drawn over game text gets in the way.
- **Dragging selects whole glyphs.** An OCR overlay boxes every glyph in its own span, and Chromium's own drag cannot anchor a selection after such a glyph, so it ends as one glyph or nothing. The reader selects from the pressed glyph to the one under the pointer instead. Releasing looks up exactly the selected text; with no entry for it, the popup offers the pencil to add your own definition.
- The **mining screenshot** is never taken, whatever Settings says. Electron has no `chrome.tabs.captureVisibleTab`, and the see-through overlay page would not show the game anyway.
- The **first-run setup page** is skipped. An embedded host has no tab to show it in.

## Turning it on

Edit `extension/overlay-mode.js` in the host's copy of the extension:

```js
export const OVERLAY_MODE = true;
```

Then load the extension as usual, for example with Electron's
`session.extensions.loadExtension()`. There is nothing to change in storage or Settings.

GameSentenceMiner does this in `scripts/sync-hachidori.mjs` when it vendors a
Hachidori commit, and records the change in the vendored `SOURCE.json`.

## What it changes

When the service worker starts and no options are stored yet, it writes the
normal first-install preferences plus:

| Option | Value | Settings control |
| --- | --- | --- |
| `lookupMode` | `"hover"` | Lookup → Activation → Lookup mode → Hover |
| `sourceHighlightEnabled` | `false` | Design → Highlight the word on the page |
| `anki.captureScreenshot` | `false` | Anki → Screenshot the page when mining |

- **Defaults only:** these are starting values, not locks. A user can change
  any of them in Settings, and the change persists.
- **Existing profiles:** a profile that already has stored options keeps them.
- **Timing:** seeding runs on worker start, not in `chrome.runtime.onInstalled`,
  because an embedding host may never fire that event.
- **Setup:** `onInstalled` does not create a setup record or open `startup.html`,
  so Settings shows no "Resume setup" link.
- **Screenshot:** seeding the option off only keeps the Settings checkbox honest
  on a fresh profile. The worker reads `anki.captureScreenshot` as `false` in
  every overlay profile, so `{screenshot}` fields stay empty without a warning.
- **Pronunciation:** no media capture host runs in an overlay, so browser
  text-to-speech cannot be recorded. Mining skips text-to-speech audio sources.
  With no downloadable source left,
  `{audio}` fields stay empty without a warning; add one under Audio to fill them.

Everything else behaves exactly as in Chrome. In particular, the page scan is
layout-unaware like Yomitan's default: an overlay may box every glyph in its own
absolutely positioned span and Hachidori still reads the word across the boxes,
taking the sentence from the neighbouring text nodes up to a `"\n"` separator.

## Telling the host when the reader needs the window

A click-through overlay window has to become interactive while the reader is
in use. The content script dispatches two events on `window`:

| Event | Meaning |
| --- | --- |
| `hachidori-popup-shown` | The reader needs the window's mouse events: a popup is open, a drag is selecting text, or the lookup for a selection is pending. |
| `hachidori-popup-hidden` | None of that is true any more. |

The events fire once per change, in order, and the shown one is dispatched
from the `mousedown` that starts a drag, before the page's own listeners run.
GameSentenceMiner turns click-through off on the first and back on after the
second; a host that only did so for a visible popup would lose every drag
that starts without one.

Selecting text in the overlay works whether or not a popup is open: press on
a glyph and drag. The selection follows glyphs, not caret positions, so the
pressed glyph and the one under the pointer are always included, in either
direction, and a gap between boxes keeps the last glyph. A press that does
not move is a click and dismisses the popup, as in Chrome.

## Installing dictionaries without setup

Setup normally offers the recommended dictionaries. Without it, open Settings.
An empty library shows **Install recommended dictionaries**, which downloads
and installs every recommended dictionary in one click. The same button stays under
**Import dictionaries** until any of them is installed, and **Retry missing
dictionaries** covers a partial install.

The shared installer picks Jitendex for compact summaries and Bee's term-based
dictionary for kanji clicks from their committed titles, including when installed
through Settings in overlay mode. Each initial selection is consumed once in
installation-local `recommendedDictionarySelections` bookkeeping; an existing
choice is preserved. This does not create an onboarding record in an overlay.
Recommended installation continues after closing Settings, and reopening it
reattaches to the same run.

## Tests

`node test/extension-smoke.mjs` loads the service worker with `OVERLAY_MODE`
set to `true`. Its "overlay mode seeds hover lookups without a highlight or mining screenshot
once and never opens setup" check covers:

- the seeded options;
- no setup record and no tab;
- a later edit surviving a restarted worker;
- a pre-existing profile staying untouched.

Its "overlay mode never takes a mining screenshot, even when the stored option
is on" check asks the worker for a screenshot from a profile that has it on.

`node test/chrome-overlay.mjs` loads a copy of the extension with the flag set
into a real Chrome, over a page that boxes glyphs the way GameSentenceMiner
does, and checks the glyph selection, the pencil for an unknown selection, and
the host events around a drag.
