// The search page (#610), after Yomitan's search page and popup window
// (yomidevs/yomitan@d3c54c1 ext/search.html and
// ext/js/display/search-display-controller.js). A word typed or pasted into
// the box is looked up through the reader this page loads into itself, which
// docks its popup over the results area. The page follows the popup theme as
// Settings does, and the popup is the reader's own, with its theme, Anki,
// pronunciation, tabs and child popups. This page is search-frame.html, the
// sandboxed frame search.html holds under its header so that Custom JavaScript
// runs here too (#644); search-bridge.js lends it the extension APIs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import { captureDebugLog, captureDocumentActions, recordUserError } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";
import { loadReaderScripts } from "./reader-page.js";
import { renderTemplateChoices } from "./search-templates.js";
import { applyPageTheme } from "./settings-dom.js";

const bridge = globalThis.HDSearchBridge;
// Settings → Advanced → Get debug info includes what failed here.
captureDocumentActions(document, captureDebugLog(window, {
  context: "search", store: bridge.debugLogStore, version: async () => (await bridge.ready).manifest.version,
}));

const { normaliseOptions } = globalThis.HDReaderOptions;
const input = document.getElementById("search-input");
const submit = document.getElementById("search-submit");
const query = document.getElementById("search-query");
const status = document.getElementById("search-status");
const templateChoices = document.querySelector("select.search-template");
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

// The reader's popup keeps its own keys and pastes, its Note form's among
// them. Its shadow root is closed, so the page sees only the reader's host.
const inReader = node => node?.localName === "hachidori-host";

// Yomitan's _isElementInput: a key typed there stays there.
function typingTarget(element) {
  return ["input", "textarea", "button", "select"].includes(element?.localName) || element?.isContentEditable === true
    || inReader(element);
}

// Where a paste goes in as text.
function pasteTarget(node) {
  return ["input", "textarea"].includes(node?.localName) || node?.isContentEditable === true || inReader(node);
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
// Ctrl+U clears it, unless focus is in the popup. The reader has already
// taken any key it handles, such as an Escape that closes a child popup.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape") {
    input.focus();
    input.select();
    return;
  }
  if (event.ctrlKey && event.key === "u" && !inReader(document.activeElement)) {
    event.preventDefault();
    clear();
    return;
  }
  const typed = (event.key.length === 1 && event.key !== " ") || event.key === "Backspace";
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (typed && (!modified || (event.ctrlKey && event.key === "Backspace")) && !typingTarget(document.activeElement)) {
    input.focus({ preventScroll: true });
  }
});

// What search.html's Clipboard monitor (#639) reads: text with Japanese in it,
// copied in any tab or program, goes into the box and is searched, as a paste
// is. A Note being written or saved in the result holds it off: the text is
// not searched.
bridge.onClipboard((text) => {
  if (!reader.isLookupWorthy(text) || reader.holdsNote()) return;
  input.value = text;
  search();
});
// Text copied or cut on this page is not searched, as in Yomitan's _onCopy:
// once it has reached the clipboard, the monitor starts over from it.
for (const type of ["copy", "cut"]) window.addEventListener(type, () => { bridge.notify("copied"); });

// The same keys, pressed in search.html's header, where the Clipboard monitor
// switch is: Escape, and Ctrl+U as "u".
bridge.onKey((key) => {
  if (key === "u") clear();
  if (key !== "Escape") return;
  input.focus();
  input.select();
});

// Text pasted anywhere but a text field or the popup is searched at once.
window.addEventListener("paste", (event) => {
  if (event.composedPath().some(pasteTarget)) return;
  const text = event.clipboardData?.getData("text") ?? "";
  if (!text) return;
  event.preventDefault();
  input.value = text;
  search();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) applyPageTheme(document, normaliseOptions(changes.options.newValue));
});

// search.html's Anki Template switch lies over this header (#656). The copy
// here lists the same Templates, invisibly, so both documents lay it out alike.
// Its first read is sent before the page's own below, so the copy is laid out
// before the page is shown.
const showTemplates = (stored) => { renderTemplateChoices(templateChoices, normaliseOptions(stored).anki); };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) showTemplates(changes.options.newValue);
});
chrome.storage.local.get("options").then(({ options }) => { showTemplates(options); }, () => {
  // The page's own read below fails too, and says so.
});

// Design → Custom JavaScript, the user script web pages run (custom-javascript.js),
// once the reader is ready, as a user script runs at document_idle after the
// content scripts. search.html hands it over only where the worker registered
// it, which Chrome's Allow User Scripts or Firefox's permission allows. The
// frame's sandbox allows eval for this alone; inline script stays blocked.
function runCustomJavaScript(code) {
  try {
    (0, eval)(code); // NOSONAR: the user's own Custom JavaScript, as their user script; see above.
  } catch (error) {
    console.error("hachidori: Custom JavaScript failed on the search page:", error);
  }
}

try {
  const connection = await bridge.ready;
  applyPageTheme(document, normaliseOptions((await chrome.storage.local.get("options")).options));
  bridge.notify("shown");
  // The page opens ready to type into, as Yomitan's focuses its box. It is
  // hidden, and its box cannot take focus, until settings-theme.js has the
  // saved theme, which in search.html's frame waits for the bridge.
  input.focus();
  reader = await loadReaderScripts(document, chrome, "searchReader");
  reader.dock(document.getElementById("search-results"));
  // Reading → Search page → Look up words with a click (#656).
  reader.lookUpOnClick(query);
  if (connection.customJavaScript) runCustomJavaScript(connection.customJavaScript);
  status.textContent = "Type or paste a word above, then press Enter.";
  submit.disabled = false;
  // The Clipboard monitor starts.
  bridge.notify("ready");
} catch (error) {
  status.textContent = `The search page could not start: ${describeErrorMessage(error)}`;
  recordUserError(window, "search-status", status.textContent, error);
}
