// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnkiFields } from "../extension/anki-values.js";

const request = patch => ({ term: { expression: "食べる", reading: "たべる", rules: "v1",
  glossaries: [{ dictionary: "A", glossary: '["to eat"]', definitionTags: "common", termTags: "v1" }],
  frequencies: [], pitches: [] }, trace: [{ name: "polite" }], sentence: "🍵 食べます。", matchOffset: 3,
  matched: "食べます", popupSelectionText: "<selected>", searchQuery: "食べます", documentTitle: "A & B",
  dictionaryAliases: { A: "Alias A" }, dictionaryIds: { A: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  frequencyDictionaries: [], ...patch });
const templates = value => ({ Front: { value, overwriteMode: "coalesce" } });
const render = async (source, value, resources = {}) => (await buildAnkiFields(source, templates(value), {
  definition: () => { throw new Error("Unexpected rich glossary work"); }, ...resources,
})).Front;

test("Anki values escape literal data, reuse lookup furigana and preserve UTF-16 sentence/cloze context", async () => {
  const value = await render(request(), "{expression}|{reading}|{furigana}|{furigana-plain}|{cloze-prefix}|{cloze-body}|{cloze-suffix}|{document-title}|{popup-selection-text}");
  assert.equal(value, "食べる|たべる|<ruby>食<rt>た</rt></ruby>べる|食[た]べる|🍵 |食べます|。|A &amp; B|&lt;selected&gt;");
  assert.equal(await render(request(), "{sentence}"), "🍵 <b>食べます</b>。");
  assert.equal(await render(request(), "{sentence-furigana}|{sentence-furigana-plain}"), "🍵 <b>食べます</b>。|🍵 <b>食べます</b>。");
});

test("only requested glossary variants render and legacy title markers keep exact collision and suffix precedence", async () => {
  const calls = [];
  const definition = options => { calls.push(options); return JSON.stringify(options); };
  assert.equal(await render(request(), "{expression}", { definition }), "食べる");
  assert.equal(calls.length, 0);
  await render(request(), "{definition}|{glossary}|{main-definition}|{glossary-first}", { definition });
  assert.deepEqual(calls, [{}, { firstOnly: true }]);
  calls.length = 0;
  const source = request();
  source.term.glossaries.push({ dictionary: "A Brief", glossary: '["second"]', definitionTags: "", termTags: "" });
  source.term.glossaries.push({ dictionary: "A Plain", glossary: '["third"]', definitionTags: "", termTags: "" });
  await render(source, "{single-glossary-a-brief}|{single-glossary-a-plain}|"
    + "{single-glossary-a-plain-no-dictionary}", { definition });
  assert.deepEqual(calls, [
    { dictionary: "A Brief" },
    { dictionary: "A Plain" },
    { dictionary: "A", plain: true, noDictionary: true },
  ]);
  assert.equal(await render(source, "{single-glossary-missing}", { definition }), "");
});

test("legacy glossary suffixes keep precedence over exact and suffixed aliases", async () => {
  const source = request({
    term: { ...request().term, glossaries: [
      { dictionary: "A", glossary: '["first"]', definitionTags: "", termTags: "" },
      { dictionary: "B", glossary: '["second"]', definitionTags: "", termTags: "" },
      { dictionary: "C", glossary: '["third"]', definitionTags: "", termTags: "" },
    ] },
    dictionaryAliases: { B: "A Brief", C: "A Plain" },
    dictionaryIds: {
      A: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      B: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      C: "cccccccccccccccccccccccccccccccc",
    },
  });
  const calls = [];
  const definition = options => { calls.push(options); return options.dictionary; };
  assert.equal(await render(source,
    "{single-glossary-a-brief}|{single-glossary-a-plain-no-dictionary}", { definition }), "A|A");
  assert.deepEqual(calls, [
    { dictionary: "A", brief: true },
    { dictionary: "A", plain: true, noDictionary: true },
  ]);
});

test("stable single-glossary markers survive dated title updates without changing saved templates", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const template = "{single-glossary-jitendex-plain-no-dictionary}|"
    + `{single-glossary-id--${id}-brief}`;
  const templatesBefore = templates(template);
  const definition = options => JSON.stringify(options);
  const dated = title => request({
    term: { ...request().term, glossaries: [
      { dictionary: title, glossary: '["to eat"]', definitionTags: "", termTags: "" },
    ] },
    dictionaryAliases: { [title]: "Jitendex" },
    dictionaryIds: { [title]: id },
  });
  const oldTitle = "Jitendex.org [2026-08-11]";
  const newTitle = "Jitendex.org [2026-09-16]";
  const oldValue = (await buildAnkiFields(dated(oldTitle), templatesBefore, { definition })).Front;
  const newValue = (await buildAnkiFields(dated(newTitle), templatesBefore, { definition })).Front;
  assert.equal(oldValue, `{"dictionary":"${oldTitle}","plain":true,"noDictionary":true}|{"dictionary":"${oldTitle}","brief":true}`);
  assert.equal(newValue, `{"dictionary":"${newTitle}","plain":true,"noDictionary":true}|{"dictionary":"${newTitle}","brief":true}`);
  assert.equal(templatesBefore.Front.value, template, "rendering never rewrites a saved field template");
  assert.equal(await render(dated(newTitle), "{single-glossary-jitendexorg-2026-09-16}", { definition }),
    `{"dictionary":"${newTitle}"}`, "the current title marker remains compatible");
  assert.equal(await render(dated(newTitle), "{single-glossary-jitendexorg-2026-08-11}", { definition }), "",
    "Hachidori does not guess historical titles or silently migrate their templates");
});

