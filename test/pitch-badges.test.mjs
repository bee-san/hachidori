// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const entry = (position, pattern = "", nasal = [], devoice = []) => ({ position, pattern, nasal, devoice });
const pitch = (dictionary, ...pitches) => ({ dictionary, pitches: pitches.map(value =>
  typeof value === "object" ? value : entry(value)), transcriptions: [] });
const result = (expression, reading, pitches) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, rules: "", frequencies: [], pitches,
    glossaries: [{ dictionary: "Jitendex", glossary: JSON.stringify(["gloss"]), termTags: "" }] } });
const RESULT = result("昭和", "しょうわ", [pitch("NHK", 0), pitch("Daijirin", 1)]);

function fixture(t) {
  const dom = new JSDOM('<p>昭和の映画</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test" });
  const { window } = dom;
  const { document } = window;
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const { HDReaderOptions, HDGlossary, HDPopup } = window;
  const popup = document.getElementById("popup");
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    positionPopup() {},
  });
  const source = document.querySelector("p");
  const candidate = { anchor: source, query: "昭和", sentence: source.textContent, sourceElements: [source], matchOffset: 0 };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, render: (value = RESULT, options = {}) => {
    view.renderResults([value], candidate, { ...HDReaderOptions.normaliseOptions({}), ...options });
    return [...popup.querySelectorAll(".pronunciation-group")];
  } };
}

const levels = pronunciation => [...pronunciation.querySelectorAll(".pronunciation-mora")]
  .map(mora => `${mora.textContent}:${mora.dataset.pitch}>${mora.dataset.pitchNext}`);
const representations = pronunciation => [...pronunciation.querySelector(".pronunciation-representation-list").children]
  .map(node => node.className);

test("each pitch dictionary is a Yomitan pronunciation group named by its dictionary tag", t => {
  const f = fixture(t);
  const groups = f.render();
  assert.deepEqual(groups.map(group => group.dataset.dictionary), ["NHK", "Daijirin"]);
  groups.forEach((group, index) => {
    const tag = group.querySelector(".pronunciation-group-tag-list > .tag");
    assert.equal(tag.dataset.category, "pronunciation-dictionary");
    assert.equal(tag.dataset.details, group.dataset.dictionary);
    assert.equal(tag.textContent, group.dataset.dictionary);
    const [pronunciation] = group.querySelectorAll(".pronunciation-list > .pronunciation");
    assert.equal(pronunciation.dataset.pronunciationType, "pitch-accent");
    assert.equal(pronunciation.dataset.pitchAccentDownstepPosition, String(index));
    // Yomitan's defaults: text and [n] notation on, graph off.
    assert.deepEqual(representations(pronunciation),
      ["pronunciation-text-container", "pronunciation-downstep-notation-container"]);
    assert.equal(pronunciation.querySelector(".pronunciation-text-container").lang, "ja");
    assert.equal(pronunciation.querySelector(".pronunciation-downstep-notation").textContent, `[${index}]`);
    assert.equal(pronunciation.title, `${group.dataset.dictionary}: しょうわ [${index}]`);
    assert.equal(pronunciation.getAttribute("aria-label"), pronunciation.title);
  });
  assert.deepEqual(levels(groups[0].querySelector(".pronunciation")),
    ["しょ:low>high", "う:high>high", "わ:high>high"]);
  assert.deepEqual(levels(groups[1].querySelector(".pronunciation")),
    ["しょ:high>low", "う:low>low", "わ:low>low"]);
});

test("a dictionary's accents share one group and a string pattern reads as its downstep", t => {
  const f = fixture(t);
  // hoshidicts hands Yomitan's "LHL" over as { position: 0, pattern: "LHL" }.
  const [group] = f.render(result("橋", "はし", [pitch("Kanjium", entry(0, "LHL"), 2, 0)]));
  const pronunciations = [...group.querySelectorAll(".pronunciation")];
  assert.equal(group.querySelector(".pronunciation-list").dataset.count, "3");
  assert.deepEqual(pronunciations.map(node => node.querySelector(".pronunciation-downstep-notation").textContent),
    ["[2]", "[2]", "[0]"]);
  assert.deepEqual(levels(pronunciations[0]), ["は:low>high", "し:high>low"]);
  assert.deepEqual(levels(pronunciations[0]), levels(pronunciations[1]));
  assert.equal(pronunciations[0].title, "Kanjium: はし [2]");
  // The furigana contour reads the same pattern: a drop after し, not heiban.
  const reading = f.popup.querySelector(".gsm-hoshidicts-pitch-reading");
  assert.equal(reading.dataset.pitchPosition, "2");
  assert.deepEqual([...f.popup.querySelectorAll(".gsm-hoshidicts-expression .gsm-hoshidicts-pitch-mora")]
    .map(mora => `${mora.dataset.pitchLevel}:${mora.dataset.pitchTransition ?? ""}`), ["low:rise", "high:drop"]);
});

