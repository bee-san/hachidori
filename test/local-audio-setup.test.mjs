// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM || new URL("./tooling/", import.meta.url).pathname] }));

const sourceUrl = "http://127.0.0.1:5050/?term={term}&reading={reading}";
const info = { lookupMode: "sqlite", sources: ["fixture"], audioPack: null };

test("canonical local audio rows are exact, ordered option records", async () => {
  const { createLocalAudioSource, findLocalAudioSource } = await import("../extension/local-audio-source.js");
  const source = createLocalAudioSource("local-audio");
  assert.deepEqual(source, { id: "local-audio", type: "custom-json", enabled: true, url: sourceUrl, voice: "" });
  assert.equal(findLocalAudioSource([{ ...source, enabled: false }])?.id, "local-audio");
  assert.equal(findLocalAudioSource([{ ...source, type: "custom" }]), null);
  assert.equal(findLocalAudioSource([{ ...source, url: "http://localhost:5050/?term={term}&reading={reading}" }]), null);
});

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
  const pill = () => [el("anki-audio-pill").textContent, el("anki-audio-pill").dataset.state];
  controller.render();
  assert.equal(checks, 0);
  assert.deepEqual(pill(), ["Not detected", "offline"]);
  el("anki-audio-check").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(edits.length, 0);
  assert.equal(el("anki-audio-add").hidden, false);
  assert.deepEqual(pill(), ["Ready", "connected"]);
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
  const added = sources[1];
  sources = original;
  controller.render();
  assert.match(el("anki-audio-status").textContent, /Found local audio/u);
  sources = [...original, { ...added, enabled: true }];
  controller.cancel();
  controller.render();
  assert.deepEqual(pill(), ["Ready", "connected"], "an enabled configured source is ready without a fresh check");
});

test("linked clients cannot detect or add a source on the wrong machine", async t => {
  const { createLocalAudioSetup } = await import("../extension/local-audio-setup.js");
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  let linked = false;
  let resolve;
  let signal;
  const controller = createLocalAudioSetup({ document: dom.window.document, readSources: () => [],
    isLinked: () => linked, editSources: () => assert.fail("unexpected edit"),
    detect: options => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
  const el = id => dom.window.document.getElementById(id);
  el("anki-audio-check").click();
  linked = true;
  controller.render();
  assert.equal(signal.aborted, true);
  resolve(sourceUrl);
  await new Promise(done => setImmediate(done));
  assert.equal(el("anki-audio-check").disabled, true);
  assert.equal(el("anki-audio-add").hidden, true);
  assert.match(el("anki-audio-status").textContent, /host/u);
  linked = false;
  controller.render();
  assert.equal(el("anki-audio-check").disabled, false);
});

test("cancel and pagehide retire a check before late replies; retry stays usable", async t => {
  const { createLocalAudioSetup } = await import("../extension/local-audio-setup.js");
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const calls = [];
  createLocalAudioSetup({ document: dom.window.document, readSources: () => [], editSources: () => assert.fail("unexpected edit"),
    detect: ({ signal }) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject })) });
  const el = id => dom.window.document.getElementById(id);
  el("anki-audio-check").click();
  el("anki-audio-check").click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  el("anki-audio-check").click();
  calls[0].resolve(sourceUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el("anki-audio-add").hidden, true);
  calls[1].reject(new Error("Unavailable. Retry."));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(el("anki-audio-status").textContent, /Unavailable/u);
  el("anki-audio-check").click();
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve(sourceUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el("anki-audio-add").hidden, true);
  el("anki-audio-check").click();
  calls[3].resolve(sourceUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el("anki-audio-add").hidden, false);
});

test("discovery rejects unavailable, malformed and unsupported services and bounds response bodies", async () => {
  const { detectLocalAudioSource } = await import("../extension/local-audio-setup.js");
  for (const response of [new Response("", { status: 503 }), new Response("not json"), Response.json({ status: "ok" }),
    Response.json({ ...info, sources: [123] })]) {
    await assert.rejects(detectLocalAudioSource({ fetch: async () => response }), /No compatible/u);
  }
  await assert.rejects(detectLocalAudioSource({ fetch: async () => { throw new TypeError("connection refused"); } }), /No compatible/u);
  let calls = 0;
  await assert.rejects(detectLocalAudioSource({ fetch: async () => Response.json(++calls === 1 ? info : { unexpected: true }) }), /No compatible/u);
  for (const stallAt of [1, 2]) {
    let count = 0;
    await assert.rejects(detectLocalAudioSource({ timeoutMs: 10, fetch: async (_url, { signal }) => {
      if (++count !== stallAt) return Response.json(info);
      return { ok: true, json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
    } }), /No compatible/u);
    assert.equal(count, stallAt);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(detectLocalAudioSource({ signal: controller.signal, fetch: async (_url, { signal }) => {
    signal.throwIfAborted();
  } }), /cancelled/u);
});
