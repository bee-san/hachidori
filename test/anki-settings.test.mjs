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

function fixture(t, capabilities) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  let config = window.HDReaderOptions.normaliseOptions({}).anki;
  const edits = [], sent = [];
  const controller = createAnkiSettingsController({ document: window.document, readConfig: () => config,
    capabilities,
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

test("overlay screenshot controls show the effective capability while preserving saved mappings", async t => {
  const f = fixture(t, { screenshot: false });
  f.adopt({ captureScreenshot: true, fields: { ...f.read().fields, screenshot: "Picture" } });
  assert.equal(f.el("opt-anki-screenshot").disabled, true);
  assert.equal(f.el("opt-anki-screenshot").checked, false);
  assert.match(f.el("anki-screenshot-help").textContent, /unavailable in this overlay/u);
  assert.equal(f.read().captureScreenshot, true);
  assert.equal(f.read().fields.screenshot, "Picture");
  assert.equal(f.edits.length, 0);
});

test("Settings explicitly retries setup discovery and applies its proposal through the existing config editor", async t => {
  const f = fixture(t);
  f.controller.render();
  discovery(f.sent[0]);
  await tick();
  const button = f.el("anki-find-setup");
  button.click();
  button.click();
  const find = f.sent.filter(request => request.type === "hd_anki_setup");
  assert.equal(find.length, 1);
  assert.equal(button.disabled, true);
  find[0].resolve({ ok: true, proposal: null,
    outcome: { status: "unavailable", detail: "Open Anki with AnkiConnect.", model: null, deck: null } });
  await tick();
  assert.equal(button.disabled, false);
  assert.match(f.el("anki-setup-status").textContent, /Open Anki/u);
  assert.equal(f.edits.length, 0);
  button.click();
  const templates = { Expression: { value: "{expression}", overwriteMode: "overwrite" } };
  f.sent.at(-1).resolve({ ok: true,
    proposal: { status: "configured", model: "Kiku", deck: "Mining", fieldTemplates: templates },
    outcome: { status: "configured", model: "Kiku", deck: "Mining", detail: null } });
  await tick();
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().model, "Kiku");
  assert.equal(f.read().deck, "Mining");
  assert.deepEqual(f.read().fieldTemplates, templates);
  assert.match(f.el("anki-setup-status").textContent, /Found Kiku/u);
});

test("a setup proposal cannot replace intervening Settings edits, and a verified mapping is never rewritten", async t => {
  const f = fixture(t);
  f.controller.render();
  discovery(f.sent[0]);
  await tick();
  f.el("anki-find-setup").click();
  const pending = f.sent.at(-1);
  f.adopt({ model: "Basic", deck: "Words" });
  pending.resolve({ ok: true, proposal: { status: "configured", model: "Kiku", deck: "Mining", fieldTemplates: {} },
    outcome: { status: "configured", model: "Kiku", deck: "Mining" } });
  await tick();
  assert.equal(f.read().model, "Basic");
  assert.equal(f.edits.length, 0);
  assert.match(f.el("anki-setup-status").textContent, /changes were kept/u);
  f.el("anki-find-setup").click();
  f.sent.at(-1).resolve({ ok: true, proposal: { status: "already-configured" },
    outcome: { status: "already-configured", model: "Basic", deck: "Words", detail: null } });
  await tick();
  assert.equal(f.edits.length, 0);
  assert.match(f.el("anki-setup-status").textContent, /saved Basic setup/u);
  f.adopt({ deck: "Changed after the check" });
  assert.equal(f.el("anki-setup-status").hidden, true);
});

test("lazy Anki Settings ignores A→B→A stale successes/errors and never writes on discovery or saved echoes", async t => {
  const f = fixture(t);
  assert.equal(f.el("anki-status").classList.contains("operational-status"), true);
  assert.equal(f.el("anki-status").getAttribute("aria-atomic"), "true");
  assert.equal(f.sent.length, 0);
  f.adopt({ model: "A" });
  f.adopt({ model: "B" });
  f.adopt({ model: "A" });
  assert.equal(f.sent.length, 3);
  assert.equal(f.el("anki-status").classList.contains("is-working"), true);
  assert.equal(f.el("anki-status").classList.contains("is-ready"), false);
  assert.equal(f.el("anki-status").classList.contains("is-error"), false);
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
  assert.equal(f.el("anki-status").classList.contains("is-error"), true);
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
  assert.equal(f.el("anki-status").classList.contains("is-ready"), true);
  assert.equal(f.el("anki-status").classList.contains("is-working"), false);
  assert.equal(f.el("anki-status").classList.contains("is-error"), false);
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

test("entering template mode waits for discovered fields instead of replacing basic mappings with an empty snapshot", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fields: { ...f.read().fields, expression: "Front" } });
  const advanced = f.el("opt-anki-advanced");
  assert.equal(advanced.disabled, true);
  advanced.click();
  assert.equal(f.edits.length, 0);
  f.sent[0].resolve({ ok: false, error: "Offline" });
  await tick();
  assert.equal(advanced.disabled, true);
  const pending = f.controller.refresh();
  discovery(f.sent[1]);
  await pending;
  assert.equal(advanced.disabled, false);
  advanced.click();
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().fieldTemplates.Front.value, "{expression}");
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

test("field-order refresh rearranges surrounding rows without detaching the focused template editor", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fieldTemplates: { Front: { value: "{expression}", overwriteMode: "coalesce" },
    Back: { value: "{definition}", overwriteMode: "coalesce" } } });
  discovery(f.sent[0]);
  await tick();
  const pending = f.controller.refresh();
  const editor = f.el("anki-templates").querySelectorAll("textarea")[1];
  editor.focus();
  editor.setSelectionRange(2, 5);
  discovery(f.sent[1], { fields: ["Back", "Front"] });
  await pending;
  assert.equal(f.window.document.activeElement, editor);
  assert.equal(f.el("anki-templates").querySelector("textarea"), editor);
  assert.equal(editor.selectionStart, 2);
  assert.equal(editor.selectionEnd, 5);
});

