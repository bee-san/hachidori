// SPDX-License-Identifier: GPL-3.0-or-later
// The search page's sandboxed frame (#644) reaches the extension only through
// search.html: search-shell.js answers what the reader sends, and
// search-bridge.js is the `chrome` the frame's scripts see.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { READER_EVENTS, READER_REQUESTS, readerKey, serveSearchFrame } from "../extension/search-shell.js";

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
  const close = serveSearchFrame(api, port1, { async write(ops) {
    written.push(ops);
    return ops.map(({ key }) => key ?? (nextKey += 1));
  } });
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
  await settle();
  const reply = id => replies.find(data => data.kind === "reply" && data.id === id);
  assert.deepEqual(reply(1).value, { type: "hd_lookup_result", requestId: "a", ok: true });
  assert.match(reply(2).error, /cannot send hd_remove/u);
  assert.match(reply(3).error, /cannot send hd_options_write to hachidori-updates/u);
  assert.equal(reply(4).error, "Could not establish connection. Receiving end does not exist.");
  assert.deepEqual(api.sent.map(message => message.type), ["hd_lookup", "hd_page_zoom", "hd_options_write"]);
  assert.deepEqual(api.sent[2].options, { hoverEnabled: false });
  for (const id of [10, 11, 12]) assert.match(reply(id).error, /cannot send hd_options_write/u);
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

// search-bridge.js in a sandboxed document: `chrome` is absent until it runs.
function frameContext() {
  const offers = [];
  const context = vm.createContext({ URL, Promise, Error, Set, Map, Object, String, MessageChannel,
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
  assert.ok(requests.every(data => ["get", "send"].includes(data.kind)));
  port.close();
});
