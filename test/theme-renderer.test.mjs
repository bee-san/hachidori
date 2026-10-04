// Focused renderer boundary and fallback contracts.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import plain from "../extension/vendor/themes/plain/theme.js";
import theme from "../extension/vendor/themes/nazeka/theme.js";
import bee from "../extension/vendor/themes/bee/theme.js";
const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const extension = resolve(import.meta.dirname, "../extension");
function environment(html = "<div id='host'></div>") {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  for (const name of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "theme-host.js"]) dom.window.eval(readFileSync(resolve(extension, name), "utf8"));
  return dom;
}
const results = [{ matched: "食べる", trace: [], term: { expression: "食べる", reading: "たべる", frequencies: [],
  glossaries: [{ dictionary: "test", glossary: JSON.stringify([{ type: "structured-content", content: [
    { tag: "b", content: "eat " }, { tag: "a", href: "https://example.test", content: "food" },
    { tag: "img", path: "test.png" },
  ] }]) }] } }];
test("Nazeka builds text directly, binds core actions, and never constructs Default or rich DOM", () => {
  const dom = environment(), { window } = dom, { document } = window;
  try {
    const popup = document.createElement("div"); document.body.append(popup);
    let bound;
    const view = theme.createView({ document, window, popup, positionPopup() {},
      components: window.HDPopup && { ...window.HDPopup, glossaryToPlainText: window.HDGlossary.glossaryToPlainText },
      appendTextOnlyGlossary() { throw new Error("rich renderer called"); },
      onResultsRendered(value) { bound = value; },
    });
    view.renderResults(results, { query: "食べる" });
    assert.match(popup.textContent, /eat food/);
    assert.equal(popup.querySelectorAll("img,a,b,.gsm-hoshidicts-result-chrome,.gsm-hoshidicts-glossary-card").length, 0);
    assert.equal(bound.audioButtons[0].result, results[0]);
    assert.equal(bound.miningActions[0].result, results[0]);
    assert.equal(bound.lookupStats, null);
    assert.equal(popup.querySelector(".nazeka-count"), null);
    const second = { ...results[0], term: { ...results[0].term, glossaries: [
      { dictionary: "second", glossary: "other definition" },
    ] } };
    view.renderResults([results[0], second], { query: "食べる" });
    const entries = popup.querySelectorAll(".gsm-hoshidicts-entry");
    entries[1].querySelector(".gsm-hoshidicts-glossary-content").click();
    assert.equal(view.currentEntryIndex(), 1, "clicking text selects its entry for keyboard actions");
    let scrolled;
    view.scrollElement.scrollTo = value => { scrolled = value; };
    view.scrollElement.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
    entries.forEach((entry, index) => {
      entry.querySelector(".nazeka-sense").getBoundingClientRect = () => ({ top: index * 100, bottom: index * 100 + 50 });
    });
    entries[0].click();
    assert.equal(view.focusEntry({ dictionary: 1 }), true);
    assert.equal(view.currentEntryIndex(), 1);
    assert.equal(scrolled.top, 100);
    assert.equal(view.focusEntry({ dictionary: 1 }), false);
    view.destroy(); assert.equal(popup.children.length, 0);
  } finally { dom.window.close(); }
});
test("text traversal retains deeply nested content without building DOM", () => {
  const dom = environment();
  try {
    let data = "deep";
    for (let i = 0; i < 1000; i++) data = { tag: "div", content: data };
    assert.equal(dom.window.HDGlossary.glossaryToPlainText(data), "deep");
    assert.equal(dom.window.HDGlossary.glossaryToPlainText({ content: [
      { tag: "img", title: "Caption" }, { tag: "summary", content: "Note" }, { tag: "p", content: "Text" },
    ] }), "Caption\nNote\nText");
    assert.equal(dom.window.HDGlossary.glossaryToPlainText([{ content: ["食", { tag: "b", content: "べる" }] }, "eat"]), "食べる\neat");
  } finally { dom.window.close(); }
});
test("text traversal lays out Jitendex-style structured content like JL", () => {
  const dom = environment();
  try {
    const tag = content => ({ tag: "span", data: { class: "tag" }, content });
    const special = content => ({ tag: "span", data: { class: "form-special" }, content });
    assert.equal(dom.window.HDGlossary.glossaryToPlainText([{ type: "structured-content", content: [
      { tag: "div", content: [tag("noun"), tag("adverb"),
        { tag: "ol", content: { tag: "li", style: { listStyleType: "\"①\"" }, content: { tag: "ul", content: { tag: "li", content: "yesterday" } } } },
        { tag: "div", content: [{ tag: "ruby", content: ["昨日", { tag: "rp", content: "(" }, { tag: "rt", content: "きのう" }, { tag: "rp", content: ")" }] }, "は"] }] },
      { tag: "div", content: [tag("forms"), { tag: "table", content: [
        { tag: "tr", content: [{ tag: "th" }, { tag: "th", content: "昨日" }] },
        { tag: "tr", content: [{ tag: "th", content: [special("《"), "きのう", special("》")] }, { tag: "td", content: { tag: "span", title: "high priority form" } }] },
      ] }] },
    ] }]), "noun adverb\n①\n• yesterday\n昨日[きのう]は\nforms\n|  | 昨日 |\n| 《きのう》 | high priority form |");
  } finally { dom.window.close(); }
});
test("renderer failure replays the current model with Default CSS and keeps the preference", async () => {
  const dom = environment(), { window } = dom, { document } = window;
  const original = theme.createView;
  try {
    const options = { popupTheme: "nazeka" }, fetched = [], rendered = [];
    window.chrome = { runtime: { getURL: path => pathToFileURL(resolve(extension, path)).href } };
    window.fetch = async url => { fetched.push(url); return { ok: true, text: async () => url.includes("nazeka") ? ".nazeka-only {}" : ".default-only {}" }; };
    window.HDPopup.createPopupView = () => ({ renderResults: value => rendered.push(value), destroy() {} });
    const host = window.HDThemeHost.createThemeHost({ getOptions: () => options });
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    host.attach(shadow);
    theme.createView = () => ({ renderResults() { throw new Error("injected failure"); }, destroy() {}, captureTermView() {} });
    await host.sync();
    assert.equal(fetched.some(url => url.includes("reader.css")), false);
    const popup = document.createElement("div"); shadow.append(popup);
    const view = host.createView({ document, window, popup });
    view.renderResults(results, {});
    await host.sync();
    assert.equal(rendered[0], results);
    assert.equal(options.popupTheme, "nazeka");
    assert.equal(shadow.host.dataset.hoshidictsRenderer, "default");
    const css = [...shadow.querySelectorAll("style")].map(node => node.textContent).join("")
      + [...(shadow.adoptedStyleSheets || [])].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join("");
    assert.match(css, /default-only/);
    assert.doesNotMatch(css, /nazeka-only/);
    view.destroy();
  } finally { theme.createView = original; dom.window.close(); }
});

