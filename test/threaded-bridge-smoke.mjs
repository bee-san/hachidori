#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";

const runtimeListeners = [];
const engineWorkers = [];
const capabilityWorkers = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ENGINE_WORKER_SCRIPT = /\/engine-worker(?:-idbfs)?\.js$/u;

class FakeWorker {
  static creationError = null;

  constructor(url, options) {
    this.url = String(url);
    this.name = options?.name;
    if (ENGINE_WORKER_SCRIPT.test(this.url) && FakeWorker.creationError !== null) {
      throw FakeWorker.creationError;
    }
    this.listeners = new Map();
    this.onmessage = null;
    this.messages = [];
    this.dispatchError = null;
    if (ENGINE_WORKER_SCRIPT.test(this.url)) engineWorkers.push(this);
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

let configuredLowMemory = true;
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListeners.push(listener);
      },
    },
    sendMessage: async (message) => message.type === "hd_engine_config"
      ? { ok: true, lowMemoryMode: configuredLowMemory } : {},
  },
};

await import(`../extension/offscreen.js?threaded-bridge-smoke=${Date.now()}`);
await tick();

assert.equal(engineWorkers.length, 0);
// Each fresh offscreen import registers its own engine, audio, capture and
// setup listeners. Route through that import's listeners, not a fixed index.
function importedRuntime() {
  const listeners = runtimeListeners.splice(0);
  return (...args) => listeners.some(listener => listener(...args) === true);
}
let relay = importedRuntime();

// The initial config read has finished, but the capability probe has not.
// A newer option push must win when that probe finally selects a worker.
configuredLowMemory = false;
assert.equal(relay(
  { target: "hoshidicts-offscreen", type: "hd_engine_config", relayed: true, lowMemoryMode: false },
  { url: "background.js" },
  () => {},
), true);

