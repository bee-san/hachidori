// The search page's own document (#644). Chrome and Firefox run no user script
// in an extension page, so search.html holds the search box, its results and
// the reader in a sandboxed frame, search-frame.html, where Design → Custom
// JavaScript runs as a user script does on a web page. A sandboxed document
// has no extension APIs. This gives it the part of `chrome` the reader and
// search.js use, through the page holding the frame (search-shell.js): runtime
// messages, the stored keys the reader reads, and the events sent to the
// reader. It loads first, so every later script finds `chrome` in place.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  // Firefox before 154 loads the frame as an ordinary extension page, with its
  // own API; Custom JavaScript cannot run there.
  if (globalThis.chrome?.runtime?.id) return;

  const base = new URL(".", location.href);
  const pending = new Map();
  const messageListeners = new Set();
  const storageListeners = new Set();
  let port = null;
  let connection = null;
  let nextId = 0;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  // The page holding the frame hands over one port, once.
  window.addEventListener("message", (event) => {
    if (port || event.source !== window.parent || event.data?.type !== "hachidori-search-bridge" || !event.ports[0]) return;
    connection = event.data;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data.kind === "reply") {
        const call = pending.get(data.id);
        pending.delete(data.id);
        if (data.error === undefined) call?.resolve(data.value);
        else call?.reject(new Error(data.error));
      } else if (data.kind === "message") {
        for (const listener of [...messageListeners]) listener(data.message, data.sender, () => {});
      } else if (data.kind === "changed") {
        for (const listener of [...storageListeners]) listener(data.changes, data.area);
      }
    };
    resolveReady(connection);
  });

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
    hasListener: listener => listeners.has(listener),
  });

  const runtime = {
    lastError: undefined,
    get id() { return connection?.id; },
    getURL: path => new URL(String(path).replace(/^\//u, ""), base).href,
    getManifest: () => connection?.manifest,
    sendMessage: (message, callback) => settle(call("send", { message }), callback),
    onMessage: event(messageListeners),
  };
  globalThis.chrome = {
    runtime,
    storage: {
      local: { get: (keys, callback) => settle(call("get", { keys }), callback) },
      onChanged: event(storageListeners),
    },
  };
  // search.js waits for the connection and keeps its debug log in the
  // extension's store through it.
  globalThis.HDSearchBridge = Object.freeze({
    ready,
    debugLogStore: Object.freeze({ write: ops => call("log", { ops }) }),
  });
}());
