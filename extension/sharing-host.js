/*
 * Host side of sharing: one outbound WebSocket to the relay GameSentenceMiner
 * runs, the browsers linked through it, and the storage batches pushed to
 * them. Requests arrive as ordinary runtime messages and are answered by the
 * service worker's own handlers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  DEFAULT_SHARING_PORT, PROTOCOL_VERSION, formatHostAddress, formatLinkAddress, parseClientFrame,
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
export function createSharingHost({ WebSocket, alarms, dispatch, readSnapshot, sharedKey, version }) {
  const clients = new Map();
  let enabled = false;
  let configuredPort = DEFAULT_SHARING_PORT;
  let socket = null;
  let listeningPort = null;
  let relayName = null;
  let error = null;
  let attempt = 0;
  let retryTimer = null;

  function status() {
    const connected = socket !== null && listeningPort !== null;
    return {
      enabled,
      connected,
      // Which relay carries the link: "GameSentenceMiner" or "Anki".
      relay: connected ? relayName : null,
      port: listeningPort ?? configuredPort,
      address: formatLinkAddress({ port: listeningPort ?? configuredPort }),
      clients: [...clients.values()],
      error,
    };
  }

  function post(frame) {
    if (socket === null || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (sendError) {
      console.warn("hachidori: could not reach the sharing relay:", describe(sendError));
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

  function onRelayMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      console.warn("hachidori: dropped an unreadable relay message");
      return;
    }
    switch (message?.kind) {
      case "listening":
        listeningPort = Number(message.port) || configuredPort;
        relayName = message.relay;
        error = null;
        attempt = 0;
        alarms.clear(SHARING_HOST_ALARM);
        return;
      case "listen-failed":
        error = String(message.error ?? "The relay refused this Hachidori.");
        return;
      case "client-open":
        clients.set(message.clientId, { id: message.clientId, origin: String(message.origin ?? ""), name: "", version: "", connectedAt: Date.now() });
        return;
      case "client-close":
        clients.delete(message.clientId);
        return;
      case "client-text":
        void handleClientText(message.clientId, String(message.text));
        return;
      case "ping":
        return;
      default:
        console.warn("hachidori: unknown sharing relay message", message?.kind);
    }
  }

  // While the relay is away, retry quickly for as long as this worker lives and
  // once a minute through the alarm after Chrome has put it to sleep.
  function scheduleRetry() {
    if (!enabled || retryTimer !== null) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    alarms.create(SHARING_HOST_ALARM, { delayInMinutes: 1 });
  }

  function connect() {
    if (!enabled || socket !== null) return;
    let next;
    try {
      next = new WebSocket(formatHostAddress({ port: configuredPort }));
    } catch (connectError) {
      error = describe(connectError);
      scheduleRetry();
      return;
    }
    socket = next;
    listeningPort = null;
    next.onmessage = (event) => onRelayMessage(String(event.data));
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      listeningPort = null;
      clients.clear();
      if (enabled) scheduleRetry();
    };
  }

  function dropSocket() {
    const previous = socket;
    socket = null;
    listeningPort = null;
    clients.clear();
    previous?.close();
  }

  return {
    status,
    enable({ port: requestedPort = DEFAULT_SHARING_PORT } = {}) {
      enabled = true;
      configuredPort = Number(requestedPort) || DEFAULT_SHARING_PORT;
      error = null;
      attempt = 0;
      dropSocket();
      connect();
    },
    disable() {
      enabled = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      alarms.clear(SHARING_HOST_ALARM);
      dropSocket();
      error = null;
    },
    // The alarm and worker restarts land here.
    reconnect() {
      if (enabled && socket === null && retryTimer === null) connect();
    },
    storageChanged(changes, area) {
      if (area !== "local" || socket === null || clients.size === 0) return;
      const shared = Object.entries(changes).filter(([key]) => sharedKey(key));
      if (shared.length === 0) return;
      post({ kind: "broadcast", text: JSON.stringify({
        kind: "storage", changes: Object.fromEntries(shared.map(([key, change]) => [key, change.newValue ?? null])),
      }) });
    },
  };
}
