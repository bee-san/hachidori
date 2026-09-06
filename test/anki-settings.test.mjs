// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiSettingsController } from "../extension/anki-settings.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  let config = window.HDReaderOptions.normaliseOptions({}).anki;
  const edits = [], sent = [];
  const controller = createAnkiSettingsController({ document: window.document, readConfig: () => config,
    editConfig(value) { config = value; edits.push(value); },
    send(type, fields) { return new Promise(resolve => sent.push({ type, ...fields, resolve })); } });
  const el = id => window.document.getElementById(id);
  function adopt(patch) { config = { ...config, ...patch }; controller.render(); }
  t.after(() => window.close());
  return { window, controller, edits, sent, el, adopt, read: () => config };
}
function discovery(request, patch = {}) {
  request.resolve({ ok: true, connected: true, decks: ["Default"], models: ["A", "B"],
    model: request.model, fields: ["Front", "Back"], errors: [], ...patch });
}

test("lazy Anki Settings ignores A→B→A stale successes/errors and never writes on discovery or saved echoes", async t => {
  const f = fixture(t);
  assert.equal(f.sent.length, 0);
  f.adopt({ model: "A" });
  f.adopt({ model: "B" });
  f.adopt({ model: "A" });
  assert.equal(f.sent.length, 3);
  discovery(f.sent[2], { fields: ["Newest"] });
  await tick();
  discovery(f.sent[0], { fields: ["Old"] });
  f.sent[1].resolve({ ok: false, error: "Stale failure" });
  await tick();
  assert.match(f.el("opt-anki-field-expression").textContent, /Newest/u);
  assert.doesNotMatch(f.el("opt-anki-field-expression").textContent, /Old/u);
  assert.doesNotMatch(f.el("anki-status").textContent, /Stale failure/u);
  f.controller.render();
  assert.equal(f.sent.length, 3);
  assert.equal(f.edits.length, 0);
  assert.equal(f.el("anki-refresh").disabled, false);
});

test("refresh retains unavailable saved choices and focused drafts; explicit model edits reset mappings atomically", async t => {
  const f = fixture(t);
  f.adopt({ deck: "Deleted", model: "A", fields: { ...f.read().fields, expression: "Missing" } });
  discovery(f.sent[0]);
  await tick();
  assert.equal(f.el("opt-anki-deck").value, "Deleted");
  assert.match(f.el("opt-anki-deck").textContent, /Deleted.*unavailable/u);
  assert.equal(f.el("opt-anki-field-expression").value, "Missing");
  assert.match(f.el("anki-status").textContent, /Missing.*unavailable/u);
  const tags = f.el("opt-anki-tags");
  tags.focus();
  tags.value = "unfinished draft ";
  f.controller.render();
  assert.equal(tags.value, "unfinished draft ");
  const model = f.el("opt-anki-model");
  model.value = "B";
  model.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().model, "B");
  assert.ok(Object.values(f.read().fields).every(value => value === ""));
  assert.equal(f.sent.length, 2);
});

test("case-only Anki field renames stay available without rewriting saved mappings", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fields: { ...f.read().fields, expression: "Front" } });
  discovery(f.sent[0], { fields: ["front", "Back"] });
  await tick();
  const select = f.el("opt-anki-field-expression");
  assert.equal(select.value, "Front");
  assert.equal(select.selectedOptions[0].textContent, "front");
  assert.match(f.el("anki-status").textContent, /configuration ready/u);
  assert.equal(f.edits.length, 0);
});
