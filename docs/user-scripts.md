# User scripts

Settings → Advanced → User scripts holds the user's own packages of JavaScript
and CSS (`userScripts` in the stored options). Each package has a name, a
switch, its JavaScript and its CSS; either part may be empty. Packages run in
list order, top to bottom.

- **JavaScript** runs as a user script in the top frame of every page once the
  browser lets Hachidori run user scripts: Chrome's **Allow User Scripts** on
  Hachidori's details page (Developer mode before Chrome 138), or Firefox's
  optional `userScripts` permission, which the section's **Allow user scripts**
  button asks for. The search page runs it too, in its sandboxed frame
  ([Search page](architecture.md#search-page); Firefox 154 or later). A
  package's JavaScript runs from a page's next load.
- **CSS** styles the popup as Design → Custom CSS does: in the popup's shadow
  root, after Hachidori's own styles and the dictionaries'. Packages' CSS comes
  in list order and Custom CSS comes last, so a Design rule still wins over a
  package's. Each stylesheet is parsed on its own, so a rule one package leaves
  open cannot swallow the next. CSS needs no permission and applies to the next
  popup and to the Design preview.

## What a package's JavaScript can use

- The popup is `document.querySelector("hachidori-host").shadowRoot`, a closed
  root that `custom-javascript-bridge.js` returns to user scripts alone
  ([architecture](architecture.md)). `hachidori-popup-shown` and
  `hachidori-popup-hidden` fire on `window`.
- On the search page, `globalThis.HDSearchHistory` is the search history
  ([search history](search-history.md#for-user-scripts-hdsearchhistory)).
- Each package runs inside a function of its own (`custom-javascript.js`), so
  `return` ends it early, as in `if (!globalThis.HDSearchHistory) return;`, and
  two packages can both declare `const popup`. It is a classic script, so there
  is no top-level `await`. A package that throws does not stop the next one;
  the console names it `hachidori-user-script/<name>.js`.
- The user-script world has no extension APIs.

## Settings

- **Add script** opens the editor under the list: a name, the JavaScript and
  the CSS, each with **Load .js file** or **Load .css file** to replace it from
  a file. **Import files** opens a `.js` file, a `.css` file or one of each as a
  new package named after the file.
- A row's switch turns its package on or off, the arrows move it, **Edit** opens
  it in the editor and **Delete** asks once before removing it.
- The editor saves on **Save script** or **Add script**, not as you type, so a
  half-written script never runs.

## Storage

`userScripts` is a global option, which every language shares: an array of
`{ id, name, enabled, javascript, css }` in run order. Backups and linked
browsers carry it with the other options. Design → Reset Design to defaults
leaves it alone.

Design → Custom JavaScript (`customPopupJavascript`) was the one script before.
A stored record or backup that still has it, and no `userScripts`, reads it as
one package named "Custom JavaScript", and the next save stores it that way. A
write from a linked browser that still has Custom JavaScript cannot replace the
packages.

## Tests

- `test/custom-javascript.test.mjs`: the option, its migration and validation,
  the order of the popup's stylesheets, the registration (one source per
  switched-on package, after the bridge) and each package's own function.
- `test/extension-smoke/content-popup.mjs` and `design.mjs`: the popup root a
  package's JavaScript gets, and one adopted sheet per stylesheet.
- `test/chrome-e2e/search.mjs`, `test/chrome-dark-reader.mjs` and the Firefox
  suite's `settings.mjs` and `search.mjs`: packages in real browsers, on pages
  and on the search page.
