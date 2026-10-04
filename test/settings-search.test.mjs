// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/reader-options.js";
import { createSettingsSearch } from "../extension/settings-search.js";
import { applyDesignSettings, createThemeStore } from "../extension/theme-store.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function fixture(t, initialSection = "dictionaries") {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: `https://extension.test/settings.html#${initialSection}` });
  const { document } = dom.window;
  const el = id => document.getElementById(id);
  const navigations = [];
  let activeSection = initialSection;
  let scrolled;
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled = this; };
  const sections = [...document.querySelectorAll("main > section")];
  for (const section of sections) section.hidden = section.id !== activeSection;
  const controller = createSettingsSearch({ document, navigate(section) {
    navigations.push(section ?? activeSection);
    activeSection = section ?? activeSection;
    controller.clear();
    for (const node of sections) node.hidden = node.id !== activeSection;
  } });
  const input = el("settings-search");
  function query(value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function key(value) {
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
  }
  function match(label) {
    return [...el("settings-search-matches").querySelectorAll("a")]
      .find(link => link.querySelector("strong").textContent === label);
  }
  t.after(() => dom.window.close());
  return { document, window: dom.window, controller, el, input, query, key, match, navigations,
    get scrolled() { return scrolled; } };
}

test("global search finds inactive section controls and lazy Audio by its voice keywords", t => {
  const f = fixture(t);
  f.query("reading activation key");
  const result = f.match("Activation key or button");
  assert.ok(result, "inactive Reading controls are searchable");
  assert.match(result.querySelector("small").textContent, /Reading/u);
  assert.equal(f.el("dictionaries").hidden, true);
  result.click();
  assert.equal(f.el("lookup").hidden, false);
  assert.equal(f.document.activeElement, f.el("opt-activation-key"));
  assert.equal(f.el("settings-search-results").hidden, true);
  f.query("Ｖｏｉｃｅ");
  assert.ok(f.match("Audio"), "voice is discoverable before lazy Audio rows are mounted");
  f.query("flashcards");
  assert.ok(f.match("Anki"), "flashcard settings are discoverable before lazy field mappings are mounted");
  f.query("experimental");
  const experimental = f.match("Experimental features");
  assert.ok(experimental, "the experimental group is discoverable before its rows are mounted");
  assert.match(experimental.querySelector("small").textContent, /Advanced/u);
});

test("No key and hover searches lead to the Activation key picker, as does its hidden keep-open switch", t => {
  const f = fixture(t);
  for (const query of ["no key", "hover"]) {
    f.query(query);
    const result = f.match("Activation key or button");
    assert.ok(result, `"${query}" finds the Activation key picker`);
    result.click();
    assert.equal(f.document.activeElement, f.el("opt-activation-key"));
  }
  f.el("opt-lookup-sticky-row").hidden = true;
  f.query("keep popup open");
  f.match("Keep the popup open after releasing the key or button").click();
  assert.equal(f.document.activeElement, f.el("opt-activation-key"));
});

test("Library exposes its related views together and search reports that hierarchy", t => {
  const f = fixture(t);
  const expected = [
    ["dictionaries", "Dictionaries"],
    ["add-dictionaries", "Add"],
    ["updates", "Updates"],
    ["dictionary-groups", "Groups"],
    ["custom-dictionary", "Personal dictionary"],
  ];
  const navigation = f.el("library-navigation");
  assert.ok(navigation);
  assert.deepEqual(
    [...navigation.querySelectorAll("a")].map(link => [link.hash.slice(1), link.textContent.trim()]),
    expected,
  );
  assert.deepEqual(
    [...f.el("settings-section").querySelector('optgroup[label="Library"]').querySelectorAll("option")]
      .map(option => [option.value, option.textContent.trim()]),
    expected,
  );
  f.query("default automatic updates");
  const result = f.match("Default automatic updates");
  assert.ok(result);
  assert.equal(result.querySelector("small").textContent, "Library › Updates");
  f.query("dictionaries search");
  const dictionarySearch = f.match("Search");
  assert.ok(dictionarySearch);
  assert.equal(dictionarySearch.querySelector("small").textContent, "Library › Dictionaries");
});

