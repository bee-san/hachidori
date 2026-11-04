// SPDX-License-Identifier: GPL-3.0-or-later
// The search page's sandboxed frame (#644) reaches the extension only through
// search.html: search-shell.js answers what the reader sends, and
// search-bridge.js is the `chrome` the frame's scripts see.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { connectSearchFrame, READER_EVENTS, READER_REQUESTS, readerKey, searchHistoryRequests, serveSearchFrame }
  from "../extension/search-shell.js";

const EXTENSION = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", EXTENSION), "utf8"));
const contentScripts = manifest.content_scripts[0].js.map(file => readFileSync(new URL(file, EXTENSION), "utf8"));
const literals = new Set(contentScripts.flatMap(source => [...source.matchAll(/["'](hd_[a-z_]+)["']/gu)].map(match => match[1])));
// What the content scripts receive rather than send, and Netflix's own request.
const RECEIVED = ["hd_anki_document", "hd_anki_word_status_changed", "hd_audio_playing", "hd_reader_command"];
const NETFLIX = ["hd_netflix_load"];

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("the search page forwards every request the reader sends, and the events and keys it reads", () => {
  const forwarded = [...READER_REQUESTS.values()].flatMap(types => [...types]).sort();
  assert.deepEqual(forwarded, [...literals].filter(type => !RECEIVED.includes(type) && !NETFLIX.includes(type)).sort());
  for (const target of READER_EVENTS) {
    assert.ok(contentScripts.some(source => source.includes(`"${target}"`)), `${target} names no reader listener`);
  }
  // The keys of the reader's one storage read and of the changes it adopts,
  // named or held in a reader-options.js constant, in content.js, the only
  // content script that uses chrome.storage; a lookup count's row key comes
  // from a function and has its own case below.
  const users = manifest.content_scripts[0].js.filter((file, index) => /\bchrome\.storage\b/u.test(contentScripts[index]));
  assert.deepEqual(users, ["content.js"]);
  const named = name => globalThis.HDReaderOptions[name] ?? name;
  const content = readFileSync(new URL("content.js", EXTENSION), "utf8");
  const read = content.match(/chrome\.storage\.local\.get\(\{([^}]*)\}/u)[1];
  const keys = new Set([...read.matchAll(/(?:\[(\w+)\]|(\w+))\s*:/gu)].map(([, constant, key]) => constant ? named(constant) : key));
  for (const [, key, constant] of content.matchAll(/\bchanges(?:\.(\w+)|\[(\w+)\])/gu)) keys.add(key ?? named(constant));
  // The frame's own scripts: the keys they read, by name or reader-options.js
  // constant, and the changes they adopt; and they send only what the reader does.
  for (const page of ["search.js", "settings-theme.js"]) {
    const source = readFileSync(new URL(page, EXTENSION), "utf8");
    for (const [, read] of source.matchAll(/storage\.local\.get\(([^)]*)\)/gu)) {
      for (const [, key, constant] of read.matchAll(/"(\w+)"|\b([A-Z][A-Z_]+)\b/gu)) keys.add(key ?? named(constant));
    }
    for (const [, key, constant] of source.matchAll(/\bchanges(?:\.(\w+)|\[(\w+)\])/gu)) keys.add(key ?? named(constant));
    assert.deepEqual([...source.matchAll(/["'](hd_[a-z_]+)["']/gu)].filter(([, type]) => !forwarded.includes(type)), [], page);
  }
  assert.ok(keys.has("options") && keys.has("wordStatusOverrides"), [...keys].join());
  assert.deepEqual([...keys].filter(key => !readerKey(key)), []);
  assert.deepEqual(["options", "dictionaryState", "lookupStats", "lookupStats:7:食べる", "wordStatusOverrides"].filter(readerKey).length, 5);
  assert.equal(readerKey("ankiIndex"), false);
});

function fakeApi() {
  const listeners = { message: new Set(), changed: new Set() };
  const event = set => ({ addListener: listener => set.add(listener), removeListener: listener => set.delete(listener) });
  const sent = [], read = [];
  return {
    sent, read, listeners,
    runtime: {
      onMessage: event(listeners.message),
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "hd_page_zoom") throw new Error("Could not establish connection. Receiving end does not exist.");
        return { type: `${message.type}_result`, requestId: message.requestId, ok: true };
      },
    },
    storage: {
      onChanged: event(listeners.changed),
      local: { async get(keys) { read.push(keys); return { options: { revision: 3, anki: { url: "u", apiKey: "secret" } } }; } },
    },
  };
}

test("search.html answers the frame's reader requests and refuses the rest", async () => {
  const api = fakeApi();
  const written = [];
  let nextKey = 0;
  const { port1, port2 } = new MessageChannel();
  const heard = [];
  const close = serveSearchFrame(api, port1, { async write(ops) {
    written.push(ops);
    return ops.map(({ key }) => key ?? (nextKey += 1));
  } }, { shown: () => heard.push("shown"), ready: () => heard.push("ready"), copied: () => heard.push("copied") });
  const replies = [];
  port2.onmessage = ({ data }) => replies.push(data);
  port2.postMessage({ kind: "send", id: 1, message: { target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "a" } });
  port2.postMessage({ kind: "send", id: 2, message: { target: "hoshidicts-offscreen", type: "hd_remove", requestId: "b" } });
  // A type the reader sends, to a target it never sends it to.
  port2.postMessage({ kind: "send", id: 3, message: { target: "hachidori-updates", type: "hd_options_write" } });
  port2.postMessage({ kind: "send", id: 4, message: { target: "hachidori-page-zoom", type: "hd_page_zoom" } });
  port2.postMessage({ kind: "get", id: 5, keys: { options: null, dictionaryState: null, ankiIndex: null } });
  port2.postMessage({ kind: "get", id: 6, keys: ["lookupStats", "sharing"] });
  port2.postMessage({ kind: "get", id: 13, keys: "options" });
  port2.postMessage({ kind: "get", id: 14, keys: "sharing" });
  // A record of the frame's own, with a size it claims, then its update and
  // one aimed at a record the frame never wrote.
  port2.postMessage({ kind: "log", id: 7, ops: [{ record: { message: "GET https://a.test/x?q=1", context: "settings",
    bytes: -1e9, n: 1, nested: { a: 1 } } }] });
  await settle();
  port2.postMessage({ kind: "log", id: 8, ops: [{ key: 1, record: { message: "again" } }, { key: 99, record: { message: "y" } }] });
  // The reader's Toggle option keybind, and writes it never makes.
  const write = (id, options) => port2.postMessage({ kind: "send", id,
    message: { target: "hoshidicts-worker", type: "hd_options_write", baseRevision: 3, options } });
  write(9, { hoverEnabled: false });
  write(10, { anki: { url: "http://example.test" } });
  write(11, { hoverEnabled: false, audioAutoplay: true });
  write(12, { scanLength: 4 });
  // A boolean, but not one a Toggle option keybind may change.
  write(15, { wordHighlightEnabled: true });
  // The frame's word to the Clipboard monitor, which search.html runs.
  for (const kind of ["shown", "ready", "copied", "clipboard", "toString"]) port2.postMessage({ kind });
  await settle();
  assert.deepEqual(heard, ["shown", "ready", "copied"]);
  const reply = id => replies.find(data => data.kind === "reply" && data.id === id);
  assert.deepEqual(reply(1).value, { type: "hd_lookup_result", requestId: "a", ok: true });
  assert.match(reply(2).error, /cannot send hd_remove/u);
  assert.match(reply(3).error, /cannot send hd_options_write to hachidori-updates/u);
  assert.equal(reply(4).error, "Could not establish connection. Receiving end does not exist.");
  assert.deepEqual(api.sent.map(message => message.type), ["hd_lookup", "hd_page_zoom", "hd_options_write"]);
  assert.deepEqual(api.sent[2].options, { hoverEnabled: false });
  for (const id of [10, 11, 12, 15]) assert.match(reply(id).error, /cannot send hd_options_write/u);
  // Storage is asked for the reader's keys alone; defaults fill in as Chrome's do.
  assert.deepEqual(api.read, [["options", "dictionaryState"], ["lookupStats"], ["options"], []]);
  assert.deepEqual(reply(5).value, { options: { revision: 3, anki: { url: "u", apiKey: "" } }, dictionaryState: null });
  assert.deepEqual(reply(6).value, {});
  assert.deepEqual(reply(13).value, { options: { revision: 3, anki: { url: "u", apiKey: "" } } });
  assert.deepEqual(reply(14).value, {});
  assert.deepEqual(reply(7).value, [1]);
  const [[first], [again, stranger]] = written;
  assert.equal(first.key, undefined);
  assert.deepEqual({ ...first.record, bytes: undefined },
    { message: "GET https://a.test/x?[redacted]", context: "search", n: 1, bytes: undefined });
  assert.equal(first.record.bytes, new TextEncoder().encode(JSON.stringify({ ...first.record, bytes: 0 })).length);
  assert.equal(again.key, 1);
  assert.equal(stranger.key, undefined);

  // Only the reader's events and keys reach the frame.
  const [onMessage] = api.listeners.message;
  const [onChanged] = api.listeners.changed;
  assert.equal(onMessage({ target: "hachidori-reader", type: "hd_reader_command", action: "close" }, { id: "x", tab: { id: 1 } }), false);
  onMessage({ target: "hachidori-audio-ui", type: "hd_audio_voices_changed" }, { id: "x" });
  onChanged({ options: { newValue: { anki: { apiKey: "new" } }, oldValue: { anki: { apiKey: "old" } } },
    ankiIndex: { newValue: 2 } }, "local");
  onChanged({ sharingSecret: { newValue: 3 } }, "local");
  onChanged({ options: { newValue: 4 } }, "session");
  await settle();
  assert.deepEqual(replies.filter(data => data.kind !== "reply"), [
    { kind: "message", message: { target: "hachidori-reader", type: "hd_reader_command", action: "close" }, sender: { id: "x" } },
    { kind: "changed", changes: { options: { newValue: { anki: { apiKey: "" } }, oldValue: { anki: { apiKey: "" } } } },
      area: "local" },
  ]);
  close();
  assert.equal(api.listeners.message.size + api.listeners.changed.size, 0);
});

// The search page's line history (docs/search-history.md) is search.html's: it
// keeps a line only while the history is on, up to its limit and with the
// page's window, lists, edits and removes lines, refuses anything else, and
// tells the frame of every change until the channel closes.
test("search.html keeps the frame's lines while the history is on, and tells the frame of each change", async () => {
  const api = fakeApi();
  const { port1, port2 } = new MessageChannel();
  const calls = [];
  const listeners = new Set();
  const lines = {
    async add(line, { limit }) { calls.push(["add", line, limit]); return { line: { id: 7, ...line }, added: true }; },
    async list(args) { calls.push(["list", args]); return [{ id: 1, text: "一" }]; },
    async edit(id, text) { calls.push(["edit", id, text]); return { id, text }; },
    async remove(id) { calls.push(["remove", id]); return true; },
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let settings = { searchHistoryEnabled: true, searchHistoryLimit: 50 };
  const history = { onChange: lines.onChange,
    requests: searchHistoryRequests(lines, { settings: async () => settings, page: async () => "popup" }) };
  const close = serveSearchFrame(api, port1, { write: async () => [] }, {}, history);
  const replies = [];
  port2.onmessage = ({ data }) => replies.push(data);
  const ask = (id, op, args) => port2.postMessage({ kind: "history", id, op, args });
  // The page is search.html's to say, and the id the store's.
  ask(1, "add", { text: "食べる", source: "typed", page: "tab", id: 99 });
  ask(2, "list", { before: 5, limit: 1, extra: true });
  ask(3, "edit", { id: 1, text: "壱" });
  ask(4, "remove", { id: 1 });
  ask(5, "clear", {});
  ask(6, "constructor", {});
  await settle();
  settings = { ...settings, searchHistoryEnabled: false };
  ask(7, "add", { text: "読む", source: "clipboard" });
  for (const listener of listeners) listener({ type: "remove", id: 1 });
  await settle();
  const reply = id => replies.find(data => data.kind === "reply" && data.id === id);
  assert.deepEqual(reply(1).value, { id: 7, text: "食べる", source: "typed", page: "popup" });
  assert.deepEqual(reply(2).value, [{ id: 1, text: "一" }]);
  assert.deepEqual(reply(3).value, { id: 1, text: "壱" });
  assert.equal(reply(4).value, true);
  assert.match(reply(5).error, /cannot ask its history to clear/u);
  assert.match(reply(6).error, /cannot ask its history to constructor/u);
  assert.equal(reply(7).value, null, "nothing is kept while the history is off");
  assert.deepEqual(calls, [["add", { text: "食べる", source: "typed", page: "popup" }, 50],
    ["list", { before: 5, after: undefined, limit: 1 }], ["edit", 1, "壱"], ["remove", 1]]);
  assert.deepEqual(replies.filter(data => data.kind === "history"), [{ kind: "history", change: { type: "remove", id: 1 } }]);
  close();
  assert.equal(listeners.size, 0);
});

// search.html takes the port its own frame offers, once, and starts again when
// the frame's code loads another document. Only a sandboxed frame, whose origin
// is opaque, is given the user's script.
function frameHost() {
  const listeners = {};
  const window = { location: { origin: "chrome-extension://hachidori" },
    addEventListener: (type, listener) => { listeners[type] = listener; } };
  const frame = { contentWindow: {}, focused: 0, focus() { frame.focused += 1; },
    addEventListener: (type, listener) => { listeners[`frame ${type}`] = listener; } };
  const served = [], connected = [];
  let reloads = 0;
  connectSearchFrame({ window, frame, reload: () => { reloads += 1; },
    serve: (port) => { served.push(port.name); return () => { port.closed = true; }; },
    connection: sandboxed => ({ id: "hachidori", customJavaScript: sandboxed ? "code" : "" }) });
  const port = name => ({ name, postMessage: data => connected.push([name, data]) });
  const offer = (source, origin, ports, type = "hachidori-search-bridge") => listeners.message({ source, origin, data: { type }, ports });
  return { listeners, frame, served, connected, port, offer, reloads: () => reloads };
}

test("search.html connects its frame's first offer only, and reloads when the frame navigates", () => {
  const { listeners, frame, served, connected, port, offer, reloads } = frameHost();
  offer({}, "null", [port("another window")]);
  offer(frame.contentWindow, "chrome-extension://other", [port("another extension")]);
  offer(frame.contentWindow, "https://example.test", [port("a web page")]);
  offer(frame.contentWindow, "null", [port("another type")], "something-else");
  offer(frame.contentWindow, "null", []);
  const first = port("first");
  offer(frame.contentWindow, "null", [first]);
  offer(frame.contentWindow, "null", [port("second")]);
  assert.deepEqual(served, ["first"]);
  assert.deepEqual(connected, [["first", { kind: "connect", id: "hachidori", customJavaScript: "code" }]]);
  assert.equal(frame.focused, 1);
  listeners["frame load"]();
  assert.equal(reloads(), 0);
  listeners["frame load"]();
  assert.equal(reloads(), 1);
  assert.equal(first.closed, true);

  // Firefox before 154: the frame is not sandboxed, has this page's origin and no Custom JavaScript.
  const unsandboxed = frameHost();
  unsandboxed.offer(unsandboxed.frame.contentWindow, "chrome-extension://hachidori", [unsandboxed.port("153")]);
  assert.deepEqual(unsandboxed.connected, [["153", { kind: "connect", id: "hachidori", customJavaScript: "" }]]);
});

// search-bridge.js in a sandboxed document: `chrome` is absent until it runs.
function frameContext(globals = {}) {
  const offers = [];
  const context = vm.createContext({ URL, Promise, Error, Set, Map, Object, String, MessageChannel, ...globals,
    location: { href: "chrome-extension://abcdef/search-frame.html", origin: "chrome-extension://abcdef" } });
  context.window = { parent: { postMessage: (data, origin, transfer) => offers.push({ data, origin, transfer }) } };
  vm.runInContext(readFileSync(new URL("search-bridge.js", EXTENSION), "utf8"), context);
  return { context, offers };
}

test("the frame offers search.html one port, to the extension's origin, and its chrome behaves as Chrome's callbacks do", async () => {
  const { context, offers } = frameContext();
  const chrome = context.chrome;
  // One port, to the extension's own origin, never to any window ("*").
  assert.deepEqual(offers.map(({ data, origin, transfer }) => [data.type, origin, transfer.length]),
    [["hachidori-search-bridge", "chrome-extension://abcdef", 1]]);
  assert.equal(chrome.runtime.getURL("/render/reader.css"), "chrome-extension://abcdef/render/reader.css");
  assert.equal(chrome.runtime.id, undefined);
  const early = chrome.storage.local.get("options");

  const [port] = offers[0].transfer;
  const requests = [];
  port.onmessage = ({ data }) => {
    requests.push(data);
    if (data.kind === "get") port.postMessage({ kind: "reply", id: data.id, value: { options: { revision: 1 } } });
    if (data.kind === "send" && data.message.type === "hd_lookup") port.postMessage({ kind: "reply", id: data.id, value: { ok: true } });
    if (data.kind === "send" && data.message.type === "hd_kanji") port.postMessage({ kind: "reply", id: data.id, error: "Extension context invalidated." });
    if (data.kind === "history") port.postMessage({ kind: "reply", id: data.id, value: [{ id: 3, text: data.op }] });
  };
  port.postMessage({ kind: "connect", id: "hachidori", manifest: { version: "1" }, customJavaScript: "code" });
  // A second connect changes nothing.
  port.postMessage({ kind: "connect", id: "second", manifest: { version: "2" } });
  assert.equal(await context.HDSearchBridge.ready.then(connection => connection.id), "hachidori");
  await settle();
  assert.equal(chrome.runtime.id, "hachidori");
  assert.deepEqual(chrome.runtime.getManifest(), { version: "1" });
  assert.deepEqual(await early, { options: { revision: 1 } });

  const answered = await new Promise(resolve => chrome.runtime.sendMessage({ type: "hd_lookup" }, reply => {
    resolve({ reply, lastError: chrome.runtime.lastError });
  }));
  assert.deepEqual(answered, { reply: { ok: true }, lastError: undefined });
  const failed = await new Promise(resolve => chrome.runtime.sendMessage({ type: "hd_kanji" }, reply => {
    resolve({ reply, lastError: chrome.runtime.lastError?.message });
  }));
  assert.deepEqual(failed, { reply: undefined, lastError: "Extension context invalidated." });
  assert.equal(chrome.runtime.lastError, undefined);
  await assert.rejects(chrome.runtime.sendMessage({ type: "hd_kanji" }), /context invalidated/u);

  const messages = [], changes = [];
  chrome.runtime.onMessage.addListener(message => { messages.push(message.type); });
  chrome.storage.onChanged.addListener((changed, area) => { changes.push([Object.keys(changed), area]); });
  port.postMessage({ kind: "message", message: { type: "hd_reader_command" }, sender: { id: "hachidori" } });
  port.postMessage({ kind: "changed", changes: { options: {} }, area: "local" });
  await settle();
  assert.deepEqual(messages, ["hd_reader_command"]);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [[["options"], "local"]]);

  // The history is search.html's: a request goes there, and so do its changes come back.
  assert.deepEqual(await context.HDSearchBridge.history("list", { limit: 1 }), [{ id: 3, text: "list" }]);
  const historyChanges = [];
  context.HDSearchBridge.onHistory(change => historyChanges.push(change));
  port.postMessage({ kind: "history", change: { type: "clear" } });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(historyChanges)), [{ type: "clear" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(data => data.kind === "history"))),
    { kind: "history", id: requests.find(data => data.kind === "history").id, op: "list", args: { limit: 1 } });

  // What search.html's Clipboard monitor read, and the page's word back.
  const clipboard = [], keys = [];
  context.HDSearchBridge.onClipboard(text => clipboard.push(text));
  context.HDSearchBridge.onKey(key => keys.push(key));
  port.postMessage({ kind: "clipboard", text: "読む" });
  port.postMessage({ kind: "key", key: "Escape" });
  port.postMessage({ kind: "toString" });
  context.HDSearchBridge.notify("ready");
  context.HDSearchBridge.notify("copied");
  await settle();
  assert.deepEqual(clipboard, ["読む"]);
  assert.deepEqual(keys, ["Escape"]);
  assert.deepEqual(requests.slice(-2).map(data => data.kind), ["ready", "copied"]);
  assert.ok(requests.every(data => ["get", "send", "history", "ready", "copied"].includes(data.kind)));
  port.close();
});

// Firefox before 154 does not sandbox the frame: it keeps its own API, and the
// channel carries only the debug log and the Clipboard monitor's text.
test("an unsandboxed frame keeps its own chrome and still offers search.html its port", () => {
  const native = { runtime: { id: "hachidori" } };
  const { context, offers } = frameContext({ chrome: native });
  assert.equal(context.chrome, native);
  assert.deepEqual(offers.map(({ data, origin, transfer }) => [data.type, origin, transfer.length]),
    [["hachidori-search-bridge", "chrome-extension://abcdef", 1]]);
  assert.equal(typeof context.HDSearchBridge.onClipboard, "function");
  offers[0].transfer[0].close();
});
