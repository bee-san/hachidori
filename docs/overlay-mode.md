<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Overlay mode

Overlay mode is for apps that load Hachidori into their own window instead of a
browser tab, such as the [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner)
in-game overlay. The overlay floats over a game and passes clicks through, so:

- Lookups use **hover** unless you choose an activation key in the overlay. Holding an activation key over a game is awkward.
- The **word highlight** starts off. A highlight drawn over game text gets in the way.
- **Dragging selects whole glyphs.** An OCR overlay boxes every glyph in its own span, and Chromium's own drag cannot anchor a selection after such a glyph, so it ends as one glyph or nothing. The reader selects from the pressed glyph to the one under the pointer instead. Releasing looks up exactly the selected text, subject to Reading's Japanese-only setting. With no entry for it, the popup offers the pencil to add your own definition unless Reading → Personal dictionary → **Show a popup when a selection has no definition** is off; the no-dictionaries notice still appears. With **Use the personal dictionary** off, releasing only leaves the selection for copying and hover lookups continue.
- The **mining screenshot** is unavailable. Settings shows it disabled and explains that screenshot fields stay empty. Electron has no `chrome.tabs.captureVisibleTab`, and the see-through overlay page would not show the game anyway.
- Chrome-owned pages are unavailable, so **browser shortcut management** and the **local-file access prompt** are disabled. Page/popup keybinds still work. **Custom toolbar links** remain editable and the reader asks the host to open their validated HTTP(S) URLs in the system browser. **Backup export and restore** work: export uses the host's save dialog when Chrome's downloads API is absent.
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
| `lookupMode` | `"hover"` | Reading → Activation → Activation key or button → No key |
| `sourceHighlightEnabled` | `false` | Design → Highlight the word on the page |
| every `anki.templates[].captureScreenshot` | `false` | Anki → Screenshot the page when mining |

- **Reading defaults:** lookup activation and word highlighting remain editable
  in Settings, and later choices persist.
- **Existing profiles:** a profile that already has stored options keeps them,
  including any lookup mode it chose (or a legacy `modifier`). One that never
  chose a mode, such as a profile from before overlay mode or a restored browser
  backup, reads on hover: an unlinked worker stores `lookupMode: "hover"` in one
  ordinary revisioned write when it starts, a restore writes it with the restored
  settings, and a linked overlay composes it from its local record and keeps it
  on Unlink.
- **Timing:** seeding runs on worker start, not in `chrome.runtime.onInstalled`,
  because an embedding host may never fire that event.
- **Setup:** `onInstalled` does not create a setup record or open `startup.html`,
  so Settings shows no "Resume setup" link.
- **Alarms:** the service worker keeps its one-shot alarms (the Anki duplicate
  index refresh, automatic backup retry, dictionary update schedule and sharing
  reconnect) on its own timers instead of `chrome.alarms`. Electron exposes that
  API and records the alarm, but never dispatches `onAlarm` to the worker.
  Timers last as long as the worker; a worker restart re-checks what is due,
  and a refresh left unfinished by a stopped host is retried at once.
- **Screenshot:** the worker reads screenshot capture as `false` for every
  Template in an overlay profile. Settings also shows the effective
  off/disabled capability when a carried or shared Template has the stored
  option on. It preserves each Template and its field mappings.
- **Pronunciation:** an overlay plays browser speech, but mining skips
  text-to-speech audio sources because overlays do not record browser speech.
  With no downloadable source left, `{audio}` fields stay empty without a
  warning; add a downloadable pronunciation source under Audio to fill them.

## Settings capabilities

Overlay mode keeps stored and shared settings intact, but applies the host's
capabilities before presenting or using them. A linked Chrome therefore cannot
turn an Electron-only control back on remotely.

| Settings area | Overlay behaviour |
| --- | --- |
| Anki screenshot | The switch is effectively off and disabled; existing mappings and the stored choice are preserved. |
| Audio | Downloadable pronunciation and browser-speech playback work; overlays do not record browser speech. |
| Keybinds | Page and popup keybinds remain editable. Chrome's browser-shortcut list and manager are disabled. |
| Design | Appearance, layout, custom CSS and Custom buttons work. Link buttons ask the embedding host to open the URL in the system browser; Anki buttons use their selected Template. The Settings live preview cannot launch links. |
| Backup & restore | Export and restore work. Without Chrome's downloads API, export requests a ZIP save through the host's download handler. Cancelling that save does not change your library. |
| Reading | Reading controls work. The Chrome extension-details prompt for local-file access is omitted because the embedding host owns that permission. |

`overlay-mode.js` is the single capability source used by Settings, the toolbar,
the content script and the service worker. Unsupported runtime requests fail
with an explicit overlay error even if they came from stale UI or a remotely
shared option.

For link-type Custom buttons, the content script dispatches `hachidori-open-external` with
a request ID, a normalized credential-free HTTP(S) URL and the saved activation
choice. The host answers with `hachidori-open-external-result` carrying the same
request ID and either `ok: true` or an error. Hosts must validate the URL again
at their privileged browser-opening boundary and bind that operation to the
intended overlay window.

