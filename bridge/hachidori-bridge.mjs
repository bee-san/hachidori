#!/usr/bin/env node
/*
 * Native messaging host that gives a sharing Hachidori a loopback WebSocket
 * listener. Chrome starts it when the host extension turns sharing on and it
 * exits when that port closes. It forwards frames in both directions and knows
 * nothing about dictionaries or settings.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { EXTENSION_ORIGIN_PREFIX, LINK_PATH, splitNativeText } from "../extension/sharing-protocol.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PING_MS = Number(process.env.HACHIDORI_BRIDGE_PING_MS) || 20_000;

const clients = new Map();
let nextClientId = 0;
let nextTextId = 0;
let server = null;
let pingTimer = null;
let closing = false;

function log(message) {
  process.stderr.write(`hachidori-bridge: ${message}\n`);
}

/* ------------------------------------------------------------ native port */

function writeNative(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function relayClientText(clientId, text) {
  const parts = splitNativeText(text);
  const id = ++nextTextId;
  parts.forEach((part, index) => writeNative({ kind: "client-text", clientId, id, index, count: parts.length, part }));
}

let inbound = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk]);
  while (inbound.length >= 4) {
    const length = inbound.readUInt32LE(0);
    if (inbound.length < 4 + length) return;
    const text = inbound.subarray(4, 4 + length).toString("utf8");
    inbound = inbound.subarray(4 + length);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("ignoring an unreadable message from the extension");
      continue;
    }
    handleHostMessage(message);
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.stdout.on("error", shutdown);

function handleHostMessage(message) {
  switch (message?.kind) {
    case "listen":
      listen(Number(message.port) || 0);
      return;
    case "send": {
      const client = clients.get(message.clientId);
      if (client) sendText(client, String(message.text));
      return;
    }
    case "broadcast":
      for (const client of clients.values()) sendText(client, String(message.text));
      return;
    case "close": {
      const client = clients.get(message.clientId);
      if (client) closeClient(client);
      return;
    }
    default:
      log(`ignoring an unknown message kind ${JSON.stringify(message?.kind)}`);
  }
}

/* ---------------------------------------------------------- WebSocket side */

function listen(port) {
  if (server !== null) return;
  server = createServer((request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Hachidori sharing bridge\n");
  });
  server.on("upgrade", handleUpgrade);
  server.once("error", (error) => {
    writeNative({ kind: "listen-failed", error: error.message || String(error) });
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    writeNative({ kind: "listening", port: server.address().port });
    pingTimer = setInterval(() => {
      for (const client of clients.values()) sendText(client, JSON.stringify({ kind: "ping" }));
    }, PING_MS);
  });
}

function refuse(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function handleUpgrade(request, socket, head) {
  const origin = request.headers.origin;
  const path = String(request.url ?? "").split("?")[0];
  if (path !== LINK_PATH) return refuse(socket, "404 Not Found");
  if (typeof origin !== "string" || !origin.startsWith(EXTENSION_ORIGIN_PREFIX)) return refuse(socket, "403 Forbidden");
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    return refuse(socket, "400 Bad Request");
  }
  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  const client = { id: `client-${++nextClientId}`, socket, buffer: Buffer.alloc(0), fragments: [], closed: false };
  clients.set(client.id, client);
  socket.setNoDelay(true);
  socket.on("data", (chunk) => receive(client, chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    if (!clients.delete(client.id)) return;
    if (!closing) writeNative({ kind: "client-close", clientId: client.id });
  });
  writeNative({ kind: "client-open", clientId: client.id, origin });
  if (head.length > 0) receive(client, head);
  return undefined;
}

function receive(client, chunk) {
  client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);
  while (true) {
    const frame = readFrame(client.buffer);
    if (frame === null) return;
    client.buffer = client.buffer.subarray(frame.length);
    handleFrame(client, frame);
    if (client.closed) return;
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) return null;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + payloadLength));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { fin, opcode, payload, length: offset + maskLength + payloadLength };
}

function handleFrame(client, frame) {
  switch (frame.opcode) {
    case 0x1:
    case 0x0:
      client.fragments.push(frame.payload);
      if (!frame.fin) return;
      relayClientText(client.id, Buffer.concat(client.fragments).toString("utf8"));
      client.fragments = [];
      return;
    case 0x8:
      closeClient(client);
      return;
    case 0x9:
      client.socket.write(encodeFrame(0xa, frame.payload));
      return;
    default:
      // Pongs and binary frames carry nothing this protocol uses.
  }
}

function encodeFrame(opcode, payload) {
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendText(client, text) {
  if (client.closed || client.socket.destroyed) return;
  client.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
}

function closeClient(client) {
  if (client.closed) return;
  client.closed = true;
  const socket = client.socket;
  socket.write(encodeFrame(0x8, Buffer.alloc(0)), () => socket.end());
  setTimeout(() => socket.destroy(), 500).unref();
}

function shutdown() {
  if (closing) return;
  closing = true;
  if (pingTimer !== null) clearInterval(pingTimer);
  for (const client of clients.values()) closeClient(client);
  clients.clear();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
}
