/*
 * Bridges Chrome runtime messages to the Hoshidicts engine.
 *
 * Browsers with pthread and OPFS support use the dedicated worker. Other
 * browsers use the single-thread IDBFS compatibility runtime.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const TARGET = "hoshidicts-offscreen";
const MAX_PENDING_REQUESTS = 128;
const PROBE_TIMEOUT_MS = 10_000;
const MUTATION_TYPES = new Set([
  "hd_import",
  "hd_apply_state",
  "hd_reload",
  "hd_remove",
  "hd_custom_save",
  "hd_custom_append",
]);

function supportsSharedWasmMemory() {
  if (globalThis.crossOriginIsolated !== true
      || typeof globalThis.SharedArrayBuffer !== "function"
      || typeof globalThis.WebAssembly?.Memory !== "function") {
    return false;
  }
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

const CAN_THREAD = supportsSharedWasmMemory();

let worker = null;
let localEngine = null;
let nextRequestId = 0;
let workerError = null;
let activeMutationRequestId = null;
let lastWorkerStatus = {
  ready: false,
  loading: true,
  dictionaryCount: 0,
  generation: 0,
  storageBackend: "opfs",
  threaded: true,
};
const pending = new Map();

if (typeof navigator.storage?.persist === "function") {
  navigator.storage.persist().then(
    (persistent) => {
      if (!persistent) {
        console.warn("hoshidicts: storage is not persistent, Chrome may evict imported dictionaries");
      }
    },
    (error) => console.warn(`hoshidicts: navigator.storage.persist() failed: ${describe(error)}`),
  );
}

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function failedResponse(message, error) {
  return {
    type: `${message?.type || "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error,
  };
}

function failWorker(error) {
  if (workerError !== null) return;
  workerError = describe(error) || "the Hoshidicts engine worker stopped";
  activeMutationRequestId = null;
  console.error(`hoshidicts: engine worker failed: ${workerError}`);
  for (const [id, request] of pending) {
    pending.delete(id);
    request.sendResponse(failedResponse(request.message, workerError));
  }
}

function probeDirectOpfs() {
  return new Promise((resolve) => {
    let probe = null;
    let timer = null;
    let settled = false;
    const finish = (ok, error = "") => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      probe?.terminate();
      resolve({ ok, error });
    };
    try {
      probe = new Worker(new URL("./opfs-capability-worker.js", import.meta.url), {
        type: "module",
        name: "hoshidicts-opfs-capability",
      });
      probe.addEventListener("error", (event) => finish(false, describe(event.error || event.message)));
      probe.addEventListener("messageerror", () => finish(false, "the OPFS capability worker sent an unreadable message"));
      probe.addEventListener("message", (event) => {
        if (event.data?.channel !== "opfs-capability-result") return;
        finish(event.data.ok === true, describe(event.data.error || ""));
      });
      timer = setTimeout(() => finish(false, "the OPFS capability probe timed out"), PROBE_TIMEOUT_MS);
      probe.postMessage({ channel: "opfs-capability-probe" });
    } catch (error) {
      finish(false, describe(error));
    }
  });
}

async function shouldUseThreadedEngine() {
  if (!CAN_THREAD || typeof globalThis.Worker !== "function"
      || typeof navigator.storage?.getDirectory !== "function") {
    return false;
  }
  const result = await probeDirectOpfs();
  if (!result.ok) {
    console.warn(`hoshidicts: direct OPFS is unavailable, using IDBFS: ${result.error}`);
  }
  return result.ok;
}

function startWorkerEngine() {
  worker = new Worker(new URL("./engine-worker.js", import.meta.url), {
    type: "module",
    name: "hoshidicts-engine",
  });
  worker.addEventListener("error", (event) => failWorker(event.error || event.message));
  worker.addEventListener("messageerror", () => failWorker("the engine worker sent an unreadable message"));
  worker.onmessage = (event) => {
    const data = event.data;
    if (data?.channel === "host-request") {
      Promise.resolve(chrome.runtime.sendMessage(data.message)).then(
        (response) => worker.postMessage({ channel: "host-response", id: data.id, ok: true, response }),
        (error) => worker.postMessage({ channel: "host-response", id: data.id, ok: false, error: describe(error) }),
      );
      return;
    }
    if (data?.channel !== "engine-response") return;
    const request = pending.get(data.id);
    if (request === undefined) return;
    pending.delete(data.id);
    if (data.id === activeMutationRequestId) activeMutationRequestId = null;
    if (data.response?.type === "hd_status_result") {
      lastWorkerStatus = {
        ready: data.response.ready === true,
        loading: data.response.loading === true,
        dictionaryCount: Number(data.response.dictionaryCount) || 0,
        generation: Number(data.response.generation) || 0,
        storageBackend: "opfs",
        threaded: true,
      };
    }
    request.sendResponse(data.response);
  };
}

function startLocalEngine() {
  localEngine = Promise.all([
    import("./engine-service.js"),
    import("./vendor/hoshidicts.mjs"),
  ]).then(([service, module]) => {
    service.configureEngineService(
      (message) => chrome.runtime.sendMessage(message),
      {
        createHoshidicts: module.default,
        storageBackend: "idbfs",
        lowRam: true,
      },
    );
    service.startEngine();
    return service;
  });
}

const engineSelection = shouldUseThreadedEngine().then((threaded) => {
  if (threaded) startWorkerEngine();
  else startLocalEngine();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET || message.relayed !== true) {
    return false;
  }

  engineSelection.then(() => {
    if (worker === null) {
      return localEngine.then((service) => service.handleEngineMessage(message)).then(sendResponse);
    }
    if (workerError !== null) {
      sendResponse(failedResponse(message, workerError));
      return undefined;
    }
    if (message?.type === "hd_status"
        && (activeMutationRequestId !== null || pending.size >= MAX_PENDING_REQUESTS)) {
      sendResponse({
        type: "hd_status_result",
        requestId: message.requestId ?? null,
        ok: true,
        error: null,
        ...lastWorkerStatus,
        loading: activeMutationRequestId !== null || lastWorkerStatus.loading,
      });
      return undefined;
    }
    if (activeMutationRequestId !== null) {
      sendResponse(failedResponse(message, "the dictionary engine is busy mutating"));
      return undefined;
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      sendResponse(failedResponse(message, "the dictionary engine request queue is full"));
      return undefined;
    }
    nextRequestId += 1;
    pending.set(nextRequestId, { message, sendResponse });
    if (MUTATION_TYPES.has(message.type)) activeMutationRequestId = nextRequestId;
    worker.postMessage({ channel: "engine-request", id: nextRequestId, message });
    return undefined;
  }).catch((error) => sendResponse(failedResponse(message, describe(error))));
  return true;
});