test("single-glossary identities normalize Unicode and fall back deterministically for alias changes, empty names and collisions", async () => {
  const unicodeId = "00000000000000000000000000000000";
  const firstId = "11111111111111111111111111111111";
  const secondId = "22222222222222222222222222222222";
  const punctuationId = "33333333333333333333333333333333";
  const unicodeTitle = "Unicode title";
  const collisionA = "Collision A";
  const collisionB = "Collision B";
  const punctuation = "Punctuation";
  const source = request({
    term: { ...request().term, glossaries: [
      { dictionary: unicodeTitle, glossary: '["unicode"]', definitionTags: "", termTags: "" },
      { dictionary: collisionA, glossary: '["first"]', definitionTags: "", termTags: "" },
      { dictionary: collisionA, glossary: '["duplicate row"]', definitionTags: "", termTags: "" },
      { dictionary: collisionB, glossary: '["second"]', definitionTags: "", termTags: "" },
      { dictionary: punctuation, glossary: '["punctuation"]', definitionTags: "", termTags: "" },
    ] },
    dictionaryAliases: {
      [unicodeTitle]: " Ｊｉｔｅｎｄｅｘ　Cafe\u0301_辞典!!! ",
      [collisionA]: "Same_Name",
      [collisionB]: "Same Name",
      [punctuation]: "!!!",
    },
    dictionaryIds: {
      [unicodeTitle]: unicodeId,
      [collisionA]: firstId,
      [collisionB]: secondId,
      [punctuation]: punctuationId,
    },
  });
  const definition = ({ dictionary }) => dictionary;
  const fields = await buildAnkiFields(source, {
    Unicode: templates("{single-glossary-jitendex-café-辞典}").Front,
    Ambiguous: templates("{single-glossary-same-name}").Front,
    UnicodeId: templates(`{single-glossary-id--${unicodeId}}`).Front,
    FirstId: templates(`{single-glossary-id--${firstId}}`).Front,
    SecondId: templates(`{single-glossary-id--${secondId}}`).Front,
    EmptyId: templates(`{single-glossary-id--${punctuationId}}`).Front,
    Legacy: templates("{single-glossary-punctuation}").Front,
  }, { definition });
  assert.deepEqual(fields, {
    Unicode: unicodeTitle,
    Ambiguous: "",
    UnicodeId: unicodeTitle,
    FirstId: collisionA,
    SecondId: collisionB,
    EmptyId: punctuation,
    Legacy: punctuation,
  });

  const renamedAlias = { ...source,
    dictionaryAliases: { ...source.dictionaryAliases, [unicodeTitle]: "Renamed Alias" } };
  assert.equal(await render(renamedAlias, "{single-glossary-jitendex-café-辞典}", { definition }), "");
  assert.equal(await render(renamedAlias, "{single-glossary-renamed-alias}", { definition }), unicodeTitle);
  assert.equal(await render(renamedAlias, `{single-glossary-id--${unicodeId}}`, { definition }), unicodeTitle);
});

