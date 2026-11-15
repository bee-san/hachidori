// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createCustomButtonSettings, validateLinkButton } from "../extension/custom-button-settings.js";
import { createSettingsSearch } from "../extension/settings-search.js";
import "../extension/reader-options.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { expandCustomLinkUrl } = globalThis.HDExternalLinks;
const { ankiTemplateConfig, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;

test("legacy Anki and custom-link settings migrate losslessly into one Template and stable link buttons", () => {
  const legacy = {
    url: "http://127.0.0.1:8765",
    apiKey: "secret",
    deck: "Mining::Japanese",
    model: "Kiku",
    tags: ["hachidori", "custom"],
    fields: { ...normaliseOptions({}).anki.fields, expression: "Expression", screenshot: "Picture" },
    duplicateScope: "deck",
    duplicateBehavior: "overwrite",
    captureScreenshot: true,
    fieldTemplates: {
      Expression: { value: "{expression}", overwriteMode: "coalesce" },
      Picture: { value: "{screenshot}", overwriteMode: "overwrite" },
    },
  };
  const options = normaliseOptions({ anki: legacy,
    customLinks: [{ label: "Jisho", url: "https://jisho.org/search/%w" }] });
  assert.equal(options.anki.templates.length, 1);
  assert.deepEqual(options.anki.templates[0], { id: "default", name: "Default",
    ...Object.fromEntries(globalThis.HDReaderOptions.ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, legacy[key]])) });
  assert.deepEqual(ankiTemplateConfig(options.anki, "default"), legacy);
  assert.deepEqual(options.customButtons, [{ id: "legacy-link-1", type: "link",
    label: "Jisho", url: "https://jisho.org/search/%w" }]);
  assert.deepEqual(options.customLinks, [{ label: "Jisho", url: "https://jisho.org/search/%w" }]);

  const projected = validateOptionsPatch({ customButtons: [
    { id: "link-1", type: "link", label: "Sentence", url: "https://example.test/%s" },
    { id: "anki-1", type: "anki", label: "Mine sentence", templateId: "default" },
  ] });
  assert.deepEqual(projected.customLinks, [{ label: "Sentence", url: "https://example.test/%s" }]);
  const oversized = "x".repeat(globalThis.HDReaderOptions.STABLE_ID_MAX_LENGTH + 1);
  assert.throws(() => validateOptionsPatch({ customButtons: [
    { id: oversized, type: "link", label: "Too long", url: "https://example.test/%w" },
  ] }), /invalid reader option/u);
  assert.throws(() => validateOptionsPatch({ customButtons: [
    { id: "button", type: "anki", label: "Too long", templateId: oversized },
  ] }), /invalid reader option/u);
  assert.throws(() => validateOptionsPatch({ anki: {
    ...options.anki,
    templates: [{ ...options.anki.templates[0], id: oversized }],
  } }), /invalid reader option/u);
});

test("GSM word, reading and sentence link markers encode once and reject unsafe URLs", () => {
  const values = { word: "蜂 & %s", reading: "はち", sentence: "蜂はどこ？ / a=b" };
  const expanded = expandCustomLinkUrl("https://example.test/search?word=%w&reading=%r&sentence=%s", values);
  const url = new URL(expanded);
  assert.equal(url.searchParams.get("word"), values.word);
  assert.equal(url.searchParams.get("reading"), values.reading);
  assert.equal(url.searchParams.get("sentence"), values.sentence);
  for (const template of [
    "javascript:alert('%w')", "data:text/html,%s", "file:///tmp/%w", "https:example.test/%w",
    "https:/example.test/%w", "https://user:pass@example.test/%w", "\nhttps://example.test/%w",
  ]) {
    assert.equal(expandCustomLinkUrl(template, values), null, template);
    assert.match(validateLinkButton("Unsafe", template), /http/u, template);
  }
  assert.equal(validateLinkButton("Pair", "https://example.test/?q=%w,%r"), "");
  assert.match(validateLinkButton("", "https://example.test/%w"), /name/u);
});

