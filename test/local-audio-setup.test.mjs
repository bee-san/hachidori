// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM || new URL("./tooling/", import.meta.url).pathname] }));

const sourceUrl = "http://127.0.0.1:5050/?term={term}&reading={reading}";
const info = { lookupMode: "sqlite", sources: ["fixture"], audioPack: null };

test("detects the documented local audio service without sending Anki credentials or private terms", async () => {
  const { detectLocalAudioSource } = await import("../extension/local-audio-setup.js");
  const calls = [];
  const source = await detectLocalAudioSource({ fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? info : { type: "audioSourceList", audioSources: [] });
  } });
  assert.equal(source, sourceUrl);
  assert.deepEqual(calls.map(call => call.url), ["http://127.0.0.1:5050/v1/info",
    "http://127.0.0.1:5050/?term=%E7%8C%AB&reading=%E3%81%AD%E3%81%93"]);
  for (const { options } of calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    assert.equal(options.signal.aborted, false);
  }
});

test("Anki setup offers a detected source explicitly and preserves existing sources and disabled duplicates", async t => {
  const { createLocalAudioSetup } = await import("../extension/local-audio-setup.js");
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  let sources = [{ id: "custom", type: "custom", url: "https://example.com/audio", enabled: true, voice: "" }];
  const original = structuredClone(sources);
  const edits = [];
  let checks = 0;
  const controller = createLocalAudioSetup({ document: dom.window.document, readSources: () => sources,
    editSources: value => { sources = value; edits.push(value); },
    detect: async () => { checks++; return sourceUrl; } });
  const el = id => dom.window.document.getElementById(id);
  controller.render();
  assert.equal(checks, 0);
  el("anki-audio-check").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(edits.length, 0);
  assert.equal(el("anki-audio-add").hidden, false);
  el("anki-audio-add").click();
  assert.deepEqual(sources.slice(0, 1), original);
  assert.equal(sources[1].type, "custom-json");
  assert.equal(sources[1].url, sourceUrl);
  assert.equal(sources[1].enabled, true);
  sources[1].enabled = false;
  el("anki-audio-check").click();
  await new Promise(resolve => setImmediate(resolve));
  el("anki-audio-add").click();
  assert.equal(edits.length, 1);
  assert.equal(sources[1].enabled, false);
  assert.match(el("anki-audio-status").textContent, /disabled/u);
});