The page scan is layout-unaware like Yomitan's default: an overlay may box every glyph in its own
absolutely positioned span and Hachidori still reads the word across the boxes,
taking the sentence from the neighbouring text nodes up to a `"\n"` separator.
A glyph drag reads its sentence the same way, from its first glyph, so a drag
over one glyph or on into the next block still gets the line it starts in.

## Local preferences while Sharing

A linked overlay uses the host's library and shared settings while retaining
the preferences for its own reading surface:

| Area | Overlay-local preferences |
| --- | --- |
| Activation and scanning | Lookups on/off, Japanese-only scanning, lookup mode, activation key, child popup trigger, grace period to reach the popup, and hide popup on cursor exit with its delay |
| Personal dictionary | Use the personal dictionary; show a popup when a selection has no definition |
| Source highlight | Highlight the word on the page |
| Popup layout | Width, height, columns, toolbar position and nesting depth |

These edits work while the host is disconnected and persist through host
updates, worker/browser restarts and Unlink. Other settings, including the
theme and dictionary choices, still update the shared Hachidori. Sharing
Settings explains this distinction.

The worker composes the live options from the host plus the local values kept
in `sharingLocalState`. A private `sharingOptionsVersion` tracks the host CAS
revision and a local offset, so existing readers and Settings still see one
increasing options revision. Mixed saves send shared fields first and then
commit local fields; a host conflict, intervening local edit or changed link
retains the draft for review. Network waits leave local edits and Unlink
available. Existing linked overlays adopt their kept local preferences on
worker start before reconnecting.

## Telling the host when the reader needs the window

A click-through overlay window has to become interactive while the reader is
in use. The content script dispatches two events on `window`:

| Event | Meaning |
| --- | --- |
| `hachidori-popup-shown` | The reader needs the window's mouse events: a popup is open, a drag is selecting text, the lookup for a selection is pending, or a scan mouse button is held. |
| `hachidori-popup-hidden` | None of that is true any more. |

The events fire once per change, in order, and the shown one is dispatched
from the `mousedown` that starts a drag or a scan button's hold, before the
page's own listeners run. GameSentenceMiner turns click-through off on the first
and back on after the second; a host that only did so for a visible popup would
lose every drag that starts without one.

A scan mouse button (Reading → Activation key or button) suits an overlay: the
host leaves the game focused, so an activation key never reaches the reader,
but a press over OCR text does. The claim lasts while the button is held and is
released after the release when no popup is open. Without it, Electron would
stop reporting the held button once click-through is back on.

Selecting text in the overlay works whether or not a popup is open: press on
a glyph and drag. The selection follows glyphs, not caret positions, so the
pressed glyph and the one under the pointer are always included, in either
direction, and a gap between boxes keeps the last glyph. A press that does
not move is a click and dismisses the popup, as in Chrome.

The host's own window changes are not the reader leaving the page. Turning
click-through on as the pointer leaves OCR text reports the pointer leaving the
window, and handing focus to the game or back blurs it. In overlay mode neither
closes a popup, ends a drag or releases a held scan button, and neither
publishes `hachidori-popup-hidden`: a window-exit only forgets the pointer and
cancels a scan that has not rendered, as Yomitan's does, and a blur only drops
an activation key whose release the game will receive instead. The popup then
closes by the usual rules: Escape, a click, a new lookup, Hover mode's pointer
leaving the text for the page, and **Hide popup on cursor exit** after its
delay. A browser tab keeps the popup through blur and leaving the window as
well (#432), except that focus moving into one of the page's frames is a click
outside it.

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
- a pre-existing profile without a lookup mode gaining hover in one revision,
  and one with a legacy `modifier` staying untouched.

Its "overlay mode never takes a mining screenshot, even when the stored option
is on" check asks the worker for a screenshot from a Template that has it on. It
also verifies that link-button requests fail before opening a tab and that
the worker download endpoint checks the actual API.

`node test/chrome-overlay.mjs` loads a copy of the extension with the flag set
into a real Chrome, over a page that boxes glyphs the way GameSentenceMiner
does. It checks the Settings capability matrix, the seeded No key choice,
editable Custom buttons, rendered link and Anki buttons, and backend guards
before checking glyph selection, the pencil for an unknown selection, and the
host events around a drag. A window blur during a hover and in the middle of a
drag keeps the popup, the drag and the host claim.

`test/electron-backup.cjs` exercises export, download cancellation and restore in
a sandboxed Electron window without Chrome's downloads API. With Electron 43.4.1
installed outside the extension, run `NODE_PATH=/path/to/node_modules xvfb-run -a
/path/to/electron test/electron-backup.cjs`. It saves real ZIPs, restores deleted
dictionaries and settings, and compares native payload bytes, media and styles.
`HACHIDORI_BACKUP_BASELINE=<base-sha>` repeats the enabled-button assertion with
the original Settings files in an isolated copy. Logs, ZIPs, screenshots and
disposable profiles remain under ignored `test/tmp/electron-backup`.
The harness uses Electron pointer input and `DownloadItem.setSavePath`/`cancel`,
not the OS save dialog or a packaged GameSentenceMiner installation.
