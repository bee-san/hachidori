// The search page (#610) as the extension page that holds it (#644). Chrome
// and Firefox run no user script in an extension page, so the search box, its
// results and the reader live in a sandboxed frame, search-frame.html, where
// Design → Custom JavaScript runs as it does on a web page. The frame has no
// extension APIs: this page answers for it over one MessagePort, which
// search-bridge.js offers it. The user's script shares the frame's
// document and globals with the reader, so whatever this page serves the
// reader, the script can use too, where on a web page it has no extension
// messaging at all. The frame therefore gets what the reader needs and no
// more: the requests a content script's reader sends, the stored keys it
// reads and the events sent to it. This page keeps the header, whose
// Clipboard monitor switch asks for a permission: Firefox grants one only to
// the document that handles the click.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { SCRIPT_ID } from "./custom-javascript.js";
import { captureDebugLog, debugLogRecord, openDebugLogStore } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";
import "./reader-options.js";
import { CLIPBOARD_TARGET, createClipboardMonitor } from "./search-clipboard.js";
import { applyPageTheme } from "./settings-dom.js";

// The requests the reader sends, by target. test/search-bridge.test.mjs keeps
// these equal to the ones the content scripts name.
export const READER_REQUESTS = new Map(Object.entries({
  "hoshidicts-offscreen": ["hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_media", "hd_styles", "hd_segment",
    "hd_custom_append"],
  "hoshidicts-worker": ["hd_options_write", "hd_open_external", "hd_lookup_stats_read", "hd_lookup_stats_record",
    "hd_word_status_override"],
  "hachidori-anki": ["hd_anki_status", "hd_anki_view", "hd_anki_preflight", "hd_anki_preflight_batch", "hd_anki_submit",
    "hd_anki_browse", "hd_anki_screenshot", "hd_anki_screenshot_discard", "hd_anki_maturity", "hd_anki_word_status"],
  "hachidori-audio": ["hd_audio_play", "hd_audio_candidates", "hd_audio_stop"],
  "hachidori-page-zoom": ["hd_page_zoom"],
}).map(([target, types]) => [target, new Set(types)]));
// The targets of the browser shortcuts, pronunciation progress and word-status
// events the reader listens for.
export const READER_EVENTS = new Set(["hachidori-reader", "hachidori-audio-content", "hachidori-anki-content"]);
// The stored keys it reads: options, dictionaries, lookup counts and their
// rows, and the words marked known or ignored.
export const readerKey = key => ["options", "dictionaryState", "lookupStats", "wordStatusOverrides"].includes(key)
  || key.startsWith("lookupStats:");

// What storage.local.get answers for `keys` (a key, a list or an object of
// defaults), restricted to the reader's keys: Chrome's callers may ask in
// any of those shapes.
async function readerGet(api, keys) {
  let defaults = keys ?? {};
  if (typeof keys === "string") defaults = { [keys]: undefined };
  else if (Array.isArray(keys)) defaults = Object.fromEntries(keys.map(key => [key, undefined]));
  const wanted = Object.keys(defaults).filter(readerKey);
  const stored = await api.storage.local.get(wanted);
  return Object.fromEntries(wanted.map(key => [key, readerValue(key, Object.hasOwn(stored, key) ? stored[key] : defaults[key])])
    .filter(([, value]) => value !== undefined));
}

// The reader never uses the AnkiConnect key.
const readerValue = (key, value) => (key === "options" && value?.anki
  ? { ...value, anki: { ...value.anki, apiKey: "" } } : value);

// The one option write the reader makes: a Toggle option keybind's boolean.
function readerOptionsWrite(options) {
  const entries = Object.entries(options ?? {});
  return entries.length === 1 && typeof entries[0][1] === "boolean"
    && globalThis.HDReaderOptions.KEYBIND_TOGGLE_OPTIONS.includes(entries[0][0]);
}

function readerRequest({ target, type, options } = {}) {
  return READER_REQUESTS.get(target)?.has(type) && (type !== "hd_options_write" || readerOptionsWrite(options));
}