function request(type, requestId, fields = {}) {
  const responses = [];
  const promise = new Promise((resolve, reject) => {
    const asynchronous = relay(
      { target: "hoshidicts-offscreen", relayed: true, type, requestId, ...fields },
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
assert.equal(engineWorkers[0].name, "hoshidicts-engine", "a config push during selection supersedes the startup read");
assert.match(engineWorkers[0].url, /\/engine-worker\.js$/u, "a passing OPFS probe selects the direct-OPFS worker");
const engine = engineWorkers[0];
const queued = startup.map((entry) => entry.promise);
assert.equal(engine.messages.filter((message) => message.channel === "engine-request").length, 128);
assert.deepEqual(await queued[128], {
  type: "hd_lookup_result",
  requestId: "lookup-128",
  ok: false,
  error: "the dictionary engine request queue is full",
});
const release = request("hd_backup_release", "saturated-release");
await tick();
assert.equal(engine.messages.at(-1).message.type, "hd_backup_release", "cleanup has one reserved slot");
assert.match((await send("hd_backup_release", "release-overflow")).error, /queue is full/);
engine.emit("message", { channel: "engine-response", id: engine.messages.at(-1).id,
  response: { type: "hd_backup_release_result", ok: true } });
assert.equal((await release.promise).ok, true);
engine.messages.pop();
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

for (const type of ["hd_backup_prepare", "hd_backup_auto_prepare", "hd_custom_save"]) {
  const saturated = Array.from({ length: 127 }, (_, index) => request("hd_lookup", `before-cancel-${index}`));
  const preparing = request(type, "leaving-prepare", { token: "leaving-page" });
  await tick();
  const prepareMessage = engine.messages.at(-1);
  const cancelling = request("hd_backup_cancel", "leaving-cancel", { token: "leaving-page" });
  await tick();
  const cancelMessage = engine.messages.at(-1);
  assert.equal(cancelMessage.message.type, "hd_backup_cancel", "the departing page can queue cancellation behind preparation or another mutation");
  const cleanup = request("hd_backup_release", "cleanup-during-cancel");
  await tick();
  const cleanupMessage = engine.messages.at(-1);
  assert.equal(cleanupMessage.message.type, "hd_backup_release");
  assert.match((await send("hd_backup_release", "cleanup-overflow")).error, /queue is full/);
  engine.emit("message", { channel: "engine-response", id: cleanupMessage.id,
    response: { type: "hd_backup_release_result", ok: true } });
  await cleanup.promise;
  engine.emit("message", { channel: "engine-response", id: prepareMessage.id,
    response: { type: "hd_backup_prepare_result", ok: true } });
  await preparing.promise;
  assert.match((await send("hd_lookup", "lookup-before-cancel")).error, /busy mutating/);
  engine.emit("message", { channel: "engine-response", id: cancelMessage.id,
    response: { type: "hd_backup_cancel_result", ok: true } });
  await cancelling.promise;
  for (const message of engine.messages.splice(0)) {
    engine.emit("message", { channel: "engine-response", id: message.id,
      response: { type: "hd_lookup_result", ok: true } });
  }
  await Promise.all(saturated.map(entry => entry.promise));
}

const stagedImport = request("hd_import", "staged-import", { managedFingerprint: { id: "managed-a" } });
await tick();
const stagedImportMessage = engine.messages.at(-1);
assert.equal(stagedImportMessage.message.type, "hd_import");
const stagedStatus = await send("hd_status", "status-during-staging");
assert.equal(stagedStatus.loading, true);
assert.equal(stagedStatus.threaded, true);
assert.equal(stagedStatus.storageBackend, "opfs");
assert.deepEqual(stagedStatus.updating, { id: "managed-a", phase: "downloading", fallback: null },
  "status names the package an admitted import replaces before the engine reports a phase");
const stagedLookup = request("hd_lookup", "lookup-during-staging");
await tick();
const stagedLookupMessage = engine.messages.at(-1);
assert.equal(stagedLookupMessage.message.type, "hd_lookup", "reads reach the engine while an import downloads");
engine.emit("message", {
  channel: "engine-response",
  id: stagedLookupMessage.id,
  response: { type: "hd_lookup_result", requestId: "lookup-during-staging", ok: true, results: [] },
});
assert.equal((await stagedLookup.promise).ok, true);
assert.match((await send("hd_remove", "remove-during-staging")).error, /busy mutating/);
engine.emit("message", {
  channel: "engine-progress",
  progress: {
    requestId: "staged-import",
    phase: "downloading",
    receivedBytes: 4,
    totalBytes: 8,
  },
});
const secondStagedLookup = request("hd_lookup", "second-lookup-during-staging");
await tick();
const secondStagedLookupMessage = engine.messages.at(-1);
assert.equal(secondStagedLookupMessage.message.type, "hd_lookup");
engine.emit("message", {
  channel: "engine-response",
  id: secondStagedLookupMessage.id,
  response: { type: "hd_lookup_result", requestId: "second-lookup-during-staging", ok: true, results: [] },
});
assert.equal((await secondStagedLookup.promise).ok, true);
// An isolated import (engine-service.js runIsolatedImportTransaction) leaves the
// committed dictionaries loaded, so its installing phase takes no read lock.
engine.emit("message", {
  channel: "engine-progress",
  id: 73,
  progress: {
    requestId: "staged-import",
    phase: "installing",
    receivedBytes: 8,
    totalBytes: 8,
  },
});
assert.deepEqual(engine.messages.at(-1), {
  channel: "engine-progress-ack",
  id: 73,
  ok: true,
  error: null,
});
const isolatedInstallStatus = await send("hd_status", "status-during-isolated-install");
assert.equal(isolatedInstallStatus.loading, true);
assert.deepEqual(isolatedInstallStatus.updating, { id: "managed-a", phase: "installing", fallback: null });
const isolatedInstallLookup = request("hd_lookup", "lookup-during-isolated-install");
await tick();
const isolatedInstallLookupMessage = engine.messages.at(-1);
assert.equal(isolatedInstallLookupMessage.message.type, "hd_lookup", "reads reach the engine while an isolated import installs");
engine.emit("message", {
  channel: "engine-response",
  id: isolatedInstallLookupMessage.id,
  response: { type: "hd_lookup_result", requestId: "lookup-during-isolated-install", ok: true, results: [] },
});
assert.equal((await isolatedInstallLookup.promise).ok, true);
assert.match((await send("hd_remove", "remove-during-isolated-install")).error, /busy mutating/);
engine.emit("message", {
  channel: "engine-response",
  id: stagedImportMessage.id,
  response: { type: "hd_import_result", requestId: "staged-import", ok: true },
});
assert.equal((await stagedImport.promise).ok, true);
const idleStatus = request("hd_status", "status-after-import");
await tick();
const idleStatusMessage = engine.messages.at(-1);
assert.equal(idleStatusMessage.message.type, "hd_status", "an idle bridge asks the engine for its own status");
engine.emit("message", {
  channel: "engine-response",
  id: idleStatusMessage.id,
  response: { type: "hd_status_result", requestId: "status-after-import", ok: true, ready: true, loading: false,
    dictionaryCount: 1, generation: 2, storageBackend: "opfs", threaded: true },
});
assert.equal((await idleStatus.promise).updating, undefined, "only the bridge's snapshot reports an import");

// An import inside the live engine (no isolated importer) unloads the committed
// dictionaries first, so its installing phase still refuses reads.
const memoryImport = request("hd_import", "memory-import", {
  importDecision: { action: "replace", target: { id: "replaced-b" } },
});
await tick();
const memoryImportMessage = engine.messages.at(-1);
assert.equal(memoryImportMessage.message.type, "hd_import");
engine.emit("message", {
  channel: "engine-progress",
  id: 74,
  progress: {
    requestId: "memory-import",
    phase: "installing",
    receivedBytes: 8,
    totalBytes: 8,
    fallback: "memory",
  },
});
assert.deepEqual(engine.messages.at(-1), {
  channel: "engine-progress-ack",
  id: 74,
  ok: true,
  error: null,
});
assert.match((await send("hd_lookup", "lookup-during-install")).error, /busy mutating/);
assert.deepEqual((await send("hd_status", "status-during-memory-install")).updating,
  { id: "replaced-b", phase: "installing", fallback: "memory" });
engine.emit("message", {
  channel: "engine-response",
  id: memoryImportMessage.id,
  response: { type: "hd_import_result", requestId: "memory-import", ok: true },
});
assert.equal((await memoryImport.promise).ok, true);

const mutationTypes = [
  "hd_apply_state",
  "hd_reload",
  "hd_remove",
  "hd_custom_save",
  "hd_backup_export",
  "hd_backup_prepare",
  "hd_backup_auto_prepare",
  "hd_backup_auto_cleanup",
  "hd_backup_restore",
  "hd_backup_cancel",
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
    errorCode: "engine-mutating",
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
    errorCode: "engine-mutating",
  });

  engine.emit("message", {
    channel: "engine-response",
    id: mutationMessage.id,
    response: { type: `${type}_result`, requestId, ok: true },
  });
  assert.equal((await mutating).ok, true);
}

const appending = request("hd_custom_append", "concurrent-custom-append");
await tick();
const appendMessage = engine.messages.at(-1);
assert.equal(appendMessage.message.type, "hd_custom_append");
const lookupDuringAppend = request("hd_lookup", "lookup-during-custom-append");
await tick();
const lookupDuringAppendMessage = engine.messages.at(-1);
assert.equal(lookupDuringAppendMessage.message.type, "hd_lookup", "lookups reach the engine while a custom append compiles");
engine.emit("message", { channel: "engine-response", id: lookupDuringAppendMessage.id,
  response: { type: "hd_lookup_result", requestId: "lookup-during-custom-append", ok: true, results: [] } });
assert.equal((await lookupDuringAppend.promise).ok, true);
assert.match((await send("hd_remove", "remove-during-custom-append")).error, /busy mutating/);
assert.match((await send("hd_backup_release", "release-during-custom-append")).error, /busy mutating/);
engine.emit("message", { channel: "engine-response", id: appendMessage.id,
  response: { type: "hd_custom_append_result", requestId: "concurrent-custom-append", ok: true } });
assert.equal((await appending.promise).ok, true);

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
relay = importedRuntime();
const failedSelection = request("hd_lookup", "failed-selection-lookup");
const failedSelectionMutation = request("hd_import", "failed-selection-mutation");
capabilityWorkers.at(-1).emit("message", { channel: "opfs-capability-result", ok: true });
for (const entry of [failedSelection, failedSelectionMutation]) {
  assert.match((await entry.promise).error, /test engine selection failure/);
  assert.equal(entry.responses.length, 1);
}
assert.match((await send("hd_status", "failed-selection-status")).error, /test engine selection failure/);
FakeWorker.creationError = null;

// Shared memory and workers without OPFS access handles (Electron refuses them
// to chrome-extension:// origins) select the pthread worker on IDBFS, not the
// single-thread runtime.
await import(`../extension/offscreen.js?threaded-idbfs=${Date.now()}`);
relay = importedRuntime();
const idbfsLookup = request("hd_lookup", "threaded-idbfs-lookup");
const idbfsStatus = request("hd_status", "threaded-idbfs-status");
await tick();
const engineWorkersBefore = engineWorkers.length;
capabilityWorkers.at(-1).emit("message", {
  channel: "opfs-capability-result", ok: false, error: "createSyncAccessHandle refused",
});
await tick();
assert.equal(engineWorkers.length, engineWorkersBefore + 1);
const idbfsEngine = engineWorkers.at(-1);
assert.match(idbfsEngine.url, /\/engine-worker-idbfs\.js$/u, "a failed OPFS probe selects the IDBFS pthread worker");
const idbfsRequests = idbfsEngine.messages.filter((message) => message.channel === "engine-request");
assert.deepEqual(idbfsRequests.map((entry) => entry.message.type), ["hd_lookup", "hd_status"]);
idbfsEngine.emit("message", {
  channel: "engine-response", id: idbfsRequests[0].id,
  response: { type: "hd_lookup_result", requestId: "threaded-idbfs-lookup", ok: true, results: [], dictionaryCount: 0 },
});
idbfsEngine.emit("message", {
  channel: "engine-response", id: idbfsRequests[1].id,
  response: { type: "hd_status_result", requestId: "threaded-idbfs-status", ok: true, ready: true, loading: false,
    dictionaryCount: 0, generation: 1, storageBackend: "idbfs", threaded: true },
});
assert.equal((await idbfsLookup.promise).ok, true);
assert.deepEqual([(await idbfsStatus.promise).storageBackend, (await idbfsStatus.promise).threaded], ["idbfs", true]);

// Exercise the actual offscreen settlement boundary, not just the scheduler:
// an order-only reply must neither request a recycle nor cancel a pending one.
mock.timers.enable({ apis: ["setTimeout"] });
try {
  configuredLowMemory = true;
  await import(`../extension/offscreen.js?order-only-recycle=${Date.now()}`);
  relay = importedRuntime();
  capabilityWorkers.at(-1).emit("message", { channel: "opfs-capability-result", ok: true });
  await tick();
  const originalWorkerCount = engineWorkers.length;
  assert.equal(engineWorkers.at(-1).name, "hoshidicts-engine:low-memory");
  const settle = async (type, fields = {}) => {
    const pending = request(type, `recycle-${type}`);
    await tick();
    const worker = engineWorkers.at(-1);
    worker.emit("message", { channel: "engine-response", id: worker.messages.at(-1).id,
      response: { type: `${type}_result`, ok: true, ...fields } });
    assert.equal((await pending.promise).ok, true);
  };
  await settle("hd_apply_state", { loadPath: "order-only" });
  mock.timers.tick(2500);
  assert.equal(engineWorkers.length, originalWorkerCount, "pure order does not schedule a deferred rebuild");

  await settle("hd_import");
  mock.timers.tick(1900);
  await settle("hd_apply_state", { loadPath: "order-only" });
  mock.timers.tick(1900);
  assert.equal(engineWorkers.length, originalWorkerCount, "order activity renews the pending import's idle window");
  mock.timers.tick(100);
  assert.equal(engineWorkers.length, originalWorkerCount + 1, "the pending import recycle still runs");

  relay({ target: "hoshidicts-offscreen", type: "hd_engine_config", relayed: true, lowMemoryMode: false },
    { url: "background.js" }, () => {});
  await settle("hd_apply_state", { loadPath: "order-only" });
  mock.timers.tick(2000);
  assert.equal(engineWorkers.length, originalWorkerCount + 2, "order activity preserves a pending mode change");
  assert.equal(engineWorkers.at(-1).name, "hoshidicts-engine");
} finally {
  configuredLowMemory = false;
  mock.timers.reset();
}

// Hold only the fallback service module. The production bridge is really imported;
// real IDBFS/WASM behavior is covered by extension-smoke and chrome-fallback.
const serviceLoad = Promise.withResolvers();
const serviceLoading = Promise.withResolvers();
const serviceStarted = Promise.withResolvers();
const localRequests = [];
let configured = false;
let started = false;
let statusError = null;
let localReportProgress = null;
globalThis.bridgeFallbackFixture = {
  loading: serviceLoading.resolve,
  loaded: serviceLoad.promise,
  configureEngineService(sender, options) {
    assert.equal(typeof sender, "function");
    assert.equal(typeof options.createHoshidicts, "function");
    assert.equal(options.storageBackend, "idbfs");
    assert.equal(options.lowRam, true);
    localReportProgress = options.reportProgress;
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
  relay = importedRuntime();
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
  const localRelease = request("hd_backup_release", "local-saturated-release");
  await tick();
  assert.equal(localRequests.at(-1).message.type, "hd_backup_release");
  assert.match((await send("hd_backup_release", "local-release-overflow")).error, /queue is full/);
  localRequests.pop().resolve({ type: "hd_backup_release_result", ok: true });
  assert.equal((await localRelease.promise).ok, true);
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

  const localImport = request("hd_import", "local-staged-import");
  await tick();
  assert.equal(localRequests[0].message.type, "hd_import");
  const localStagedStatus = await send("hd_status", "local-staged-status");
  assert.equal(localStagedStatus.loading, true);
  const localStagedLookup = request("hd_lookup", "local-staged-lookup");
  await tick();
  assert.equal(localRequests[1].message.type, "hd_lookup");
  localRequests[1].resolve({ type: "hd_lookup_result", requestId: "local-staged-lookup", ok: true });
  localRequests.splice(1, 1);
  assert.equal((await localStagedLookup.promise).ok, true);
  assert.match((await send("hd_remove", "local-remove-during-staging")).error, /busy mutating/);
  localReportProgress({
    requestId: "local-staged-import",
    phase: "installing",
    receivedBytes: 8,
    totalBytes: 8,
    fallback: "memory",
  });
  assert.match((await send("hd_lookup", "local-lookup-during-install")).error, /busy mutating/);
  assert.deepEqual((await send("hd_status", "local-status-during-install")).updating,
    { id: null, phase: "installing", fallback: "memory" });
  localRequests.shift().resolve({
    type: "hd_import_result",
    requestId: "local-staged-import",
    ok: true,
  });
  assert.equal((await localImport.promise).ok, true);

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
    const localBusyLookup = request("hd_lookup", "local-busy-lookup");
    await tick();
    assert.equal(localRequests.length, 2);
    const lookupEntry = localRequests.pop();
    assert.equal(lookupEntry.message.type, "hd_lookup");
    lookupEntry.resolve({ type: "hd_lookup_result", requestId: "local-busy-lookup", ok: true });
    assert.equal((await localBusyLookup.promise).ok, true);
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
