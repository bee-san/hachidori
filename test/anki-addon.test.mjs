// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ANKI_ADDON_FILE_NAME, fetchAnkiAddon } from "../extension/anki-addon.js";

test("downloads the pinned Anki release as binary without repackaging it", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
  const requests = [];
  const archive = await fetchAnkiAddon(async url => {
    requests.push(url);
    return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
  });
  assert.deepEqual(requests, ["https://github.com/bee-san/hachidori-anki/releases/download/v0.0.3/hachidori-relay.ankiaddon"]);
  assert.equal(ANKI_ADDON_FILE_NAME, "hachidori-relay.ankiaddon");
  assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), bytes);
});

test("HTTP failures are reported instead of saving the error body as an add-on", async () => {
  await assert.rejects(fetchAnkiAddon(async () => new Response("Not Found", { status: 404 })), /HTTP 404/u);
});

test("network failures reach the Sharing page", async () => {
  const offline = new TypeError("Failed to fetch");
  await assert.rejects(fetchAnkiAddon(async () => { throw offline; }), offline);
});
