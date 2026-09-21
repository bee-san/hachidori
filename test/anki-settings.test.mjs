// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiSettingsController, createAnkiTemplateSettingsController } from "../extension/anki-settings.js";
import { ANKI_TEMPLATE_MARKER_OPTIONS, ANKI_TEMPLATE_MARKERS } from "../extension/anki-templates.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, capabilities, readOwnerKey = () => "") {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  let config = window.HDReaderOptions.normaliseOptions({}).anki;
  const edits = [], sent = [];
  const controller = createAnkiSettingsController({ document: window.document, readConfig: () => config,
    capabilities,
    readOwnerKey,
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
const rows = f => [...f.el("anki-templates").children];
const row = (f, field) => rows(f).find(candidate => candidate.dataset.ankiField === field);
const editor = (f, field) => row(f, field)?.querySelector('[role="combobox"]');

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

test("setup discovery belongs to the selected Template even when two Templates have identical Anki settings", async t => {
  let owner = "word";
  const f = fixture(t, undefined, () => owner);
  f.controller.render();
  discovery(f.sent[0]);
  await tick();
  f.el("anki-find-setup").click();
  const stale = f.sent.at(-1);
  assert.equal(stale.templateId, "word");
  owner = "sentence";
  f.controller.render();
  assert.equal(f.el("anki-find-setup").disabled, false);
  assert.equal(f.el("anki-setup-status").hidden, true);
  stale.resolve({ ok: true,
    proposal: { status: "configured", model: "Kiku", deck: "Mining", fieldTemplates: {} },
    outcome: { status: "configured", model: "Kiku", deck: "Mining" } });
  await tick();
  assert.equal(f.edits.length, 0);
  assert.equal(f.el("anki-setup-status").hidden, true);

  f.el("anki-find-setup").click();
  assert.equal(f.sent.at(-1).templateId, "sentence");
  f.sent.at(-1).resolve({ ok: true, proposal: null,
    outcome: { status: "unavailable", detail: "Open Anki for this Template.", model: null, deck: null } });
  await tick();
  assert.match(f.el("anki-setup-status").textContent, /this Template/u);
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
  assert.ok(row(f, "Newest"));
  assert.equal(row(f, "Old"), undefined);
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
  assert.equal(editor(f, "Missing").value, "{expression}");
  assert.equal(row(f, "Missing").querySelector("button.ghost").hidden, false);
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
  assert.equal(editor(f, "front").value, "{expression}");
  assert.equal(f.read().fields.expression, "Front");
  assert.match(f.el("anki-status").textContent, /configuration ready/u);
  assert.equal(f.el("anki-status").classList.contains("is-ready"), true);
  assert.equal(f.el("anki-status").classList.contains("is-working"), false);
  assert.equal(f.el("anki-status").classList.contains("is-error"), false);
  assert.equal(f.edits.length, 0);
});

test("presets and field comboboxes save one complete snapshot, retain invalid drafts and clear on model change", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fields: { ...f.read().fields, expression: "Front" } });
  discovery(f.sent[0]);
  await tick();
  assert.equal(rows(f).length, 2);
  assert.equal(editor(f, "Front").value, "{expression}");
  assert.equal(editor(f, "Front").readOnly, false);
  assert.equal(f.edits.length, 0, "projecting a simple mapping must not rewrite it");
  f.el("anki-preset").value = "automatic";
  f.el("anki-apply-preset").click();
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().fieldTemplates.Front.value, "{expression}");
  assert.equal(f.read().fieldTemplates.Back.value, "");
  const control = editor(f, "Front");
  control.focus();
  control.value = "literal {unknown}";
  control.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.read().fieldTemplates.Front.value, "literal {unknown}");
  assert.match(f.el("anki-status").textContent, /Unknown marker/u);
  assert.equal(control.getAttribute("aria-invalid"), "true");
  assert.match(row(f, "Front").querySelector(".anki-template-error").textContent, /Unknown marker/u);
  const mode = row(f, "Front").querySelector("select");
  mode.value = "coalesce-new";
  mode.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().fieldTemplates.Front.overwriteMode, "coalesce-new");
  const model = f.el("opt-anki-model");
  model.value = "B";
  model.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().fieldTemplates, null);
  assert.ok(Object.values(f.read().fields).every(value => value === ""));
});

