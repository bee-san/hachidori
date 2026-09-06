// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/reader-options.js";
import "../extension/anki-content.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const configured = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, anki: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki, model: "Basic" } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100 && !predicate(); n++) await tick();
  assert.ok(predicate(), "mining controller did not reach the expected state");
}
function fixture(t, send) {
  const dom = new JSDOM("<!doctype html><body><section></section></body>");
  t.after(() => dom.window.close());
  const popup = dom.window.document.querySelector("section");
  const owner = {}, request = {};
  const controller = globalThis.HDAnki.createAnkiController({ send, onChange() {} });
  const context = { owner, popup, request, isCurrent: () => true,
    getRequest: result => ({ term: result.term }) };
  const items = ["猫", "犬", "鳥"].map(expression => {
    const control = dom.window.document.createElement("div");
    control.innerHTML = "<button>Add</button><button>View</button><output></output>";
    popup.append(control);
    const [add, view] = control.querySelectorAll("button");
    return { control, add, view, output: control.querySelector("output"), result: { term: { expression, reading: "" } } };
  });
  return { controller, context, items };
}

test("Anki stays quiet when unconfigured and preflights all rendered candidates sequentially", async t => {
  const calls = [];
  const held = Promise.withResolvers();
  const f = fixture(t, async (type, { request } = {}) => {
    calls.push([type, request?.term.expression]);
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (request.term.expression === "猫") await held.promise;
    return { state: "addable", canAdd: true };
  });
  f.controller.update(globalThis.HDReaderOptions.DEFAULT_OPTIONS);
  f.controller.bind(f.items, f.context);
  await tick();
  assert.deepEqual(calls, []);
  assert.ok(f.items.every(item => item.control.hidden));
  f.controller.update(configured);
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map(call => call[1]), [undefined, "猫"]);
  held.resolve();
  await until(() => !f.items[2].add.disabled);
  assert.deepEqual(calls.map(call => call[1]), [undefined, "猫", "犬", "鳥"]);
  const before = calls.length;
  f.controller.update({ ...configured });
  f.controller.bind(f.items, f.context);
  await tick();
  assert.equal(calls.length, before, "unchanged bindings do not repeat discovery or preflight");
});

test("successful Add remains successful after a refresh failure and cannot invite a second click", async t => {
  let submitted = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") { submitted++; return { state: "added", noteId: 12, warnings: ["Audio unavailable"] }; }
    if (submitted) throw new Error("refresh offline");
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => !f.items[2].add.disabled);
  f.items[0].add.click();
  f.items[0].add.click();
  await until(() => f.items[0].add.textContent === "Added");
  await tick();
  assert.match(f.items[0].output.textContent, /Added.*12.*Audio unavailable/u);
  assert.equal(f.items[0].add.disabled, true);
  assert.equal(submitted, 1);
});

test("late preflight cannot expose retired controls and an uncertain write stays disabled with View available", async t => {
  const held = Promise.withResolvers();
  let pending = true, writes = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") { if (pending) await held.promise; return { available: true, configKey: "current" }; }
    if (type === "hd_anki_submit") { writes++; throw new Error("reply lost"); }
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await tick();
  f.controller.retire(f.context.owner);
  pending = false;
  f.controller.bind([f.items[1]], f.context);
  held.resolve();
  await until(() => !f.items[1].add.disabled);
  assert.equal(f.items[0].control.hidden, true);
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "uncertain");
  assert.equal(f.items[1].add.disabled, true);
  assert.equal(f.items[1].view.disabled, false);
  assert.match(f.items[1].output.textContent, /View in Anki/u);
  f.items[1].add.click();
  assert.equal(writes, 1);
});
