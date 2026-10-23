// SPDX-License-Identifier: GPL-3.0-or-later
// A clicked-kanji group renders each native kanji entry as a term-view card,
// and the term view binds Anki mining, whose preflight runs the production
// field builder on that result (#333). The builder reads the engine's term
// contract (test/node-smoke.mjs LOOKUP_RESULT), so the renderer's shared
// kanjiEntryResult must satisfy it: before it did, every Kiku, Lapis and Senren
// note failed with "Cannot read properties of undefined (reading 'split')".
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { applyAnkiPreset } from "../extension/anki-templates.js";
import { buildAnkiFields } from "../extension/anki-values.js";
import { buildAnkiResourceFields } from "../extension/anki-resources.js";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "RelatedExpression",
  "SelectionText", "MainDefinition", "DefinitionPicture", "Sentence", "SentenceFurigana", "SentenceTranslation",
  "SentenceAudio", "Picture", "Glossary", "Hint", "IsWordAndSentenceCard", "IsClickCard", "IsSentenceCard",
  "IsAudioCard", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo"];
const SENREN_FIELDS = ["word", "reading", "sentence", "sentenceFurigana", "sentenceTranslation", "sentenceCard",
  "audioCard", "notes", "hint", "picture", "wordAudio", "sentenceAudio", "selectionText", "definition", "glossary",
  "pitchAccents", "pitchPositions", "pitchCategories", "frequencies", "freqSort", "miscInfo", "dictionaryPreference"];
// hdw_kanji's KANJI_ENTRY shape (test/node-smoke.mjs), as kanjiGroupFixture() imports it.
const ENTRY = { dictionary: "kanji-group-first", onyomi: "ショク ジキ", kunyomi: "く.う た.べる", tags: "jouyou",
  definitions: ["kanji-group first meaning"], stats: [{ name: "strokes", value: "9" }] };

function renderer(t) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "https://extension.test",
    virtualConsole: new VirtualConsole() });
  t.after(() => dom.window.close());
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    dom.window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  return { document: dom.window.document, HDPopup: dom.window.HDPopup };
}

// content.js bindResultActions spreads the rendered result into the mining request.
const miningRequest = result => ({ ...result, generation: 7, sentence: "食べたかった", matchOffset: 0,
  searchQuery: result.matched, popupSelectionText: "", documentTitle: "Page title", dictionaryAliases: {},
  dictionaryIds: { [ENTRY.dictionary]: "a".repeat(32) }, frequencyDictionaries: [] });

test("a native kanji entry becomes a complete engine term result", t => {
  const { HDPopup } = renderer(t);
  // The renderer runs in the jsdom realm; compare as plain data, key sets included.
  assert.deepEqual(JSON.parse(JSON.stringify(HDPopup.kanjiEntryResult("食", ENTRY))), {
    matched: "食", deinflected: "食", trace: [], preprocessorSteps: 0,
    term: { expression: "食", reading: "", rules: "", score: 0, frequencies: [], pitches: [], glossaries: [
      { dictionary: ENTRY.dictionary, glossary: HDPopup.kanjiEntryGlossary(ENTRY), definitionTags: "", termTags: "", kanji: ENTRY },
    ] },
  });
});

test("a clicked-kanji group's native card builds Anki fields for every preset and the rendered glossary", async t => {
  const { document, HDPopup } = renderer(t);
  globalThis.HDGlossary = document.defaultView.HDGlossary;
  t.after(() => { delete globalThis.HDGlossary; });
  const request = miningRequest(HDPopup.kanjiEntryResult("食", ENTRY));
  const noDefinition = { definition: async () => "" };
  for (const [preset, fields, expression, categories] of [["kiku", KIKU_FIELDS, "Expression", "PitchCategories"],
    ["lapis", KIKU_FIELDS, "Expression", "PitchCategories"], ["senren", SENREN_FIELDS, "word", "pitchCategories"]]) {
    const { fieldTemplates } = applyAnkiPreset({ fieldTemplates: {} }, fields, preset);
    const built = await buildAnkiFields(request, fieldTemplates, noDefinition);
    assert.equal(built[expression], "食", `${preset}: expression`);
    assert.equal(built[categories], "", `${preset}: a kanji card has no pitch categories`);
  }
  const template = value => ({ value, overwriteMode: "coalesce" });
  assert.deepEqual(await buildAnkiFields(request, { Tags: template("{tags}"), Pos: template("{part-of-speech}"),
    Conjugation: template("{conjugation}") }, noDefinition), {
    Tags: '<span class="tag" data-details="jouyou">jouyou</span>', Pos: "Unknown", Conjugation: "" });

  // The real hd_anki_fields entry renders the card itself (anki-glossary.js reads request.trace).
  const { fieldTemplates } = applyAnkiPreset({ fieldTemplates: {} }, KIKU_FIELDS, "kiku");
  const { fields } = await buildAnkiResourceFields(request, fieldTemplates,
    { document, dictionaryPaths: { [ENTRY.dictionary]: "/dicts/generation/kanji-group-first" }, styles: async () => [] });
  assert.equal(fields.ExpressionReading, "");
  assert.equal(fields.PitchPosition, "");
  assert.match(fields.Glossary, /kanji-group first meaning/u);
  assert.match(fields.Glossary, /ショク · ジキ/u);
  assert.match(fields.MainDefinition, /kanji-group first meaning/u);
});