function fixture(t, { experimental = {} } = {}) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: "https://extension.test/settings.html" });
  const { document } = dom.window;
  const el = id => document.getElementById(id);
  let buttons = [];
  let templates = [{ id: "default", name: "Default" }, { id: "sentence", name: "Sentence card" }];
  const saves = [];
  let nextId = 0;
  const controller = createCustomButtonSettings({ document, readButtons: () => buttons,
    readTemplates: () => templates, createId: () => `button-${++nextId}`,
    readExperimental: () => experimental,
    readAudioSources: () => [{ id: "jpod", type: "jpod101", enabled: true }],
    saveButtons(value) { saves.push(value); buttons = value; } });
  function change(id, value, event = "input") {
    el(id).value = value;
    el(id).dispatchEvent(new dom.window.Event(event, { bubbles: true }));
  }
  function addLink(label, url) {
    change("opt-custom-button-name", label);
    change("opt-custom-button-url", url);
    el("custom-button-submit").click();
  }
  function addAnki(label, templateId) {
    change("opt-custom-button-name", label);
    change("opt-custom-button-type", "anki", "change");
    change("opt-custom-button-template", templateId, "change");
    el("custom-button-submit").click();
  }
  const rows = () => [...el("custom-button-list").children];
  const row = label => rows().find(node => node.querySelector("strong").textContent === label);
  const action = (label, text) => [...row(label).querySelectorAll("button")].find(node => node.textContent === text);
  t.after(() => dom.window.close());
  return { window: dom.window, document, el, controller, saves, change, addLink, addAnki, rows, row, action,
    labels: () => rows().map(node => node.querySelector("strong").textContent),
    get buttons() { return buttons; },
    receive(value) { buttons = value; controller.render(); },
    templates(value) { templates = value; controller.render(); },
    experimental(value) { experimental = value; controller.render(); },
  };
}

test("button editor creates link and Anki actions, then edits, reorders and deletes them with stable IDs", t => {
  const f = fixture(t);
  // The editor is on Design, and the reorder steps below check where keyboard
  // focus lands. A browser focuses a rendered control only (jsdom too, since
  // 30.1.2), so show the section, as opening Design does.
  f.el("design").hidden = false;
  assert.equal(f.el("custom-button-empty").hidden, false);
  f.addLink("Jisho", "https://jisho.org/search/%w");
  f.addAnki("Mine sentence", "sentence");
  assert.deepEqual(f.buttons, [
    { id: "button-1", type: "link", label: "Jisho", url: "https://jisho.org/search/%w" },
    { id: "button-2", type: "anki", label: "Mine sentence", templateId: "sentence" },
  ]);
  assert.equal(f.row("Mine sentence").querySelector(".custom-button-kind").textContent, "Anki");
  assert.match(f.row("Mine sentence").textContent, /Sentence card/u);

  f.row("Mine sentence").querySelector('[data-action="up"]').click();
  assert.deepEqual(f.labels(), ["Mine sentence", "Jisho"]);
  assert.deepEqual(f.buttons.map(button => button.id), ["button-2", "button-1"]);
  assert.equal(f.document.activeElement.dataset.action, "down");

  f.action("Mine sentence", "Edit").click();
  assert.equal(f.el("custom-button-submit").textContent, "Save button");
  assert.equal(f.el("opt-custom-button-type").value, "anki");
  assert.equal(f.el("opt-custom-button-template").value, "sentence");
  f.change("opt-custom-button-name", "Mine context");
  f.change("opt-custom-button-template", "default", "change");
  f.el("custom-button-submit").click();
  assert.deepEqual(f.buttons[0], { id: "button-2", type: "anki", label: "Mine context", templateId: "default" });

  f.action("Jisho", "Edit").click();
  f.change("opt-custom-button-url", "https://example.test/local/%w");
  f.receive([{ id: "button-2", type: "anki", label: "Mine context", templateId: "default" },
    { id: "button-1", type: "link", label: "Other window", url: "https://example.test/current/%w" }]);
  f.el("custom-button-submit").click();
  assert.match(f.el("custom-buttons-status").textContent, /changed elsewhere/u);
  f.controller.reset();
  assert.deepEqual(f.labels(), ["Mine context", "Other window"]);

  f.action("Mine context", "Delete").click();
  f.action("Other window", "Delete").click();
  assert.deepEqual(f.buttons, []);
  assert.equal(f.el("custom-button-empty").hidden, false);
});

