# User scripts

Settings → Advanced → User scripts holds the user's own packages of JavaScript
and CSS (`userScripts` in the stored options). Each package has a name, a
switch, its JavaScript and its CSS; either part may be empty. Packages run in
list order, top to bottom.

- **JavaScript** runs as a user script in every matching page and frame, including
  YouTube live chat, once the
  browser lets Hachidori run user scripts: Chrome's **Allow User Scripts** on
  Hachidori's details page (Developer mode before Chrome 138), or Firefox's
  optional `userScripts` permission, which the section's **Allow user scripts**
  button asks for. The search page runs it too, in its sandboxed frame
  ([Search page](architecture.md#search-page); Firefox 154 or later). An
  overlay such as GameSentenceMiner has no user-script API and needs no
  switch: it runs the JavaScript in each page's own world
  ([overlay mode](overlay-mode.md)). A package's JavaScript runs from a page's
  next load.
- **CSS** styles the popup as Design → Custom CSS does: in the popup's shadow
  root, after Hachidori's own styles and the dictionaries'. Packages' CSS comes
  in list order and Custom CSS comes last, so a Design rule still wins over a
  package's. Each stylesheet is parsed on its own, so a rule one package leaves
  open cannot swallow the next. CSS needs no permission and applies to the next
  popup and to the Design preview.

## What a package's JavaScript can use

- The popup is `document.querySelector("hachidori-host").shadowRoot`, a closed
  root that `custom-javascript-bridge.js` returns to user scripts alone
  ([architecture](architecture.md)). In an overlay the root is open. `hachidori-popup-shown` and
  `hachidori-popup-hidden` fire on `window`.
- On the search page, `globalThis.HDSearchHistory` is the search history
  ([search history](search-history.md#for-user-scripts-hdsearchhistory)).
- On Crunchyroll, a package that shows subtitles can hand Hachidori their
  timing, so that with Experimental features → **Crunchyroll mining** on, a
  note from a line gets its audio, its animation and the whole line as the
  sentence. The Script Store's Jimaku Player does; the attributes and events
  are in [Crunchyroll mining](architecture.md#crunchyroll-mining-experimental).
- Each package runs inside a function of its own (`custom-javascript.js`), so
  `return` ends it early, as in `if (!globalThis.HDSearchHistory) return;`, and
  two packages can both declare `const popup`. It is a classic script, so there
  is no top-level `await`. A package that throws does not stop the next one;
  the console names it `hachidori-user-script/<name>.js`.
- The user-script world has no extension APIs. In an overlay the packages
  share the page's own world and its globals; in GameSentenceMiner's overlay
  window, that includes Node.

## Settings

Settings → Advanced → User scripts lists the user's packages under **Your
scripts**, with the **Script Store** below them.

- A notice above the list says how to let the browser run the packages'
  JavaScript, and shows only until it can: on Chrome while Allow User Scripts
  is off, checked when Settings opens and whenever it comes back into view, and
  on Firefox until the optional permission is granted. An overlay shows none.
  On Chrome its **Open Hachidori's details** opens `chrome://extensions/?id=…`,
  where the switch is (Developer mode on Chrome 137 and earlier): an extension
  may open that page but cannot turn the switch on. On Firefox its **Allow user
  scripts** asks for the permission.
- **Add script** opens the editor under the list: a name, the JavaScript and
  the CSS, each with **Load .js file** or **Load .css file** to replace it from
  a file. The warning about pasting JavaScript you do not understand is beside
  the JavaScript. **Import files** opens a `.js` file, a `.css` file or one of
  each as a new package named after the file.
- The JavaScript and CSS are edited in a code editor (`code-editor.js`, with
  CodeMirror from `vendor/codemirror/`), which the editor's first opening
  loads: line numbers, highlighting, bracket matching, undo and search
  (Ctrl+F, or ⌘F on a Mac). Tab indents; Esc and then Tab moves on from the
  keyboard, as the hint above the boxes says. A box grows with its code to
  three quarters of the window and scrolls after that, and its corner resizes
  it. Until the code editor loads, or if it cannot, plain text boxes edit the
  same text.
- Code takes the palette's own colours, each mixed with the text colour only
  as far as a 4.5:1 contrast on the box's background needs; Windows contrast
  themes use their own colours.
- A new script's JavaScript starts from a short example that waits for
  `hachidori-popup-shown` and finds the popup's root, with a link to this page.
  Saved unchanged, it counts as no JavaScript, so a script of CSS alone still
  needs no permission.
- While you type, the editor marks the lines its parser cannot read and lists
  them under the box. It is a hint: **Save script** still saves, and
  JavaScript with a syntax error does not run until it is fixed.
- A row's switch turns its package on or off, the arrows move it (once there
  are two packages), **Edit** opens it in the editor and **Delete** asks once
  before removing it. Once **Check for scripts** finds another version of an
  installed package, its row also has **Update to**, which does what the
  Script Store's does without moving focus there.
- The editor saves on **Save script** or **Add script**, not as you type, so a
  half-written script never runs.

## Script Store

The Script Store, under Your scripts (`script-store.js`), lists the packages
people share in
[bee-san/hachidori-scripts](https://github.com/bee-san/hachidori-scripts),
where Bee reviews each one before it is merged.

- **Check for scripts** fetches the repository's `catalogue.json` from its
  `main` branch, and nothing is fetched before then. The repository's
  `tools/build-catalogue.mjs` writes that file with every package's
  JavaScript and CSS in it, so one request gives one consistent list.
  Hachidori refuses a list that is not in that shape and shows names and
  descriptions as text. Each package shows its author, version, licence,
  parts and size, and links to its folder in the repository. The status after
  a check names the installed packages it found an update for.
- **View code** shows a package's JavaScript and CSS under its row, read-only
  in the code editor (`code-editor.js`, loaded the first time), so it can be
  read, searched and copied before it is installed. The code comes from the
  catalogue already fetched; nothing more is.
- **Install** copies a package into Your scripts, switched on, with its slug
  and version (`store: { slug, version }`). It then runs as the user's own
  scripts do. **Update to** replaces its name and parts once the catalogue's
  version differs, and keeps its switch and place. Both lists save the one
  list of packages, so an install, update or delete in either shows in the
  other at once.
- Editing an installed package and saving a change makes it the user's own:
  it loses its slug and version, so Update can no longer replace the change.

## Storage

`userScripts` is a global option, which every language shares: an array of
`{ id, name, enabled, javascript, css }` in run order, with `store` on a
package installed from the Script Store. Backups and linked
browsers carry it with the other options. Design → Reset Design to defaults
leaves it alone.

Design → Custom JavaScript (`customPopupJavascript`) was the one script before.
A stored record or backup that still has it, and no `userScripts`, reads it as
one package named "Custom JavaScript", and the next save stores it that way. A
write from a linked browser that still has Custom JavaScript cannot replace the
packages.

## Tests

- `test/script-store.test.mjs`: the catalogue's shape, Check for scripts,
  Install, Installed, Update and a failed check, the `store` field, View code
  with a stand-in code view, and the updates a check offers to Your scripts.
- `test/advanced-settings.test.mjs`: the Script Store's place in User scripts,
  with no switch, tab or section of its own, and a package installed from it
  showing in Your scripts at once.
- `test/custom-javascript.test.mjs`: the option, its migration and validation,
  the order of the popup's stylesheets, the registration (one source per
  switched-on package, after the bridge) and each package's own function.
- `test/extension-smoke/content-popup.mjs` and `design.mjs`: the popup root a
  package's JavaScript gets, and one adopted sheet per stylesheet.
- `test/user-script-settings.test.mjs`: a row's Update to, and the editor,
  with a stand-in for the code editor: nothing loaded before the editor opens, the textareas' text
  carried over, counts and syntax errors under each box, the example a new
  script starts from, and the textareas kept when the code editor cannot load.
- `test/chrome-e2e/settings.mjs`: the notice's way to Hachidori's details
  page, and the code editor in Chrome: its labels and
  descriptions, the example, Tab, Esc then Tab, search, syntax errors, Load .js
  file and Save, and code that keeps 4.5:1 in five colours in every palette.
- `test/chrome-e2e/search.mjs`, `test/chrome-dark-reader.mjs` and the Firefox
  suite's `settings.mjs` and `search.mjs`: packages in real browsers, on pages
  and on the search page; Firefox's types its script into the code editor.

## Prepare an Anki card

An Anki Template can choose one preparation function from an installed user
script. Select its package and registered function under **Anki → Templates →
Preparation script**. Its custom Anki buttons use the same preparation. The
package must be enabled, and browser user scripts must be allowed; after adding
or changing its JavaScript, reload the reading page.

Register a function while the package loads:

```js
if (!globalThis.HDAnkiPreparation) return;
HDAnkiPreparation.register("prepare", async (context, { request }) => {
  const response = await request("https://your-sentence-service.example/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: context.term.expression }),
  });
  if (!response.ok) throw new Error("The sentence service refused the request.");
  return { example: (await response.json()).sentence };
});
```

Map a field to `{preparation-example}` to insert that returned string. The
marker escapes HTML and literal cloze braces. Marker names are case-insensitive;
use distinct lowercase names for returned values. A returned object or array
is inserted as JSON. The complete result must be a JSON object, with no
functions, undefined values or cycles. Handlebars fields can read the same data
under `preparation` when that syntax is available.

`context` is a copy of the clicked lookup: `term` (expression, reading and
ordered dictionary glossaries), `sentence`, `matched`, `matchOffset`,
`searchQuery`, `pageUrl`, `documentTitle`, the glossary selection when there is
one, and the chosen `templateId`. Mutating this copy does not change the lookup
or destination. No AnkiConnect key, endpoint or saved field mappings are given
to the script.

The second argument's `request(url, options)` makes an HTTP(S) request through
Hachidori, so the service need not enable CORS. `options` supports `method`,
`headers` and a string `body`. The returned response has `ok`, `status`,
`headers`, `text()` and `json()`. Cookies are omitted; a script can explicitly
provide an API authorization header. This helper is available only during the
preparation that owns it. It cannot be called on hover, from an unrelated page
message or after that operation is cancelled.

Registration and ordinary lookup readiness do not run the preparation or
contact the service. Pressing Add captures the lookup, awaits the function,
then checks the final fields and duplicates through the normal Anki path.
Failure sends no note and leaves Add retryable. Navigation or retiring that
lookup cancels its preparation; a late result cannot add a note for another
lookup. Once an Anki write has been sent, today's confirmed-success and
uncertain-write behavior still applies.

Browser user scripts communicate through the browser's dedicated
`onUserScriptConnect` channel. A page cannot register such a port. Search and
overlay scripts use the same API in their own document, with a worker-issued
operation token for each preparation request. A linked browser runs its own
script and sends only named data; its sharing host still chooses the saved
Template, renders the fields and owns Anki writes. Both sides need the
`anki-preparation-v1` capability. Older hosts refuse prepared submissions.

Get debug info includes the saved script/function choice, registration and
active-operation counts, and fixed failure categories. Preparation data is
summarized by its value count, and script failures never put API responses or
prompts into diagnostic messages.