test("simple mappings project without writes and the first explicit edit materializes their exact field templates", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fields: { ...f.read().fields, expression: "Front" } });
  assert.equal(editor(f, "Front").value, "{expression}");
  assert.equal(f.edits.length, 0);
  const control = editor(f, "Front");
  control.value = "  custom {expression}\n";
  control.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.edits.length, 1);
  assert.equal(f.read().fieldTemplates.Front.value, "  custom {expression}\n");
  const pending = f.controller.refresh();
  discovery(f.sent[1]);
  await pending;
  assert.equal(f.read().fieldTemplates.Front.value, "  custom {expression}\n");
  assert.equal(f.read().fieldTemplates.Back, undefined,
    "discovery must not rewrite an explicit mapping snapshot");
  assert.equal(editor(f, "Back").value, "");
});

test("field marker comboboxes expose every option and preserve free-form input across keyboard, pointer, paste and composition", async t => {
  const f = fixture(t);
  f.adopt({ model: "A", fieldTemplates: {
    Front: { value: "", overwriteMode: "coalesce" },
    Back: { value: "{definition}", overwriteMode: "coalesce" },
  } });
  discovery(f.sent[0]);
  await tick();
  const control = editor(f, "Front");
  const owner = row(f, "Front");
  const toggle = owner.querySelector(".anki-marker-combobox-toggle");
  const listbox = owner.querySelector('[role="listbox"]');
  const options = [...listbox.querySelectorAll('[role="option"]')];
  const input = (value, { inputType = "insertText", isComposing = false } = {}) => {
    control.value = value;
    control.setSelectionRange(value.length, value.length);
    control.dispatchEvent(new f.window.InputEvent("input", { bubbles: true, inputType, isComposing }));
  };
  const key = (value, options = {}) => {
    const event = new f.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
    const allowed = control.dispatchEvent(event);
    return { event, allowed };
  };

  assert.equal(control.getAttribute("role"), "combobox");
  assert.equal(control.getAttribute("aria-autocomplete"), "list");
  assert.equal(control.getAttribute("aria-expanded"), "false");
  assert.equal(control.getAttribute("aria-controls"), listbox.id);
  assert.equal(f.window.document.querySelector(`label[for="${control.id}"]`)?.textContent, "Front");
  assert.equal(options.length, ANKI_TEMPLATE_MARKER_OPTIONS.length);
  assert.deepEqual(options.map(option => option.dataset.marker),
    ANKI_TEMPLATE_MARKER_OPTIONS.map(option => option.value));
  assert.ok(ANKI_TEMPLATE_MARKERS.every(marker =>
    options.some(option => option.dataset.marker === `{${marker}}`)));
  assert.ok(options.every(option => option.getAttribute("aria-label")?.includes(": ")));

  control.focus();
  input("{expr");
  assert.equal(control.getAttribute("aria-expanded"), "true");
  assert.equal(listbox.hidden, false);
  const visible = options.filter(option => !option.hidden);
  assert.deepEqual(visible.map(option => option.dataset.marker), ["{expression}"]);
  assert.equal(control.getAttribute("aria-activedescendant"), visible[0].id);
  assert.equal(visible[0].getAttribute("aria-selected"), "true");
  const shiftEnter = key("Enter", { shiftKey: true });
  assert.equal(shiftEnter.allowed, true);
  assert.equal(shiftEnter.event.defaultPrevented, false,
    "Shift+Enter remains available for literal multiline text");
  key("Enter");
  assert.equal(control.value, "{expression}");
  assert.equal(f.read().fieldTemplates.Front.value, "{expression}");
  assert.equal(control.getAttribute("aria-expanded"), "false");

  toggle.click();
  const firstActive = control.getAttribute("aria-activedescendant");
  key("ArrowDown");
  assert.notEqual(control.getAttribute("aria-activedescendant"), firstActive);
  assert.equal(options.find(option => option.id === control.getAttribute("aria-activedescendant"))
    ?.getAttribute("aria-selected"), "true");
  key("Escape");
  assert.equal(control.value, "{expression}", "Escape closes without choosing the highlighted option");
  assert.equal(control.getAttribute("aria-expanded"), "false");

  input("before  after");
  control.setSelectionRange(7, 7);
  options.find(option => option.dataset.marker === "{glossary}").click();
  assert.equal(control.value, "before {glossary} after");
  assert.equal(f.read().fieldTemplates.Front.value, "before {glossary} after");

  input("{expression}{expression}");
  control.setSelectionRange("{expression}".length, "{expression}".length);
  options.find(option => option.dataset.marker === "{reading}").click();
  assert.equal(control.value, "{expression}{reading}{expression}",
    "a caret between adjacent markers inserts without replacing either marker");
  assert.equal(f.read().fieldTemplates.Front.value, "{expression}{reading}{expression}");

  input("{expression}");
  control.setSelectionRange("{expression}".length, "{expression}".length);
  options.find(option => option.dataset.marker === "{reading}").click();
  assert.equal(control.value, "{expression}{reading}",
    "a caret at the closing boundary inserts after the complete marker");

  input("{expression}");
  control.setSelectionRange(0, 0);
  options.find(option => option.dataset.marker === "{reading}").click();
  assert.equal(control.value, "{reading}{expression}",
    "a caret at the opening boundary inserts before the complete marker");

  input("{expression}");
  control.setSelectionRange(2, 7);
  options.find(option => option.dataset.marker === "{reading}").click();
  assert.equal(control.value, "{reading}",
    "a range intersecting a marker replaces the complete marker");

  input("{definitely-no-marker");
  assert.equal(options.every(option => option.hidden), true);
  assert.equal(owner.querySelector(".anki-marker-empty").hidden, false);
  assert.equal(control.hasAttribute("aria-activedescendant"), false);
  key("Escape");

  const exact = " \t literal {unknown} {unknown}\n{expression}  ";
  input(exact, { inputType: "insertFromPaste" });
  assert.equal(f.read().fieldTemplates.Front.value, exact);
  assert.equal(control.value, exact);
  assert.equal(control.getAttribute("aria-invalid"), "true");
  assert.match(owner.querySelector(".anki-template-error").textContent, /Unknown marker: \{unknown\}/u);
  toggle.click();
  const tab = key("Tab");
  assert.equal(tab.allowed, true);
  assert.equal(tab.event.defaultPrevented, false);
  owner.querySelector("select").focus();
  await tick();
  assert.equal(control.getAttribute("aria-expanded"), "false");
  assert.equal(f.read().fieldTemplates.Front.value, exact,
    "Tab and focus exit must not replace free-form text with the active option");

  control.focus();
  input("composition: ");
  control.dispatchEvent(new f.window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  control.value = "composition: 日本";
  control.setSelectionRange(control.value.length, control.value.length);
  control.dispatchEvent(new f.window.InputEvent("input",
    { bubbles: true, inputType: "insertCompositionText", data: "日本", isComposing: true }));
  assert.equal(f.read().fieldTemplates.Front.value, "composition: ");
  control.value = "composition: 日本語\t";
  control.setSelectionRange(control.value.length, control.value.length);
  control.dispatchEvent(new f.window.CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
  assert.equal(f.read().fieldTemplates.Front.value, "composition: 日本語\t");
  assert.equal(control.value, "composition: 日本語\t");
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
  f.adopt({ model: "A", fieldTemplates: {
    Front: { value: "{expression}", overwriteMode: "coalesce" },
    Back: { value: "{definition}", overwriteMode: "coalesce" },
  } });
  const old = f.sent[0];
  discovery(old);
  await tick();
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
  assert.equal(f.el("anki-status").classList.contains("is-working"), true);
  assert.doesNotMatch(f.el("anki-status").textContent, /configuration ready/u,
    "the retired endpoint's fields must not be paired with the new endpoint");
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

function templateFixture(t, { send: sendRequest } = {}) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  const base = window.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const first = { ...base, id: "default", name: "Word card", model: "Basic", deck: "Words",
    tags: ["word"], fields: { ...base.fields, expression: "Front", screenshot: "Picture" },
    fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "coalesce" },
      Picture: { value: "{screenshot}", overwriteMode: "overwrite" },
    } };
  const second = { ...base, id: "sentence", name: "Sentence card", model: "Sentence", deck: "Sentences",
    tags: ["sentence"], fields: { ...base.fields, sentence: "Front" }, fieldTemplates: null };
  let anki = window.HDReaderOptions.normaliseAnki({ url: "http://127.0.0.1:8765", apiKey: "", templates: [first, second] });
  let buttons = [];
  let sequence = 0;
  const edits = [], sent = [];
  const controller = createAnkiTemplateSettingsController({ document: window.document,
    readAnki: () => anki, readButtons: () => buttons, createId: () => `template-${++sequence}`,
    editAnki(value) { anki = value; edits.push(value); },
    async send(type, fields) {
      const request = { type, ...fields };
      sent.push(request);
      if (sendRequest) return sendRequest(request);
      if (type === "hd_anki_discover") return { ok: true, connected: true,
        decks: ["Words", "Sentences", "Context"], models: ["Basic", "Sentence"], model: fields.model,
        fields: fields.model === "Sentence" ? ["Front", "Back"] : ["Front", "Picture"], errors: [] };
      return { ok: true, proposal: null,
        outcome: { status: "unavailable", detail: "Open Anki.", model: null, deck: null } };
    },
  });
  const el = id => window.document.getElementById(id);
  t.after(() => window.close());
  return { window, controller, edits, sent, el, read: () => anki,
    adopt(value) {
      anki = window.HDReaderOptions.normaliseAnki(value);
      controller.render();
    },
    buttons(value) { buttons = value; },
  };
}

test("Template pills select through the existing Template change path", async t => {
  const f = templateFixture(t);
  f.controller.render();
  await tick();
  const pills = [...f.el("anki-template-pills").querySelectorAll(".anki-template-pill")];
  assert.deepEqual(pills.map(pill => pill.getAttribute("aria-pressed")), ["true", "false"]);
  assert.equal(pills[0].querySelector(".anki-template-pill-badge")?.textContent, "Built-in");

  pills[1].click();
  await tick();
  assert.equal(f.el("anki-template-select").value, "sentence");
  assert.equal(f.el("opt-anki-template-name").value, "Sentence card");
  assert.deepEqual([...f.el("anki-template-pills").querySelectorAll(".anki-template-pill")]
    .map(pill => pill.getAttribute("aria-pressed")), ["false", "true"]);
});

test("Set built-in moves the selected Template first and updates its badge", async t => {
  const f = templateFixture(t);
  f.controller.render();
  await tick();
  [...f.el("anki-template-pills").querySelectorAll(".anki-template-pill")][1].click();
  await tick();
  const setBuiltin = f.el("anki-template-set-builtin");
  assert.equal(setBuiltin.disabled, false);
  setBuiltin.click();

  assert.deepEqual(f.read().templates.map(template => template.id), ["sentence", "default"]);
  const pills = [...f.el("anki-template-pills").querySelectorAll(".anki-template-pill")];
  assert.match(pills[0].textContent, /Sentence card/u);
  assert.equal(pills[0].querySelector(".anki-template-pill-badge")?.textContent, "Built-in");
  assert.equal(pills[0].getAttribute("aria-pressed"), "true");
  assert.equal(setBuiltin.disabled, true);
});

test("Template manager edits the selected mapping while connection settings remain shared", async t => {
  const f = templateFixture(t);
  f.controller.render();
  await tick();
  assert.deepEqual([...f.el("anki-template-select").options].map(option => option.textContent),
    ["Word card", "Sentence card"]);
  assert.equal(f.el("anki-template-role").hidden, false);
  assert.equal(f.el("anki-template-position").textContent, "1 of 2");

  f.el("anki-template-next").click();
  await tick();
  assert.equal(f.el("anki-template-select").value, "sentence");
  assert.equal(f.el("anki-template-role").hidden, true);
  assert.equal(f.el("opt-anki-tags").value, "sentence");
  f.el("opt-anki-tags").value = "sentence context";
  f.el("opt-anki-tags").dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.deepEqual(f.read().templates[0].tags, ["word"]);
  assert.deepEqual(f.read().templates[1].tags, ["sentence", "context"]);

  const url = f.el("opt-anki-url");
  url.value = "https://anki.example.test/connect";
  url.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().url, "https://anki.example.test/connect");
  assert.deepEqual(f.read().templates.map(template => template.id), ["default", "sentence"]);

  f.el("anki-template-up").click();
  assert.deepEqual(f.read().templates.map(template => template.id), ["sentence", "default"]);
  assert.equal(f.read().model, "Sentence", "the first Template remains the built-in button projection");
  assert.equal(f.el("anki-template-role").hidden, false);
  assert.equal(f.window.document.activeElement, f.el("anki-template-down"));
});

