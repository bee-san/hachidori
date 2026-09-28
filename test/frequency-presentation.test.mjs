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
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
  });
  const source = document.querySelector("p");
  const candidate = { anchor: source, query: RESULT.matched, sentence: source.textContent,
    sourceElements: [source], matchOffset: 7 };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, candidate, options: HDReaderOptions, api: HDPopup, render: (options, result = RESULT) => {
    view.renderResults([result], candidate, options);
    return popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule");
  } };
}

test("fresh and partial stored options default to numeric frequencies while explicit display choices survive", t => {
  const { options } = fixture(t);
  for (const stored of [{}, { popupWidthPx: 640 }]) {
    const value = options.normaliseOptions(stored);
    assert.equal(value.showFrequencyDictionaryNames, false);
    assert.equal(value.compactFrequencyNumbers, false);
    assert.equal(value.hidePopupGrammarTags, true);
  }
  const chosen = options.normaliseOptions({ showFrequencyDictionaryNames: true, compactFrequencyNumbers: true,
    hidePopupGrammarTags: false });
  assert.equal(chosen.showFrequencyDictionaryNames, true);
  assert.equal(chosen.compactFrequencyNumbers, true);
  assert.equal(chosen.hidePopupGrammarTags, false);
});

// The class path from the frequency tag down to its values, so the first
// entry's capsule and a later entry's metadata row can be compared as DOM
// shape rather than by their (different) numbers.
function tagShape(tag) {
  return [tag.className, ...[...tag.querySelectorAll("*")].map(node => node.className)];
}

test("the first entry's frequency tags share the later entries' Yomitan-like tag structure", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const second = { ...RESULT, term: { ...RESULT.term, expression: "食う", reading: "くう", frequencies: [
    { dictionary: "Jiten", frequencies: [{ value: 2048, displayValue: "2,048" }, { value: 3100, displayValue: "3,100㋕" }] },
  ] } };
  const cases = [
    { ...defaults },
    { ...defaults, showFrequencyDictionaryNames: true },
    { ...defaults, averageFrequency: true, dictionaryPresentation: [{ title: "Jiten", frequencyMode: "rank-based" }] },
  ];
  for (const options of cases) {
    f.view.renderResults([RESULT, second], f.candidate, { ...options, expandAll: true });
    const capsule = f.popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule");
    const primary = capsule.querySelector(".gsm-hoshidicts-primary-frequencies > .gsm-hoshidicts-tag-frequency");
    const later = f.popup.querySelectorAll(".gsm-hoshidicts-entry")[1]
      .querySelector(".gsm-hoshidicts-frequency-metadata > .gsm-hoshidicts-tag-frequency");
    assert.ok(primary, "first entry keeps a frequency tag in its capsule");
    assert.ok(later, "second entry renders a frequency tag in its metadata row");
    assert.deepEqual(tagShape(primary), tagShape(later));
    assert.equal(Boolean(primary.querySelector(".gsm-hoshidicts-frequency-source")),
      Boolean(options.showFrequencyDictionaryNames || options.averageFrequency));
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-frequency-label"), null);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-frequencies-default"), null);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-frequencies[data-average]"), null);
  }
});

test("the default Jiten frequency is a plain tag that preserves the kana marker", t => {
  const f = fixture(t);
  for (const options of [undefined, f.options.normaliseOptions({})]) {
    const capsule = f.render(options);
    const entry = f.popup.querySelector(".gsm-hoshidicts-entry");
    const frequencies = capsule.querySelector(".gsm-hoshidicts-primary-frequencies");
    assert.equal(capsule.textContent, "14,200㋕ · 191");
    assert.equal(capsule.getAttribute("aria-label"), "Entry metadata");
    assert.equal(capsule.closest(".gsm-hoshidicts-entry"), entry);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-header").contains(capsule), false);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-metadata-strip"), null);
    assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-grammar"), null);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-source"), null);
    assert.equal(frequencies.className, "gsm-hoshidicts-primary-frequencies");
    assert.deepEqual(
      [...frequencies.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(node => node.textContent),
      ["14,200㋕", "191"]
    );
    const frequency = capsule.querySelector(".gsm-hoshidicts-tag-frequency");
    assert.equal(frequency.title, "Jiten");
    assert.match(frequency.getAttribute("aria-label"), /Jiten:.*Kana frequency: 14200.*191/u);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-frequency-value").title, "Kana frequency: 14200");
    assert.ok(
      capsule.compareDocumentPosition(entry.querySelector(".gsm-hoshidicts-ipa-metadata"))
        & capsule.DOCUMENT_POSITION_FOLLOWING,
      "primary metadata precedes the other result metadata"
    );
  }
});