test("Plain writes complete definitions directly with no action or metadata DOM", () => {
  const dom = environment(), { window } = dom, { document } = window;
  try {
    const popup = document.createElement("div");
    let bound;
    const view = plain.createView({ document, popup, positionPopup() {},
      components: { glossaryToPlainText: window.HDGlossary.glossaryToPlainText },
      onResultsRendered(value) { bound = value; },
    });
    view.renderResults(results, { query: "食べる" });
    assert.equal(popup.textContent, "eat food");
    assert.equal(popup.querySelectorAll("*").length, 1);
    assert.equal(popup.querySelectorAll("button,img,a,.gsm-hoshidicts-expression").length, 0);
    assert.deepEqual(bound, { audioButtons: [], miningActions: [], lookupStats: null });
    view.destroy();
  } finally { dom.window.close(); }
});

test("JL renders one block per dictionary, binds each shown block to its own definitions and switches tabs in place", async () => {
  const dom = environment(), { window } = dom, { document } = window;
  try {
    window.chrome = { runtime: { getURL: path => pathToFileURL(resolve(extension, path)).href } };
    window.fetch = async () => ({ ok: true, text: async () => "" });
    const host = window.HDThemeHost.createThemeHost({ getOptions: () => ({ popupTheme: "jl" }) });
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    host.attach(shadow);
    await host.sync();
    assert.equal(shadow.host.dataset.hoshidictsRenderer, "jl");
    const popup = document.createElement("div"); shadow.append(popup);
    let bound, expanded, tab;
    const view = host.createView({ document, window, popup, positionPopup() {},
      onResultsRendered(value) { bound = value; }, onResultsExpanded(value) { expanded = value; } });
    const result = { matched: "食べた", trace: [{ name: "-た" }], term: { expression: "食べる", reading: "たべる",
      frequencies: [{ dictionary: "JPDB", frequencies: [{ value: 9209, displayValue: "9209" }, { value: 9500, displayValue: "9500" }] }],
      pitches: [{ dictionary: "NHK", pitches: [{ position: 2, pattern: "", nasal: [], devoice: [] }] }],
      glossaries: [
        { dictionary: "JMdict", glossary: JSON.stringify(["to eat", "to have a meal"]), definitionTags: "v1 vt" },
        { dictionary: "JMdict", glossary: JSON.stringify(["to live on"]), definitionTags: "v1 vt col" },
        { dictionary: "大辞泉", glossary: JSON.stringify(["た・べる【食べる】"]), definitionTags: "" },
      ] } };
    const context = { dictionaryPresentation: [{ title: "大辞泉" }, { title: "JMdict", displayName: "JM" }],
      onDictionaryTabSelected(value) { tab = value; } };
    view.renderResults([result], { query: "食べた" }, context);
    const blocks = [...popup.querySelectorAll(".gsm-hoshidicts-entry")];
    assert.deepEqual(blocks.map(block => block.querySelector(".gsm-hoshidicts-glossary-content").textContent),
      ["[v1, vt]\n1. to eat; to have a meal\n2. [col] to live on", "た・べる【食べる】"]);
    assert.deepEqual(bound.miningActions.map(item => item.result.term.glossaries.length), [2, 1]);
    assert.equal(bound.audioButtons[1].result, bound.miningActions[1].result);
    assert.equal(bound.lookupStats, null);
    assert.deepEqual(["jl-deconj", "jl-frequency", "jl-dictionary"].map(name => blocks[0].querySelector(`.${name}`).textContent),
      ["食べた ～-た", "#9209", "JM"]);
    assert.deepEqual([...blocks[0].querySelectorAll(".jl-reading .jl-mora")]
      .map(mora => [mora.textContent, mora.dataset.pitch, mora.dataset.transition]),
    [["た", "low", "rise"], ["べ", "high", "drop"], ["る", "low", undefined]]);
    const tabs = [...popup.querySelectorAll(".jl-tab")];
    assert.deepEqual(tabs.map(button => [button.textContent, button.getAttribute("aria-pressed")]),
      [["All", "true"], ["大辞泉", "false"], ["JM", "false"]]);
    tabs[1].click();
    assert.deepEqual(tab, { dictionary: "大辞泉" });
    assert.deepEqual(blocks.map(block => block.hidden), [true, false]);
    assert.deepEqual(expanded.miningActions.map(item => item.result.term.glossaries[0].dictionary), ["大辞泉"],
      "core rebinds audio, Anki and keybinds to the shown blocks");
    assert.equal(expanded.audioButtons[0].button, bound.audioButtons[1].button);
    assert.equal(view.currentEntryIndex(), 0, "keyboard actions index the shown blocks");
    assert.equal(popup.querySelectorAll(".gsm-hoshidicts-entry")[1], blocks[1], "switching tabs does not rebuild");
    assert.equal(bound.miningActions[1].actions.isConnected, true);
    view.renderResults([result], { query: "食べた" }, { ...context, selectedDictionaryTab: tab });
    assert.deepEqual([...popup.querySelectorAll(".gsm-hoshidicts-entry")].map(block => block.hidden), [true, false],
      "Back restores the selected tab");
    assert.deepEqual(bound.miningActions.map(item => item.result.term.glossaries[0].dictionary), ["大辞泉"],
      "Back binds the restored tab's blocks, so autoplay starts from the first one shown");
    view.destroy();
  } finally { dom.window.close(); }
});

