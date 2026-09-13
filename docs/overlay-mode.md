<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Overlay mode

Overlay mode is for apps that load Hachidori into their own window instead of a
browser tab, such as the [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner)
in-game overlay. The overlay floats over a game and passes clicks through, so:

- Lookups start on **hover**. Holding an activation key over a game is awkward.
- The **word highlight** starts off. A highlight drawn over game text gets in the way.
- The **mining screenshot** starts off. The overlay page is see-through, so a screenshot of it would not show the game.
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

Everything else behaves exactly as in Chrome. In particular, the page scan is
layout-unaware like Yomitan's default: an overlay may box every glyph in its own
absolutely positioned span and Hachidori still reads the word across the boxes,
taking the sentence from the neighbouring text nodes up to a `"\n"` separator.

## Installing dictionaries without setup

Setup normally offers the recommended dictionaries. Without it, open Settings.
An empty library shows **Install recommended dictionaries**, which downloads
and installs every recommended dictionary in one click. The same button stays under
**Import dictionaries** until any of them is installed, and **Retry missing
dictionaries** covers a partial install.

The setup page also picks the compact summary and kanji-click dictionaries
from the dictionaries it installed. Settings leaves both on Automatic, and you
can choose them under Design.

## Tests

`node test/extension-smoke.mjs` loads the service worker with `OVERLAY_MODE`
set to `true`. Its "overlay mode seeds hover lookups without a highlight or mining screenshot
once and never opens setup" check covers:

- the seeded options;
- no setup record and no tab;
- a later edit surviving a restarted worker;
- a pre-existing profile staying untouched.
