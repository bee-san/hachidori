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
  const observer = new f.window.MutationObserver(() => {});
  observer.observe(f.el("anki"), { subtree: true, childList: true, characterData: true, attributes: true });
  f.controller.render();
  assert.equal(observer.takeRecords().length, 0, "unchanged config must not repaint or repeat live status");
  observer.disconnect();
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

test("presets and advanced templates save one complete snapshot, retain invalid drafts and clear on model change", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fields: { ...f.read().fields, expression: "Front" } });
  discovery(f.sent[0]);
  await tick();
  const rows = () => [...f.el("anki-templates").children];
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].querySelector("textarea").value, "{expression}");
  assert.equal(rows()[0].querySelector("textarea").readOnly, true);
  f.el("anki-preset").value = "automatic";
  f.el("anki-apply-preset").click();
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().fieldTemplates.Front.value, "{expression}");
  assert.equal(f.read().fieldTemplates.Back.value, "");
  const editor = rows()[0].querySelector("textarea");
  editor.focus();
  editor.value = "literal {unknown}";
  editor.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.read().fieldTemplates.Front.value, "literal {unknown}");
  assert.match(f.el("anki-status").textContent, /Unknown marker/u);
  const mode = rows()[0].querySelector("select");
  mode.value = "coalesce-new";
  mode.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().fieldTemplates.Front.overwriteMode, "coalesce-new");
  const model = f.el("opt-anki-model");
  model.value = "B";
  model.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().fieldTemplates, null);
  assert.ok(Object.values(f.read().fields).every(value => value === ""));
});

test("case-only field refresh preserves the focused template row and subsequent edits target its current name", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fieldTemplates: { Front: { value: "{expression}", overwriteMode: "coalesce" } } });
  discovery(f.sent[0]);
  await tick();
  const editor = f.el("anki-templates").querySelector("textarea");
  editor.focus();
  editor.value = "draft {expression}";
  editor.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  const pending = f.controller.refresh();
  discovery(f.sent[1], { fields: ["front", "Back"] });
  await pending;
  assert.equal(f.window.document.activeElement, editor);
  assert.equal(f.el("anki-templates").querySelector("textarea"), editor);
  editor.value = "next {expression}";
  editor.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.read().fieldTemplates.front.value, "next {expression}");
  assert.equal(Object.hasOwn(f.read().fieldTemplates, "Front"), false);
});
