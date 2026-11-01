// SPDX-License-Identifier: GPL-3.0-or-later
//
// Capabilities in Settings (docs/languages.md 7): the data-requires markup
// agrees with OPTION_REQUIREMENTS; a profile without a requirement hides its
// controls (and their group), Settings search and the keybind editor skip
// them, Word highlighting hides as a whole, and labels name the language.
// A Japanese profile's page is today's.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { LANGUAGES, PACKAGE, extension, openSettings, plain, settle } from "./language-settings-harness.mjs";

const context = {};
vm.runInNewContext(extension("reader-options.js"), { globalThis: context, URL });
const { OPTION_REQUIREMENTS, KEYBIND_TOGGLE_OPTIONS } = context.HDReaderOptions;

// Controls of the option keys without a data-design-setting of their own.
const KEY_CONTROLS = {
  wordHighlightEnabled: "opt-word-highlight",
  wordHighlightUnknown: "opt-word-highlight-unknown",
  wordHighlightLearning: "opt-word-highlight-learning",
  wordHighlightKnown: "opt-word-highlight-known",
  wordHighlightIgnored: "opt-word-highlight-ignored",
  wordHighlightStyle: "opt-word-highlight-style",
};
const REQUIREMENT_KINDS = new Set(["readings", "ruby", "pitchAccent", "characterView", "wordHighlighting",
  "ankiNoteTypeFamilies"]);

function parse(value) {
  return value.startsWith("{") ? JSON.parse(value) : value;
}

test("every requirement-bound option's control carries its requirement, and every data-requires is a known kind", t => {
  const { document } = openSettings(t);
  for (const [key, { requires }] of Object.entries(OPTION_REQUIREMENTS)) {
    const controls = KEY_CONTROLS[key]
      ? [document.getElementById(KEY_CONTROLS[key])]
      : [...document.querySelectorAll(`[data-design-setting="${key}"]`)];
    assert.ok(controls.length > 0 && controls.every(Boolean), `${key} has a Settings control`);
    for (const control of controls) {
      const holder = control.closest("[data-requires]");
      assert.ok(holder, `${key}'s control carries data-requires`);
      assert.deepEqual(parse(holder.dataset.requires), requires, key);
    }
  }
  for (const node of document.querySelectorAll("[data-requires]")) {
    const requirement = parse(node.dataset.requires);
    assert.ok(REQUIREMENT_KINDS.has(requirement) || Array.isArray(requirement?.scripts), node.dataset.requires);
    // A Design control with a requirement is in OPTION_REQUIREMENTS under that requirement.
    const key = node.dataset.designSetting;
    if (key) assert.deepEqual(OPTION_REQUIREMENTS[key]?.requires, requirement, key);
  }
  // Anki's automatic setup, presets and their hint need note-type families (section 12).
  assert.deepEqual([...document.querySelectorAll('[data-requires="ankiNoteTypeFamilies"]')].map(node =>
    node.querySelector("#anki-find-setup, #anki-preset") ? node.querySelector("#anki-find-setup, #anki-preset").id
      : node.textContent.trim()),
  ["anki-find-setup", "Kiku, Lapis and Senren fill their matching fields automatically.", "anki-preset"]);
});

test("a Japanese profile hides nothing and keeps today's labels, with or without a registry", async t => {
  for (const languages of [null, LANGUAGES]) {
    const settings = openSettings(t, { hash: "#design", languages, stored: { options: { revision: 1 } } });
    await settings.page.start();
    await settle();
    const { document } = settings;
    assert.equal(document.querySelectorAll("[data-requirement-unmet]").length, 0);
    assert.equal([...document.querySelectorAll("[data-requires]")].filter(node => node.localName !== "section"
      && node.hidden).length, 0, "no requirement-bound control is hidden");
    assert.equal(settings.el("opt-japanese-only").closest("label").textContent.trim(), "Japanese text only");
    assert.match(settings.el("activation-key-hint").textContent, /hover over Japanese text/u);
    assert.equal(document.querySelector('[data-design-setting="kanjiClickDictionary"] .field-label').textContent,
      "Clicked-kanji dictionary");
    assert.deepEqual(settings.search("pitch badges"), ["Show pitch badges"]);
    assert.deepEqual(settings.search("mark unknown words"), ["Mark unknown words"]);
  }
});

