// SPDX-License-Identifier: GPL-3.0-or-later
// Design → Definitions → Collapse dictionaries (#671): Default's dictionary
// cards become Hoshi Reader's collapsible glossary groups, a <details> per
// dictionary whose <summary> is its name.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM || resolve("test/tooling")] }));

const result = (expression, dictionaries) => ({ matched: expression, deinflected: expression, trace: [], term: {
  expression, reading: "たべる", rules: "", frequencies: [], pitches: [],
  glossaries: dictionaries.map(dictionary => ({ dictionary, glossary: JSON.stringify([`${dictionary} definition`]),
    definitionTags: dictionary === "Jitendex" ? "v1" : "" })),
} });
const RESULTS = [result("食べる", ["Jitendex", "大辞林 第四版", "新明解"]), result("食う", ["大辞林 第四版", "新明解"])];

function fixture(t) {
  const dom = new JSDOM('<p>食べる</p><div id="popup"></div>', { pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const popup = window.document.getElementById("popup");
  const view = window.HDPopup.createPopupView({ window, document: window.document, popup, ...window.HDGlossary,
    positionPopup() {} });
  t.after(() => { view.destroy(); window.close(); });
  const candidate = { anchor: window.document.querySelector("p"), query: "食べる" };
  // Every result at once, with an alias that the card's name must show.
  const render = (context = {}) => view.renderResults(RESULTS, candidate, { expandAll: true,
    dictionaryPresentation: [{ title: "大辞林 第四版", displayName: "Daijirin" }], ...context });
  const cards = () => [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
  const states = () => cards().map(card => card.localName === "details" ? card.open : "always open");
  return { window, popup, view, candidate, render, cards, states };
}

test("collapsing off keeps today's open cards, with the dictionary's tag after the first definition's tags", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "off", expandFirstDictionary: true, collapsedDictionaries: ["Jitendex"] });
  assert.deepEqual(f.states(), Array(5).fill("always open"));
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card summary"), null);
  const row = f.cards()[0].querySelector(":scope > .gsm-hoshidicts-definitions > .definition-item > .definition-tag-list");
  assert.deepEqual([...row.children].map(tag => tag.textContent), ["v1", "Jitendex"]);
  assert.ok(row.lastElementChild.classList.contains("gsm-hoshidicts-dictionary-tag"));
});

test("Collapse all closes every card to its dictionary's name, which opens and closes it", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "all" });
  assert.deepEqual(f.states(), [false, false, false, false, false]);
  const [jitendex, daijirin] = f.cards();
  const summary = card => card.querySelector(":scope > summary.gsm-hoshidicts-glossary-summary");
  assert.deepEqual(f.cards().map(card => summary(card).textContent), ["Jitendex", "Daijirin", "新明解", "Daijirin", "新明解"]);
  // The name is the card's own dictionary tag, kept in one place: the first
  // definition's row holds only its definition tags.
  const tag = summary(daijirin).querySelector(".gsm-hoshidicts-dictionary-tag");
  assert.equal(tag.title, "大辞林 第四版");
  assert.equal(tag.dataset.category, "dictionary");
  assert.equal(daijirin.querySelectorAll(".gsm-hoshidicts-dictionary-tag").length, 1);
  assert.equal(daijirin.querySelector(".definition-tag-list"), null, "no empty tag row");
  assert.deepEqual([...jitendex.querySelectorAll(".definition-tag-list > *")].map(node => node.textContent), ["v1"]);
  // The definitions are inside the card, in the body after the summary.
  assert.equal(daijirin.querySelector(".gsm-hoshidicts-definitions > .definition-item").dataset.dictionary, "大辞林 第四版");
  summary(daijirin).click();
  assert.deepEqual(f.states(), [false, true, false, false, false]);
  summary(daijirin).click();
  assert.equal(daijirin.open, false);
});

test("Expand the first dictionary opens each result's first card", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "all", expandFirstDictionary: true });
  assert.deepEqual(f.states(), [true, false, false, true, false]);
});

