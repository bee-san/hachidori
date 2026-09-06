/*
 * Bridges Chrome runtime messages to the Hoshidicts engine.
 *
 * Browsers with pthread and OPFS support use the dedicated worker. Other
 * browsers use the single-thread IDBFS compatibility runtime.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { boundResponseFailure } from "./response-limits.js";

const TARGET = "hoshidicts-offscreen";
const AUDIO_TARGET = "hachidori-audio";
let audioService;
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
let engineError = null;
let activeMutationRequestId = null;
let lastEngineStatus = {
  ok: true,
  error: null,
  ready: false,
  loading: true,
  dictionaryCount: 0,
  generation: 0,
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
  return boundResponseFailure({
    type: `${message?.type || "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error,
  });
}

function finishRequest(id, response) {
  const request = pending.get(id);
  if (request === undefined) return;
  pending.delete(id);
  if (id === activeMutationRequestId) activeMutationRequestId = null;
  if (response?.type === "hd_status_result") {
    lastEngineStatus = {
      ...lastEngineStatus,
      ok: response.ok === true,
      error: response.error ?? null,
      ready: response.ready === true,
      loading: response.loading === true,
      dictionaryCount: Number(response.dictionaryCount) || 0,
      generation: Number(response.generation) || 0,
    };
  }
  request.sendResponse(response);
}

function failEngine(error) {
  if (engineError !== null) return;
  engineError = describe(error) || "the Hoshidicts engine stopped";
  console.error(`hoshidicts: engine failed: ${engineError}`);
  for (const [id, request] of pending) {
    finishRequest(id, failedResponse(request.message, engineError));
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
  worker.addEventListener("error", (event) => failEngine(event.error || event.message));
  worker.addEventListener("messageerror", () => failEngine("the engine worker sent an unreadable message"));
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
    finishRequest(data.id, data.response);
  };
}

function startLocalEngine() {
  return Promise.all([
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
    localEngine = service;
  });
}

const engineSelection = shouldUseThreadedEngine().then((threaded) => {
  lastEngineStatus.storageBackend = threaded ? "opfs" : "idbfs";
  lastEngineStatus.threaded = threaded;
  return threaded ? startWorkerEngine() : startLocalEngine();
}).catch(failEngine);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== AUDIO_TARGET || message.relayed !== true) return false;
  audioService ??= import("./audio-offscreen.js").then(module => module.createAudioService(globalThis));
  audioService.then(handle => handle(message)).then(
    result => sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true, ...result }),
    error => sendResponse(failedResponse(message, describe(error))),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET || message.relayed !== true) {
    return false;
  }

  if (engineError !== null) {
    sendResponse(failedResponse(message, engineError));
    return true;
  }
  if (message.type === "hd_status"
      && (activeMutationRequestId !== null || pending.size >= MAX_PENDING_REQUESTS)) {
    sendResponse({
      type: "hd_status_result",
      requestId: message.requestId ?? null,
      ...lastEngineStatus,
      loading: activeMutationRequestId !== null || lastEngineStatus.loading,
    });
    return true;
  }
  if (activeMutationRequestId !== null) {
    sendResponse(failedResponse(message, "the dictionary engine is busy mutating"));
    return true;
  }
  if (pending.size >= MAX_PENDING_REQUESTS) {
    sendResponse(failedResponse(message, "the dictionary engine request queue is full"));
    return true;
  }

  // Reserve before engine selection or module loading can retain the payload.
  const id = ++nextRequestId;
  pending.set(id, { message, sendResponse });
  if (MUTATION_TYPES.has(message.type)) activeMutationRequestId = id;
  engineSelection.then(() => {
    if (!pending.has(id)) return undefined;
    if (worker === null) {
      return localEngine.handleEngineMessage(message).then((response) => finishRequest(id, response));
    }
    worker.postMessage({ channel: "engine-request", id, message });
    return undefined;
  }).catch((error) => finishRequest(id, failedResponse(message, describe(error))));
  return true;
});