test("result opens collapsed details and focuses the existing textarea without touching its draft", t => {
  const f = fixture(t);
  const draft = f.el("opt-custom-popup-css");
  const disclosure = draft.closest("details");
  draft.value = ".gloss-image { border-radius: 12px; } /* unfinished */";
  draft.setSelectionRange(8, 16);
  let changes = 0;
  draft.addEventListener("input", () => { changes++; });
  draft.addEventListener("change", () => { changes++; });
  f.query("popup stylesheet");
  assert.equal(disclosure.open, false);
  f.match("Popup stylesheet").click();
  assert.equal(disclosure.open, true);
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.document.activeElement, draft);
  assert.equal(f.el("opt-custom-popup-css"), draft, "search never clones or rebuilds controls");
  assert.equal(draft.value, ".gloss-image { border-radius: 12px; } /* unfinished */");
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [8, 16]);
  assert.equal(changes, 0);
});

test("hidden conditional results lead to their visible enable control without enabling the feature", t => {
  const f = fixture(t);
  f.el("opt-blur-count").checked = false;
  f.query("threshold lookups");
  f.match("Threshold (lookups)").click();
  assert.equal(f.el("lookup").hidden, false);
  assert.equal(f.document.activeElement, f.el("opt-blur-count"));
  assert.equal(f.el("definition-blur-reveal-controls").hidden, true);
  assert.equal(f.el("definition-blur-count-controls").hidden, true);
  assert.equal(f.el("opt-blur-count").checked, false);
  assert.equal(f.scrolled, f.el("definition-blur-settings"));
});

test("highlight, selection and custom dictionary searches find the personal dictionary switch", t => {
  const f = fixture(t);
  for (const words of ["highlight", "selection", "custom dictionary"]) {
    f.query(words);
    const result = f.match("Use the personal dictionary");
    assert.ok(result, `"${words}" finds the switch`);
    assert.equal(result.querySelector("small").textContent, "Library › Personal dictionary › Lookups");
  }
  // Off, the notice switch it governs is hidden and leads back to it.
  f.el("selection-notice-controls").hidden = true;
  f.query("selection has no definition");
  f.match("Show a popup when a selection has no definition").click();
  assert.equal(f.document.activeElement, f.el("opt-personal-dictionary"));
  assert.equal(f.el("custom-dictionary").hidden, false);
});

test("unmatched markup query remains plain text and clearing restores the active page", t => {
  const f = fixture(t, "design");
  f.query('<img src=x onerror="alert(1)">');
  assert.equal(f.el("settings-search-matches").childElementCount, 0);
  assert.match(f.el("settings-search-count").textContent, /No settings found/u);
  assert.equal(f.el("settings-search-results").querySelector("img"), null);
  assert.equal(f.el("design").hidden, true);
  f.query("");
  assert.equal(f.el("settings-search-results").hidden, true);
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.el("dictionaries").hidden, true);
  assert.equal(f.document.activeElement, f.input);
});

test("arrow keys traverse results and Escape restores the active section from input or results", t => {
  const f = fixture(t, "anki");
  f.query("audio");
  const links = [...f.el("settings-search-matches").querySelectorAll("a")];
  assert.ok(links.length > 1);
  f.key("ArrowDown");
  assert.equal(f.document.activeElement, links[0]);
  f.key("ArrowDown");
  assert.equal(f.document.activeElement, links[1]);
  f.key("ArrowUp");
  assert.equal(f.document.activeElement, links[0]);
  f.key("ArrowUp");
  assert.equal(f.document.activeElement, f.input);
  f.key("ArrowDown");
  f.key("Escape");
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.el("anki").hidden, false);
  assert.equal(f.input.value, "");
  f.query("nothing-matches-this-setting");
  f.key("Escape");
  assert.equal(f.el("settings-search-results").hidden, true);
  assert.equal(f.el("anki").hidden, false);
});

test("moved settings are found under the section that now owns them", t => {
  const f = fixture(t);
  for (const [words, label, breadcrumb, section] of [
    ["audio button", "Show the audio button", "Audio", "audio"],
    ["grace period", "Grace period to reach the popup", "Reading › Popup closing", "lookup"],
    ["leaving the popup", "Delay after leaving the popup", "Reading › Popup closing", "lookup"],
    ["threshold dictionary", "Blur threshold dictionary", "Reading › Definition blur", "lookup"],
  ]) {
    f.query(words);
    const result = f.match(label);
    assert.ok(result, `"${words}" finds ${label}`);
    assert.equal(result.querySelector("small").textContent, breadcrumb);
    result.click();
    assert.equal(f.el(section).hidden, false);
  }
});

