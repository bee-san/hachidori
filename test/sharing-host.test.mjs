// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createSharingHost } from "../extension/sharing-host.js";

class Socket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    Socket.instances.push(this);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const clientFrame = (clientId, frame) => ({
  kind: "client-text",
  clientId,
  text: JSON.stringify(frame),
});
const replies = socket => socket.sent
  .filter(frame => frame.kind === "send")
  .map(frame => JSON.parse(frame.text))
  .filter(frame => frame.kind === "reply");

test("a request from a retired relay client cannot reply into a replacement session", async () => {
  Socket.instances.length = 0;
  let releaseOld;
  const host = createSharingHost({
    WebSocket: Socket,
    alarms: { clear() {}, create() {} },
    dispatch: message => message.type === "held"
      ? new Promise(resolve => { releaseOld = resolve; })
      : Promise.resolve({ ok: true, type: message.type }),
    readSnapshot: async () => ({ dictionaryState: { dictionaries: [{}] } }),
    sharedKey: () => true,
    version: "1.0.0",
    name: "Chrome",
  });

  host.enable({ port: 8771, dictionaries: 1 });
  const oldSocket = Socket.instances[0];
  oldSocket.receive({ kind: "client-open", clientId: "client-1", address: "127.0.0.1" });
  oldSocket.receive(clientFrame("client-1", {
    kind: "request",
    id: "old",
    message: { target: "hoshidicts-offscreen", type: "held" },
  }));
  await tick();
  assert.equal(typeof releaseOld, "function");

  host.enable({ port: 9000, dictionaries: 1 });
  const currentSocket = Socket.instances[1];
  currentSocket.receive({ kind: "client-open", clientId: "client-1", address: "127.0.0.1" });
  releaseOld({ ok: true, owner: "old" });
  await tick();
  assert.deepEqual(replies(currentSocket), []);

  currentSocket.receive(clientFrame("client-1", {
    kind: "request",
    id: "current",
    message: { target: "hoshidicts-offscreen", type: "fresh" },
  }));
  await tick();
  assert.deepEqual(replies(currentSocket), [{
    kind: "reply",
    id: "current",
    response: { ok: true, type: "fresh" },
  }]);
});