test("an Arabic profile hides pitch accent, the clicked-kanji dictionary and Anki's note-type setup, and keeps their values", async t => {
  const settings = openSettings(t, { hash: "#design", stored: { options: { revision: 1, showPitchAccentGraph: true,
    kanjiClickDictionary: { title: "KANJIDIC", kind: "kanji" } },
  dictionaryState: { schemaVersion: 1, revision: 1, groups: [],
    dictionaries: [PACKAGE("a".repeat(32), "KANJIDIC", { termCount: 0, kanjiCount: 1 })] } } });
  await settings.page.start();
  await settle();
  const { document, el, page } = settings;
  page.edit({ id: "ar", language: "ar", packSettings: {} });
  await settle();
  const pitch = document.querySelector('[data-design-setting="showPitchAccentGraph"]');
  assert.equal(pitch.hidden, true);
  assert.equal(pitch.closest("fieldset").hidden, true, "the Pitch accent group hides with its controls");
  assert.equal(document.querySelector('[data-design-setting="kanjiClickDictionary"]').hidden, true);
  assert.equal(document.querySelector('[data-design-setting="popupColumns"]').hidden, false, "core controls stay");
  for (const node of document.querySelectorAll('[data-requires="ankiNoteTypeFamilies"]')) assert.equal(node.hidden, true);
  // Kept: hiding never writes or changes the value.
  assert.equal(page.options().showPitchAccentGraph, true);
  assert.equal(Object.keys(page.pending()).length, 0);
  assert.equal(settings.messages.filter(message => message.type === "hd_options_write").length, 0);
  // Search skips what is hidden, and still finds what is shown.
  assert.deepEqual(settings.search("pitch badges"), []);
  assert.deepEqual(settings.search("clicked"), []);
  assert.deepEqual(settings.search("find existing setup"), []);
  assert.deepEqual(settings.search("definition columns"), ["Definition columns"]);
  // Labels name the edited profile's language (section 7.4).
  assert.equal(el("opt-japanese-only").closest("label").textContent.trim(), "Arabic text only");
  assert.match(el("activation-key-hint").textContent, /hover over Arabic text/u);
  assert.match(el("personal-dictionary-help").textContent, /^Highlighting Arabic text looks it up/u);
  assert.equal(el("personal-dictionary-help").querySelector("a").getAttribute("href"), "#keybinds", "links survive");
  // Back to Japanese, everything returns as it was.
  page.edit({ id: "ja", language: "ja", packSettings: {} });
  await settle();
  assert.equal(pitch.hidden, false);
  assert.equal(pitch.closest("fieldset").hidden, false);
  assert.equal(document.querySelectorAll("[data-requirement-unmet]").length, 0);
  assert.equal(el("opt-japanese-only").closest("label").textContent.trim(), "Japanese text only");
  assert.deepEqual(settings.search("pitch badges"), ["Show pitch badges"]);
});

test("the theme filter and the requirement both decide a Design control", async t => {
  // Nazeka declares no pitch settings; JL declares two.
  const settings = openSettings(t, { hash: "#design", stored: { options: { revision: 1, popupTheme: "jl" } } });
  await settings.page.start();
  await settle();
  const { document, page } = settings;
  const furigana = document.querySelector('label[data-design-setting="showPitchAccentFurigana"]');
  const graph = document.querySelector('[data-design-setting="showPitchAccentGraph"]');
  assert.deepEqual([furigana.hidden, graph.hidden], [false, true], "JL shows its pitch reading only");
  page.edit({ id: "en", language: "en", packSettings: {} });
  await settle();
  assert.deepEqual([furigana.hidden, graph.hidden], [true, true], "English has no pitch accent in any theme");
  page.edit({ id: "ja", language: "ja", packSettings: {} });
  await settle();
  assert.deepEqual([furigana.hidden, graph.hidden], [false, true], "the theme's own choice comes back");
});