test("the overline furigana style draws the headword with the pronunciation list's Yomitan text", t => {
  const f = fixture(t);
  const [group] = f.render(result("食べる", "たべる", [pitch("NHK", 2)]), { pitchAccentFuriganaStyle: "overline" });
  const expression = f.popup.querySelector(".gsm-hoshidicts-expression");
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  const contours = [...expression.querySelectorAll(".gsm-hoshidicts-pitch-contour")];
  const segments = contours.map(levels);
  assert.deepEqual(segments, [["た:low>high"], ["べ:high>low", "る:low>low"]]);
  assert.deepEqual(segments.flat(), levels(group.querySelector(".pronunciation")), "the same levels as the list");
  assert.ok(contours.every(contour => contour.dataset.pitchStyle === "overline"));
  assert.equal(expression.querySelectorAll(".gsm-hoshidicts-pitch-mora").length, 0);
  assert.equal(expression.querySelectorAll(".pronunciation-mora > .pronunciation-mora-line").length, 3);
  const reading = expression.querySelector(".gsm-hoshidicts-pitch-reading");
  assert.equal(reading.dataset.pitchPosition, "2");
  assert.equal(reading.dataset.pitchDictionary, "NHK");
  assert.equal(reading.title, "NHK · Pitch accent 2");
  f.view.updateDictionaryPresentation({ pitchAccentFuriganaStyle: "contour" });
  assert.deepEqual([...f.popup.querySelectorAll(".gsm-hoshidicts-expression .gsm-hoshidicts-pitch-mora")]
    .map(mora => `${mora.dataset.pitchLevel}:${mora.dataset.pitchTransition ?? ""}`), ["low:rise", "high:drop", "low:"]);
  assert.ok(card.isConnected && f.popup.querySelector(".gsm-hoshidicts-glossary-card") === card,
    "a style switch keeps the definitions");
  // 見る [1] drops at the segment boundary: み, the first segment's last mora, hooks.
  f.render(result("見る", "みる", [pitch("NHK", 1)]), { pitchAccentFuriganaStyle: "overline" });
  assert.deepEqual([...f.popup.querySelectorAll(".gsm-hoshidicts-expression .gsm-hoshidicts-pitch-contour")]
    .map(levels), [["み:high>low"], ["る:low>low"]]);
});

test("the text, position and graph toggles update an open popup without replacing definitions", t => {
  const f = fixture(t);
  f.render(RESULT);
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  const first = () => f.popup.querySelector(".pronunciation");
  f.view.updateDictionaryPresentation({ showPitchAccentGraph: true });
  assert.deepEqual(representations(first()), ["pronunciation-text-container",
    "pronunciation-downstep-notation-container", "pronunciation-graph-container"]);
  const graph = first().querySelector("svg.pronunciation-graph");
  assert.equal(graph.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(graph.getAttribute("viewBox"), "0 0 200 100");
  f.view.updateDictionaryPresentation({ showPitchAccentText: false, showPitchAccentPosition: false });
  assert.deepEqual(representations(first()), ["pronunciation-graph-container"]);
  assert.equal(first().title, "NHK: しょうわ [0]", "the label outlives hidden notations");
  assert.ok(card.isConnected && f.popup.querySelector(".gsm-hoshidicts-glossary-card") === card);
});

test("nasal and devoiced morae carry Yomitan's marks", t => {
  const f = fixture(t);
  const [group] = f.render(result("学生", "がくせい", [pitch("NHK", entry(0, "", [1], [2]))]));
  const [nasal, devoiced] = group.querySelectorAll(".pronunciation-mora");
  assert.equal(nasal.dataset.nasal, "true");
  assert.equal(nasal.dataset.originalText, "が");
  assert.equal(nasal.querySelector(".pronunciation-character").textContent, "か");
  assert.ok(nasal.querySelector(".pronunciation-nasal-indicator"));
  assert.equal(devoiced.dataset.devoice, "true");
  assert.ok(devoiced.querySelector(".pronunciation-devoice-indicator"));
});

test("aliases relabel the dictionary tag in place and the names switch hides it live", t => {
  const f = fixture(t);
  const [group] = f.render();
  const tag = group.querySelector(".pronunciation-group-tag-list > .tag");
  const pronunciation = group.querySelector(".pronunciation");
  f.view.updateDictionaryPresentation({ dictionaryPresentation: [{ title: "NHK", displayName: "NHK 日本語発音アクセント辞典" }] });
  assert.ok(pronunciation.isConnected);
  assert.equal(pronunciation.title, "NHK 日本語発音アクセント辞典 (NHK): しょうわ [0]");
  assert.equal(group.querySelector(".pronunciation-group-tag-list > .tag"), tag, "a rename keeps the tag element");
  assert.equal(tag.querySelector(".tag-label-content").textContent, "NHK 日本語発音アクセント辞典");
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  const labels = () => [...f.popup.querySelectorAll(".pronunciation-group-tag-list")].map(node => node.textContent);
  f.view.updateDictionaryPresentation({ showPitchAccentDictionaryNames: false });
  assert.deepEqual(labels(), []);
  assert.equal(f.popup.querySelectorAll(".pronunciation").length, 2);
  f.view.updateDictionaryPresentation({ showPitchAccentDictionaryNames: true });
  assert.deepEqual(labels(), ["NHK 日本語発音アクセント辞典", "Daijirin"]);
  assert.ok(card.isConnected && f.popup.querySelector(".gsm-hoshidicts-glossary-card") === card);
});