test("kanji markers use the projected dictionaries and stay empty for ordinary terms", async t => {
  const { document, HDPopup } = renderer(t);
  globalThis.HDGlossary = document.defaultView.HDGlossary;
  t.after(() => { delete globalThis.HDGlossary; });
  const result = HDPopup.kanjiEntryResult("食", ENTRY);
  const source = miningRequest(result);
  const markers = { Front: { value: "{character}|{onyomi}|{kunyomi}|{stroke-count}", overwriteMode: "coalesce" } };
  assert.deepEqual(await buildAnkiFields(source, markers, {}), { Front: "食|ショク, ジキ|く.う, た.べる|9" });
  source.term.glossaries.push(...HDPopup.kanjiEntryResult("食", { ...ENTRY, dictionary: "Other",
    onyomi: "ショク <ジキ>", kunyomi: "く.う", stats: [] }).term.glossaries);
  assert.deepEqual(await buildAnkiFields(source, markers, {}), { Front: "食|ショク, ジキ, &lt;ジキ&gt;|く.う, た.べる|9" });
  source.term.glossaries = source.term.glossaries.slice(1);
  assert.deepEqual(await buildAnkiFields(source, markers, {}), { Front: "食|ショク, &lt;ジキ&gt;|く.う|" });
  delete source.term.glossaries[0].kanji;
  assert.deepEqual(await buildAnkiFields(source, markers, {}), { Front: "|||" });
});

test("the native kanji view binds built-in and custom Anki actions to the displayed entries", async t => {
  const { document, HDPopup } = renderer(t);
  const window = document.defaultView;
  for (const file of ["reader-options.js", "anki-content.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const popup = document.createElement("section");
  document.body.append(popup);
  const calls = [];
  const controller = window.HDAnki.createAnkiController({ onChange() {}, async send(type, fields) {
    calls.push({ type, fields });
    if (type === "hd_anki_view") return { cached: false, state: "unknown", configKey: "current" };
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight_batch") return { replies: fields.requests.map(() => ({ state: "addable", canAdd: true })) };
    if (type === "hd_anki_submit") return { state: "added", noteId: 42 };
    if (type === "hd_anki_browse") return { noteIds: [42] };
    throw new Error(`Unexpected message ${type}`);
  } });
  const options = window.HDReaderOptions.normaliseOptions({ anki: { templates: [
    { id: "word", name: "Word", model: "Basic" }, { id: "kanji", name: "Kanji", model: "Kanji" },
  ] }, customButtons: [{ id: "mine-kanji", type: "anki", label: "Kanji card", templateId: "kanji" }] });
  controller.update(options);
  let rendered;
  const context = { owner: {}, request: {}, popup, isCurrent: () => true, getRequest: miningRequest };
  const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {}, customButtons: options.customButtons,
    parseTagList: window.HDGlossary.parseTagList,
    onResultsRendered(value) { rendered = value; controller.bind(value.miningActions, context); } });
  t.after(() => { controller.retire(); view.destroy(); });
  view.renderKanji({ character: "食", entries: [ENTRY, { ...ENTRY, dictionary: "Other" }], frequencies: [] },
    { sentence: "食べたかった" }, { onBack() {}, generation: 7, selectedDictionaryTab: { dictionary: ENTRY.dictionary },
      dictionaryPresentation: [{ title: ENTRY.dictionary, favorite: true }, { title: "Other", favorite: true }] });
  const settle = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), "kanji mining did not settle");
  };
  const add = popup.querySelector(".gsm-hoshidicts-mine-button");
  const custom = popup.querySelector(".gsm-hoshidicts-custom-anki-button");
  await settle(() => add.dataset.state === "ready" && custom.dataset.state === "ready");
  assert.equal(add.previousElementSibling.className, "gsm-hoshidicts-kanji-back");
  assert.equal(rendered.audioButtons.length, 0);
  assert.equal(rendered.miningActions[0].result.generation, 7);
  assert.equal(rendered.miningActions[0].result.term.glossaries.length, 1, "only the displayed dictionary is mined");
  assert.equal(rendered.miningActions[0].result.term.glossaries[0].kanji.dictionary, ENTRY.dictionary);
  assert.equal(rendered.miningActions[0].feedback.parentElement, popup);
  custom.click();
  await settle(() => custom.dataset.state === "success");
  const submitted = calls.find(call => call.type === "hd_anki_submit").fields.request;
  assert.equal(submitted.templateId, "kanji");
  assert.equal(submitted.term.expression, "食");
  assert.equal(submitted.term.glossaries[0].kanji.onyomi, ENTRY.onyomi);
  custom.click();
  await settle(() => calls.some(call => call.type === "hd_anki_browse"));
  view.renderNotice("No definition found.", { query: "unknown" });
  const before = calls.length;
  custom.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, before, "a replaced kanji toolbar cannot mine");
});
