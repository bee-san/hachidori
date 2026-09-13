// A plain Node WebSocket server around extension/sharing-relay.js, standing in
// for the relay GameSentenceMiner runs. Used by the relay unit test and the
// two-browser sharing suite; not shipped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { EXTENSION_ORIGIN_PREFIX, HOST_PATH, LINK_PATH } from "../extension/sharing-protocol.js";
import { createSharingRelay } from "../extension/sharing-relay.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

export function encodeFrame(opcode, payload) {
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

function refuse(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// Resolves with `{ port, relay, close() }` once the server listens on 127.0.0.1.
export async function startSharingRelayServer({ port = 0, pingMs = 20_000 } = {}) {
  let relay = null;
  const server = createServer((request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Hachidori sharing relay\n");
  });
  const sockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    const path = String(request.url ?? "").split("?")[0];
    const origin = request.headers.origin;
    if (path !== HOST_PATH && path !== LINK_PATH) return refuse(socket, "404 Not Found");
    if (typeof origin !== "string" || !origin.startsWith(EXTENSION_ORIGIN_PREFIX)) return refuse(socket, "403 Forbidden");
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") return refuse(socket, "400 Bad Request");
    // A linked browser is refused while no host is connected; it retries later.
    if (path === LINK_PATH && !relay.hasHost) return refuse(socket, "503 Service Unavailable");
    let closed = false;
    const endpoint = {
      send(text) {
        if (!closed && !socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
      },
      close() {
        if (closed) return;
        closed = true;
        socket.write(encodeFrame(0x8, Buffer.alloc(0)), () => socket.end());
        setTimeout(() => socket.destroy(), 500).unref();
      },
    };
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {});
    // A second host is told why and closed; a client that lost the host between
    // the check above and here is simply closed.
    const handlers = path === HOST_PATH ? relay.connectHost(endpoint) : relay.connectClient(endpoint, origin);
    socket.on("close", () => {
      sockets.delete(socket);
      handlers?.closed();
    });
    if (handlers === null) {
      endpoint.close();
      return undefined;
    }
    let buffer = Buffer.alloc(0);
    let fragments = [];
    const receive = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (true) {
        const frame = readFrame(buffer);
        if (frame === null) return;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x1 || frame.opcode === 0x0) {
          fragments.push(frame.payload);
          if (frame.fin) {
            handlers.message(Buffer.concat(fragments).toString("utf8"));
            fragments = [];
          }
        } else if (frame.opcode === 0x8) {
          endpoint.close();
          return;
        } else if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
        }
      }
    };
    socket.on("data", receive);
    if (head.length > 0) receive(head);
    return undefined;
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  relay = createSharingRelay({ port: server.address().port });
  const pinger = setInterval(() => relay.ping(), pingMs);
  return {
    port: server.address().port,
    relay,
    close() {
      clearInterval(pinger);
      for (const socket of sockets) socket.destroy();
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
