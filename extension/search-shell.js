// The search page (#610) as the extension page that holds it (#644). Chrome
// and Firefox run no user script in an extension page, so the search box, its
// results and the reader live in a sandboxed frame, search-frame.html, where
// Design → Custom JavaScript runs as it does on a web page. The frame has no
// extension APIs: this page answers for it over one MessagePort, of which
// search-bridge.js is the other end. The user's script shares the frame's
// document with the reader, so the frame gets what the reader needs and no
// more: the requests a content script's reader sends, the stored keys it
// reads and the events sent to it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { SCRIPT_ID } from "./custom-javascript.js";
import { captureDebugLog, openDebugLogStore } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";

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

function readerKeys(keys) {
  if (typeof keys === "string") return readerKey(keys) ? keys : [];
  if (Array.isArray(keys)) return keys.filter(key => typeof key === "string" && readerKey(key));
  return Object.fromEntries(Object.entries(keys ?? {}).filter(([key]) => readerKey(key)));
}

// Answers the frame on `port` until the returned function closes it.
export function serveSearchFrame(api, port, store) {
  const answer = (id, request) => {
    Promise.resolve().then(request).then((value) => { port.postMessage({ kind: "reply", id, value }); },
      (error) => { port.postMessage({ kind: "reply", id, error: describeErrorMessage(error) }); });
  };
  port.onmessage = ({ data }) => {
    if (data?.kind === "send") {
      answer(data.id, () => {
        const { target, type } = data.message ?? {};
        if (!READER_REQUESTS.get(target)?.has(type)) throw new Error(`The search page cannot send ${type} to ${target}.`);
        return api.runtime.sendMessage(data.message);
      });
    } else if (data?.kind === "get") {
      answer(data.id, () => api.storage.local.get(readerKeys(data.keys)));
    } else if (data?.kind === "log") {
      answer(data.id, () => store.write(data.ops));
    }
  };
  const onMessage = (message, sender) => {
    if (READER_EVENTS.has(message?.target)) port.postMessage({ kind: "message", message, sender: { id: sender.id } });
    return false;
  };
  const onChanged = (changes, area) => {
    const read = Object.fromEntries(Object.entries(changes).filter(([key]) => readerKey(key)));
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

async function start() {
  const store = openDebugLogStore(window.indexedDB);
  captureDebugLog(window, { context: "search", store });
  const customJavaScript = await userScript(chrome);
  const frame = document.createElement("iframe");
  frame.className = "search-frame";
  frame.title = "Hachidori Search";
  // Settings' Copy error details, beside an error the page shows.
  frame.allow = "clipboard-write";
  let close = null;
  frame.addEventListener("load", () => {
    // Only the frame's own code can navigate it. A later load is a new
    // document, which gets no port: the page starts again instead.
    if (close) {
      close();
      location.reload();
      return;
    }
    const channel = new MessageChannel();
    close = serveSearchFrame(chrome, channel.port1, store);
    // Focused first, so the frame can focus its box once it is connected.
    frame.focus();
    // A sandboxed frame's origin is opaque, so no target origin can name it.
    frame.contentWindow.postMessage({ type: "hachidori-search-bridge", id: chrome.runtime.id,
      manifest: chrome.runtime.getManifest(), customJavaScript }, "*", [channel.port2]);
  });
  frame.src = "search-frame.html";
  document.body.append(frame);
  // The shortcuts bring the page forward with focus in this document.
  window.addEventListener("focus", () => { frame.focus(); });
}

if (globalThis.document) await start();
