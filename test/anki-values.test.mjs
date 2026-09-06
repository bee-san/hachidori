// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnkiFields } from "../extension/anki-values.js";

const request = patch => ({ term: { expression: "食べる", reading: "たべる", rules: "v1",
  glossaries: [{ dictionary: "A", glossary: '["to eat"]', definitionTags: "common", termTags: "v1" }],
  frequencies: [], pitches: [] }, trace: [{ name: "polite" }], sentence: "🍵 食べます。", matchOffset: 3,
  matched: "食べます", popupSelectionText: "<selected>", searchQuery: "食べます", documentTitle: "A & B",
  dictionaryAliases: { A: "Alias A" }, frequencyDictionaries: [], ...patch });
const templates = value => ({ Front: { value, overwriteMode: "coalesce" } });
const render = (source, value, resources = {}) => buildAnkiFields(source, templates(value), {
  definition: () => { throw new Error("Unexpected rich glossary work"); }, ...resources,
}).Front;

test("Anki values escape literal data, reuse lookup furigana and preserve UTF-16 sentence/cloze context", () => {
  const value = render(request(), "{expression}|{reading}|{furigana}|{furigana-plain}|{cloze-prefix}|{cloze-body}|{cloze-suffix}|{document-title}|{popup-selection-text}");
  assert.equal(value, "食べる|たべる|<ruby>食<rt>た</rt></ruby>べる|食[た]べる|🍵 |食べます|。|A &amp; B|&lt;selected&gt;");
  assert.equal(render(request(), "{sentence}"), "🍵 <b>食べます</b>。");
  assert.equal(render(request(), "{sentence-furigana}|{sentence-furigana-plain}"), "🍵 <b>食べます</b>。|🍵 <b>食べます</b>。");
});

test("only requested glossary variants render, aliases share work and real dictionary names win suffix collisions", () => {
  const calls = [];
  const definition = options => { calls.push(options); return JSON.stringify(options); };
  assert.equal(render(request(), "{expression}", { definition }), "食べる");
  assert.equal(calls.length, 0);
  render(request(), "{definition}|{glossary}|{main-definition}|{glossary-first}", { definition });
  assert.deepEqual(calls, [{}, { firstOnly: true }]);
  calls.length = 0;
  const source = request();
  source.term.glossaries.push({ dictionary: "A Brief", glossary: '["second"]', definitionTags: "", termTags: "" });
  render(source, "{single-glossary-a-brief}|{single-glossary-a-plain-no-dictionary}", { definition });
  assert.deepEqual(calls, [{ dictionary: "A Brief" }, { dictionary: "A", plain: true, noDictionary: true }]);
  assert.equal(render(source, "{single-glossary-missing}", { definition }), "");
});

test("frequency markers preserve configured order, mode-specific aggregates and dynamic display versus numeric values", () => {
  const source = request();
  source.frequencyDictionaries = ["Rank", "Count"];
  source.term.frequencies = [
    { dictionary: "Rank", frequencyMode: "rank-based", frequencies: [{ value: 10, displayValue: "20㋕" }] },
    { dictionary: "Count", frequencyMode: "occurrence-based", frequencies: [{ value: 100, displayValue: null }] },
  ];
  assert.equal(render(source, "{frequency-average-rank}|{frequency-harmonic-occurrence}|{single-frequency-number-rank}"), "20|100|20");
  assert.equal(render(source, "{frequencies}"), "<b>Rank</b>: 20㋕<br><b>Count</b>: 100");
  assert.equal(render(source, "{single-frequency-count}"), '<ul style="text-align: left;"><li>Count: 100</li></ul>');
  assert.equal(render(request(), "{frequency-average-rank}|{frequency-average-occurrence}"), "9999999|0");
});

test("pitch, part-of-speech, tags and transcriptions keep source meanings and markup escaping", () => {
  const source = request();
  source.term.pitches = [{ dictionary: "Pitch", transcriptions: ["<ipa>"], pitches: [
    { position: 0, pattern: "LHH", nasal: [], devoice: [] }, { position: 2, pattern: "LHL", nasal: [1], devoice: [2] },
  ] }];
  assert.equal(render(source, "{pitch-position}|{pitch-accent-categories}|{part-of-speech}|{conjugation}"), "0, 2|heiban,kifuku|Ichidan verb|polite");
  assert.match(render(source, "{tags}"), /data-details="common">common/u);
  assert.match(render(source, "{phonetic-transcriptions}"), /&lt;ipa&gt;/u);
  assert.equal(render(source, "{pitch}"), "<b>Pitch</b>: LHH, LHL (nasal 1; devoice 2), &lt;ipa&gt;");
  assert.equal(render(source, "{audio}", { audio: "[sound:chosen.mp3]" }), "[sound:chosen.mp3]");
});
