// Wire contract shared by the service worker and bridge/hachidori-bridge.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 8771;
export const NATIVE_HOST_NAME = "com.hachidori.bridge";
export const LINK_PATH = "/link";
export const EXTENSION_ORIGIN_PREFIX = "chrome-extension://";

// Chrome accepts at most 1 MB per message from a native host. JSON escaping
// can expand one UTF-16 code unit to six bytes, so a part this long always
// fits with its envelope.
export const NATIVE_PART_CHARS = 160 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Which runtime messages a linked client sends to the host instead of its own
// engine or worker. Everything else stays local: audio, Anki mining, capture,
// page zoom, external links, setup, local-file imports and backups.
export const FORWARDED_REQUESTS = {
  "hoshidicts-offscreen": new Set([
    "hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_styles", "hd_media", "hd_status",
    "hd_custom_append", "hd_custom_save", "hd_apply_state", "hd_reload", "hd_remove", "hd_import",
  ]),
  "hoshidicts-worker": new Set([
    "hd_state_read", "hd_state_cas", "hd_custom_read", "hd_custom_cas", "hd_options_write",
    "hd_lookup_stats_read", "hd_lookup_stats_record",
  ]),
  "hachidori-updates": new Set(["hd_updates_schedule", "hd_updates_check", "hd_updates_install"]),
  "hachidori-anki": new Set(["hd_anki_maturity"]),
};

export function forwardableRequest(message) {
  if (!message || typeof message !== "object") return false;
  const types = FORWARDED_REQUESTS[message.target];
  if (!types || !types.has(message.type)) return false;
  // A blob: URL only resolves inside the browser that created it; the host can
  // download an archive itself.
  if (message.type === "hd_import") return typeof message.archiveUrl === "string" && message.blobUrl === undefined;
  return true;
}

export function formatLinkAddress({ port = DEFAULT_BRIDGE_PORT } = {}) {
  return `ws://127.0.0.1:${port}${LINK_PATH}`;
}

export function parseLinkAddress(text) {
  const trimmed = String(text ?? "").trim();
  const withScheme = trimmed === "" ? formatLinkAddress() : trimmed.includes("://") ? trimmed : `ws://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Enter an address like ${formatLinkAddress()}.`);
  }
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("A shared Hachidori can only be reached through ws:// on this computer.");
  }
  if (!["", "/", LINK_PATH].includes(url.pathname)) {
    throw new Error(`The address path must be ${LINK_PATH}.`);
  }
  const port = url.port === "" ? DEFAULT_BRIDGE_PORT : Number(url.port);
  return { port, address: formatLinkAddress({ port }) };
}

export function splitNativeText(text, limit = NATIVE_PART_CHARS) {
  const parts = [];
  for (let offset = 0; offset < text.length; offset += limit) parts.push(text.slice(offset, offset + limit));
  return parts.length === 0 ? [""] : parts;
}

// Reassembles the parts of one WebSocket text frame relayed over the native
// port. Returns the complete text once the last part of an id has arrived.
export function createTextAssembler() {
  const pending = new Map();
  return {
    push({ id, index, count, part }) {
      if (typeof part !== "string" || !Number.isInteger(index) || !Number.isInteger(count)
          || index < 0 || index >= count) throw new Error("malformed bridge text part");
      if (count === 1) return part;
      const entry = pending.get(id) ?? { parts: new Array(count), received: 0 };
      pending.set(id, entry);
      if (entry.parts[index] === undefined) entry.received += 1;
      entry.parts[index] = part;
      if (entry.received < count) return null;
      pending.delete(id);
      return entry.parts.join("");
    },
  };
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("malformed sharing frame");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed sharing frame");
  return value;
}

// A frame a client sends to the host.
export function parseClientFrame(text) {
  const frame = parseJsonObject(text);
  switch (frame.kind) {
    case "hello":
      if (frame.protocol !== PROTOCOL_VERSION) throw new Error(`unsupported sharing protocol ${JSON.stringify(frame.protocol)}`);
      return { kind: "hello", version: String(frame.version ?? ""), name: String(frame.name ?? "") };
    case "request":
      if (!frame.message || typeof frame.message !== "object" || Array.isArray(frame.message)
          || typeof frame.message.target !== "string" || typeof frame.message.type !== "string"
          || (typeof frame.id !== "string" && typeof frame.id !== "number")) throw new Error("malformed sharing request");
      return { kind: "request", id: frame.id, message: frame.message };
    case "pong":
      return { kind: "pong" };
    default:
      throw new Error(`unknown sharing frame ${JSON.stringify(frame.kind)}`);
  }
}

// A frame the host or bridge sends to a client.
export function parseHostFrame(text) {
  const frame = parseJsonObject(text);
  switch (frame.kind) {
    case "hello":
      if (frame.protocol !== PROTOCOL_VERSION) throw new Error(`unsupported sharing protocol ${JSON.stringify(frame.protocol)}`);
      if (!frame.snapshot || typeof frame.snapshot !== "object") throw new Error("malformed sharing hello");
      return { kind: "hello", version: String(frame.version ?? ""), dictionaryCount: Number(frame.dictionaryCount) || 0,
        snapshot: frame.snapshot };
    case "reply":
      if (typeof frame.id !== "string" && typeof frame.id !== "number") throw new Error("malformed sharing reply");
      return { kind: "reply", id: frame.id, response: frame.response };
    case "storage":
      if (!frame.changes || typeof frame.changes !== "object" || Array.isArray(frame.changes)) throw new Error("malformed sharing storage frame");
      return { kind: "storage", changes: frame.changes };
    case "ping":
      return { kind: "ping" };
    case "bye":
      return { kind: "bye", reason: String(frame.reason ?? "") };
    default:
      throw new Error(`unknown sharing frame ${JSON.stringify(frame.kind)}`);
  }
}
