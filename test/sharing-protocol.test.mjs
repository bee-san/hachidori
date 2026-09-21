// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SHARING_PORT, LEGACY_LINKED_ANKI_CAPABILITY, LINKED_ANKI_CAPABILITY,
  MAX_LINKED_ANKI_FRAME_BYTES, SHARING_CAPABILITIES,
  allowLinkedAnkiDiscoveryRequest, allowLinkedAnkiRequest, allowLinkedAnkiSetupRequest,
  assertLinkedAnkiFrame, browserName,
  formatHostAddress, formatLinkAddress, forwardableRequest, mutatingForwardedRequest,
  parseClientFrame, parseHostFrame,
  parseLinkAddress,
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
  assert.equal(browserName({ userAgent: "Mozilla/5.0 Firefox/153.0" }), "Firefox");
  assert.equal(browserName({}), "another browser");
  assert.equal(browserName(undefined), "another browser");
});

test("only host-owned plain-message requests forward; screenshots and blob imports stay local", () => {
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "猫" }), true);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_memory" }), true);
  assert.equal(mutatingForwardedRequest({ target: "hoshidicts-offscreen", type: "hd_memory" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-worker", type: "hd_options_write" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-updates", type: "hd_updates_check" }), true);
  assert.equal(forwardableRequest({ target: "hachidori-setup", type: "hd_setup_install", sourceIds: [] }), true);
  for (const type of ["hd_anki_status", "hd_anki_view", "hd_anki_preflight", "hd_anki_submit", "hd_anki_browse", "hd_anki_maturity"]) {
    assert.equal(forwardableRequest({ target: "hachidori-anki", type }), true, type);
  }
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_screenshot" }), false);
  assert.equal(forwardableRequest({ target: "hachidori-anki", type: "hd_anki_screenshot_discard" }), false);
  assert.equal(forwardableRequest({ target: "hachidori-audio", type: "hd_audio_play" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_backup_export" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", blobUrl: "blob:x" }), false);
  assert.equal(forwardableRequest({ target: "hoshidicts-offscreen", type: "hd_import", archiveUrl: "https://example.com/a.zip" }), true);
  assert.equal(forwardableRequest(null), false);
});

test("forwarded mutations are classified at the protocol boundary", () => {
  assert.equal(mutatingForwardedRequest({
    target: "hoshidicts-worker", type: "hd_options_write",
  }), true);
  assert.equal(mutatingForwardedRequest({
    target: "hoshidicts-offscreen", type: "hd_import", archiveUrl: "https://example.com/a.zip",
  }), true);
  assert.equal(mutatingForwardedRequest({
    target: "hachidori-updates", type: "hd_updates_check",
  }), true);
  assert.equal(mutatingForwardedRequest({
    target: "hachidori-anki", type: "hd_anki_submit",
  }), true);
  assert.equal(mutatingForwardedRequest({
    target: "hoshidicts-offscreen", type: "hd_lookup",
  }), false);
  assert.equal(mutatingForwardedRequest({
    target: "hachidori-anki", type: "hd_anki_preflight",
  }), false);
  assert.equal(mutatingForwardedRequest({
    target: "unknown", type: "hd_options_write",
  }), false);
});

test("frames are validated on both sides", () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", name: "GSM",
    capabilities: SHARING_CAPABILITIES })),
  { kind: "hello", version: "0.1.0", name: "GSM", capabilities: [...SHARING_CAPABILITIES] });
  assert.deepEqual(SHARING_CAPABILITIES, [LEGACY_LINKED_ANKI_CAPABILITY, LINKED_ANKI_CAPABILITY]);
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "old", name: "Old" })),
    { kind: "hello", version: "old", name: "Old", capabilities: [] });
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "request", id: 3, message: { target: "hoshidicts-offscreen", type: "hd_status" } })),
    { kind: "request", id: 3, message: { target: "hoshidicts-offscreen", type: "hd_status" } });
  assert.deepEqual(parseClientFrame(JSON.stringify({ kind: "pong" })), { kind: "pong" });
  assert.throws(() => parseClientFrame(JSON.stringify({ kind: "hello", protocol: 2 })), /unsupported sharing protocol/u);
  assert.throws(() => parseClientFrame(JSON.stringify({ kind: "request", id: 1, message: { type: "hd_status" } })), /malformed sharing request/u);
  assert.throws(() => parseClientFrame("[]"), /malformed sharing frame/u);
  assert.throws(() => parseClientFrame("{"), /malformed sharing frame/u);
  const snapshot = { options: { revision: 1 } };
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", name: "Chrome",
    dictionaryCount: "5", capabilities: SHARING_CAPABILITIES, snapshot })),
  { kind: "hello", version: "0.1.0", name: "Chrome", dictionaryCount: 5,
    capabilities: [...SHARING_CAPABILITIES], snapshot });
  assert.equal(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, snapshot })).name, "");
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "hello", protocol: 1, snapshot })).capabilities, []);
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "reply", id: "a", response: { ok: true } })), { kind: "reply", id: "a", response: { ok: true } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "storage", changes: { options: null } })), { kind: "storage", changes: { options: null } });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "ping" })), { kind: "ping" });
  assert.deepEqual(parseHostFrame(JSON.stringify({ kind: "bye", reason: "old" })), { kind: "bye", reason: "old" });
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "storage", changes: [] })), /malformed sharing storage frame/u);
  assert.throws(() => parseHostFrame(JSON.stringify({ kind: "nope" })), /unknown sharing frame/u);
});