const { themes: catalogue } = JSON.parse(readFileSync(new URL("../extension/vendor/themes/index.json", import.meta.url), "utf8"));
const catalogueTheme = slug => catalogue.find(theme => theme.slug === slug);
// Shown Design legends ("# …") and control labels, in page order.
function designControls(document) {
  return [...document.querySelectorAll("#design .design-controls legend, #design .design-controls label.field, #design .design-controls label.lookup-enable")]
    .filter(node => !node.closest("[hidden], #custom-button-form"))
    .map(node => node.matches("legend") ? `# ${node.textContent}`
      : (node.querySelector(".field-label") ?? node.querySelector("span")).textContent);
}
const CORE_DESIGN = ["# Appearance", "Theme", "Width", "Height", "Scale", "Highlight the word on the page"];
const JL_DESIGN = ["# Appearance", "Theme", "Background opacity", "Width", "Height", "Scale", "Highlight the word on the page",
  "# Definitions", "Clicked-kanji dictionary", "# Pitch accent", "Show pitch in furigana", "Pitch accent dictionary"];

test("Design shows the core controls and only the settings the selected theme declares", t => {
  const f = fixture(t, "design");
  const design = f.el("design");
  const everything = designControls(f.document);
  const expected = {
    plain: CORE_DESIGN,
    nazeka: [...CORE_DESIGN, "# Definitions", "Clicked-kanji dictionary"],
    jl: JL_DESIGN,
    bee: ["# Appearance", "Theme", "Background opacity", "Width", "Height", "Scale", "Highlight the word on the page",
      "# Definitions", "Compact glossaries", "Image source", "Image hover preview", "Clicked-kanji dictionary",
      "# Frequency labels", "Show frequency dictionary names", "Abbreviate large numbers (51.5k)", "Show frequency averages",
      "# Pitch accent", "Show pitch in furigana", "Pitch accent dictionary", "Furigana pitch style", "# Custom buttons"],
    default: everything,
  };
  for (const [slug, controls] of Object.entries(expected)) {
    applyDesignSettings(design, catalogueTheme(slug));
    assert.deepEqual(designControls(f.document), controls, slug);
    assert.equal(f.el("opt-custom-popup-css").closest("[hidden]"), null, "Custom CSS is core");
    assert.equal(f.el("reset-design").closest("[hidden]"), null, "Reset Design is core");
    assert.equal(f.el("popup-theme-hint").hidden, slug === "default");
  }
  assert.equal(design.querySelectorAll("[data-design-setting][hidden], [data-design-group][hidden]").length, 0,
    "Default leaves Design unchanged");
  applyDesignSettings(design, catalogueTheme("plain"));
  assert.equal(f.el("popup-theme-hint").textContent,
    "Plain uses only the settings shown here. Your other Design settings are kept for Default.");
  for (const undeclared of [{ slug: "new", name: "New" }, undefined]) {
    applyDesignSettings(design, catalogueTheme("plain"));
    applyDesignSettings(design, undeclared);
    assert.deepEqual(designControls(f.document), everything, "a theme without a declaration shows every control");
    assert.equal(f.el("popup-theme-hint").hidden, true);
  }
});

test("search offers no Design control the selected theme hides", t => {
  const f = fixture(t);
  const design = f.el("design");
  applyDesignSettings(design, catalogueTheme("plain"));
  for (const [words, label] of [["pitch badges", "Show pitch badges"], ["compact summary", "Compact summary"],
    ["custom buttons", "Custom buttons"]]) {
    f.query(words);
    assert.equal(f.match(label), undefined, `Plain hides ${label}`);
  }
  applyDesignSettings(design, catalogueTheme("default"));
  f.query("pitch badges");
  f.match("Show pitch badges").click();
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.document.activeElement, f.el("opt-pitch-badge"));
});

test("Design follows the latest theme in use, even with the Store off, and shows everything without a catalogue", async t => {
  const f = fixture(t, "design");
  const design = f.el("design");
  const everything = designControls(f.document);
  const settle = () => new Promise(done => setImmediate(done));
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const store = () => createThemeStore({ root: f.el("theme-store"), design, onSelect() {} });
  const options = popupTheme => ({ popupTheme, experimental: { themeStore: false } });
  let respond;
  globalThis.fetch = () => new Promise(resolve => { respond = resolve; });
  const slow = store();
  slow.render(options("plain"));
  slow.render(options("jl"));
  respond({ ok: true, json: async () => ({ themes: catalogue }) });
  await settle();
  assert.deepEqual(designControls(f.document), JL_DESIGN, "the earlier Plain selection does not apply");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  store().render(options("plain"));
  await settle();
  assert.deepEqual(designControls(f.document), everything);
  assert.equal(f.el("popup-theme-hint").hidden, true);
});
