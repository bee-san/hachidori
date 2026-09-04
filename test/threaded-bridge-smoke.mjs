#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

const runtimeListeners = [];
const engineWorkers = [];

class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.onmessage = null;
    this.messages = [];
    if (this.url.endsWith("/engine-worker.js")) engineWorkers.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    if (this.url.endsWith("/opfs-capability-worker.js")) {
      queueMicrotask(() => this.emit("message", { channel: "opfs-capability-result", ok: true }));
    }
  }

  terminate() {}

  emit(type, data) {
    const event = { data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === "message") this.onmessage?.(event);
  }
}

Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      getDirectory: async () => ({}),
      persist: async () => true,
    },
  },
});

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListeners.push(listener);
      },
    },
    sendMessage: async () => ({}),
  },
};

await import(`../extension/offscreen.js?threaded-bridge-smoke=${Date.now()}`);
await new Promise((resolve) => setImmediate(resolve));

assert.equal(runtimeListeners.length, 1);
assert.equal(engineWorkers.length, 1);
const engine = engineWorkers[0];
const relay = runtimeListeners[0];

function send(type, requestId) {
  return new Promise((resolve, reject) => {
    const asynchronous = relay(
      { target: "hoshidicts-offscreen", relayed: true, type, requestId },
      {},
      resolve,
    );
    if (asynchronous !== true) reject(new Error(`${type} was not accepted asynchronously`));
  });
}

const queued = Array.from({ length: 129 }, (_, index) => send("hd_lookup", `lookup-${index}`));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(engine.messages.filter((message) => message.channel === "engine-request").length, 128);
assert.deepEqual(await queued[128], {
  type: "hd_lookup_result",
  requestId: "lookup-128",
  ok: false,
  error: "the dictionary engine request queue is full",
});

for (const message of engine.messages.splice(0)) {
  engine.emit("message", {
    channel: "engine-response",
    id: message.id,
    response: { type: "hd_lookup_result", requestId: message.message.requestId, ok: true, results: [] },
  });
}
await Promise.all(queued.slice(0, 128));

const importing = send("hd_import", "import-1");
await new Promise((resolve) => setImmediate(resolve));
const importMessage = engine.messages.at(-1);
assert.equal(importMessage.message.type, "hd_import");

const status = await send("hd_status", "status-during-import");
assert.equal(status.ok, true);
assert.equal(status.loading, true);
assert.equal(status.threaded, true);
assert.equal(status.storageBackend, "opfs");

assert.deepEqual(await send("hd_lookup", "lookup-during-import"), {
  type: "hd_lookup_result",
  requestId: "lookup-during-import",
  ok: false,
  error: "the dictionary engine is busy importing",
});

engine.emit("message", {
  channel: "engine-response",
  id: importMessage.id,
  response: { type: "hd_import_result", requestId: "import-1", ok: true, report: { success: true } },
});
assert.equal((await importing).ok, true);

console.log("threaded bridge caps pending requests and answers status while import blocks");
