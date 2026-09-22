// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dom = new JSDOM("<body><p>猫</p></body>", { runScripts: "outside-only", url: "https://reader.example" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const pending = [], released = [];
  window.chrome = { runtime: { id: "test-extension", sendMessage(message, callback) {
    pending.push({ message, callback: reply => callback({ ...reply, type: `${message.type}_result`, requestId: message.requestId }) });
  } } };
  window.HDPopup = { normaliseDictionaryTab: value => value };
  window.HDCapture = { release(pin) { if (pin?.token) released.push(pin.token); } };
  for (const file of ["reader-options.js", "dictionary-group-state.js", "lookup-stats-identity.js", "sentence.js"]) window.eval(extension(file));
  // Expose the production request/lifetime entrypoints; only UI creation and the
  // browser message transport are replaced. Every stale/error branch runs as shipped.
  const marker = "  start();\n}());";
  const source = extension("content.js");
  assert.ok(source.includes(marker));
  window.eval(source.replace(marker, `
  globalThis.driver = {
    resolveCandidate,
    install(pin) {
      uiPromise = Promise.resolve();
      currentGeneration = 1;
      const anchor = document.querySelector("p");
      const candidate = { anchor, query: "猫", sentence: "猫", matchOffset: 0, sentenceSource: "猫",
        sourceElements: [anchor], sourceText: "猫", sourceOffset: 0,
        scanEntries: [{ node: anchor.firstChild, offset: 0, sourceLength: 1, text: "猫" }] };
      highlighter = { clearAll() {}, refresh() {} };
      for (const level of [rootLevel, createLevelState(1)]) {
        if (level !== rootLevel) levels.push(level);
        level.popup = document.createElement("div");
        document.body.append(level.popup);
        level.activeCandidate = candidate;
        level.view = { hideImagePreview() {}, clear() {}, destroy() {}, flushDictionaryPresentation() {} };
      }
      rootLevel.capturePin = pin;
      rootLevel.capturePinPromise = Promise.resolve(pin);
    },
    request(depth) {
      const level = levels[depth];
      return executeTermRequest({ candidate: level.activeCandidate, kind: "term", payload: { text: "猫" },
        capturePinPromise: rootLevel.capturePinPromise }, level);
    },
    dismiss(depth) { hide(levels[depth]); },
    supersede(depth) { levels[depth].lookupToken++; },
    makeProvisional() { rootLevel.capturePin = null; },
    pin() { return rootLevel.capturePin; },
    rootVisible() { return !rootLevel.popup.hidden; },
  };
}());`));
  const pin = { token: "root-pin" };
  window.driver.install(pin);
  return { window, driver: window.driver, pending, released, pin };
}

test("dismissed or superseded child replies and errors never release the visible root pin", async t => {
  for (const transition of ["dismiss", "supersede"]) {
    for (const ok of [true, false]) {
      const f = fixture(t);
      const lookup = f.driver.request(1);
      assert.equal(f.pending[0].message.type, "hd_lookup");
      f.driver[transition](1);
      f.pending[0].callback({ ok, generation: 1, results: [], error: "Lookup failed" });
      await lookup;
      await tick();
      assert.deepEqual(f.released, []);
      assert.equal(f.driver.pin(), f.pin);
      assert.equal(f.driver.rootVisible(), true);
      f.driver.dismiss(0);
      await tick();
      assert.deepEqual(f.released, ["root-pin"]);
    }
  }
});

test("a stale root replay preserves the pin already adopted by its visible result", async t => {
  for (const ok of [true, false]) {
    const f = fixture(t);
    const lookup = f.driver.request(0);
    f.driver.supersede(0);
    f.pending[0].callback({ ok, generation: 1, results: [], error: "Lookup failed" });
    await lookup;
    await tick();
    assert.deepEqual(f.released, []);
    assert.equal(f.driver.pin(), f.pin);
    assert.equal(f.driver.rootVisible(), true);
  }
});

test("a stale initial root lookup still releases its unadopted provisional pin", async t => {
  for (const ok of [true, false]) {
    const f = fixture(t);
    f.driver.makeProvisional();
    const lookup = f.driver.request(0);
    f.driver.supersede(0);
    f.pending[0].callback({ ok, generation: 1, results: [], error: "Lookup failed" });
    await lookup;
    await tick();
    assert.deepEqual(f.released, ["root-pin"]);
    assert.equal(f.driver.pin(), null);
  }
});

test("ordinary reader hover candidates carry precise DOM boundaries for capture occurrence matching", t => {
  const f = fixture(t);
  const { document } = f.window;
  const paragraph = document.querySelector("p");
  paragraph.textContent = "犬。鳥。";
  const caret = document.createRange();
  caret.setStart(paragraph.firstChild, 0);
  caret.collapse(true);
  document.caretRangeFromPoint = () => caret;
  document.elementFromPoint = () => paragraph;
  f.window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 20, bottom: 20 }];
  const candidate = f.driver.resolveCandidate(10, 10);
  assert.equal(candidate.anchor, paragraph);
  assert.equal(candidate.anchorRange.toString(), "犬");
  const line = document.createRange();
  line.setStart(paragraph.firstChild, 0);
  line.setEnd(paragraph.firstChild, paragraph.textContent.length);
  assert.equal(line.comparePoint(candidate.anchorRange.startContainer, candidate.anchorRange.startOffset), 0);
  assert.equal(line.comparePoint(candidate.anchorRange.endContainer, candidate.anchorRange.endOffset), 0);
});

test("unlink releases a root pin whose acquisition was still pending when unlink began", async t => {
  const dom = new JSDOM("<body><p>猫</p></body>", { runScripts: "outside-only", url: "https://reader.example" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const pendingPin = Promise.withResolvers(), requested = Promise.withResolvers();
  const released = [];
  let listener;
  window.chrome = { runtime: {
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage(message) {
      if (message.type === "hd_capture_content_identify") return { ok: true, documentId: "reader-document" };
      if (message.type === "hd_capture_pin") { requested.resolve(); return pendingPin.promise; }
      if (message.type === "hd_capture_release") released.push(message.token);
      return { ok: true };
    },
  } };
  for (const file of ["reader-options.js", "capture-content.js"]) window.eval(extension(file));
  const command = type => new Promise(resolve => listener({ type, target: "hachidori-capture-content",
    mediaCapture: { ...window.HDReaderOptions.DEFAULT_MEDIA_CAPTURE, enabled: true, timingMode: "recent" } }, {}, resolve));
  await command("hd_capture_link");
  const lookup = window.HDCapture.rootLookup({ anchor: window.document.querySelector("p"), sentence: "猫", query: "猫" });
  await requested.promise;
  const unlinked = command("hd_capture_unlink");
  await tick();
  pendingPin.resolve({ ok: true, token: "late-root-pin" });
  await Promise.all([lookup, unlinked]);
  assert.deepEqual(released, ["late-root-pin"]);
});
