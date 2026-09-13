// Drives the real bridge/hachidori-bridge.mjs process over its native stdio
// port and raw loopback WebSocket connections.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, connect } from "node:net";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_PART_CHARS, createTextAssembler } from "../extension/sharing-protocol.js";

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "hachidori-bridge.mjs");
const EXTENSION_ORIGIN = "chrome-extension://hachidoribridgetestextensionid";

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
    get length() { return items.length; },
  };
}

function startBridge(t, env = {}) {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HACHIDORI_BRIDGE_PING_MS: "50", ...env } });
  const messages = queue();
  let inbound = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    inbound = Buffer.concat([inbound, chunk]);
    while (inbound.length >= 4) {
      const length = inbound.readUInt32LE(0);
      if (inbound.length < 4 + length) return;
      messages.push(JSON.parse(inbound.subarray(4, 4 + length).toString("utf8")));
      inbound = inbound.subarray(4 + length);
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return {
    child,
    exited,
    stderr: () => stderr,
    write(message) {
      const json = Buffer.from(JSON.stringify(message), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(json.length, 0);
      child.stdin.write(Buffer.concat([header, json]));
    },
    next: (what) => messages.next(what),
    async listen(port = 0) {
      this.write({ kind: "listen", port });
      const reply = await messages.next("listening");
      assert.equal(reply.kind, "listening", JSON.stringify(reply));
      return reply.port;
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
// the bridge checks.
async function connectClient(t, port, origin = EXTENSION_ORIGIN, path = "/link") {
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
  const parse = () => {
    while (true) {
      const frame = readServerFrame(buffer);
      if (frame === null) return;
      buffer = buffer.subarray(frame.length);
      frames.push(frame);
    }
  };
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
      parse();
    });
  });
  socket.on("error", () => {});
  await head;
  return {
    status,
    closed,
    send(text) { socket.write(encodeClientFrame(0x1, Buffer.from(text, "utf8"))); },
    async text(what = "a text frame") {
      const frame = await frames.next(what);
      assert.equal(frame.opcode, 0x1, `expected a text frame, got opcode ${frame.opcode}`);
      return frame.payload.toString("utf8");
    },
    async frame(what = "a frame") { return frames.next(what); },
    close() { socket.write(encodeClientFrame(0x8, Buffer.alloc(0))); },
  };
}

test("listens on the requested port, then exits when the extension disconnects", async (t) => {
  const bridge = startBridge(t);
  const port = await bridge.listen(0);
  assert.ok(port > 0);
  bridge.child.stdin.end();
  assert.equal(await bridge.exited, 0, bridge.stderr());
});

test("refuses handshakes that are not from an extension", async (t) => {
  const bridge = startBridge(t);
  const port = await bridge.listen(0);
  assert.equal((await connectClient(t, port, "https://example.com")).status, 403);
  assert.equal((await connectClient(t, port, null)).status, 403);
  assert.equal((await connectClient(t, port, EXTENSION_ORIGIN, "/elsewhere")).status, 404);
  const client = await connectClient(t, port);
  assert.equal(client.status, 101);
  const opened = await bridge.next("client-open");
  assert.equal(opened.kind, "client-open");
  assert.equal(opened.origin, EXTENSION_ORIGIN);
});

test("relays text both ways, splits large frames and pings clients", async (t) => {
  const bridge = startBridge(t);
  const port = await bridge.listen(0);
  const first = await connectClient(t, port);
  const { clientId } = await bridge.next("client-open");

  first.send("hello");
  const small = await bridge.next("client-text");
  assert.deepEqual(small, { kind: "client-text", clientId, id: small.id, index: 0, count: 1, part: "hello" });

  bridge.write({ kind: "send", clientId, text: "reply ✓" });
  assert.equal(await first.text(), "reply ✓");

  const large = "大きな".repeat(Math.ceil(1.5 * 1024 * 1024 / 3));
  first.send(large);
  const assembler = createTextAssembler();
  let assembled = null;
  let parts = 0;
  while (assembled === null) {
    const part = await bridge.next("a large text part");
    assert.equal(part.kind, "client-text");
    assert.ok(part.part.length <= NATIVE_PART_CHARS);
    parts += 1;
    assembled = assembler.push(part);
  }
  assert.equal(parts, Math.ceil(large.length / NATIVE_PART_CHARS));
  assert.equal(assembled, large);

  const second = await connectClient(t, port);
  const secondOpen = await bridge.next("second client-open");
  assert.equal(secondOpen.kind, "client-open");
  bridge.write({ kind: "broadcast", text: "everyone" });
  const [one, two] = await Promise.all([first.text(), second.text()]);
  assert.deepEqual([one, two].map(text => text === "everyone" || text === '{"kind":"ping"}'), [true, true]);

  let ping = await second.text("a ping");
  while (ping !== '{"kind":"ping"}') ping = await second.text("a ping");
  assert.equal(ping, '{"kind":"ping"}');
});

test("closes a client on request and reports clients that leave", async (t) => {
  const bridge = startBridge(t);
  const port = await bridge.listen(0);
  const first = await connectClient(t, port);
  const { clientId } = await bridge.next("client-open");
  bridge.write({ kind: "close", clientId });
  let frame = await first.frame("a close frame");
  while (frame.opcode !== 0x8) frame = await first.frame("a close frame");
  await first.closed;
  assert.deepEqual(await bridge.next("client-close"), { kind: "client-close", clientId });

  const second = await connectClient(t, port);
  const secondOpen = await bridge.next("client-open");
  second.close();
  assert.deepEqual(await bridge.next("client-close"), { kind: "client-close", clientId: secondOpen.clientId });
});

test("disconnecting the extension closes every client", async (t) => {
  const bridge = startBridge(t);
  const port = await bridge.listen(0);
  const client = await connectClient(t, port);
  await bridge.next("client-open");
  bridge.child.stdin.end();
  let frame = await client.frame("a close frame");
  while (frame.opcode !== 0x8) frame = await client.frame("a close frame");
  await client.closed;
  assert.equal(await bridge.exited, 0, bridge.stderr());
});

test("reports a port that is already in use", async (t) => {
  const blocker = createServer();
  await new Promise((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
  t.after(() => blocker.close());
  const bridge = startBridge(t);
  bridge.write({ kind: "listen", port: blocker.address().port });
  const failure = await bridge.next("listen-failed");
  assert.equal(failure.kind, "listen-failed");
  assert.match(failure.error, /EADDRINUSE/u);
  assert.equal(await bridge.exited, 1);
});