test("live display choices keep frequency and grammar in the primary result and preserve the definition and draft", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const capsule = f.render(defaults);
  const entry = capsule.closest(".gsm-hoshidicts-entry");
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "keep my draft";
  f.view.updateDictionaryPresentation({ ...defaults, showFrequencyDictionaryNames: true, hidePopupGrammarTags: false });
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-frequencies").textContent, "Jiten14,200㋕ · 191");
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-grammar")?.textContent, "-た-ますv1");
  f.view.updateDictionaryPresentation(defaults);
  assert.equal(capsule.textContent, "14,200㋕ · 191");
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-primary-grammar"), null);
  assert.equal(capsule.closest(".gsm-hoshidicts-entry"), entry);
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card"), card);
  assert.equal(f.popup.querySelector("form"), form);
  assert.equal(form.elements.definition.value, "keep my draft");
});

// A hidden tag's markup with `hidden` removed, to compare it with the tag that
// averages-off renders.
function unhiddenHTML(tag) {
  const clone = tag.cloneNode(true);
  clone.hidden = false;
  return clone.outerHTML;
}

test("harmonic averages use concise typed labels and keep each dictionary's tag hidden in the DOM", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, frequencies: [
    { dictionary: "RankDict", frequencies: [{ value: 142, displayValue: "142" }] },
    { dictionary: "CountDict", frequencies: [{ value: 12400, displayValue: "12,400" }] },
  ] } };
  const options = {
    ...defaults,
    showFrequencyDictionaryNames: true,
    dictionaryPresentation: [
      { title: "RankDict", frequencyMode: "rank-based" },
      { title: "CountDict", frequencyMode: "occurrence-based" },
    ],
  };
  const individual = [...f.render(options, result).querySelectorAll(".gsm-hoshidicts-tag-frequency")]
    .map(tag => tag.outerHTML);
  const capsule = f.render({ ...options, averageFrequency: true }, result);
  const tags = [...capsule.querySelectorAll(".gsm-hoshidicts-tag-frequency")];
  const visible = tags.filter(tag => !tag.hidden);
  assert.deepEqual(visible.map(tag => tag.querySelector(".gsm-hoshidicts-frequency-source").textContent),
    ["Avg rank", "Avg count"]);
  assert.deepEqual(visible.map(tag => tag.title), ["Rank average", "Occurrence average"]);
  assert.deepEqual(visible.map(tag => tag.dataset.frequencyAverage), ["rank-based", "occurrence-based"]);
  assert.equal(visible.map(tag => tag.textContent).join(""), "Avg rank142Avg count12400");
  // The averages-off tags follow the aggregates, unchanged apart from hidden.
  assert.deepEqual(tags.slice(visible.length).map(unhiddenHTML), individual);
  assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-frequencies").hidden, false);
});

test("averaged hidden tags take no pitch budget, hide all-hidden groups and follow live toggles and aliases", t => {
  const f = fixture(t);
  const pitch = dictionary => ({ dictionary, pitches: [{ position: 0, pattern: "", nasal: [], devoice: [] }],
    transcriptions: [] });
  const sources = Array.from({ length: 10 }, (_, index) => `Rank ${index + 1}`);
  const second = { ...RESULT, term: { ...RESULT.term, expression: "食う", reading: "くう",
    frequencies: sources.map((dictionary, index) => ({ dictionary,
      frequencies: [{ value: 100 * (index + 1), displayValue: String(100 * (index + 1)) }] })),
    pitches: ["NHK", "Daijirin", "Shinmeikai"].map(pitch) } };
  const presentation = sources.map(title => ({ title, frequencyMode: "rank-based" }));
  const options = { ...f.options.normaliseOptions({}), showFrequencyDictionaryNames: true,
    dictionaryPresentation: presentation, expandAll: true };
  f.view.renderResults([RESULT, second], f.candidate, options);
  const entry = () => f.popup.querySelectorAll(".gsm-hoshidicts-entry")[1];
  const row = () => entry().querySelector(".gsm-hoshidicts-frequency-metadata");
  const pitchBadges = () => entry().querySelectorAll(".gsm-hoshidicts-tag-pitch").length;
  const individual = [...row().children].map(tag => tag.outerHTML);
  assert.equal(individual.length, 10);
  assert.equal(pitchBadges(), 2, "ten frequency tags leave two of the twelve metadata tags for pitch");
  f.view.updateDictionaryPresentation({ ...options, averageFrequency: true });
  assert.equal(row().hidden, false);
  assert.deepEqual([...row().children].map(tag => [tag.dataset.dictionary, tag.hidden]),
    [["Rank average", false], ...sources.map(source => [source, true])]);
  assert.deepEqual([...row().children].slice(1).map(unhiddenHTML), individual);
  assert.equal(pitchBadges(), 3, "hidden tags take none of the metadata budget");
  // An alias rename relabels the hidden source, not the average's unit.
  f.view.updateDictionaryPresentation({ ...options, averageFrequency: true,
    dictionaryPresentation: [{ ...presentation[0], displayName: "Renamed" }, ...presentation.slice(1)] });
  assert.deepEqual([...row().querySelectorAll(".gsm-hoshidicts-frequency-source")].slice(0, 2)
    .map(node => node.textContent), ["Avg rank", "Renamed"]);
  f.view.updateDictionaryPresentation({ ...options, averageFrequency: false });
  assert.deepEqual([...row().children].map(tag => tag.outerHTML), individual);
  assert.equal(pitchBadges(), 2);

  // With no value to average, only hidden tags remain: the row, the frequency
  // group and, unless grammar is shown, the capsule are hidden too.
  const unusable = { dictionary: "Rank 1", frequencies: [{ value: 0, displayValue: "unranked" }] };
  const withUnusable = result => ({ ...result, term: { ...result.term, frequencies: [unusable] } });
  for (const hidePopupGrammarTags of [true, false]) {
    f.view.renderResults([withUnusable(RESULT), withUnusable(second)], f.candidate,
      { ...options, averageFrequency: true, hidePopupGrammarTags });
    const capsule = f.popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule");
    assert.deepEqual([...capsule.querySelectorAll(".gsm-hoshidicts-tag-frequency")].map(tag => tag.hidden), [true]);
    assert.equal(capsule.querySelector(".gsm-hoshidicts-primary-frequencies").hidden, true);
    assert.equal(capsule.hidden, hidePopupGrammarTags);
    assert.deepEqual([...row().children].map(tag => tag.hidden), [true]);
    assert.equal(row().hidden, true);
  }
});