test("Template renames update Anki button summaries without discarding a link draft", t => {
  const f = fixture(t);
  f.addAnki("Mine sentence", "sentence");
  f.change("opt-custom-button-name", "Unfinished link");
  f.change("opt-custom-button-url", "https://example.test/%w");
  f.templates([{ id: "default", name: "Default" }, { id: "sentence", name: "Sentence and audio" }]);
  assert.match(f.row("Mine sentence").textContent, /Sentence and audio/u);
  assert.equal(f.el("opt-custom-button-name").value, "Unfinished link");
  assert.equal(f.controller.dirty(), true);
});

test("global Settings search reaches Custom buttons with keyboard-focusable native controls", t => {
  const f = fixture(t);
  f.change("opt-custom-button-name", "Unfinished link");
  f.window.HTMLElement.prototype.scrollIntoView = function () {};
  const search = createSettingsSearch({ document: f.document, navigate(section) {
    search.clear();
    for (const node of f.document.querySelectorAll("main > section")) node.hidden = node.id !== section;
    f.controller.render();
  } });
  const input = f.el("settings-search");
  input.value = "custom buttons name";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  const result = [...f.el("settings-search-matches").querySelectorAll("a")]
    .find(node => node.querySelector("strong").textContent === "Button name");
  assert.ok(result);
  result.click();
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.document.activeElement, f.el("opt-custom-button-name"));
  assert.equal(f.el("opt-custom-button-name").value, "Unfinished link");
  assert.equal(f.el("custom-button-submit").type, "submit");
});

test("More custom buttons: action, script, icon and marker fields are stored, and validated as written", () => {
  const { normaliseCustomButtons, effectiveCustomButtons, extendedCustomButton } = globalThis.HDReaderOptions;
  const buttons = normaliseCustomButtons([
    { id: "view", type: "action", label: "View in Anki", action: "viewNotes", argument: "x", icon: "book-search" },
    { id: "next", type: "action", label: "Next", action: "nextEntry", argument: "3" },
    { id: "kana", type: "anki", label: "Mine as kana", templateId: "default",
      markers: { " Expression ": "READING", glossary: "glossary", "{bad}": "reading" } },
    { id: "speak", type: "script", label: "Speak", icon: "not-an-icon" },
    { id: "search", type: "action", label: "Search line", action: "searchNextLine" },
    { id: "jisho", type: "link", label: "Jisho", url: "https://jisho.org/search/%w" },
  ]);
  assert.deepEqual(buttons, [
    { id: "view", type: "action", label: "View in Anki", action: "viewNotes", argument: "", icon: "book-search" },
    { id: "next", type: "action", label: "Next", action: "nextEntry", argument: "3" },
    { id: "kana", type: "anki", label: "Mine as kana", templateId: "default", markers: { expression: "reading" } },
    { id: "speak", type: "script", label: "Speak" },
    { id: "jisho", type: "link", label: "Jisho", url: "https://jisho.org/search/%w" },
  ], "search-page actions are not button actions, and unknown icons and no-op substitutions drop");
  assert.deepEqual(buttons.map(extendedCustomButton), [true, true, true, true, false]);
  assert.deepEqual(effectiveCustomButtons(buttons, {}).map(button => button.id), ["jisho"]);
  assert.equal(effectiveCustomButtons(buttons, { popupActions: true }), buttons);
  assert.deepEqual(validateOptionsPatch({ customButtons: buttons }).customButtons, buttons);
  assert.throws(() => validateOptionsPatch({ customButtons: [{ ...buttons[2], markers: { Expression: "reading" } }] }),
    /invalid reader option/u);
  assert.equal(globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental.popupActions, false);
});

test("More custom buttons off: only link and Anki kinds are offered, and its buttons stay listed but cannot be edited", t => {
  const f = fixture(t);
  const offered = () => [...f.el("opt-custom-button-type").options].filter(option => !option.disabled).map(option => option.value);
  assert.deepEqual(offered(), ["link", "anki"]);
  assert.equal(f.el("custom-button-presets").hidden, true);
  assert.equal(f.el("custom-button-icon-field").hidden, true);
  f.change("opt-custom-button-type", "anki", "change");
  assert.equal(f.el("custom-button-markers-field").hidden, true);
  f.receive([{ id: "view", type: "action", label: "View in Anki", action: "viewNotes", argument: "" },
    { id: "jisho", type: "link", label: "Jisho", url: "https://jisho.org/search/%w" }]);
  assert.equal(f.action("View in Anki", "Edit").disabled, true);
  assert.match(f.row("View in Anki").textContent, /Hidden: turn on More custom buttons/u);
  assert.equal(f.action("Jisho", "Edit").disabled, false);
  f.experimental({ popupActions: true });
  assert.deepEqual(offered(), ["link", "anki", "action", "script"]);
  assert.equal(f.action("View in Anki", "Edit").disabled, false);
  assert.doesNotMatch(f.row("View in Anki").textContent, /Hidden/u);
});