function beeFixture(t, overrides = {}) {
  const dom = environment(), { window } = dom, { document } = window;
  const popup = document.createElement("div"); document.body.append(popup);
  const components = { ...window.HDPopup, ...window.HDGlossary };
  const view = bee.createView({ document, window, popup, positionPopup() {},
    components,
    appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary, ...overrides });
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, window, components };
}
const beeResult = { ...results[0], term: { ...results[0].term, glossaries: [
  { ...results[0].term.glossaries[0], definitionTags: "v1 vt ★" }, { dictionary: "second", glossary: '["meal"]', definitionTags: "n" },
] } };
const beeContext = { dictionaryPresentation: [{ title: "test", favorite: true }, { title: "second" }],
  dictionaryTabGroups: [{ id: "first", name: "English", dictionaries: ["test"] },
    { id: "both", name: "Everything", dictionaries: ["test", "second"] }] };

test("Bee keeps All results accessible alongside named groups and restores an explicit group on Back", t => {
  let bound, selected;
  const f = beeFixture(t, { onResultsRendered(value) { bound = value; }, onResultsExpanded(value) { bound = value; } });
  f.view.renderResults([beeResult], { query: "食べる" }, { ...beeContext, onDictionaryTabSelected(value) { selected = value; } });
  assert.deepEqual([...f.popup.querySelectorAll(".jl-tab")].map(node => node.textContent), ["All", "English", "Everything"]);
  assert.equal(selected, undefined, "a fresh lookup keeps the core's All selection");
  assert.equal(bound.miningActions.length, 2, "All includes dictionaries outside the first group");
  const blocks = [...f.popup.querySelectorAll(".jl-entry")];
  f.popup.querySelectorAll(".jl-tab")[1].click();
  assert.deepEqual(selected, { groupId: "first" });
  assert.deepEqual(blocks.map(node => node.hidden), [false, true]);
  assert.equal(bound.miningActions.length, 1);
  const saved = f.view.captureTermView();
  f.view.renderResults([beeResult], { query: "食べる" }, { ...beeContext, ...saved, onDictionaryTabSelected(value) { selected = value; } });
  assert.equal(f.popup.querySelectorAll('.jl-entry:not([hidden])').length, 1);
  const all = f.popup.querySelector(".jl-tab");
  all.click();
  assert.equal(selected, null);
  all.focus();
  f.view.updateDictionaryPresentation({ ...beeContext, ...saved, dictionaryTabGroups: [
    { id: "first", name: "Renamed", dictionaries: ["test"] },
  ] });
  assert.equal(f.view.captureTermView().selectedDictionaryTab, null, "a previous group context cannot override All");
  assert.equal(f.popup.ownerDocument.activeElement, f.popup.querySelector(".jl-tab"), "group updates retain deliberate tab focus");
  assert.equal(f.popup.querySelectorAll('.jl-entry:not([hidden])').length, 2);
  assert.deepEqual(bound.miningActions.map(item => item.result.term.glossaries[0].dictionary), ["test", "second"]);
  assert.equal(f.popup.querySelectorAll(".jl-spelling").length, 2, "retain JL's repeated headers");
  f.view.renderResults([beeResult], { query: "食べる" }, { ...beeContext, selectedDictionaryTab: null });
  assert.equal(f.popup.querySelectorAll('.jl-entry:not([hidden])').length, 2, "See links with null selection show all dictionaries");
  f.view.renderResults([beeResult], { query: "食べる" });
  assert.equal(f.popup.querySelectorAll(".jl-tab").length, 0, "ungrouped dictionaries never become tabs");
  assert.equal(f.popup.querySelectorAll('.jl-entry:not([hidden])').length, 2);
});

