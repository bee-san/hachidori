// The search page (#610), after Yomitan's search page and popup window
// (yomidevs/yomitan@d3c54c1 ext/search.html and
// ext/js/display/search-display-controller.js). A word typed or pasted into
// the box is looked up through the reader this page loads into itself, which
// docks its popup over the results area. The page follows the popup theme as
// Settings does, and the popup is the reader's own, with its theme, Anki,
// pronunciation, tabs and child popups.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import { captureDebugLog, captureDocumentActions, openDebugLogStore, recordUserError } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";
import { loadReaderScripts } from "./reader-page.js";
import { applyPageTheme } from "./settings-dom.js";

// Settings → Advanced → Get debug info includes what failed here.
captureDocumentActions(document, captureDebugLog(window, {
  context: "search", store: openDebugLogStore(window.indexedDB),
}));

const { normaliseOptions } = globalThis.HDReaderOptions;
const input = document.getElementById("search-input");
const submit = document.getElementById("search-submit");
const query = document.getElementById("search-query");
const status = document.getElementById("search-status");
let reader = null;

// Yomitan's search trims the box's text, shows it above the results, where
// the reader can look up its other words, and blurs the box. The results
// cover the hint, which would show through a translucent popup.
function search() {
  const text = input.value.trim();
  if (!reader || !text) return;
  query.textContent = text;
  query.hidden = false;
  status.hidden = true;
  input.blur();
  void reader.search(query.firstChild);
}

// Yomitan's _isElementInput: a key typed there stays there.
function typingTarget(element) {
  return ["input", "textarea", "button", "select"].includes(element?.localName) || element?.isContentEditable === true;
}

// The element with focus, inside the reader's popup too.
function focusedElement() {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return focused;
}

function clear() {
  input.value = "";
  input.focus();
}

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
input.addEventListener("keydown", (event) => {
  // Enter searches and Shift+Enter starts a line. An IME's Enter confirms its text.
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  search();
});
document.getElementById("search-clear").addEventListener("click", clear);
// As on Yomitan's search page, Escape focuses the box and selects its text
// (its focusSearchBox hotkey), a character typed elsewhere goes into it, and
// Ctrl+U clears it. The reader has already taken any key it handles, such as
// an Escape that closes a child popup.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape") {
    input.focus();
    input.select();
    return;
  }
  if (event.ctrlKey && event.key === "u") {
    event.preventDefault();
    clear();
    return;
  }
  const typed = (event.key.length === 1 && event.key !== " ") || event.key === "Backspace";
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (typed && (!modified || (event.ctrlKey && event.key === "Backspace")) && !typingTarget(focusedElement())) {
    input.focus({ preventScroll: true });
  }
});
// Text pasted anywhere but a text field is searched at once.
window.addEventListener("paste", (event) => {
  if (typingTarget(event.composedPath()[0])) return;
  const text = event.clipboardData?.getData("text") ?? "";
  if (!text) return;
  event.preventDefault();
  input.value = text;
  search();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) applyPageTheme(document, normaliseOptions(changes.options.newValue));
});
// The page opens ready to type into, as Yomitan's focuses its box.
input.focus();
try {
  applyPageTheme(document, normaliseOptions((await chrome.storage.local.get("options")).options));
  reader = await loadReaderScripts(document, chrome, "searchReader");
  reader.dock(document.getElementById("search-results"));
  status.textContent = "Type or paste a word above, then press Enter.";
  submit.disabled = false;
} catch (error) {
  status.textContent = `The search page could not start: ${describeErrorMessage(error)}`;
  recordUserError(window, "search-status", status.textContent, error);
}