test("ready-made buttons fill the form for View in Anki, Mine as kana and Jisho; action arguments and markers save", t => {
  const f = fixture(t, { experimental: { popupActions: true } });
  const preset = id => f.el("custom-button-preset-list").querySelector(`[data-preset="${id}"]`);
  preset("view-notes").click();
  assert.equal(f.el("opt-custom-button-type").value, "action");
  assert.equal(f.el("opt-custom-button-action").value, "viewNotes");
  assert.equal(f.el("opt-custom-button-icon").value, "book-search");
  f.el("custom-button-submit").click();
  preset("mine-kana").click();
  assert.equal(f.el("opt-custom-button-markers").value,
    "{expression} → {reading}\n{furigana} → {reading}\n{furigana-plain} → {reading}");
  f.el("custom-button-submit").click();
  preset("jisho").click();
  f.el("custom-button-submit").click();
  assert.deepEqual(f.buttons, [
    { id: "button-1", type: "action", label: "View in Anki", action: "viewNotes", argument: "", icon: "book-search" },
    { id: "button-2", type: "anki", label: "Mine as kana", templateId: "default",
      markers: { expression: "reading", furigana: "reading", "furigana-plain": "reading" } },
    { id: "button-3", type: "link", label: "Jisho", url: "https://jisho.org/search/%w", icon: "search" },
  ]);
  assert.match(f.row("Mine as kana").textContent, /Default · \{expression\} → \{reading\}/u);

  f.change("opt-custom-button-name", "Two on");
  f.change("opt-custom-button-type", "action", "change");
  f.change("opt-custom-button-action", "nextEntry", "change");
  assert.equal(f.el("custom-button-count-field").hidden, false);
  f.change("opt-custom-button-count", "0");
  f.el("custom-button-submit").click();
  assert.match(f.el("custom-buttons-status").textContent, /count of 1 or more/u);
  f.change("opt-custom-button-count", "2");
  f.el("custom-button-submit").click();
  f.change("opt-custom-button-name", "Pronounce");
  f.change("opt-custom-button-type", "action", "change");
  f.change("opt-custom-button-action", "playAudioFromSource", "change");
  f.el("custom-button-submit").click();
  assert.match(f.el("custom-buttons-status").textContent, /pronunciation source/u);
  f.change("opt-custom-button-source", "jpod", "change");
  f.el("custom-button-submit").click();
  f.change("opt-custom-button-name", "Speak");
  f.change("opt-custom-button-type", "script", "change");
  assert.equal(f.el("custom-button-script-help").hidden, false);
  f.el("custom-button-submit").click();
  f.change("opt-custom-button-name", "Broken");
  f.change("opt-custom-button-type", "anki", "change");
  f.change("opt-custom-button-markers", "{expression} → {nope}");
  f.el("custom-button-submit").click();
  assert.match(f.el("custom-buttons-status").textContent, /Unknown marker: \{nope\}/u);
  f.change("opt-custom-button-markers", "expression reading");
  f.el("custom-button-submit").click();
  assert.match(f.el("custom-buttons-status").textContent, /\{marker\} → \{marker\}/u);
  assert.deepEqual(f.buttons.slice(3), [
    { id: "button-4", type: "action", label: "Two on", action: "nextEntry", argument: "2" },
    { id: "button-5", type: "action", label: "Pronounce", action: "playAudioFromSource", argument: "jpod" },
    { id: "button-6", type: "script", label: "Speak" },
  ]);
  f.action("Two on", "Edit").click();
  assert.equal(f.el("opt-custom-button-count").value, "2");
  assert.equal(f.controller.dirty(), false);
});