test("Template switching and unrelated edits retain each Template's mapping byte-for-byte", async t => {
  const f = templateFixture(t);
  const firstValue = " \tfirst {expression}{expression} {unknown}\n ";
  const secondValue = "\nsecond literal {sentence}\t{sentence}  ";
  const current = f.read();
  f.adopt({
    url: current.url,
    apiKey: current.apiKey,
    templates: current.templates.map(template => ({
      ...template,
      fieldTemplates: {
        Front: {
          value: template.id === "default" ? firstValue : secondValue,
          overwriteMode: "coalesce",
        },
      },
    })),
  });
  await tick();
  assert.equal(editor(f, "Front").value, firstValue);

  const tags = f.el("opt-anki-tags");
  tags.value = "word unrelated";
  tags.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().templates[0].fieldTemplates.Front.value, firstValue);
  assert.equal(f.read().templates[1].fieldTemplates.Front.value, secondValue);

  f.el("anki-template-select").value = "sentence";
  f.el("anki-template-select").dispatchEvent(new f.window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(editor(f, "Front").value, secondValue);
  const editedSecond = `${secondValue}追加`;
  const secondEditor = editor(f, "Front");
  secondEditor.value = editedSecond;
  secondEditor.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.read().templates[0].fieldTemplates.Front.value, firstValue);
  assert.equal(f.read().templates[1].fieldTemplates.Front.value, editedSecond);

  f.el("anki-template-select").value = "default";
  f.el("anki-template-select").dispatchEvent(new f.window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(editor(f, "Front").value, firstValue);
  assert.equal(f.read().templates[0].fieldTemplates.Front.value, firstValue);
  assert.equal(f.read().templates[1].fieldTemplates.Front.value, editedSecond);
});

