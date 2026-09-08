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

test("the default Jiten capsule shows compact numbers with source and kana detail available on hover", t => {
  const f = fixture(t);
  for (const options of [undefined, f.options.normaliseOptions({})]) {
    const capsule = f.render(options);
    assert.equal(capsule.textContent, "14.2k · 191");
    assert.equal(capsule.getAttribute("aria-label"), "Entry metadata");
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-grammar"), null);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-source"), null);
    const frequency = capsule.querySelector(".gsm-hoshidicts-tag-frequency");
    assert.equal(frequency.title, "Jiten");
    assert.match(frequency.getAttribute("aria-label"), /Jiten:.*Kana frequency: 14200.*191/u);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-value").title, "Kana frequency: 14200");
    assert.ok(f.popup.querySelector(".gsm-hoshidicts-deinflection"), "the full explanation stays available");
  }
});

test("live display choices keep frequency and grammar together in the metadata capsule and preserve the definition and draft", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const capsule = f.render(defaults);
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
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card"), card);
  assert.equal(f.popup.querySelector("form"), form);
  assert.equal(form.elements.definition.value, "keep my draft");
});

test("opt-in grammar stays visible without frequency or dictionary tabs and hides again when disabled", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, glossaries: [], frequencies: [] } };
  const capsule = f.render({ ...defaults, hidePopupGrammarTags: false }, result);
  const strip = capsule.parentElement;
  assert.equal(capsule.hidden, false);
  assert.equal(strip.hidden, false);
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-grammar")?.textContent, "-た-ますv1");
  f.view.updateDictionaryPresentation(defaults);
  assert.equal(capsule.hidden, true);
  assert.equal(strip.hidden, true);
});
