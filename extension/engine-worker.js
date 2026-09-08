/*
 * Dedicated owner of the Hoshidicts WASM runtime.
 *
 * The runtime lives off the browser main thread so Hoshidicts can join pthreads
 * and WasmFS can synchronously proxy OPFS operations without deadlocking an
 * extension page.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  configureEngineService,
  handleEngineMessage,
  startEngine,
} from "./engine-service.js";
import createHoshidicts from "./vendor/hoshidicts-threaded.mjs";
import { boundResponseFailure } from "./response-limits.js";

let nextHostRequestId = 0;
const HOST_REQUEST_TIMEOUT_MS = 30_000;
const pendingHostRequests = new Map();

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function requestHost(message) {
  nextHostRequestId += 1;
  const id = nextHostRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingHostRequests.delete(id)) return;
      reject(new Error("the extension host did not answer the engine worker"));
    }, HOST_REQUEST_TIMEOUT_MS);
    pendingHostRequests.set(id, { resolve, reject, timer });
    globalThis.postMessage({ channel: "host-request", id, message });
  });
}

configureEngineService(requestHost, {
  createHoshidicts,
  storageBackend: "opfs",
  lowRam: false,
  // Fire-and-forget: import phases need no reply and must not wait on one.
  reportProgress: (progress) => globalThis.postMessage({ channel: "engine-progress", progress }),
});
startEngine();

// A dedicated worker receives only from its creator over its implicit
// MessagePort. MessageEvent.origin is always empty, so there is no origin value
// to validate; the channel check below validates the expected protocol.
globalThis.onmessage = (event) => { // NOSONAR
  const data = event.data;
  if (data?.channel === "host-response") {
    const pending = pendingHostRequests.get(data.id);
    if (pending === undefined) return;
    pendingHostRequests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.ok === true) pending.resolve(data.response);
    else pending.reject(new Error(data.error || "host request failed"));
    return;
  }
  if (data?.channel !== "engine-request") return;

  Promise.resolve(handleEngineMessage(data.message)).then(
    (response) => globalThis.postMessage({ channel: "engine-response", id: data.id, response }),
    (error) => globalThis.postMessage({
      channel: "engine-response",
      id: data.id,
      response: boundResponseFailure({
        type: `${data.message?.type || "hd_unknown"}_result`,
        requestId: data.message?.requestId ?? null,
        ok: false,
        error: describe(error),
      }),
    }),
  );
};