test("frequency markers preserve configured order, mode-specific aggregates and dynamic display versus numeric values", async () => {
  const source = request();
  source.frequencyDictionaries = ["Rank", "Count"];
  source.term.frequencies = [
    { dictionary: "Rank", frequencyMode: "rank-based", frequencies: [{ value: 10, displayValue: "20㋕" }] },
    { dictionary: "Count", frequencyMode: "occurrence-based", frequencies: [{ value: 100, displayValue: null }] },
  ];
  assert.equal(await render(source, "{frequency-average-rank}|{frequency-harmonic-occurrence}|{single-frequency-number-rank}"), "20|100|20");
  assert.equal(await render(source, "{frequencies}"), "<b>Rank</b>: 20㋕<br><b>Count</b>: 100");
  assert.equal(await render(source, "{single-frequency-count}"), '<ul style="text-align: left;"><li>Count: 100</li></ul>');
  assert.equal(await render(request(), "{frequency-average-rank}|{frequency-average-occurrence}"), "9999999|0");
  source.term.frequencies[0].frequencies.push({ get value() { throw new Error("Aggregate must stop at the first positive frequency"); } });
  assert.equal(await render(source, "{frequency-average-rank}"), "20");
});

test("single-frequency marker sanitization remains byte-for-byte compatible", async () => {
  const dictionary = "Ｃafe\u0301";
  const source = request({
    frequencyDictionaries: [dictionary],
    term: { ...request().term, frequencies: [
      { dictionary, frequencyMode: "rank-based", frequencies: [{ value: 12, displayValue: "12" }] },
    ] },
  });
  assert.equal(await render(source, "{single-frequency-number-ｃafe}"), "12");
  assert.equal(await render(source, "{single-frequency-number-café}"), "");
});

test("pitch, part-of-speech, tags and transcriptions keep source meanings and markup escaping", async () => {
  const source = request();
  source.term.pitches = [{ dictionary: "Pitch", transcriptions: ["<ipa>"], pitches: [
    { position: 0, pattern: "LHH", nasal: [], devoice: [] }, { position: 2, pattern: "LHL", nasal: [1], devoice: [2] },
  ] }];
  assert.equal(await render(source, "{pitch-position}|{pitch-accent-categories}|{part-of-speech}|{conjugation}"), "0, 2|heiban,kifuku|Ichidan verb|polite");
  assert.match(await render(source, "{tags}"), /data-details="common">common/u);
  assert.match(await render(source, "{phonetic-transcriptions}"), /&lt;ipa&gt;/u);
  assert.equal(await render(source, "{pitch}"), "<b>Pitch</b>: LHH, LHL (nasal 1; devoice 2), &lt;ipa&gt;");
  assert.equal(await render(source, "{audio}", { audio: "[sound:chosen.mp3]" }), "[sound:chosen.mp3]");
});

test("captured media markers use generated pinned filenames and can omit unavailable outputs", async () => {
  const capturePin = {
    animationFilename: "hachidori-abc123.avif",
    audioFilename: "hachidori-abc123.wav",
  };
  assert.equal(await render(request({ capturePin }), "{capture-animation}|{capture-audio}"),
    '<img src="hachidori-abc123.avif">|[sound:hachidori-abc123.wav]');
  assert.equal(await render(request({ capturePin, captureUnavailable: ["audio"] }),
    "{capture-animation}|{capture-audio}"), '<img src="hachidori-abc123.avif">|');
});

test("the screenshot marker references only a stored picture and escapes its filename", async () => {
  assert.equal(await render(request({}), "{screenshot}"), "");
  assert.equal(await render(request({ screenshot: { filename: "hachidori-screenshot-1.jpg" } }), "{screenshot}"),
    '<img src="hachidori-screenshot-1.jpg">');
  // A capture or upload that failed marks itself unavailable, so the field stays
  // empty instead of pointing at a picture Anki does not have.
  assert.equal(await render(request({ screenshot: { filename: "hachidori-screenshot-1.jpg" },
    captureUnavailable: ["screenshot"] }), "{screenshot}"), "");
  assert.equal(await render(request({ screenshot: { filename: '"><script>' } }), "{screenshot}"),
    '<img src="&quot;&gt;&lt;script&gt;">');
});
