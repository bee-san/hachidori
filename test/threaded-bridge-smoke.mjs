#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const runtimeListeners = [];
const engineWorkers = [];
const capabilityWorkers = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWorker {
  static creationError = null;

  constructor(url) {
    this.url = String(url);
    if (this.url.endsWith("/engine-worker.js") && FakeWorker.creationError !== null) {
      throw FakeWorker.creationError;
    }
    this.listeners = new Map();
    this.onmessage = null;
    this.messages = [];
    this.dispatchError = null;
    if (this.url.endsWith("/engine-worker.js")) engineWorkers.push(this);
    else capabilityWorkers.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  postMessage(message) {
    if (this.dispatchError !== null) {
      const error = this.dispatchError;
      this.dispatchError = null;
      throw error;
    }
    this.messages.push(message);
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
await tick();

assert.equal(runtimeListeners.length, 1);
assert.equal(engineWorkers.length, 0);
let relay = runtimeListeners[0];

function request(type, requestId) {
  const responses = [];
  const promise = new Promise((resolve, reject) => {
    const asynchronous = relay(
      { target: "hoshidicts-offscreen", relayed: true, type, requestId },
      {},
      (response) => {
        responses.push(response);
        resolve(response);
      },
    );
    if (asynchronous !== true) reject(new Error(`${type} was not accepted asynchronously`));
  });
  return { promise, responses };
}

function send(type, requestId) {
  return request(type, requestId).promise;
}

const startup = Array.from({ length: 129 }, (_, index) => request("hd_lookup", `lookup-${index}`));
await tick();
assert.equal(startup[128].responses.length, 1, "admit before awaiting engine selection");
assert.equal(engineWorkers.length, 0);
const startupStatus = request("hd_status", "startup-status");
await tick();
assert.equal(startupStatus.responses.length, 1, "status remains available during selection");
assert.equal((await startupStatus.promise).ready, false);
assert.equal((await startupStatus.promise).loading, true);
assert.equal((await startupStatus.promise).storageBackend, undefined);
capabilityWorkers[0].emit("message", { channel: "opfs-capability-result", ok: true });
await tick();
assert.equal(engineWorkers.length, 1);
const engine = engineWorkers[0];
const queued = startup.map((entry) => entry.promise);
assert.equal(engine.messages.filter((message) => message.channel === "engine-request").length, 128);
assert.deepEqual(await queued[128], {
  type: "hd_lookup_result",
  requestId: "lookup-128",
  ok: false,
  error: "the dictionary engine request queue is full",
});
const responseLimits = [["hd_lookup", 32 * 1024 * 1024], ["hd_media", 6 * 1024 * 1024]];
for (const [type, limit] of responseLimits) {
  const fullQueueOversizedId = await send(type, "x".repeat(limit));
  assert.equal(fullQueueOversizedId.ok, false);
  assert.equal(fullQueueOversizedId.requestId, null);
  assert.ok(Buffer.byteLength(JSON.stringify(fullQueueOversizedId)) <= limit);
  assert.equal((await send(type, {})).requestId, null);
}

for (const message of engine.messages.splice(0)) {
  engine.emit("message", {
    channel: "engine-response",
    id: message.id,
    response: { type: "hd_lookup_result", requestId: message.message.requestId, ok: true, results: [] },
  });
}
await Promise.all(queued.slice(0, 128));

const mutationTypes = [
  "hd_import",
  "hd_apply_state",
  "hd_reload",
  "hd_remove",
  "hd_custom_save",
  "hd_custom_append",
];

for (const [index, type] of mutationTypes.entries()) {
  const requestId = `mutation-${index}`;
  const mutating = send(type, requestId);
  await new Promise((resolve) => setImmediate(resolve));
  const mutationMessage = engine.messages.at(-1);
  assert.equal(mutationMessage.message.type, type);

  const status = await send("hd_status", `status-during-${type}`);
  assert.equal(status.ok, true);
  assert.equal(status.loading, true);
  assert.equal(status.threaded, true);
  assert.equal(status.storageBackend, "opfs");

  assert.deepEqual(await send("hd_lookup", `lookup-during-${type}`), {
    type: "hd_lookup_result",
    requestId: `lookup-during-${type}`,
    ok: false,
    error: "the dictionary engine is busy mutating",
  });
  if (index === 0) {
    for (const [boundedType, limit] of responseLimits) {
      const oversizedId = await send(boundedType, "x".repeat(limit));
      assert.equal(oversizedId.requestId, null);
      assert.ok(Buffer.byteLength(JSON.stringify(oversizedId)) <= limit);
    }
  }
  assert.deepEqual(await send("hd_remove", `remove-during-${type}`), {
    type: "hd_remove_result",
    requestId: `remove-during-${type}`,
    ok: false,
    error: "the dictionary engine is busy mutating",
  });

  engine.emit("message", {
    channel: "engine-response",
    id: mutationMessage.id,
    response: { type: `${type}_result`, requestId, ok: true },
  });
  assert.equal((await mutating).ok, true);
}

engine.dispatchError = new Error("test dispatch failure");
const failedDispatch = request("hd_custom_append", "failed-dispatch");
assert.match((await failedDispatch.promise).error, /test dispatch failure/);
const recoveredMutation = request("hd_custom_append", "recovered-mutation");
await tick();
const recoveredMessage = engine.messages.at(-1);
assert.equal(recoveredMessage.message.requestId, "recovered-mutation", "failed dispatch releases mutation lock");
engine.emit("message", {
  channel: "engine-response", id: recoveredMessage.id,
  response: { type: "hd_custom_append_result", ok: true },
});
assert.equal((await recoveredMutation.promise).ok, true);
assert.equal(failedDispatch.responses.length, 1);

const beforeFailure = request("hd_lookup", "before-worker-failure");
const failedMutation = request("hd_remove", "worker-failure-mutation");
await tick();
engine.emit("messageerror");
assert.match((await beforeFailure.promise).error, /unreadable message/);
assert.match((await failedMutation.promise).error, /unreadable message/);
engine.emit("message", {
  channel: "engine-response", id: engine.messages.at(-1).id,
  response: { type: "hd_remove_result", ok: true },
});
assert.equal(beforeFailure.responses.length, 1);
assert.equal(failedMutation.responses.length, 1, "late worker replies cannot settle twice");
assert.match((await send("hd_status", "failed-worker-status")).error, /unreadable message/);

FakeWorker.creationError = new Error("test engine selection failure");
await import(`../extension/offscreen.js?failed-selection=${Date.now()}`);
relay = runtimeListeners.at(-1);
const failedSelection = request("hd_lookup", "failed-selection-lookup");
const failedSelectionMutation = request("hd_import", "failed-selection-mutation");
capabilityWorkers.at(-1).emit("message", { channel: "opfs-capability-result", ok: true });
for (const entry of [failedSelection, failedSelectionMutation]) {
  assert.match((await entry.promise).error, /test engine selection failure/);
  assert.equal(entry.responses.length, 1);
}
assert.match((await send("hd_status", "failed-selection-status")).error, /test engine selection failure/);
FakeWorker.creationError = null;

// Hold only the fallback service module. The production bridge is really imported;
// real IDBFS/WASM behavior is covered by extension-smoke and chrome-fallback.
const serviceLoad = Promise.withResolvers();
const serviceLoading = Promise.withResolvers();
const serviceStarted = Promise.withResolvers();
const localRequests = [];
let configured = false;
let started = false;
let statusError = null;
globalThis.bridgeFallbackFixture = {
  loading: serviceLoading.resolve,
  loaded: serviceLoad.promise,
  configureEngineService(sender, options) {
    assert.equal(typeof sender, "function");
    assert.equal(typeof options.createHoshidicts, "function");
    assert.equal(options.storageBackend, "idbfs");
    assert.equal(options.lowRam, true);
    configured = true;
  },
  startEngine() {
    started = true;
    serviceStarted.resolve();
  },
  handleEngineMessage(message) {
    if (message.type === "hd_status") {
      return Promise.resolve({
        type: "hd_status_result", requestId: message.requestId,
        ok: statusError === null, error: statusError,
        ready: true, loading: false, dictionaryCount: 3, generation: 7,
        threaded: false, storageBackend: "idbfs",
      });
    }
    const result = Promise.withResolvers();
    localRequests.push({ message, ...result });
    return result.promise;
  },
};
const serviceUrl = new URL("../extension/engine-service.js", import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== serviceUrl) return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: `const fixture = globalThis.bridgeFallbackFixture;
        fixture.loading();
        await fixture.loaded;
        export const { configureEngineService, startEngine, handleEngineMessage } = fixture;`,
    };
  },
});
try {
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
  await import(`../extension/offscreen.js?fallback-bridge-smoke=${Date.now()}`);
  relay = runtimeListeners.at(-1);
  await serviceLoading.promise;
  const loading = Array.from({ length: 129 }, (_, index) => request("hd_lookup", `local-${index}`));
  await tick();
  assert.equal(loading[128].responses.length, 1, "fallback loading must share admission");
  assert.match((await loading[128].promise).error, /queue is full/);
  assert.equal(localRequests.length, 0);
  const loadingStatus = await send("hd_status", "fallback-loading-status");
  assert.equal(loadingStatus.loading, true);
  assert.equal(loadingStatus.storageBackend, "idbfs");
  assert.equal(loadingStatus.threaded, false);
  serviceLoad.resolve();
  await serviceStarted.promise;
  await tick();
  assert.equal(configured, true);
  assert.equal(started, true);
  assert.equal(localRequests.length, 128);
  const overflow = await send("hd_lookup", "local-overflow");
  assert.match(overflow.error, /queue is full/);
  localRequests.shift().resolve({ type: "hd_lookup_result", ok: true });
  await loading[0].promise;
  const replacement = request("hd_lookup", "local-replacement");
  await tick();
  assert.equal(localRequests.length, 128, "exactly one slot is reusable after completion");
  for (const entry of localRequests.splice(0)) entry.resolve({ type: "hd_lookup_result", ok: true });
  await Promise.all([...loading.map((entry) => entry.promise), replacement.promise]);
  const realStatus = await send("hd_status", "local-ready");
  assert.equal(realStatus.ready, true);
  assert.equal(realStatus.generation, 7);

  for (const fails of [false, true]) {
    statusError = fails ? "test reload failure" : null;
    assert.equal((await send("hd_status", "local-status-before-mutation")).error, statusError);
    const mutation = request("hd_custom_append", `local-mutation-${fails}`);
    await tick();
    assert.equal(localRequests.length, 1);
    const status = await send("hd_status", "local-busy-status");
    assert.equal(status.ok, !fails, "cached status must preserve a known engine failure");
    assert.equal(status.error, statusError);
    assert.equal(status.loading, true);
    assert.equal(status.threaded, false);
    assert.equal(status.storageBackend, "idbfs");
    assert.equal(status.dictionaryCount, 3);
    assert.equal(status.generation, 7);
    assert.match((await send("hd_lookup", "local-busy-lookup")).error, /busy mutating/);
    assert.match((await send("hd_remove", "local-busy-remove")).error, /busy mutating/);
    const entry = localRequests.shift();
    if (fails) entry.reject(new Error("test local failure"));
    else entry.resolve({ type: "hd_custom_append_result", ok: true });
    assert.equal((await mutation.promise).ok, !fails);
    assert.equal(mutation.responses.length, 1);
  }
  statusError = null;
  const restoredStatus = await send("hd_status", "local-restored-status");
  assert.equal(restoredStatus.ok, true);
  assert.equal(restoredStatus.error, null, "normal status still reaches engine recovery");
  const healthy = request("hd_lookup", "local-healthy");
  await tick();
  assert.equal(localRequests.length, 1, "local failure releases its admission and lock");
  localRequests.shift().resolve({ type: "hd_lookup_result", ok: true });
  assert.equal((await healthy.promise).ok, true);
} finally {
  serviceLoad.resolve();
  hooks.deregister();
  delete globalThis.bridgeFallbackFixture;
}

console.log("offscreen bridge caps startup and both backends, preserves status, and releases failed requests");
