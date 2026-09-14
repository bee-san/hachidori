// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SHARING_PORT, browserName, formatHostAddress, formatLinkAddress, forwardableRequest,
  parseClientFrame, parseHostFrame, parseLinkAddress,
} from "../extension/sharing-protocol.js";

test("link addresses take a host, host:port or a ws:// URL, and say where that is", () => {
  const local = { host: "127.0.0.1", port: DEFAULT_SHARING_PORT, address: `ws://127.0.0.1:${DEFAULT_SHARING_PORT}/link`, display: "this computer" };
  assert.deepEqual(parseLinkAddress(""), local);
  assert.deepEqual(parseLinkAddress("localhost"), local);
  assert.deepEqual(parseLinkAddress("ws://[::1]:8771/"), local);
  assert.deepEqual(parseLinkAddress(" ws://127.0.0.1:9000/link "), { host: "127.0.0.1", port: 9000, address: "ws://127.0.0.1:9000/link", display: "this computer" });
  assert.deepEqual(parseLinkAddress("100.75.152.75"), { host: "100.75.152.75", port: DEFAULT_SHARING_PORT, address: "ws://100.75.152.75:8771/link", display: "100.75.152.75" });
  assert.deepEqual(parseLinkAddress("192.168.1.20:9000"), { host: "192.168.1.20", port: 9000, address: "ws://192.168.1.20:9000/link", display: "192.168.1.20:9000" });
  assert.deepEqual(parseLinkAddress("ws://bee-desktop:8771/link"), { host: "bee-desktop", port: DEFAULT_SHARING_PORT, address: "ws://bee-desktop:8771/link", display: "bee-desktop" });
  assert.equal(formatLinkAddress({ port: 9003 }), "ws://127.0.0.1:9003/link");
  assert.equal(formatLinkAddress({ host: "10.0.0.2", port: 9003 }), "ws://10.0.0.2:9003/link");
  assert.equal(formatHostAddress({ port: 9003 }), "ws://127.0.0.1:9003/host");
  assert.equal(formatHostAddress(), `ws://127.0.0.1:${DEFAULT_SHARING_PORT}/host`);
  for (const bad of ["http://127.0.0.1:8771/link", "wss://100.75.152.75/link", "ws://127.0.0.1:8771/other", "ws://", "ws://:9000"]) {
    assert.throws(() => parseLinkAddress(bad), /Enter the address shown under Sharing on the other computer/u, bad);
  }
});

test("a browser names itself by its brand", () => {
  const brands = (...names) => ({ userAgentData: { brands: names.map(brand => ({ brand, version: "150" })) } });
  assert.equal(browserName(brands("Not A(Brand", "Chromium", "Google Chrome")), "Google Chrome");
  assert.equal(browserName(brands("Chromium", "Not=A?Brand")), "Chromium");
  assert.equal(browserName(brands("Microsoft Edge", "Not;A=Brand", "Chromium")), "Microsoft Edge");
  assert.equal(browserName(brands()), "another browser");
  assert.equal(browserName({}), "another browser");
  assert.equal(browserName(undefined), "another browser");
});

test("only plain-message requests forward; blob imports stay local", () => {
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "猫" }), true);
  assert.equal(forwardableRequest({ target: "hoshidicts-worker", type: "hd_options_write" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-updates", type: "hd_updates_check" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-setup", type: "hd_setup_install", sourceIds: [] }), true);
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_maturity" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_submit" }), false);
  assert.equal(forwardableRequest({ target: "hachidori-audio", type: "hd_audio_play" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_backup_export" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", blobUrl: "blob:x" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", archiveUrl: "https://example.com/a.zip" }), true);
  assert.equal(forwardableRequest(null), false);
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
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", name: "Chrome", dictionaryCount: "5", snapshot })),
    { kind: "hello", version: "0.1.0", name: "Chrome", dictionaryCount: 5, snapshot });
  assert.equal(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, snapshot })).name, "");
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "reply", id: "a", response: { ok: true } })), { kind: "reply", id: "a", response: { ok: true } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "storage", changes: { options: null } })), { kind: "storage", changes: { options: null } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "ping" })), { kind: "ping" });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "bye", reason: "old" })), { kind: "bye", reason: "old" });
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "storage", changes: [] })), /malformed sharing storage frame/u);
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "nope" })), /unknown sharing frame/u);
});
