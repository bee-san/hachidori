/*
 * Host side of sharing: owns the native messaging port to
 * bridge/hachidori-bridge.mjs, the browsers linked through it, and the
 * storage batches pushed to them. Requests arrive as ordinary runtime messages
 * and are answered by the service worker's own handlers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  DEFAULT_BRIDGE_PORT, NATIVE_HOST_NAME, PROTOCOL_VERSION, createTextAssembler, formatLinkAddress, parseClientFrame,
} from "./sharing-protocol.js";

export const SHARING_KEY = "sharing";
export const SHARING_HOST_ALARM = "hachidori-sharing-host";

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

// `dispatch(message, clientId)` answers a forwarded request with the same
// reply object a runtime sender would receive. `readSnapshot()` returns the
// shared storage keys as stored. `sharedKey(key)` says whether a storage
// change belongs to the mirror.
export function createSharingHost({ chrome, alarms, dispatch, readSnapshot, sharedKey, version }) {
  const clients = new Map();
  const assembler = createTextAssembler();
  let enabled = false;
  let configuredPort = DEFAULT_BRIDGE_PORT;
  let port = null;
  let listeningPort = null;
  let error = null;
  let attempt = 0;
  let retryTimer = null;

  function status() {
    const connected = port !== null && listeningPort !== null;
    return {
      enabled,
      connected,
      port: listeningPort ?? configuredPort,
      address: formatLinkAddress({ port: listeningPort ?? configuredPort }),
      clients: [...clients.values()],
      error,
    };
  }

  function post(message) {
    try {
      port?.postMessage(message);
    } catch (postError) {
      console.warn("hachidori: could not reach the sharing bridge:", describe(postError));
    }
  }

  function send(clientId, frame) {
    post({ kind: "send", clientId, text: JSON.stringify(frame) });
  }

  async function handleClientText(clientId, text) {
    let frame;
    try {
      frame = parseClientFrame(text);
    } catch (parseError) {
      send(clientId, { kind: "bye", reason: describe(parseError) });
      post({ kind: "close", clientId });
      return;
    }
    if (frame.kind === "hello") {
      const client = clients.get(clientId);
      if (client) Object.assign(client, { name: frame.name, version: frame.version });
      const snapshot = await readSnapshot();
      const dictionaryCount = Array.isArray(snapshot.dictionaryState?.dictionaries) ? snapshot.dictionaryState.dictionaries.length : 0;
      send(clientId, { kind: "hello", protocol: PROTOCOL_VERSION, version, dictionaryCount, snapshot });
      return;
    }
    if (frame.kind === "request") {
      send(clientId, { kind: "reply", id: frame.id, response: await dispatch(frame.message, clientId) });
    }
  }

  function onNativeMessage(message) {
    switch (message?.kind) {
      case "listening":
        listeningPort = Number(message.port) || configuredPort;
        error = null;
        attempt = 0;
        alarms.clear(SHARING_HOST_ALARM);
        return;
      case "listen-failed":
        error = `The sharing bridge could not listen on port ${configuredPort}: ${message.error}`;
        return;
      case "client-open":
        clients.set(message.clientId, { id: message.clientId, origin: String(message.origin ?? ""), name: "", version: "", connectedAt: Date.now() });
        return;
      case "client-close":
        clients.delete(message.clientId);
        return;
      case "client-text": {
        let text;
        try {
          text = assembler.push(message);
        } catch (partError) {
          console.warn("hachidori: dropped a malformed bridge part:", describe(partError));
          return;
        }
        if (text !== null) void handleClientText(message.clientId, text);
        return;
      }
      default:
        console.warn("hachidori: unknown sharing bridge message", message?.kind);
    }
  }

  function scheduleRetry() {
    if (!enabled || retryTimer !== null) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    alarms.create(SHARING_HOST_ALARM, { periodInMinutes: 1 });
  }

  function connect() {
    if (!enabled || port !== null) return;
    let next;
    try {
      next = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (connectError) {
      error = describe(connectError);
      scheduleRetry();
      return;
    }
    port = next;
    listeningPort = null;
    next.onMessage.addListener(onNativeMessage);
    next.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message;
      if (port !== next) return;
      port = null;
      listeningPort = null;
      clients.clear();
      if (!enabled) return;
      // A failed listen already explains itself better than the exit it causes.
      if (error === null) error = reason || "The sharing bridge stopped.";
      scheduleRetry();
    });
    next.postMessage({ kind: "listen", port: configuredPort });
  }

  return {
    status,
    enable({ port: requestedPort = DEFAULT_BRIDGE_PORT } = {}) {
      enabled = true;
      configuredPort = Number(requestedPort) || DEFAULT_BRIDGE_PORT;
      error = null;
      attempt = 0;
      if (port !== null) {
        port.disconnect();
        port = null;
        listeningPort = null;
        clients.clear();
      }
      connect();
    },
    disable() {
      enabled = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      alarms.clear(SHARING_HOST_ALARM);
      port?.disconnect();
      port = null;
      listeningPort = null;
      clients.clear();
      error = null;
    },
    // The watchdog alarm and worker restarts land here.
    reconnect() {
      if (enabled && port === null && retryTimer === null) connect();
    },
    storageChanged(changes, area) {
      if (area !== "local" || port === null || clients.size === 0) return;
      const shared = Object.entries(changes).filter(([key]) => sharedKey(key));
      if (shared.length === 0) return;
      post({ kind: "broadcast", text: JSON.stringify({
        kind: "storage", changes: Object.fromEntries(shared.map(([key, change]) => [key, change.newValue ?? null])),
      }) });
    },
  };
}
