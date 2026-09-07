// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createDictionaryNameDrafts, renameWithBaseline } from "../extension/dictionary-name-drafts.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(done => setImmediate(done));
const pause = ms => new Promise(done => setTimeout(done, ms));

function fixture(t, validate) {
  const dom = new JSDOM("<body><label><input></label></body>");
  const { window } = dom;
  let items = [{ id: "one", name: "Study", dictionaryIds: [] }], release = null;
  const sent = [];
  const drafts = createDictionaryNameDrafts({ delayMs: 10 });
  function bind() {
    const input = window.document.querySelector("input");
    drafts.bind("one", input, {
      value: items[0]?.name ?? "", normalise: value => value.trim(),
      readName: () => items[0]?.name,
      async save(baseName, name) {
        sent.push({ baseName, name });
        const result = renameWithBaseline(items, "one", "name", baseName, name, validate);
        if (!result.error) items = result.items;
        if (release) await new Promise(done => { release = done; });
        if (result.error) return { ok: false, ...result };
        return { ok: true };
      },
    });
    return input;
  }
  let input = bind();
  function edit(value, type = "input") {
    input.value = value;
    input.dispatchEvent(new window.Event(type));
  }
  t.after(() => { drafts.dispose(); window.close(); });
  return { drafts, window, sent, edit, input: () => input, read: () => items,
    external(name) { items = [{ ...items[0], name, dictionaryIds: ["added-elsewhere"] }]; },
    remove() { items = []; }, hold() { release = true; }, release() { const done = release; release = null; done(); },
    rerender() { input.parentElement.replaceChildren(window.document.createElement("input")); input = bind(); },
  };
}

test("name autosave coalesces input, retains focus and merges only unrelated edits", async t => {
  const f = fixture(t);
  f.input().focus();
  f.edit("S"); f.edit("St"); f.edit("Mine");
  f.external("Study");
  await pause(30);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.read()[0], { id: "one", name: "Mine", dictionaryIds: ["added-elsewhere"] });
  assert.equal(f.window.document.activeElement, f.input());
  assert.equal(f.drafts.hasPendingChanges(), false);
  f.edit("Mine", "change");
  await tick();
  assert.equal(f.sent.length, 1, "blur after an autosave must not save again");
});

test("external rename preserves the draft across renders until explicit retry or discard", async t => {
  const f = fixture(t);
  f.edit("Mine"); f.external("Shared");
  await pause(30);
  assert.equal(f.read()[0].name, "Shared");
  f.rerender();
  assert.equal(f.input().value, "Mine");
  assert.match(f.window.document.body.textContent, /changed elsewhere/u);
  f.window.document.querySelector(".name-draft-retry").click();
  await tick();
  assert.equal(f.read()[0].name, "Mine");
  f.edit("Unsent"); f.external("Newest");
  await pause(30);
  f.window.document.querySelector(".name-draft-discard").click();
  assert.equal(f.input().value, "Newest");
  assert.equal(f.drafts.hasPendingChanges(), false);
});

test("queued edits advance through their own save, not a newer external event or reply", async t => {
  const f = fixture(t);
  f.hold(); f.edit("Mine", "change");
  await tick();
  f.edit("Next");
  await pause(30);
  assert.equal(f.sent.length, 1);
  f.external("Shared"); f.rerender(); f.release();
  await tick(); await tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].baseName, "Mine");
  assert.equal(f.read()[0].name, "Shared");
  assert.equal(f.input().value, "Next");
  assert.equal(f.drafts.hasPendingChanges(), true);
});

test("rename baseline supports alias no-op readback and never resurrects a removed item", () => {
  const items = [{ id: "one", displayName: "Mine", enabled: false }];
  assert.equal(renameWithBaseline(items, "one", "displayName", "Old", "Mine").items, items);
  assert.match(renameWithBaseline([], "one", "displayName", "Old", "Mine").error, /removed/u);
  assert.match(renameWithBaseline(items, "one", "displayName", "Old", "New").error, /changed elsewhere/u);
});

test("correcting a locally invalid name resumes autosave without rebasing an external conflict", async t => {
  const f = fixture(t, (_items, name) => name === "All" ? "All is reserved." : "");
  f.edit("All");
  await pause(30);
  assert.match(f.window.document.body.textContent, /reserved/u);
  f.edit("All terms");
  await pause(30);
  assert.equal(f.read()[0].name, "All terms");
  assert.equal(f.drafts.hasPendingChanges(), false);
  f.edit("Mine"); f.external("Shared");
  await pause(30);
  const before = f.sent.length;
  f.edit("My corrected draft");
  await pause(30);
  assert.equal(f.sent.length, before);
  assert.equal(f.read()[0].name, "Shared");
});

test("an obsolete validation reply cannot block a corrected queued name", async t => {
  const f = fixture(t, (_items, name) => name === "All" ? "All is reserved." : "");
  f.hold(); f.edit("All", "change");
  await tick();
  f.edit("All terms");
  await pause(30);
  f.release();
  await tick(); await tick();
  assert.equal(f.read()[0].name, "All terms");
  assert.equal(f.drafts.hasPendingChanges(), false);
});