test("a pending note-type preset cannot cross into another Template with the same connection and model", async t => {
  const f = templateFixture(t, {
    send: request => new Promise(resolve => { request.resolve = resolve; }),
  });
  f.controller.render();
  f.sent[0].resolve({ ok: true, connected: true, decks: ["Words", "Sentences"],
    models: ["Basic", "Kiku"], model: "Basic", fields: ["Front", "Picture"], errors: [] });
  await tick();
  const initial = f.read();
  f.adopt({ ...initial, templates: initial.templates.map(template => template.id === "sentence"
    ? { ...template, model: "Kiku", fields: { ...template.fields }, fieldTemplates: null }
    : template) });

  const model = f.el("opt-anki-model");
  model.value = "Kiku";
  model.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  const preset = f.sent.at(-1);
  f.el("anki-template-select").value = "sentence";
  f.el("anki-template-select").dispatchEvent(new f.window.Event("change", { bubbles: true }));
  preset.resolve({ ok: true, connected: true, decks: ["Words", "Sentences"],
    models: ["Basic", "Kiku"], model: "Kiku",
    fields: ["Expression", "ExpressionReading", "Sentence", "MainDefinition"], errors: [] });
  await tick();

  assert.equal(f.read().templates.find(template => template.id === "sentence").fieldTemplates, null);
  assert.equal(f.read().templates.find(template => template.id === "default").fieldTemplates, null);
  assert.equal(f.edits.filter(edit => edit.templates.some(template => template.fieldTemplates !== null)).length, 0);
});