test("Chosen dictionaries start collapsed while the others start open, and every card can be collapsed", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "custom", collapsedDictionaries: ["大辞林 第四版", "Not installed"] });
  assert.deepEqual(f.states(), [true, false, true, false, true]);
  f.cards()[0].querySelector(":scope > summary").click();
  assert.equal(f.cards()[0].open, false);
  f.render({ dictionaryCollapseMode: "custom", collapsedDictionaries: ["大辞林 第四版"], expandFirstDictionary: true });
  assert.deepEqual(f.states(), [true, false, true, true, true], "the first card opens even when it was chosen");
  f.render({ dictionaryCollapseMode: "custom" });
  assert.deepEqual(f.states(), [true, true, true, true, true], "nothing chosen: every card open but collapsible");
});

test("changing the collapse settings rebuilds an open popup's cards without a new lookup", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "off" });
  f.view.updateDictionaryPresentation({ dictionaryCollapseMode: "all", expandFirstDictionary: true, collapsedDictionaries: [] });
  f.view.flushDictionaryPresentation();
  assert.deepEqual(f.states(), [true, false, false, true, false]);
  f.view.updateDictionaryPresentation({ dictionaryCollapseMode: "custom", expandFirstDictionary: false,
    collapsedDictionaries: ["新明解"] });
  f.view.flushDictionaryPresentation();
  assert.deepEqual(f.states(), [true, true, false, true, false]);
  f.view.updateDictionaryPresentation({ dictionaryCollapseMode: "off", expandFirstDictionary: false, collapsedDictionaries: [] });
  f.view.flushDictionaryPresentation();
  assert.deepEqual(f.states(), Array(5).fill("always open"));
});

test("Back restores the cards the reader opened and closed", async t => {
  const f = fixture(t);
  // Back restores disclosures once the later entries' glossaries are filled.
  const settle = () => new Promise(done => f.window.setTimeout(done, 0));
  const context = { dictionaryCollapseMode: "all", expandFirstDictionary: true };
  f.render(context);
  await settle();
  f.cards()[0].querySelector(":scope > summary").click();
  f.cards()[2].querySelector(":scope > summary").click();
  const saved = f.view.captureTermView();
  f.render(context);
  await settle();
  assert.deepEqual(f.states(), [true, false, false, true, false], "a new lookup starts from the settings");
  f.render({ ...context, ...saved });
  await settle();
  assert.deepEqual(f.states(), [false, false, true, true, false]);
});

test("a blurred collapsible card keeps its name a working disclosure; its body is the click-to-reveal button", t => {
  const f = fixture(t);
  f.render({ dictionaryCollapseMode: "custom", collapsedDictionaries: ["新明解"], definitionBlurState: "blurred" });
  let reveals = 0;
  const reveal = f.window.HDPopup.createDefinitionReveal(f.popup, { revealMode: () => "click", blurred: () => reveals === 0,
    reveal: () => { reveals++; } });
  reveal.sync();
  const [jitendex, , shinmeikai] = f.cards();
  for (const card of [jitendex, shinmeikai]) {
    const body = card.querySelector(":scope > .gsm-hoshidicts-glossary-body");
    assert.equal(card.hasAttribute("data-definition-reveal"), false, "the card holds a summary, so it is not the button");
    assert.equal(body.getAttribute("role"), "button");
    assert.equal(body.getAttribute("aria-label"), "Reveal definitions");
    assert.equal(body.tabIndex, 0);
    assert.ok(body.querySelector(":scope > .gsm-hoshidicts-definitions").hasAttribute("inert"));
    assert.equal(card.querySelector(":scope > summary").closest("[data-definition-reveal], [inert]"), null);
  }
  shinmeikai.querySelector(":scope > summary").click();
  assert.equal(shinmeikai.open, true, "opening a blurred card is not a reveal");
  assert.equal(reveals, 0);
  jitendex.querySelector(":scope > .gsm-hoshidicts-glossary-body").click();
  assert.equal(reveals, 1);
  assert.equal(jitendex.open, true, "the reveal click does not close the card");
});
