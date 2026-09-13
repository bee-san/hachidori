// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BRIDGE_PORT, NATIVE_PART_CHARS, createTextAssembler, formatLinkAddress, forwardableRequest,
  parseClientFrame, parseHostFrame, parseLinkAddress, splitNativeText,
} from "../extension/sharing-protocol.js";

test("link addresses are loopback ws:// URLs on the /link path", () => {
  assert.deepEqual(parseLinkAddress(""), { port: DEFAULT_BRIDGE_PORT, address: `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/link` });
  assert.deepEqual(parseLinkAddress(" ws://127.0.0.1:9000/link "), { port: 9000, address: "ws://127.0.0.1:9000/link" });
  assert.deepEqual(parseLinkAddress("localhost:9001"), { port: 9001, address: "ws://127.0.0.1:9001/link" });
  assert.deepEqual(parseLinkAddress("ws://[::1]:9002/"), { port: 9002, address: "ws://127.0.0.1:9002/link" });
  assert.equal(formatLinkAddress({ port: 9003 }), "ws://127.0.0.1:9003/link");
  assert.throws(() => parseLinkAddress("http://127.0.0.1:8771/link"), /ws:\/\/ on this computer/u);
  assert.throws(() => parseLinkAddress("ws://example.com:8771/link"), /ws:\/\/ on this computer/u);
  assert.throws(() => parseLinkAddress("ws://127.0.0.1:8771/other"), /path must be \/link/u);
  assert.throws(() => parseLinkAddress("ws://"), /Enter an address/u);
});

test("only plain-message requests forward; blob imports stay local", () => {
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "猫" }), true);
  assert.equal(forwardableRequest({ target: "hoshidicts-worker", type: "hd_options_write" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-updates", type: "hd_updates_check" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_maturity" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_submit" }), false);
  assert.equal(forwardableRequest({ target: "hachidori-audio", type: "hd_audio_play" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_backup_export" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", blobUrl: "blob:x" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", archiveUrl: "https://example.com/a.zip" }), true);
  assert.equal(forwardableRequest(null), false);
});

test("native parts reassemble to the original text", () => {
  const unit = `漢字${String.fromCharCode(0)}"\\`;
  const text = unit.repeat(Math.ceil(NATIVE_PART_CHARS * 2.5 / unit.length));
  const parts = splitNativeText(text);
  assert.equal(parts.length, Math.ceil(text.length / NATIVE_PART_CHARS));
  assert.ok(parts.every(part => part.length <= NATIVE_PART_CHARS));
  const assembler = createTextAssembler();
  let assembled = null;
  parts.forEach((part, index) => {
    assembled = assembler.push({ id: 7, index, count: parts.length, part });
    if (index < parts.length - 1) assert.equal(assembled, null);
  });
  assert.equal(assembled, text);
  assert.equal(createTextAssembler().push({ id: 8, index: 0, count: 1, part: "single" }), "single");
  assert.deepEqual(splitNativeText(""), [""]);
  assert.throws(() => assembler.push({ id: 9, index: 2, count: 2, part: "x" }), /malformed/u);
});

test("frames are validated on both sides", () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", name: "GSM" })),
    { kind: "hello", version: "0.1.0", name: "GSM" });
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "request", id: 3, message: { target: "hoshidicts-offscreen", type: "hd_status" } })),
    { kind: "request", id: 3, message: { target: "hoshidicts-offscreen", type: "hd_status" } });
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "pong" })), { kind: "pong" });
  assert.throws(() => parseClientFrame(JSON.stringify({ kind: "hello", protocol: 2 })), /unsupported sharing protocol/u);
  assert.throws(() => parseClientFrame(JSON.stringify({ kind: "request", id: 1, message: { type: "hd_status" } })), /malformed sharing request/u);
  assert.throws(() => parseClientFrame("[]"), /malformed sharing frame/u);
  assert.throws(() => parseClientFrame("{"), /malformed sharing frame/u);
  const snapshot = { options: { revision: 1 } };
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", dictionaryCount: "5", snapshot })),
    { kind: "hello", version: "0.1.0", dictionaryCount: 5, snapshot });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "reply", id: "a", response: { ok: true } })), { kind: "reply", id: "a", response: { ok: true } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "storage", changes: { options: null } })), { kind: "storage", changes: { options: null } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "ping" })), { kind: "ping" });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "bye", reason: "old" })), { kind: "bye", reason: "old" });
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "storage", changes: [] })), /malformed sharing storage frame/u);
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "nope" })), /unknown sharing frame/u);
});