test("Template CRUD preserves mappings, uses stable IDs and blocks deletion while a custom button refers to one", async t => {
  const f = templateFixture(t);
  f.controller.render();
  await tick();
  f.el("anki-template-select").value = "default";
  f.el("anki-template-select").dispatchEvent(new f.window.Event("change", { bubbles: true }));
  f.el("anki-template-duplicate").click();
  const copy = f.read().templates[1];
  assert.equal(copy.id, "template-1");
  assert.equal(copy.name, "Word card copy");
  assert.deepEqual(copy.fieldTemplates, f.read().templates[0].fieldTemplates);
  assert.notEqual(copy.fieldTemplates, f.read().templates[0].fieldTemplates);
  assert.equal(copy.fieldTemplates.Picture.value, "{screenshot}");

  const name = f.el("opt-anki-template-name");
  name.value = "Picture card";
  name.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.equal(f.read().templates[1].name, "Picture card");
  assert.match(f.el("anki-template-select").textContent, /Picture card/u);

  f.buttons([{ id: "button", type: "anki", label: "Mine picture", templateId: copy.id }]);
  f.el("anki-template-delete").click();
  assert.equal(f.read().templates.some(template => template.id === copy.id), true);
  assert.match(f.el("anki-template-status").textContent, /Mine picture/u);
  f.buttons([]);
  f.el("anki-template-delete").click();
  assert.equal(f.read().templates.some(template => template.id === copy.id), false);
  assert.equal(f.window.document.activeElement, f.el("anki-template-select"));

  f.el("anki-template-add").click();
  assert.equal(f.read().templates.at(-1).id, "template-2");
  assert.equal(f.read().templates.at(-1).name, "Template");
  assert.equal(f.window.document.activeElement, f.el("opt-anki-template-name"));
  assert.equal(f.el("opt-anki-template-name").selectionStart, 0);
});