test("the host allowlists linked Anki operations and strips endpoint credentials", () => {
  const request = {
    term: { expression: "猫", reading: "ねこ", glossaries: [{ dictionary: "A", glossary: "url stays in dictionary data" }] },
    generation: 3,
    trace: [],
    configKey: "host-config",
    templateId: "sentence",
    dictionaryIds: { A: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    url: "https://client.invalid/anki",
    apiKey: "client-secret",
    anki: { url: "https://client.invalid/anki", apiKey: "client-secret" },
  };
  const media = {};
  assert.deepEqual(allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_view", requestId: 3,
    request: { term: request.term, templateId: "sentence", configKey: "client-key", apiKey: "nope" },
  }), {
    target: "hachidori-anki", type: "hd_anki_view", requestId: 3,
    request: { term: { expression: "猫", reading: "ねこ" }, templateId: "sentence" },
  });
  assert.deepEqual(allowLinkedAnkiRequest({
    target: "hachidori-anki",
    type: "hd_anki_submit",
    requestId: "submit-1",
    url: "https://client.invalid/anki",
    apiKey: "client-secret",
    request,
    clientMedia: media,
  }), {
    target: "hachidori-anki",
    type: "hd_anki_submit",
    requestId: "submit-1",
    request: {
      term: request.term,
      trace: [],
      generation: 3,
      configKey: "host-config",
      dictionaryIds: request.dictionaryIds,
      templateId: "sentence",
    },
    clientMedia: media,
  });
  assert.deepEqual(allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_browse", requestId: 4,
    request: { expression: "猫", noteIds: [1, 2], configKey: "linked:host:key",
      templateId: "sentence", apiKey: "nope" },
  }), {
    target: "hachidori-anki", type: "hd_anki_browse", requestId: 4,
    request: { noteIds: [1, 2], expression: "猫", configKey: "linked:host:key", templateId: "sentence" },
  });
  assert.deepEqual(allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_status", requestId: 5, templateId: "sentence",
  }), {
    target: "hachidori-anki", type: "hd_anki_status", requestId: 5, templateId: "sentence",
  });
  assert.throws(() => allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_status", templateId: "\n",
  }), /Template/u);
  assert.throws(() => allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_status", templateId: "x".repeat(257),
  }), /Template/u);
  assert.throws(() => allowLinkedAnkiRequest({
    target: "hachidori-anki", type: "hd_anki_screenshot", requestId: "capture",
  }), /unsupported linked Anki request/u);
  assert.deepEqual(allowLinkedAnkiDiscoveryRequest({
    target: "hoshidicts-worker",
    type: "hd_anki_discover",
    requestId: "discover-1",
    model: "Basic",
    url: "https://client.invalid/anki",
    apiKey: "client-secret",
  }), {
    target: "hoshidicts-worker",
    type: "hd_anki_discover",
    requestId: "discover-1",
    model: "Basic",
  });
  assert.throws(() => allowLinkedAnkiDiscoveryRequest({
    target: "hoshidicts-worker", type: "hd_anki_discover", model: null,
  }), /unsupported linked Anki discovery request/u);
  assert.throws(() => allowLinkedAnkiDiscoveryRequest({
    target: "hoshidicts-worker", type: "hd_anki_discover", model: "x".repeat(4097),
  }), /unsupported linked Anki discovery request/u);
  assert.deepEqual(allowLinkedAnkiSetupRequest({
    target: "hoshidicts-worker",
    type: "hd_anki_setup",
    requestId: "setup-1",
    templateId: "sentence",
    anki: {
      model: "Client model",
      deck: "Client deck",
      url: "https://client.invalid/anki",
      apiKey: "client-secret",
    },
  }), {
    target: "hoshidicts-worker",
    type: "hd_anki_setup",
    requestId: "setup-1",
    templateId: "sentence",
  });
  assert.throws(() => allowLinkedAnkiSetupRequest({
    target: "hoshidicts-worker", type: "hd_anki_setup", templateId: "\n",
  }), /Template/u);
  assert.throws(() => allowLinkedAnkiSetupRequest({
    target: "hoshidicts-worker", type: "hd_setup_anki",
  }), /unsupported linked Anki setup request/u);
});

test("linked Anki submissions have one 16 MiB UTF-8 frame limit", () => {
  const exact = "x".repeat(MAX_LINKED_ANKI_FRAME_BYTES);
  assert.doesNotThrow(() => assertLinkedAnkiFrame(exact));
  assert.throws(() => assertLinkedAnkiFrame(`${exact}x`), /16 MiB frame limit/u);
  const oversized = JSON.stringify({ kind: "request", id: 1, message: {
    target: "hachidori-anki", type: "hd_anki_submit", clientMedia: { screenshot: { data: exact } },
  } });
  assert.throws(() => parseClientFrame(oversized), /16 MiB frame limit/u);
});