test("a language without word highlighting hides the whole section, its tab and picker option, and #word-highlighting leads to Reading", async t => {
  const languages = { ...LANGUAGES, xx: { ...LANGUAGES.en, code: "xx", name: "Example",
    capabilities: { ...LANGUAGES.en.capabilities, wordHighlighting: false } } };
  const settings = openSettings(t, { hash: "#word-highlighting", languages, stored: { options: { revision: 1 } } });
  await settings.page.start();
  await settle();
  const { el, page } = settings;
  const tab = () => el("reading-navigation").querySelector('a[href="#word-highlighting"]');
  const option = () => el("settings-section").querySelector('option[value="word-highlighting"]');
  assert.deepEqual(settings.visible(), ["word-highlighting"]);
  page.edit({ id: "xx", language: "xx", packSettings: {} });
  await settle();
  assert.deepEqual(settings.visible(), ["lookup"]);
  assert.equal(tab().hidden, true);
  assert.equal(option().hidden, true);
  assert.equal(el("reading-navigation").hidden, true, "Reading has no tabs left to show");
  assert.deepEqual(settings.search("mark unknown words"), []);
  settings.navigate("word-highlighting");
  assert.equal(page.activeSection(), "lookup");
  page.edit({ id: "en", language: "en", packSettings: {} });
  await settle();
  assert.equal(tab().hidden, false);
  assert.equal(option().hidden, false);
  settings.navigate("word-highlighting");
  assert.equal(page.activeSection(), "word-highlighting");
});

test("an optional capability turned on by a pack setting shows the settings that require it", async t => {
  const korean = { ...LANGUAGES.ar, code: "ko", name: "Korean", scripts: ["Kore"], direction: "ltr",
    capabilities: { ...LANGUAGES.ar.capabilities, characterView: { name: "Hanja", pattern: "[\\u4E00-\\u9FFF]",
      readingLabels: { onyomi: "Eum", kunyomi: "Hun" }, readingSeparator: ", ", optional: true } },
    settings: [{ id: "hanja", type: "boolean", default: false, label: "Hanja character view", group: "lookup",
      effect: { capability: "characterView" } }] };
  const settings = openSettings(t, { hash: "#design", languages: { ...LANGUAGES, ko: korean },
    stored: { options: { revision: 1 } } });
  await settings.page.start();
  await settle();
  const { document, page } = settings;
  const kanji = document.querySelector('[data-design-setting="kanjiClickDictionary"]');
  page.edit({ id: "ko", language: "ko", packSettings: {} });
  await settle();
  assert.equal(kanji.hidden, true);
  page.edit({ id: "ko", language: "ko", packSettings: { hanja: true } });
  await settle();
  assert.equal(kanji.hidden, false);
  assert.equal(kanji.querySelector(".field-label").textContent, "Clicked-hanja dictionary");
  assert.equal(document.getElementById("opt-kanji-dictionary").options[0].textContent,
    "Automatic — use every hanja dictionary");
});

test("the keybind editor offers only Toggle options the edited language has and marks a stored one it lacks", async t => {
  const keybinds = [{ action: "toggleOption", argument: "showPitchAccentBadge", key: "KeyP", modifiers: ["alt"],
    scopes: ["popup"], enabled: true }, { action: "toggleOption", argument: "hoverEnabled", key: "KeyH",
    modifiers: ["alt"], scopes: ["popup"], enabled: true }];
  const settings = openSettings(t, { hash: "#keybinds", stored: { options: { revision: 1, keybinds } } });
  await settings.page.start();
  await settle();
  const { document, page } = settings;
  const select = index => document.querySelectorAll("#keybind-list .keybind-option")[index];
  const note = index => document.querySelectorAll("#keybind-list .keybind-option-note")[index];
  const offered = index => [...select(index).options].filter(option => !option.hidden).map(option => option.value);
  assert.deepEqual(offered(1), ["", ...KEYBIND_TOGGLE_OPTIONS], "Japanese offers every toggle");
  assert.equal(note(0).hidden, true);
  page.edit({ id: "en", language: "en", packSettings: {} });
  await settle();
  const pitch = KEYBIND_TOGGLE_OPTIONS.filter(key => OPTION_REQUIREMENTS[key]?.requires === "pitchAccent");
  assert.ok(pitch.length > 0);
  assert.deepEqual(offered(1), ["", ...KEYBIND_TOGGLE_OPTIONS.filter(key => !pitch.includes(key))]);
  assert.equal(select(0).value, "showPitchAccentBadge", "the stored bind is kept");
  assert.equal(note(0).hidden, false);
  assert.equal(note(0).textContent, "Not available in English");
  assert.equal([...select(1).options].find(option => option.value === "onlyScanJapaneseText").textContent,
    "English text only");
  assert.deepEqual(plain(page.options().keybinds), keybinds, "nothing is rewritten");
});

