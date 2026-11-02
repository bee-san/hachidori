// The search page's own document (#644). Chrome and Firefox run no user script
// in an extension page, so search.html holds the search box, its results and
// the reader in a sandboxed frame, search-frame.html, where Design → Custom
// JavaScript runs as a user script does on a web page. A sandboxed document
// has no extension APIs. This gives it the part of `chrome` the reader and
// search.js use, through the page holding the frame (search-shell.js): runtime
// messages, the stored keys the reader reads, and the events sent to the
// reader. It loads first, so every later script finds `chrome` in place. The
// same channel brings search.js what the Clipboard monitor, whose switch is
// search.html's, reads.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  // Firefox before 154 loads the frame as an ordinary extension page, with its
  // own API: Custom JavaScript cannot run there, and only the Clipboard monitor
  // uses the channel.
  const sandboxed = !globalThis.chrome?.runtime?.id;
  const base = new URL(".", location.href);
  const pending = new Map();
  const messageListeners = new Set();
  const storageListeners = new Set();
  const clipboardListeners = new Set();
  const keyListeners = new Set();
  let connection = null;
  let nextId = 0;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  // The frame makes the channel and offers its port to the extension's own
  // origin, which this sandboxed document's location keeps: only search.html
  // can take it. search.html connects by sending its first message.
  const { port1: port, port2 } = new MessageChannel();
  port.onmessage = ({ data }) => {
    if (data.kind === "connect") {
      connection ??= data;
      resolveReady(connection);
    } else if (data.kind === "reply") {
      const call = pending.get(data.id);
      pending.delete(data.id);
      if (data.error === undefined) call?.resolve(data.value);
      else call?.reject(new Error(data.error));
    } else if (data.kind === "message") {
      for (const listener of messageListeners) listener(data.message, data.sender, () => {});
    } else if (data.kind === "changed") {
      for (const listener of storageListeners) listener(data.changes, data.area);
    } else if (data.kind === "clipboard") {
      for (const listener of clipboardListeners) listener(data.text);
    } else if (data.kind === "key") {
      for (const listener of keyListeners) listener(data.key);
    }
  };
  window.parent.postMessage({ type: "hachidori-search-bridge" }, location.origin, [port2]);

  function call(kind, fields) {
    return ready.then(() => new Promise((resolve, reject) => {
      const id = nextId += 1;
      pending.set(id, { resolve, reject });
      port.postMessage({ kind, id, ...fields });
    }));
  }

  // The callback form sets runtime.lastError for the callback's duration, as
  // Chrome's does; without a callback, the promise.
  function settle(promise, callback) {
    if (typeof callback !== "function") return promise;
    promise.then((value) => { callback(value); }, (error) => {
      runtime.lastError = { message: error.message };
      try {
        callback();
      } finally {
        runtime.lastError = undefined;
      }
    });
    return undefined;
  }

  const event = listeners => ({
    addListener: (listener) => { listeners.add(listener); },
    removeListener: (listener) => { listeners.delete(listener); },
  });

  const runtime = {
    lastError: undefined,
    get id() { return connection?.id; },
    getURL: path => new URL(String(path).replace(/^\//u, ""), base).href,
    getManifest: () => connection?.manifest,
    sendMessage: (message, callback) => settle(call("send", { message }), callback),
    onMessage: event(messageListeners),
  };
  if (sandboxed) {
    globalThis.chrome = {
      runtime,
      storage: {
        local: { get: (keys, callback) => settle(call("get", { keys }), callback) },
        onChanged: event(storageListeners),
      },
    };
  }
  // search.js waits for the connection and keeps its debug log in the
  // extension's store through it. It searches what the Clipboard monitor reads,
  // takes the page's keys pressed in search.html's header, and tells
  // search.html when its reader is ready and when text is copied here.
  globalThis.HDSearchBridge = Object.freeze({
    ready,
    debugLogStore: Object.freeze({ write: ops => call("log", { ops }) }),
    onClipboard: (listener) => { clipboardListeners.add(listener); },
    onKey: (listener) => { keyListeners.add(listener); },
    notify: (kind) => { port.postMessage({ kind }); },
  });
}());
