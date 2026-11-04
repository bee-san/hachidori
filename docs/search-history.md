<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Search history

The owner, 2026-11-03: "store every line copied to the search field … and let
users go to prior lines by pressing Up on their keyboard. Copy
[Rubi_for_vita](https://github.com/bee-san/Rubi_for_vita) with the logic for
keyboard navigation, like left right up down etc. Include … a Userscript to
turn Hachidori Search into a texthooker UI like
[texthooker-ui](https://github.com/Renji-XD/texthooker-ui)."

The [search page](architecture.md#search-page) keeps each line it searches.
Up and Down in its box bring earlier lines back, as a shell's do. In the
searched text, the arrow keys move a cursor word by word and row by row, and
on to earlier lines, as Rubi's overlay does, and each word is looked up as the
cursor reaches it. User scripts read and change the lines through
`HDSearchHistory`.

## What is kept

Every line that enters the search box and is searched is kept: typed and
searched with Enter or the Search button, pasted outside a text field, or read
by the Clipboard monitor. A line is the box's text, trimmed, as the page
searches it, and is kept even when it finds nothing. Each line has:

| Field | |
| --- | --- |
| `id` | a positive integer, larger for each newer line |
| `text` | the line |
| `at` | when it was kept, in milliseconds since 1970 (`Date.now()`) |
| `source` | `typed`, `paste` or `clipboard` |
| `page` | `tab`, or `popup` for the search page's popup window |

A line that repeats the newest line is not kept again (A, A is one line); a
line that comes back after another one is (A, B, A). Edited lines keep their
id, time, source and page.

**Settings → Advanced → Search history** has the controls. The feature is off
until you switch it on:

- **Keep a history of searched lines** (`searchHistoryEnabled`, off). On, the
  page keeps its lines and its keys act: Up and Down in the box, and the
  searched text's cursor below. Off, the page is as it was before the history:
  it keeps no line, a search leaves the box, the searched text is no text box
  and the search page's keys do nothing; the lines already kept stay. Switched
  off during a visit, the page shows the searched line again, and during a
  walk in the box, the box shows its draft again.
- **Lines kept** (`searchHistoryLimit`, 10,000; any number from 1). Past it,
  the oldest lines are removed. The search page applies it with each new line,
  and Settings applies a lowered limit at once.
- How many lines are kept, and **Clear history**, which deletes them all.

Both options are reader options: they travel in backups, sharing and restore
with the other options, and Toggle option does not offer the switch.

## Where the lines are kept

The lines are an IndexedDB database of the extension's origin,
`hachidori-search-history`, with one object store, `lines`, keyed by `id`
(`extension/search-history.js`). `search.html` opens it for the page's
sandboxed frame and serves the frame's requests (`search-shell.js`), and
Settings opens it for the count, the limit and Clear history. Each change
goes to the other open pages on a `BroadcastChannel` of the same name.

- **Not page `localStorage`.** The page itself is a sandboxed frame
  (`search-frame.html`, #644) with an opaque origin, which has no storage of
  its own. `localStorage` is also synchronous, holds only strings, and is
  limited to a few megabytes per origin.
- **Not `chrome.storage.local`.** The service worker owns its writes through
  one queue (AGENTS.md), and every change goes to every extension context and
  to the reader in every tab, which reads its `options`, dictionary state and
  lookup counts from the same events. With the Clipboard monitor on, a line
  can come every few seconds, and each would wake every tab's reader and write
  the whole list again.
- **IndexedDB**, as the debug log is (`debug-log.js`): each line is one record
  added in one transaction with the repeat check and the limit, the pages that
  need the lines open the database themselves, and nothing else hears of them.

**Backups.** The lines are not in backups or automatic snapshots, and linked
browsers do not share them. They can hold any Japanese text copied in any
program while the Clipboard monitor is on, and a backup is an unencrypted file
made to be kept and moved; the automatic snapshots copy everything they hold
into `chrome.storage.local` every day. A restore also publishes its saved state
in one `chrome.storage.local` write ([backup format](backup-format.md)), which
a separate IndexedDB database cannot join. Backups leave out the browser's own
history for the same reasons. The two options are in backups.

**Profiles.** Hachidori has no profiles on `main` yet (the multi-language work,
#640, adds them). A profile key can be added later as a `profile` field with an
index, in the database's version 2; lines without one belong to the Japanese
profile, as the single-profile shape of
[`docs/languages.md`](https://github.com/bee-san/hachidori/blob/feat/multi-language/docs/languages.md)
keeps today's records as the Japanese profile's.

## Keys

Each key is a keybind in **Settings → Keybinds**, in the **On the search page**
scope (Yomitan's search scope), so it can be changed, turned off or given
another key there. A keybind list saved before this scope existed has no row
in it; it gains the search page's default rows when it is read, and keeps them
once a keybind is next edited. A list with any row in that scope is kept as it
is: untick a row to turn its key off.

| Default | Action | Where it applies |
| --- | --- | --- |
| Up | Previous line in the search history | the search box, with the caret on its first line and no text selected |
| Down | Next line in the search history | the search box, during a walk, with the caret on its last line |
| Left | Previous word in the searched text | the searched text, while it has focus |
| Right | Next word in the searched text | the searched text |
| Up | Row above, or the earlier line | the searched text |
| Down | Row below, or the later line | the searched text |
| Enter | Add note | the searched text: adds the word under the cursor to Anki |
| Escape | (the page's own, not a keybind) | anywhere outside the popup: focuses the box and selects its text, as before |

A key acts only where it applies. Everywhere else it does what it always did:
the arrows move the caret in the box and in other fields, scroll, or move
between a popup's controls, and an IME's keys stay with the IME.

### In the box

Up shows the newest line, and each further Up the one before it; Down goes
forward again, and Down past the newest line brings back what the box held
before the walk (the draft). A line equal to what the box shows is skipped. Up
leaves the caret at the end of the line's first row and Down at its end, so the
next press walks on. Only line breaks make rows here: in a long line the box
wraps onto several rows, Up walks from any of them, as in a shell. Typing in
the box ends the walk, and the text in it is the next walk's draft. Enter searches the line shown, which is kept again as
the newest line unless it is the newest already.

### In the searched text

After a search the searched text has focus, unless focus was in the popup or
another control. A click or Tab gives it focus too. It is a read-only text
box, so a screen reader passes it the arrow keys, and each word the cursor
reaches is read out from a polite live region once its lookup answers, and
again when focus comes to the text; a click that moves the cursor reads out
the word it moves to instead. With Reading → Search page →
Look up words with a click on, a click on a word moves the cursor there and
looks it up from the clicked character. Its cursor
is the underlined word, the one the results show.

This is Rubi's overlay cursor (bee-san/Rubi_for_vita@6b5e276:
`core/text_rows.c` `vjo_word_step`, `vjo_text_row_step`,
`vjo_text_row_vertical` and `vjo_text_row_key`, as `shell/overlay.cpp`
`input_overlay` calls them), in `extension/search-lines.js`:

- **Right** goes past the word the last lookup matched, to the next character
  the cursor can rest on, and looks the word there up. While a lookup is
  pending, or one matched nothing, Right goes one character.
- **Left** goes back to where each of up to 16 Rights started, and then one
  character at a time.
- Both go across rows and line breaks in reading order and stop at the text's
  first and last characters, except that a text on one row goes round its ends
  for a fresh press; a held key stops there.
- **Up** and **Down** go to the row above or below, soft-wrapped rows included,
  keeping the column across a short row. The rows are the browser's own layout
  of the text.
- The cursor rests on Japanese letters only while Reading → Japanese text only
  is on (Rubi's **Japanese characters only**), otherwise on any visible
  character.

Up on the text's top row opens Rubi's line history
([`docs/line-history.md`](https://github.com/bee-san/Rubi_for_vita/blob/main/docs/line-history.md)):
the line before it takes its place, between the last row of the line before
that and the first row of the line after it, both dimmed and in smaller type,
which no lookup, selection or screen reader reads. Each palette dims them,
less where it has less room above 4.5:1. Solarized Light, whose text is at
4.65:1, has no room, and Solarized Dark and Valentine have little, so there
the size does most of the work; a minimum font size of 20 px or more removes
it. A note under them says where it is:
`Earlier line -2 · ▲ earlier · ▼ later`, without `▲ earlier` on the oldest
line. Up on its top row goes further back, and Down on its last row comes
forward; past the newest earlier line, the searched line comes back with its
cursor where it was. Each earlier line opens with its cursor on its first
word, looked up. Enter on an earlier line adds its word with that line as the
sentence, as a card from Rubi's earlier line does. A new search starts from
the line it searched.

These differ from Rubi's overlay:

- A visit has no 32-line cap; the history's limit bounds it.
- A new line from the Clipboard monitor ends a visit and is searched. Rubi
  holds new text until the visit ends.
- An earlier line opens after the brackets and spaces it starts with, where a
  search starts. Rubi's opens on its first character while Japanese characters
  only is off.
- Escape leaves the visit shown while it focuses the box.
- The neighbour rows are smaller than the text as well as dimmed; Rubi draws
  them at the text's size.
- The cursor always goes by word (Rubi's Whole word mode).

Beside the text, while it has focus, a note names its keys from the keybinds,
such as `Left/Right: words · Up/Down: rows and earlier lines · Enter: add to
Anki · Escape: back to the box`; the text's accessible description is that
note and the visit's position. The note keeps its room while hidden, so a
click that takes focus from the text does not move what is under the pointer.

## For user scripts: `HDSearchHistory`

Design → Custom JavaScript runs on the search page in its frame once the
browser allows user scripts ([Search page](architecture.md#search-page)): from
Chrome's Allow User Scripts, and in Firefox from version 154, which sandboxes
the frame. There, `globalThis.HDSearchHistory` is the history. It is undefined
on web pages, where the same script runs too, so a script for the search page
starts with `if (!globalThis.HDSearchHistory) return;`. A user's script can
read, edit and delete the history's lines through it, which no web page can.

| Member | |
| --- | --- |
| `list({ before, after, limit } = {})` | resolves to lines, oldest first: all of them; the newest `limit` lines before the line with id `before`; or the oldest `limit` after the line with id `after` |
| `edit(id, text)` | gives the line new text, trimmed (not empty); resolves to the line, or `null` when there is none |
| `remove(id)` | deletes the line; resolves to whether there was one |
| `lookUp(node, offset)` | looks up the word at `offset` in the text node `node` of the page, as the cursor does, and shows it in the results area; resolves to the length of the text the result matched there, 0 when nothing was shown |
| `enabled` | whether Advanced → Search history is on |
| `clipboardPaused` | set to `true` to stop searching and keeping the Clipboard monitor's text, `false` to go on; it lasts until the page reloads |
| `"line"` event | `event.detail` is a line just kept, on this search page or another one |
| `"change"` event | `event.detail` is `{ type: "edit", line }`, `{ type: "remove", id }`, `{ type: "clear" }` or `{ type: "prune", before }` once the lines older than the id `before` are gone |

```js
// Custom JavaScript runs as a classic script: no top-level await.
if (globalThis.HDSearchHistory) {
  HDSearchHistory.list({ limit: 5 }).then((lines) => { for (const line of lines) console.log(line.text); });
  HDSearchHistory.addEventListener("line", event => console.log("kept", event.detail.text));
}
```

A user script has no storage on the search page: the frame's origin is
opaque, so anything it wants to keep across reloads lives in its own code.

## A texthooker user script

A texthooker view built on `HDSearchHistory`, inspired by
[texthooker-ui](https://github.com/Renji-XD/texthooker-ui) (MIT, Copyright (c)
2023 Renji-xD) but with code of its own, is attached to
[the pull request that added the history](https://github.com/bee-san/hachidori/pull/666)
as [`texthooker.js`](https://raw.githubusercontent.com/bee-san/hachidori/assets/search-history/search-history/texthooker.js), rather than kept in this repository. It
lists the kept lines with their counts and times, pauses the Clipboard monitor,
edits and deletes lines and looks up a clicked word. To use it, switch on
Settings → Advanced → Search history, paste the file into Design → Custom
JavaScript and switch on the search page's Clipboard monitor. It has no
websocket client, as texthooker-ui has for Textractor's and mpv's plugins: the
Clipboard monitor brings in what those programs copy, and the search page opens
no connection of its own. Firefox 153 runs no Custom JavaScript on the search
page, so it needs Firefox 154 or later there.

## Tests

- `test/search-history.test.mjs`: the store, on a fake of the IndexedDB it uses
  (`test/indexeddb-fake.mjs`): the fields, the repeat, the limit, lists from
  either side of a line, edits, removals, prunes, clears and the channel.
- `test/search-lines.test.mjs`: the cursor's word, row and column steps, on
  cases from Rubi's `host/tests/test_text_rows.c` in UTF-16 units.
- `test/search-bridge.test.mjs`: what the frame may ask of the history, and
  the switch and limit `search.html` applies.
- `test/keybind-settings.test.mjs`: the search scope's default rows and the
  rule for lists saved before it.
- `test/extension-smoke/content-search.mjs`: the reader's search from an
  offset and the length it resolves to.
- `test/chrome-search-history.mjs` (run by `test/run.mjs chrome-e2e`) and the
  Firefox suite's `search.mjs`: the whole feature in real browsers; see
  [the test guide](../test/README.md).