// Answers the frame on `port` until the returned function closes it. `page`
// hears when the frame shows its themed page, when its reader is ready and
// when text is copied there.
export function serveSearchFrame(api, port, store, page) {
  // The ring's keys of the records this frame wrote, the only ones it may update.
  const written = new Set();
  const answer = (id, request) => {
    Promise.resolve().then(request).then((value) => { port.postMessage({ kind: "reply", id, value }); },
      (error) => { port.postMessage({ kind: "reply", id, error: describeErrorMessage(error) }); });
  };
  port.onmessage = ({ data }) => {
    if (data?.kind === "send") {
      answer(data.id, () => {
        if (!readerRequest(data.message)) {
          throw new Error(`The search page cannot send ${data.message?.type} to ${data.message?.target}.`);
        }
        return api.runtime.sendMessage(data.message);
      });
    } else if (data?.kind === "get") {
      answer(data.id, () => readerGet(api, data.keys));
    } else if (data?.kind === "log") {
      answer(data.id, async () => {
        const keys = await store.write(data.ops.map(({ key, record }) => ({ key: written.has(key) ? key : undefined,
          record: debugLogRecord({ ...record, context: "search" }) })));
        for (const key of keys) written.add(key);
        return keys;
      });
    } else if (["shown", "ready", "copied"].includes(data?.kind)) {
      page[data.kind]();
    }
  };
  const onMessage = (message, sender) => {
    if (READER_EVENTS.has(message?.target)) port.postMessage({ kind: "message", message, sender: { id: sender.id } });
    return false;
  };
  const onChanged = (changes, area) => {
    const read = Object.fromEntries(Object.entries(changes).filter(([key]) => readerKey(key))
      .map(([key, { oldValue, newValue }]) => [key, { oldValue: readerValue(key, oldValue), newValue: readerValue(key, newValue) }]));
    if (area === "local" && Object.keys(read).length > 0) port.postMessage({ kind: "changed", changes: read, area });
  };
  api.runtime.onMessage.addListener(onMessage);
  api.storage.onChanged.addListener(onChanged);
  return () => {
    api.runtime.onMessage.removeListener(onMessage);
    api.storage.onChanged.removeListener(onChanged);
    port.close();
  };
}

// Connects `frame` once, through the port its document offers this page as it
// parses (search-bridge.js). A sandboxed frame's origin is opaque, so the offer
// is known by its window; Firefox before 154 does not sandbox it, and there
// it has this page's origin. Only the frame's own code can navigate it,
// perhaps to another site, so a later document is never connected: the page
// starts again instead, through `reload`.
export function connectSearchFrame({ window, frame, serve, connection, reload }) {
  let close = null;
  window.addEventListener("message", (event) => {
    if (close || event.source !== frame.contentWindow || !["null", window.location.origin].includes(event.origin)
        || event.data?.type !== "hachidori-search-bridge" || !event.ports?.[0]) return;
    const [port] = event.ports;
    close = serve(port);
    // Focused first, so the frame can focus its box once it is connected.
    frame.focus();
    port.postMessage({ kind: "connect", ...connection(event.origin === "null") });
  });
  let loads = 0;
  frame.addEventListener("load", () => {
    loads += 1;
    if (loads === 1) return;
    close?.();
    reload();
  });
}

// The user's script, where it runs on web pages: once the worker has
// registered it (custom-javascript.js), which Chrome's Allow User Scripts or
// Firefox's userScripts permission allows.
async function userScript(api) {
  try {
    const [script] = await api.userScripts.getScripts({ ids: [SCRIPT_ID] });
    return script?.js?.find(source => typeof source.code === "string")?.code ?? "";
  } catch {
    return "";
  }
}

// Yomitan's search page clipboard monitor (#639; yomidevs/yomitan@ac1d839
// ext/js/display/search-display-controller.js): text with Japanese in it,
// copied in any tab or program, is searched in the frame, as a paste is, up
// to Yomitan's 1,000 characters, which is all the offscreen document sends.
// Only that text reaches the frame, which the user's script shares: other
// text, which the reader would not search, stays here (isLookupWorthy in
// content.js). The switch is the browser's clipboardRead permission, which
// turning it on asks for and turning it off gives back. The monitor starts
// once the frame's reader is ready.
const CLIPBOARD_PERMISSION = { permissions: ["clipboardRead"] };

// The reader's Japanese character set, which content-scan.js publishes. It is
// loaded once the monitor reads something, rather than as the page starts.
async function lookupWorthy(text) {
  await import("./content-scan.js");
  return globalThis.HDContent.JAPANESE_CHARACTER_PATTERN.test(text);
}

