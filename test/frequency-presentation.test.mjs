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
const RESULT = { matched: "食べました", deinflected: "食べる", trace: [
  { name: "-た", description: "Past tense" }, { name: "-ます", description: "Polite" },
], term: { expression: "食べる", reading: "たべる", rules: "v1", pitches: [], glossaries: [
  { dictionary: "Jitendex", glossary: JSON.stringify(["to eat"]), termTags: "v1" },
], frequencies: [{ dictionary: "Jiten", frequencies: [
  { value: 191, displayValue: "191" }, { value: 14200, displayValue: "14,200㋕" },
] }] } };

function fixture(t) {
  const dom = new JSDOM('<p>昨日すき焼きを食べました</p><div id="popup"></div>',
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
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
  });
  const source = document.querySelector("p");
  const candidate = { anchor: source, query: RESULT.matched, sentence: source.textContent,
    sourceElements: [source], matchOffset: 7 };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, options: HDReaderOptions, render: (options, result = RESULT) => {
    view.renderResults([result], candidate, options);
    return popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule");
  } };
}

test("fresh and partial stored options default to numeric frequencies while explicit display choices survive", t => {
  const { options } = fixture(t);
  for (const stored of [{}, { popupWidthPx: 640 }]) {
    const value = options.normaliseOptions(stored);
    assert.equal(value.showFrequencyDictionaryNames, false);
    assert.equal(value.hidePopupGrammarTags, true);
  }
  const chosen = options.normaliseOptions({ showFrequencyDictionaryNames: true, hidePopupGrammarTags: false });
  assert.equal(chosen.showFrequencyDictionaryNames, true);
  assert.equal(chosen.hidePopupGrammarTags, false);
});

test("the default Jiten frequency is quiet inline headword metadata with detail available on hover", t => {
  const f = fixture(t);
  for (const options of [undefined, f.options.normaliseOptions({})]) {
    const capsule = f.render(options);
    assert.equal(capsule.textContent, "14.2k · 191");
    assert.equal(capsule.getAttribute("aria-label"), "Entry metadata");
    assert.ok(capsule.parentElement.classList.contains("gsm-hoshidicts-headword"));
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-metadata-strip"), null);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-grammar"), null);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-source"), null);
    const frequency = capsule.querySelector(".gsm-hoshidicts-tag-frequency");
    assert.equal(frequency.title, "Jiten");
    assert.match(frequency.getAttribute("aria-label"), /Jiten:.*Kana frequency: 14200.*191/u);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-value").title, "Kana frequency: 14200");
    const deinflection = f.popup.querySelector(".gsm-hoshidicts-deinflection");
    assert.ok(deinflection, "the full explanation stays available");
    assert.ok(
      capsule.compareDocumentPosition(deinflection) & capsule.DOCUMENT_POSITION_FOLLOWING,
      "inline metadata precedes the full deinflection row"
    );
  }
});

test("live display choices keep frequency and grammar together beside the headword and preserve the definition and draft", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const capsule = f.render(defaults);
  const headword = capsule.parentElement;
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "keep my draft";
  f.view.updateDictionaryPresentation({ ...defaults, showFrequencyDictionaryNames: true, hidePopupGrammarTags: false });
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-frequencies").textContent, "Jiten14.2k㋕ · 191");
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-grammar")?.textContent, "-た-ますv1");
  f.view.updateDictionaryPresentation(defaults);
  assert.equal(capsule.textContent, "14.2k · 191");
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-grammar"), null);
  assert.equal(capsule.parentElement, headword);
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card"), card);
  assert.equal(f.popup.querySelector("form"), form);
  assert.equal(form.elements.definition.value, "keep my draft");
});

test("harmonic averages use concise typed labels without individual dictionary names", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, frequencies: [
    { dictionary: "RankDict", frequencies: [{ value: 142, displayValue: "142" }] },
    { dictionary: "CountDict", frequencies: [{ value: 12400, displayValue: "12,400" }] },
  ] } };
  const capsule = f.render({
    ...defaults,
    averageFrequency: true,
    showFrequencyDictionaryNames: true,
    dictionaryPresentation: [
      { title: "RankDict", frequencyMode: "rank-based" },
      { title: "CountDict", frequencyMode: "occurrence-based" },
    ],
  }, result);
  assert.deepEqual(
    [...capsule.querySelectorAll(".gsm-hoshidicts-frequency-source")].map(node => node.textContent),
    ["Avg rank", "Avg count"]
  );
  assert.equal(capsule.textContent, "Avg rank142Avg count12.4k");
  assert.equal(capsule.textContent.includes("RankDict"), false);
  assert.equal(capsule.textContent.includes("CountDict"), false);
  assert.deepEqual(
    [...capsule.querySelectorAll(".gsm-hoshidicts-tag-frequency")].map(node => node.title),
    ["Rank average", "Occurrence average"]
  );
});

test("opt-in grammar stays visible without frequency or dictionary tabs and hides again when disabled", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, glossaries: [], frequencies: [] } };
  const capsule = f.render({ ...defaults, hidePopupGrammarTags: false }, result);
  assert.equal(capsule.hidden, false);
  assert.ok(capsule.parentElement.classList.contains("gsm-hoshidicts-headword"));
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-metadata-strip"), null);
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-grammar")?.textContent, "-た-ますv1");
  f.view.updateDictionaryPresentation(defaults);
  assert.equal(capsule.hidden, true);
});

test("the lower metadata strip exists only for dictionary tabs", t => {
  const f = fixture(t);
  const result = { ...RESULT, term: { ...RESULT.term, glossaries: [
    ...RESULT.term.glossaries,
    { dictionary: "Second dictionary", glossary: JSON.stringify(["another meaning"]), termTags: "" },
  ] } };
  const capsule = f.render({
    ...f.options.normaliseOptions({}),
    dictionaryPresentation: [
      { title: "Jitendex", favorite: true },
      { title: "Second dictionary", favorite: true },
    ],
  }, result);
  const strip = f.popup.querySelector(".gsm-hoshidicts-metadata-strip");
  assert.ok(strip);
  assert.equal(strip.children.length, 1);
  assert.ok(strip.firstElementChild.classList.contains("gsm-hoshidicts-tab-list"));
  assert.equal(strip.contains(capsule), false);
  assert.ok(capsule.parentElement.classList.contains("gsm-hoshidicts-headword"));
});
