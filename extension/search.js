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
import { CLIPBOARD_TARGET, createClipboardMonitor } from "./search-clipboard.js";
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
const clipboardSwitch = document.getElementById("search-clipboard");
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

// Yomitan's search page clipboard monitor (#639; yomidevs/yomitan@ac1d839
// ext/js/display/search-display-controller.js): text with Japanese in it,
// copied in any tab or program, goes into the box and is searched, as a paste
// is. A Note being written or saved in the result holds it off: the text is not
// searched. The switch is the browser's clipboardRead permission, which turning
// it on asks for and turning it off gives back.
const CLIPBOARD_PERMISSION = { permissions: ["clipboardRead"] };
const monitor = createClipboardMonitor({
  async read() {
    const reply = await chrome.runtime.sendMessage({ target: CLIPBOARD_TARGET, type: "hd_clipboard_read" });
    return reply?.ok === true ? reply.text : null;
  },
  change(text) {
    if (!reader.isLookupWorthy(text) || reader.holdsNote()) return;
    input.value = text;
    search();
  },
});

async function showClipboardMonitor() {
  const on = await chrome.permissions.contains(CLIPBOARD_PERMISSION).catch(() => false);
  clipboardSwitch.checked = on;
  if (!on || !reader) monitor.stop();
  else if (!monitor.running) monitor.start();
}

clipboardSwitch.addEventListener("change", () => {
  if (!clipboardSwitch.checked) monitor.stop();
  // The browser asks only for a request made while it handles the click.
  const asked = clipboardSwitch.checked ? chrome.permissions.request(CLIPBOARD_PERMISSION)
    : chrome.permissions.remove(CLIPBOARD_PERMISSION);
  void asked.catch(() => false).then(showClipboardMonitor);
});
chrome.permissions.onAdded.addListener(() => { void showClipboardMonitor(); });
chrome.permissions.onRemoved.addListener(() => { void showClipboardMonitor(); });
// The switch shows its state at once; the monitor starts once the reader has.
void showClipboardMonitor();
// Text copied or cut on this page is not searched, as in Yomitan's _onCopy:
// once it has reached the clipboard, the monitor starts over from it.
for (const type of ["copy", "cut"]) {
  window.addEventListener(type, () => {
    if (!monitor.running) return;
    monitor.stop();
    setTimeout(() => { void showClipboardMonitor(); }, 0);
  });
}

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
// The page opens ready to type into, as Yomitan's focuses its box.
input.focus();
try {
  applyPageTheme(document, normaliseOptions((await chrome.storage.local.get("options")).options));
  reader = await loadReaderScripts(document, chrome, "searchReader");
  reader.dock(document.getElementById("search-results"));
  status.textContent = "Type or paste a word above, then press Enter.";
  submit.disabled = false;
  clipboardSwitch.disabled = false;
  void showClipboardMonitor();
} catch (error) {
  status.textContent = `The search page could not start: ${describeErrorMessage(error)}`;
  recordUserError(window, "search-status", status.textContent, error);
}