function clipboardMonitor(clipboardSwitch, search) {
  let ready = false;
  const monitor = createClipboardMonitor({
    async read() {
      const reply = await chrome.runtime.sendMessage({ target: CLIPBOARD_TARGET, type: "hd_clipboard_read" });
      return reply?.ok === true ? reply.text : null;
    },
    // Not once the switch is off, which it may be by the time the import ends.
    async change(text) {
      if (await lookupWorthy(text) && monitor.running) search(text);
    },
  });
  async function show() {
    const on = await chrome.permissions.contains(CLIPBOARD_PERMISSION).catch(() => false);
    clipboardSwitch.checked = on;
    if (!on || !ready) monitor.stop();
    else if (!monitor.running) monitor.start();
  }
  clipboardSwitch.addEventListener("change", () => {
    if (!clipboardSwitch.checked) monitor.stop();
    // The browser asks only for a request made while it handles the click.
    const asked = clipboardSwitch.checked ? chrome.permissions.request(CLIPBOARD_PERMISSION)
      : chrome.permissions.remove(CLIPBOARD_PERMISSION);
    void asked.catch(() => false).then(show);
  });
  chrome.permissions.onAdded.addListener(() => { void show(); });
  chrome.permissions.onRemoved.addListener(() => { void show(); });
  // Text copied or cut on the page is not searched, as in Yomitan's _onCopy:
  // once it has reached the clipboard, the monitor starts over from it.
  const copied = () => {
    if (!monitor.running) return;
    monitor.stop();
    setTimeout(() => { void show(); }, 0);
  };
  for (const type of ["copy", "cut"]) window.addEventListener(type, copied);
  // The switch shows its state while the reader loads.
  void show();
  return {
    // The switch appears with the frame's header, as it did when the header held it.
    shown() { clipboardSwitch.closest("[hidden]")?.removeAttribute("hidden"); },
    ready() {
      ready = true;
      clipboardSwitch.disabled = false;
      void show();
    },
    copied,
  };
}

async function start() {
  const store = openDebugLogStore(window.indexedDB);
  captureDebugLog(window, { context: "search", store });
  const { normaliseOptions } = globalThis.HDReaderOptions;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.options) applyPageTheme(document, normaliseOptions(changes.options.newValue));
  });
  const customJavaScript = await userScript(chrome);
  const frame = document.createElement("iframe");
  frame.className = "search-frame";
  frame.title = "Hachidori Search";
  let port = null;
  const clipboardSwitch = document.getElementById("search-clipboard");
  const page = clipboardMonitor(clipboardSwitch, (text) => { port?.postMessage({ kind: "clipboard", text }); });
  connectSearchFrame({ window, frame,
    serve: (offered) => { port = offered; return serveSearchFrame(chrome, offered, store, page); },
    connection: sandboxed => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest(),
      customJavaScript: sandboxed ? customJavaScript : "" }),
    reload: () => location.reload() });
  frame.src = "search-frame.html";
  document.body.append(frame);
  // The shortcuts bring the page forward with focus in this document, and a
  // click on the header leaves it there: the box takes it, unless the switch has.
  window.addEventListener("focus", () => {
    setTimeout(() => { if (document.activeElement === document.body) frame.focus(); }, 0);
  });
  // A mouse or touch click on the switch then hands focus back to the frame,
  // where the reader's keybinds and activation key work, as they did beside
  // the switch when it shared the page's document. It waits for the click: a
  // tap focuses the switch after its pointerup. A switch that already has
  // focus as the pointer goes down keeps it, and so does Space, whose click
  // has no pointerType: Chrome sends a screen reader's or voice control's
  // click as pointer events, but only after focusing the switch.
  const clipboardLabel = clipboardSwitch.closest("label");
  let handBack = false;
  clipboardLabel.addEventListener("pointerdown", () => { handBack = document.activeElement !== clipboardSwitch; });
  clipboardLabel.addEventListener("click", (event) => {
    if (!handBack || !event.pointerType) return;
    handBack = false;
    setTimeout(() => { frame.focus(); }, 0);
  });
  // The page's own keys work from the switch too, as they did when it shared
  // the page's document (search.js): Escape selects the box's text and Ctrl+U
  // clears it, rather than showing this page's source.
  window.addEventListener("keydown", (event) => {
    const clear = event.ctrlKey && event.key === "u";
    if (event.isComposing || (event.key !== "Escape" && !clear)) return;
    if (clear) event.preventDefault();
    frame.focus();
    port?.postMessage({ kind: "key", key: event.key });
  });
  applyPageTheme(document, normaliseOptions((await chrome.storage.local.get("options")).options));
}

if (globalThis.document) await start();