test("deliberately choosing a recognized note type selects and applies its preset once after field discovery", async t => {
  const f = fixture(t);
  const models = ["Kiku v2", "Lapis-1.4", "Senren (2026)"];
  f.controller.render();
  discovery(f.sent[0], { models });
  await tick();
  for (const [index, model] of models.entries()) {
    const select = f.el("opt-anki-model");
    select.value = model;
    select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    assert.equal(f.read().fieldTemplates, null, "old mappings clear before discovered fields arrive");
    const family = ["kiku", "lapis", "senren"][index];
    assert.equal(f.el("anki-preset").value, family);
    const editsBeforeReply = f.edits.length;
    const fields = family === "senren" ? ["word", "reading", "sentence", "definition"]
      : ["Expression", "ExpressionReading", "Sentence", "MainDefinition"];
    discovery(f.sent.at(-1), { models, fields });
    await tick();
    assert.equal(f.edits.length, editsBeforeReply + 1);
    assert.equal(f.read().fieldTemplates[fields[0]].value, "{expression}");
    assert.equal(f.read().fieldTemplates[fields[1]].value, "{reading}");
    const editor = f.el("anki-templates").querySelector("textarea");
    editor.value = "Custom {expression}";
    editor.dispatchEvent(new f.window.Event("input", { bubbles: true }));
    const editsBeforeRefresh = f.edits.length;
    const refreshed = f.controller.refresh();
    discovery(f.sent.at(-1), { models, fields });
    await refreshed;
    assert.equal(f.read().fieldTemplates[fields[0]].value, "Custom {expression}");
    assert.equal(f.edits.length, editsBeforeRefresh, "refresh never reapplies the preset over edits");
  }
});

test("a stale preset response or intervening mapping edit cannot overwrite the current mapping", async t => {
  const f = fixture(t);
  const models = ["Kiku", "Senren", "Kikuchi"];
  f.controller.render();
  discovery(f.sent[0], { models });
  await tick();
  function choose(model) {
    const select = f.el("opt-anki-model");
    select.value = model;
    select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    return f.sent.at(-1);
  }
  const stale = choose("Kiku");
  const current = choose("Senren");
  const customized = { word: { value: "Already edited {expression}", overwriteMode: "coalesce" } };
  f.adopt({ fieldTemplates: customized });
  const editCount = f.edits.length;
  discovery(current, { models, fields: ["word", "reading", "sentence", "definition"] });
  discovery(stale, { models, fields: ["Expression", "ExpressionReading", "Sentence", "MainDefinition"] });
  await tick();
  assert.deepEqual(f.read().fieldTemplates, customized);
  assert.equal(f.edits.length, editCount);
  const unknown = choose("Kikuchi");
  discovery(unknown, { models, fields: ["Front", "Back"] });
  await tick();
  assert.equal(f.el("anki-preset").value, "automatic");
  assert.equal(f.read().fieldTemplates, null, "unrelated names are never guessed as Kiku");
});

test("AnkiConnect URL commits on change, retains invalid drafts and ignores old endpoint responses", async t => {
  const f = fixture(t);
  f.controller.render();
  const old = f.sent[0];
  const url = f.el("opt-anki-url");
  url.focus();
  url.value = "http://";
  url.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.edits.length, 0);
  assert.equal(f.sent.length, 1);
  url.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  url.blur();
  await tick();
  assert.equal(url.value, "http://");
  assert.match(f.el("anki-url-error").textContent, /valid HTTP/u);
  assert.equal(f.sent.length, 1);
  url.value = "https://anki.example.test:8766/connect";
  url.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().url, "https://anki.example.test:8766/connect");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].url, f.read().url);
  discovery(f.sent[1], { models: ["New endpoint"] });
  await tick();
  discovery(old, { models: ["Old endpoint"] });
  await tick();
  assert.match(f.el("opt-anki-model").textContent, /New endpoint/u);
  assert.doesNotMatch(f.el("opt-anki-model").textContent, /Old endpoint/u);
});

test("duplicate scope labels follow the exact configured destination and replace the legacy controls", async t => {
  const f = fixture(t);
  f.adopt({ model: "Kiku v2", deck: "Mining::Words", duplicateScope: "model" });
  discovery(f.sent[0], { models: ["Kiku v2"] });
  await tick();
  const scope = f.el("opt-anki-duplicate-scope");
  assert.deepEqual([...scope.options].map(option => [option.value, option.textContent]), [
    ["model", "Note type: Kiku v2"],
    ["deck", "Deck: Mining::Words"],
    ["all", "All of Anki"],
  ]);
  assert.equal(scope.value, "model");
  assert.equal(f.el("opt-anki-check-duplicates"), null);
  assert.equal(f.el("opt-anki-check-all-models"), null);
  scope.value = "all";
  scope.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().duplicateScope, "all");
  assert.deepEqual([...f.el("opt-anki-duplicate-behavior").options].map(option => option.textContent),
    ["Prevent", "Add anyway", "Overwrite"]);
});