test("opt-in grammar stays visible without frequency or dictionary tabs and hides again when disabled", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, glossaries: [], frequencies: [] } };
  const capsule = f.render({ ...defaults, hidePopupGrammarTags: false }, result);
  assert.equal(capsule.hidden, false);
  assert.ok(capsule.closest(".gsm-hoshidicts-entry"));
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
  assert.ok(capsule.closest(".gsm-hoshidicts-entry"));
});

test("frequency values stay as each dictionary shows them unless abbreviation is switched on, live", t => {
  const f = fixture(t);
  const defaults = f.options.normaliseOptions({});
  const result = { ...RESULT, term: { ...RESULT.term, frequencies: [...RESULT.term.frequencies,
    { dictionary: "NWJC", frequencies: [{ value: 51499, displayValue: "51499" }] },
    { dictionary: "Grouped", frequencies: [{ value: 51499, displayValue: "51,499" }] },
    { dictionary: "Kanji numerals", frequencies: [{ value: 50000, displayValue: "5万" }] },
  ] } };
  const capsule = f.render(defaults, result);
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "keep my draft";
  const values = () => [...capsule.querySelectorAll(".gsm-hoshidicts-frequency-values")].map(node => node.textContent);
  const nwjc = () => capsule.querySelector('[data-dictionary="NWJC"] .gsm-hoshidicts-frequency-value');
  const full = ["14,200㋕ · 191", "51499", "51,499", "5万"];
  assert.deepEqual(values(), full);
  f.view.updateDictionaryPresentation({ ...defaults, showFrequencyDictionaryNames: true });
  assert.deepEqual(values(), full);
  f.view.updateDictionaryPresentation({ ...defaults, showFrequencyDictionaryNames: true, compactFrequencyNumbers: true });
  assert.deepEqual(values(), ["14.2k㋕ · 191", "51.5k", "51.5k", "5万"]);
  assert.equal(nwjc().title, "51499");
  assert.equal(nwjc().dataset.frequency, "51499");
  f.view.updateDictionaryPresentation({ ...defaults, compactFrequencyNumbers: true });
  assert.deepEqual(values(), ["14.2k㋕ · 191", "51.5k", "51.5k", "50k"]);
  f.view.updateDictionaryPresentation(defaults);
  assert.deepEqual(values(), full);
  assert.equal(nwjc().title, "51499");
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card"), card);
  assert.equal(f.popup.querySelector("form"), form);
  assert.equal(form.elements.definition.value, "keep my draft");
});

test("abbreviated frequency numbers pick the unit after rounding", t => {
  const { api } = fixture(t);
  assert.deepEqual([999, 1000, 51499, 99950, 999949, 999950, 1234567, 999950000].map(api.formatCompactFrequencyNumber),
    ["999", "1k", "51.5k", "100k", "999.9k", "1m", "1.2m", "1b"]);
});
