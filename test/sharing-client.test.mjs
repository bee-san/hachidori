// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createSharingClient } from "../extension/sharing-client.js";
import { LINKED_ANKI_CAPABILITY } from "../extension/sharing-protocol.js";

class Socket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    Socket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text) { this.sent.push(JSON.parse(text)); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

function hello(capabilities = []) {
  return {
    kind: "hello",
    protocol: 1,
    version: "1.0.0",
    name: "Chrome",
    dictionaryCount: 1,
    capabilities,
    snapshot: {},
  };
}

async function linked(capabilities) {
  Socket.instances.length = 0;
  const client = createSharingClient({
    WebSocket: Socket,
    applyBatch: async () => {},
    version: "1.0.0",
    name: "Brave",
  });
  client.link("ws://127.0.0.1:8771/link");
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hello(capabilities));
  await Promise.resolve();
  return { client, socket };
}

test("an old host keeps dictionary sharing but refuses capability-gated Anki requests before send", async () => {
  const { client, socket } = await linked([]);
  await assert.rejects(client.forward({
    target: "hachidori-anki", type: "hd_anki_status", requestId: "status",
  }, { capability: LINKED_ANKI_CAPABILITY }), /does not support host-owned Anki mining/u);
  assert.equal(socket.sent.some(frame => frame.kind === "request"), false);

  const lookup = client.forward({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "lookup", text: "猫" });
  const request = socket.sent.find(frame => frame.kind === "request");
  socket.receive({ kind: "reply", id: request.id, response: { ok: true, results: [] } });
  assert.deepEqual(await lookup, { ok: true, results: [] });
});

test("a capability-gated request reports whether its frame was sent", async () => {
  const { client, socket } = await linked([LINKED_ANKI_CAPABILITY]);
  let sent = false;
  const pending = client.forward({
    target: "hachidori-anki", type: "hd_anki_submit", requestId: "submit", request: {}, clientMedia: {},
  }, { capability: LINKED_ANKI_CAPABILITY, onSent: () => { sent = true; } });
  assert.equal(sent, true);
  socket.drop();
  await assert.rejects(pending, /not reachable/u);
  assert.equal(sent, true);
});

test("switching linked hosts rejects requests and connection waiters owned by the old address", async () => {
  const { client, socket } = await linked([LINKED_ANKI_CAPABILITY]);
  const request = client.forward({
    target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "lookup", text: "猫",
  });
  client.link("ws://127.0.0.1:9000/link");
  await assert.rejects(request, /not reachable/u);
  assert.equal(socket.readyState, 3);
  assert.equal(Socket.instances.at(-1).url, "ws://127.0.0.1:9000/link");

  const waiting = client.forward({
    target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "waiting", text: "犬",
  });
  client.link("ws://127.0.0.1:9001/link");
  await assert.rejects(waiting, /not reachable/u);
  assert.equal(Socket.instances.at(-1).url, "ws://127.0.0.1:9001/link");
});
