/*
 * The relay that stands between a sharing Hachidori (the host) and the
 * browsers linked to it. GameSentenceMiner runs it inside its overlay process,
 * the test suite runs it on a plain Node WebSocket server, and
 * anki-relay/server.py is the same relay in Python for Anki. It knows the
 * envelope kinds and nothing about their contents.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// `port` and `name` ("GameSentenceMiner" or "Anki") are reported to the host so
// its Settings can show the link address and which relay carries it. Every
// socket is represented by `{ send(text), close() }`.
export function createSharingRelay({ port, name }) {
  const clients = new Map();
  let host = null;
  let nextClientId = 0;

  function toHost(frame) {
    host?.send(JSON.stringify(frame));
  }

  return {
    get hasHost() {
      return host !== null;
    },
    get clientCount() {
      return clients.size;
    },
    // Returns the handlers for a new host socket, or null after telling the
    // socket that another Hachidori already shares here.
    connectHost(socket) {
      if (host !== null) {
        socket.send(JSON.stringify({ kind: "listen-failed", error: `Another Hachidori is already sharing through ${name}.` }));
        return null;
      }
      host = socket;
      socket.send(JSON.stringify({ kind: "listening", port, relay: name }));
      return {
        message(text) {
          let frame;
          try {
            frame = JSON.parse(text);
          } catch {
            return;
          }
          switch (frame?.kind) {
            case "send":
              clients.get(frame.clientId)?.send(String(frame.text));
              return;
            case "broadcast":
              for (const client of clients.values()) client.send(String(frame.text));
              return;
            case "close":
              clients.get(frame.clientId)?.close();
              return;
            default:
          }
        },
        closed() {
          if (host !== socket) return;
          host = null;
          for (const client of clients.values()) client.close();
          clients.clear();
        },
      };
    },
    // Returns the handlers for a new linked-browser socket, or null when no
    // host is connected; the caller then refuses the connection so the browser
    // retries later.
    connectClient(socket, origin) {
      if (host === null) return null;
      const id = `client-${++nextClientId}`;
      clients.set(id, socket);
      toHost({ kind: "client-open", clientId: id, origin: String(origin ?? "") });
      return {
        message(text) {
          toHost({ kind: "client-text", clientId: id, text });
        },
        closed() {
          if (!clients.delete(id)) return;
          toHost({ kind: "client-close", clientId: id });
        },
      };
    },
    // Text traffic keeps a Chrome service worker alive; called every 20 s.
    ping() {
      const ping = JSON.stringify({ kind: "ping" });
      host?.send(ping);
      for (const client of clients.values()) client.send(ping);
    },
  };
}
