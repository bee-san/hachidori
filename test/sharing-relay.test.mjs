// Drives the Anki add-on's relay, extension/anki-relay/server.py run as a
// process, over raw sockets.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";
import { startAnkiRelayServer } from "./anki-relay-server.mjs";

const EXTENSION_ORIGIN = "chrome-extension://hachidorirelaytestextensionid";

function queue() {
  const items = [];
  const waiters = [];
  return {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    next(what = "item", timeoutMs = 5000) {
      if (items.length > 0) return Promise.resolve(items.shift());
      return new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => rejectNext(new Error(`timed out waiting for ${what}`)), timeoutMs);
        waiters.push((item) => { clearTimeout(timer); resolveNext(item); });
      });
    },
  };
}

function encodeClientFrame(opcode, payload) {
  const mask = randomBytes(4);
  let header;
  if (payload.length <= 125) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function readServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { opcode, payload: buffer.subarray(offset, offset + length), length: offset + length };
}

// A minimal WebSocket client: Node's built-in one cannot set the Origin header
// the relay checks.
async function connectClient(t, port, path, origin = EXTENSION_ORIGIN) {
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  const key = randomBytes(16).toString("base64");
  socket.write([
    `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...(origin === null ? [] : [`Origin: ${origin}`]), "", "",
  ].join("\r\n"));
  const frames = queue();
  const closed = new Promise((resolveClose) => socket.once("close", resolveClose));
  let buffer = Buffer.alloc(0);
  let status = null;
  const head = new Promise((resolveHead) => {
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (status === null) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        status = Number(buffer.toString("latin1", 0, end).split(" ")[1]);
        buffer = buffer.subarray(end + 4);
        resolveHead(status);
      }
      while (true) {
        const frame = readServerFrame(buffer);
        if (frame === null) return;
        buffer = buffer.subarray(frame.length);
        frames.push(frame);
      }
    });
  });
  socket.on("error", () => {});
  await head;
  return {
    status,
    closed,
    send(text) { socket.write(encodeClientFrame(0x1, Buffer.from(text, "utf8"))); },
    async json(what = "a frame") {
      const frame = await frames.next(what);
      assert.equal(frame.opcode, 0x1, `expected a text frame, got opcode ${frame.opcode}`);
      return JSON.parse(frame.payload.toString("utf8"));
    },
    async closeFrame() {
      let frame = await frames.next("a close frame");
      while (frame.opcode !== 0x8) frame = await frames.next("a close frame");
      return frame;
    },
    close() { socket.write(encodeClientFrame(0x8, Buffer.alloc(0))); },
    destroy() { socket.destroy(); },
  };
}

async function untilKind(client, kind) {
  let frame = await client.json(`a ${kind} frame`);
  while (frame.kind !== kind) frame = await client.json(`a ${kind} frame`);
  return frame;
}

async function server(t) {
  const started = await startAnkiRelayServer({ pingMs: 50 });
  t.after(() => started.close());
  return started;
}

const listening = (port) => ({ kind: "listening", port });

test("clients are refused until a host connects, and a second host is turned away", async (t) => {
  const { port } = await server(t);
  assert.equal((await connectClient(t, port, "/link")).status, 503);
  assert.equal((await connectClient(t, port, "/host", "https://example.com")).status, 403);
  assert.equal((await connectClient(t, port, "/host", null)).status, 403);
  assert.equal((await connectClient(t, port, "/elsewhere")).status, 404);
  const host = await connectClient(t, port, "/host");
  assert.equal(host.status, 101);
  assert.deepEqual(await host.json(), listening(port));
  const second = await connectClient(t, port, "/host");
  assert.equal(second.status, 101);
  assert.deepEqual(await second.json(), { kind: "listen-failed", error: "Another browser on this computer is already sharing through Anki." });
  await second.closeFrame();
  const client = await connectClient(t, port, "/link");
  assert.equal(client.status, 101);
  const opened = await untilKind(host, "client-open");
  assert.equal(opened.origin, EXTENSION_ORIGIN);
});

test("text crosses the relay whole in both directions, with pings on both sides", async (t) => {
  const { port } = await server(t);
  const host = await connectClient(t, port, "/host");
  await host.json();
  const first = await connectClient(t, port, "/link");
  const { clientId } = await untilKind(host, "client-open");
  const large = "大きな".repeat(Math.ceil(1.5 * 1024 * 1024 / 3));
  first.send(large);
  const relayed = await untilKind(host, "client-text");
  assert.equal(relayed.clientId, clientId);
  assert.equal(relayed.text, large);
  host.send(JSON.stringify({ kind: "send", clientId, text: JSON.stringify({ kind: "reply", id: "r1", response: { ok: true, text: "reply ✓" } }) }));
  assert.deepEqual(await untilKind(first, "reply"), { kind: "reply", id: "r1", response: { ok: true, text: "reply ✓" } });
  const second = await connectClient(t, port, "/link");
  const secondOpen = await untilKind(host, "client-open");
  host.send(JSON.stringify({ kind: "broadcast", text: JSON.stringify({ kind: "storage", changes: { options: null } }) }));
  const [one, two] = await Promise.all([untilKind(first, "storage"), untilKind(second, "storage")]);
  assert.deepEqual([one, two], [{ kind: "storage", changes: { options: null } }, { kind: "storage", changes: { options: null } }]);
  assert.deepEqual(await untilKind(host, "ping"), { kind: "ping" });
  assert.deepEqual(await untilKind(second, "ping"), { kind: "ping" });
  host.send(JSON.stringify({ kind: "close", clientId: secondOpen.clientId }));
  await second.closeFrame();
  await second.closed;
  const closedFrame = await untilKind(host, "client-close");
  assert.equal(closedFrame.clientId, secondOpen.clientId);
  first.close();
  assert.equal((await untilKind(host, "client-close")).clientId, clientId);
});

test("losing the host closes its clients, and the next host is accepted", async (t) => {
  const { port } = await server(t);
  const host = await connectClient(t, port, "/host");
  await host.json();
  const client = await connectClient(t, port, "/link");
  await untilKind(host, "client-open");
  host.destroy();
  await client.closeFrame();
  await client.closed;
  assert.equal((await connectClient(t, port, "/link")).status, 503, "the lost host is forgotten");
  const next = await connectClient(t, port, "/host");
  assert.deepEqual(await next.json(), listening(port));
});