test("Bee renders only the formatted glossary, without JL text or tag brackets; retired replies cannot publish", async t => {
  let requests = 0, resolveMedia;
  const f = beeFixture(t);
  f.view.renderResults([beeResult], { query: "食べる" }, { generation: 8,
    resolveMedia() { requests++; return new Promise(resolve => { resolveMedia = resolve; }); } });
  assert.equal(f.popup.querySelector(".bee-rich-definition, .bee-rich-tags"), null);
  const contents = [...f.popup.querySelectorAll(".gsm-hoshidicts-glossary-content")];
  assert.ok(contents.every(content => content.classList.contains("bee-rich-content")), "no plain-text glossary");
  assert.match(contents[0].textContent, /eat food/);
  assert.doesNotMatch(f.popup.textContent, /\[|★|\bv1\b/, "no JMdict tag brackets in Bee");
  assert.equal(f.popup.querySelector("a").href, "https://example.test/");
  assert.equal(f.popup.querySelectorAll("img").length, 1);
  assert.equal(requests, 1);
  const image = f.popup.querySelector("img");
  f.view.renderNotice("No match", { query: "unknown" });
  resolveMedia("data:image/png;base64,AA==");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(image.hasAttribute("src"), false);
});

test("Bee enlarges a hovered glossary image beside the popup and hides it on leave, clear and destroy", async t => {
  let mode = "large";
  const f = beeFixture(t, { getImageHoverPreview: () => mode, getPageZoom: () => 1 });
  const host = f.popup.parentNode;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  f.view.renderResults([beeResult], { query: "食べる" }, { resolveMedia: async () => "data:image/png;base64,AA==" });
  await settle();
  const link = f.popup.querySelector(".gloss-image-link");
  assert.equal(link.dataset.imageLoadState, "loaded");
  link.dispatchEvent(new f.window.Event("mouseenter"));
  const preview = host.querySelector(".gsm-hoshidicts-image-hover-preview");
  assert.ok(preview && !f.popup.contains(preview), "preview is a sibling of the popup");
  assert.equal(preview.querySelector("img").src, "data:image/png;base64,AA==");
  link.dispatchEvent(new f.window.Event("mouseleave"));
  assert.equal(host.querySelector(".gsm-hoshidicts-image-hover-preview"), null);
  link.dispatchEvent(new f.window.Event("mouseenter"));
  f.view.renderNotice("No match", { query: "unknown" });
  assert.equal(host.querySelector(".gsm-hoshidicts-image-hover-preview"), null, "clear hides the preview");
  mode = "off";
  f.view.renderResults([beeResult], { query: "食べる" }, { resolveMedia: async () => "data:image/png;base64,AA==" });
  await settle();
  f.popup.querySelector(".gloss-image-link").dispatchEvent(new f.window.Event("mouseenter"));
  assert.equal(host.querySelector(".gsm-hoshidicts-image-hover-preview"), null, "Reading → Image hover preview Off is respected");
});

test("Bee reuses Note save/Escape and custom actions, retaining a draft through group presentation updates", t => {
  const saves = [], links = [];
  const buttons = [
    { id: "link", type: "link", label: "Search", url: "https://example.test/%w" },
    { id: "anki", type: "anki", label: "Sentence", templateId: "sentence" },
    { id: "more", type: "link", label: "More", url: "https://example.test/%r" },
  ];
  const f = beeFixture(t, { customButtons: buttons, onAddCustomEntry(entry) { saves.push({ ...entry }); },
    onCustomLinkClick(link) { links.push(link); } });
  f.view.renderResults([beeResult], { query: "食べる" }, beeContext);
  assert.equal(f.popup.querySelector('[data-custom-button-id="anki"]').dataset.ankiTemplateId, "sentence");
  assert.equal(f.popup.querySelector('.bee-action-menu [data-custom-button-id="more"]').textContent, "More");
  f.popup.querySelector('[data-custom-button-id="link"]').click();
  assert.equal(links[0].url, "https://example.test/%E9%A3%9F%E3%81%B9%E3%82%8B");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  assert.equal(form.elements.term.value, "食べる");
  assert.equal(form.elements.reading.value, "たべる");
  form.elements.definition.value = "My meaning";
  f.view.updateDictionaryPresentation({ ...beeContext, dictionaryTabGroups: [
    { id: "both", name: "All grouped", dictionaries: ["test", "second"] }] });
  assert.equal(form.hidden, false);
  assert.equal(form.elements.definition.value, "My meaning");
  form.dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  form.dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  assert.deepEqual(saves, [{ term: "食べる", reading: "たべる", definition: "My meaning" }]);
  assert.deepEqual([...f.popup.querySelectorAll(".jl-tab")].map(node => node.textContent), ["All", "All grouped"]);
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  assert.equal(f.view.closeNoteForm(), true);
  assert.equal(form.hidden, true);
});

test("Bee dismisses More actions before Note and preserves the action and draft", async t => {
  const links = [];
  const f = beeFixture(t, { customButtons: [
    { id: "one", type: "link", label: "One", url: "https://example.test/one" },
    { id: "two", type: "link", label: "Two", url: "https://example.test/two" },
    { id: "more", type: "link", label: "More", url: "https://example.test/%w" },
  ], onCustomLinkClick(link) { links.push(link); } });
  f.view.renderResults([beeResult], { query: "食べる" }, beeContext);
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "Unfinished meaning";
  const more = f.popup.querySelector(".bee-more-actions");
  more.open = true;
  more.querySelector("button").focus();
  assert.equal(f.view.closeActionMenu(), true);
  assert.equal(more.open, false);
  assert.equal(f.popup.ownerDocument.activeElement, more.querySelector("summary"));
  assert.equal(form.hidden, false);
  assert.equal(form.elements.definition.value, "Unfinished meaning");
  assert.equal(f.view.closeActionMenu(), false, "a closed menu leaves Escape to Note or the popup");
  more.open = true;
  more.querySelector("button").click();
  await Promise.resolve();
  assert.equal(links[0].url, "https://example.test/%E9%A3%9F%E3%81%B9%E3%82%8B", "dismissing retains link activation");
  assert.equal(more.open, false, "selecting an action dismisses its disclosure despite stopped bubbling");
  more.open = true;
  f.popup.querySelector(".jl-spelling").dispatchEvent(new f.window.Event("pointerdown", { bubbles: true }));
  assert.equal(more.open, false, "pressing outside the menu dismisses it without discarding a Note draft");
  assert.equal(form.hidden, false);
  assert.equal(form.elements.definition.value, "Unfinished meaning");
  f.view.renderNotice("No match", { query: "unknown" });
  assert.equal(more.open, false);
  assert.equal(f.view.closeActionMenu(), false, "retired disclosures never consume Escape");
});

test("switching after a retired lookup applies saved actions to the next renderer before a fresh lookup", async t => {
  const dom = environment(), { window } = dom, { document } = window;
  t.after(() => window.close());
  const options = { popupTheme: "jl" };
  window.chrome = { runtime: { getURL: path => pathToFileURL(resolve(extension, path)).href } };
  window.fetch = async () => ({ ok: true, text: async () => "" });
  const host = window.HDThemeHost.createThemeHost({ getOptions: () => options });
  await host.sync();
  const popup = document.createElement("div"); document.body.append(popup);
  const view = host.createView({ document, window, popup, customButtons: [], positionPopup() {},
    appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary });
  t.after(() => view.destroy());
  let current = true;
  view.renderResults(results, { query: "食べる" }, { isCurrentRequest: () => current });
  view.setCustomButtons([{ id: "search", type: "link", label: "Search", url: "https://example.test/%w" }]);
  current = false; options.popupTheme = "bee";
  await host.sync();
  assert.equal(popup.querySelector(".jl-entry"), null, "do not replay obsolete content");
  view.renderResults(results, { query: "食べる" });
  assert.equal(popup.querySelector('[data-custom-button-id="search"]').textContent, "Search");
  assert.equal(host.dictionaryStyles, true);
});

// Settings → Design shows a theme only the settings its catalogue entry
// declares, so each declaration must match its renderer in both directions.
const CORE_DESIGN_SETTINGS = ["popupTheme", "popupWidthPx", "popupHeightPx", "popupScalePercent",
  "sourceHighlightEnabled", "customPopupCss", "customPopupJavascript", "customLinks"];
const designResult = { matched: "食べた", deinflected: "食べる", preprocessorSteps: 0,
  trace: [{ name: "-た", description: "past" }],
  term: { expression: "食べる", reading: "たべる", rules: "v1", score: 0,
    frequencies: [
      { dictionary: "JPDB", frequencies: [{ value: 51499, displayValue: "51499" }] },
      { dictionary: "Jiten", frequencies: [{ value: 23456, displayValue: "23456" }] },
    ],
    pitches: [
      { dictionary: "NHK", pitches: [{ position: 2, pattern: "", nasal: [], devoice: [] }], transcriptions: [] },
      { dictionary: "Daijirin", pitches: [{ position: 0, pattern: "", nasal: [], devoice: [] }], transcriptions: [] },
    ],
    glossaries: [
      { dictionary: "JMdict", glossary: JSON.stringify(["to eat", "to have a meal"]), definitionTags: "v1 vt", termTags: "common" },
      { dictionary: "Example", glossary: JSON.stringify([{ type: "structured-content", content: [
        { tag: "p", content: "朝ごはんを食べる。" }, { tag: "img", path: "meal.png", width: 160, height: 80 }] }]),
      definitionTags: "", termTags: "" },
    ] } };
const designPresentation = [
  { title: "JMdict", enabled: true, termCount: 1 }, { title: "Example", enabled: true, termCount: 1 },
  { title: "JPDB", frequencyMode: "rank-based", frequencyCount: 1, enabled: true },
  { title: "Jiten", frequencyMode: "rank-based", frequencyCount: 1, enabled: true },
  { title: "NHK", pitchCount: 1, enabled: true }, { title: "Daijirin", pitchCount: 1, enabled: true },
];
// Settings core delivers through updateDictionaryPresentation:
// [key, a value other than its default, options the flip needs to show].
const DESIGN_FLIPS = [
  ["showFrequencyDictionaryNames", true], ["compactFrequencyNumbers", true], ["averageFrequency", true],
  ["showPitchAccentFurigana", false], ["pitchAccentFuriganaDictionary", "Daijirin"],
  ["pitchAccentFuriganaStyle", "overline"],
  ["showPitchAccentBadge", false], ["showPitchAccentDictionaryNames", false], ["showPitchAccentText", false],
  ["showPitchAccentPosition", false], ["showPitchAccentGraph", true], ["hidePopupGrammarTags", false],
  ["showCompactDefinitionSummary", true],
  ["compactDefinitionSummaryCount", 1, { showCompactDefinitionSummary: true }],
  ["compactDefinitionSummaryDictionary", "Example", { showCompactDefinitionSummary: true }],
];
// Settings a renderer uses outside that update, read from one rendered popup.
const DESIGN_PROBES = {
  popupOpacityPercent: probe => probe.css.includes("--gsm-hoshidicts-popup-opacity"),
  glossaryLayoutMode: probe => probe.css.includes("data-hoshidicts-glossary-layout"),
  showPitchAccentColors: probe => probe.css.includes("data-hoshidicts-pitch-colors"),
  popupToolbarPosition: probe => probe.toolbarPosition === "bottom",
  popupColumns: probe => probe.columnReads > 0,
  popupImageSource: probe => probe.images > 0,
  imageHoverPreview: probe => probe.hoverPreviewReads > 0,
  kanjiClickDictionary: probe => probe.kanjiLinks > 0,
  customButtons: probe => probe.customButtons > 0,
};

async function designSettingsUsed(slug) {
  const dom = environment("<p id='source'>昨日は食べた</p><div id='host'></div>"), { window } = dom, { document } = window;
  try {
    window.chrome = { runtime: { getURL: path => pathToFileURL(resolve(extension, path)).href } };
    window.fetch = async () => ({ ok: true, text: async () => "" });
    const host = window.HDThemeHost.createThemeHost({ getOptions: () => ({ popupTheme: slug }) });
    await host.sync();
    const settle = (ms = 0) => new Promise(done => setTimeout(done, ms));
    const reads = { columns: 0, hoverPreview: 0 };
    const source = document.getElementById("source");
    const candidate = { query: "食べた", sentence: source.textContent, matchOffset: 2, sourceElements: [source], anchor: source };
    const context = overrides => ({ ...window.HDReaderOptions.normaliseOptions({}), dictionaryPresentation: designPresentation,
      dictionaryTabGroups: [], popupImageSources: null, generation: 1, isCurrentRequest: () => true,
      resolveMedia: async () => "data:image/png;base64,AA==", ...overrides });
    const { HDGlossary: glossary } = window;
    async function render(overrides, update) {
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      document.getElementById("host").append(popup);
      const view = host.createView({ document, window, popup, positionPopup() {},
        appendExpressionRuby: glossary.appendExpressionRuby, createPronunciationPitchAccent: glossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: glossary.appendTextOnlyGlossary, appendStructuredImage: glossary.appendStructuredImage,
        parseTagList: glossary.parseTagList, getPopupScalePercent: () => 100, toolbarPosition: "top",
        getPopupColumns: () => { reads.columns++; return 2; },
        getImageHoverPreview: () => { reads.hoverPreview++; return "all"; },
        sourceHighlighter: { apply() {}, clear() {}, refresh() {} }, sourceHighlightEnabled: true,
        onKanjiClick() {}, onResultsRendered() {}, onResultsExpanded() {} });
      view.renderResults([designResult], candidate, context(overrides));
      await settle();
      if (update) {
        view.updateDictionaryPresentation(context(update));
        view.flushDictionaryPresentation();
        await settle();
      }
      // Generated ids differ between views; compare content.
      const html = popup.innerHTML.replaceAll(/ (?:id|for|aria-controls|aria-labelledby|aria-describedby)="[^"]*"/gu, "");
      return { view, popup, html };
    }
    async function snapshot(overrides, update) {
      const { view, popup, html } = await render(overrides, update);
      view.destroy(); popup.remove();
      return html;
    }
    const used = [];
    const defaults = await snapshot({});
    assert.equal(await snapshot({}), defaults, `${slug} renders the same sample identically`);
    for (const [key, value, needs = {}] of DESIGN_FLIPS) {
      const before = Object.keys(needs).length ? await snapshot(needs) : defaults;
      const flipped = { ...needs, [key]: value };
      const after = await snapshot(flipped);
      if (after === before) continue;
      used.push(key);
      assert.equal(await snapshot(needs, flipped), after, `${slug} applies ${key} to an open popup without a new lookup`);
    }
    reads.columns = 0;
    reads.hoverPreview = 0;
    const { view, popup } = await render({});
    view.scheduleMasonry();
    view.setToolbarPosition("bottom");
    view.setCustomButtons([{ id: "search", type: "link", label: "Search", url: "https://example.test/%w" }]);
    await settle(50);
    popup.querySelector(".gloss-image-link")?.dispatchEvent(new window.Event("mouseenter"));
    const probe = { css: readFileSync(resolve(extension, slug === "default" ? "render/reader.css" : `vendor/themes/${slug}/theme.css`), "utf8"),
      toolbarPosition: popup.dataset.toolbarPosition, columnReads: reads.columns, hoverPreviewReads: reads.hoverPreview,
      images: popup.querySelectorAll(".gloss-image-link").length,
      kanjiLinks: popup.querySelectorAll(".gsm-hoshidicts-kanji-link").length,
      customButtons: popup.querySelectorAll('[data-custom-button-id="search"]').length };
    view.destroy();
    return [...used, ...Object.keys(DESIGN_PROBES).filter(key => DESIGN_PROBES[key](probe))];
  } finally { window.close(); }
}

test("each theme implements exactly the Design settings its catalogue entry declares", async () => {
  const tagged = [...new Set(Array.from(readFileSync(resolve(extension, "settings.html"), "utf8")
    .matchAll(/data-design-setting="([^"]+)"/gu), match => match[1]))];
  const dom = environment();
  try {
    assert.deepEqual([...dom.window.HDReaderOptions.DESIGN_OPTION_KEYS].filter(key => !tagged.includes(key)).sort(),
      [...CORE_DESIGN_SETTINGS].sort(), "every other Design setting is renderer-owned and tagged in Settings");
  } finally { dom.window.close(); }
  assert.deepEqual([...DESIGN_FLIPS.map(([key]) => key), ...Object.keys(DESIGN_PROBES)].sort(), [...tagged].sort(),
    "every tagged Design setting has a check");
  const { themes } = JSON.parse(readFileSync(resolve(extension, "vendor/themes/index.json"), "utf8"));
  for (const entry of themes) {
    const declared = entry.designSettings === "all" ? tagged : entry.designSettings;
    assert.ok(Array.isArray(declared) && declared.every(key => tagged.includes(key)), `${entry.slug} declares Design settings by key`);
    assert.deepEqual((await designSettingsUsed(entry.slug)).sort(), [...declared].sort(),
      `${entry.slug} uses exactly the Design settings it declares`);
  }
});

test("Bee reuses per-result metadata and repaints only changed frequency inputs", t => {
  const f = beeFixture(t);
  let frequencyCalls = 0, pitchCalls = 0;
  for (const [name, record] of [["createFrequencyTags", () => frequencyCalls++], ["buildPitchAccentMorae", () => pitchCalls++]]) {
    const original = f.components[name];
    f.components[name] = (...args) => { record(); return original(...args); };
  }
  const result = { ...beeResult, term: { ...beeResult.term,
    frequencies: [{ dictionary: "Ranks", frequencies: [{ value: 1200, displayValue: null }] }],
    pitches: [{ dictionary: "Pitch", pitches: [{ position: 2 }] }],
  } };
  const context = { ...beeContext, showFrequencyDictionaryNames: true,
    dictionaryPresentation: [...beeContext.dictionaryPresentation, { title: "Ranks", displayName: "Rank source", frequencyMode: "rank-based" }] };
  f.view.renderResults([result], { query: "食べる" }, context);
  const chips = [...f.popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")];
  assert.equal(chips.length, 2);
  assert.equal(frequencyCalls, 1, "derive frequencies once for the result's two dictionaries");
  assert.equal(pitchCalls, 1, "derive pitch once for the result's two dictionaries");
  assert.notEqual(chips[0], chips[1], "each dictionary owns its frequency DOM");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "Keep my draft";
  const glossary = f.popup.querySelector(".bee-rich-content");
  for (const change of [{}, { pitchAccentFuriganaStyle: "overline" }, {
    dictionaryPresentation: context.dictionaryPresentation.map(item => item.title === "test" ? { ...item, displayName: "Words" } : item),
  }]) {
    f.view.updateDictionaryPresentation({ ...context, ...change });
    assert.ok(chips.every((chip, index) => chip === f.popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")[index]),
      "unchanged, pitch-only and non-frequency alias updates retain exact frequency nodes");
  }
  const renamed = { ...context, dictionaryPresentation: context.dictionaryPresentation.map(item =>
    item.title === "Ranks" ? { ...item, displayName: "New source" } : item) };
  f.view.updateDictionaryPresentation(renamed);
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-frequency-source").textContent, "New source");
  assert.equal(chips[0].isConnected, false, "frequency aliases repaint");
  f.view.updateDictionaryPresentation({ ...renamed, compactFrequencyNumbers: true });
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-frequency-value").textContent, "1.2k");
  f.view.updateDictionaryPresentation({ ...renamed, averageFrequency: true });
  assert.equal(f.popup.querySelector('[data-frequency-average="rank-based"] .gsm-hoshidicts-frequency-source').textContent, "Avg rank");
  f.view.updateDictionaryPresentation({ ...renamed, showFrequencyDictionaryNames: false });
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-frequency-source"), null);
  assert.equal(f.popup.querySelector(".bee-rich-content"), glossary);
  assert.equal(form.hidden, false);
  assert.equal(form.elements.definition.value, "Keep my draft");
});
