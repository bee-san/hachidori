// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { applyAnkiPreset, resolveAnkiTemplates, ankiTemplateErrors, renderAnkiTemplate } from "../extension/anki-templates.js";

const config = patch => ({ ...globalThis.HDReaderOptions.normaliseOptions({}).anki, ...patch });

test("basic mappings preserve disabled values and combine shared fields in semantic order", () => {
  const value = config({ fields: { ...config().fields, expression: "Front", reading: "front", pitch: "PitchPosition",
    captureAnimation: "Media", captureAudio: "Media" } });
  const resolved = resolveAnkiTemplates(value, ["Front", "Back", "PitchPosition", "Media"]);
  assert.deepEqual(resolved.templates, { Front: { value: "{expression}<br>{reading}", overwriteMode: "coalesce" },
    Back: { value: "", overwriteMode: "coalesce" }, PitchPosition: { value: "{pitch-position}", overwriteMode: "coalesce" },
    Media: { value: "{capture-animation}<br>{capture-audio}", overwriteMode: "coalesce" } });
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolveAnkiTemplates(config({ fieldTemplates: {} }), ["Front"]).templates,
    { Front: { value: "", overwriteMode: "coalesce" } });
});

test("saved templates prefer exact targets, retain stale targets and survive case-only field renames", () => {
  const value = config({ fieldTemplates: { front: { value: "lower", overwriteMode: "skip" },
    Front: { value: "{expression}", overwriteMode: "append" }, Removed: { value: "old", overwriteMode: "prepend" } } });
  const resolved = resolveAnkiTemplates(value, ["Front", "New"]);
  assert.equal(resolved.templates.Front.value, "{expression}");
  assert.equal(resolved.templates.Front.overwriteMode, "append");
  assert.equal(resolved.templates.New.value, "");
  assert.deepEqual(resolved.staleFields, ["front", "Removed"]);
  const renamed = resolveAnkiTemplates(config({ fieldTemplates: { FRONT: value.fieldTemplates.Front } }), ["front"]);
  assert.deepEqual(renamed.staleFields, []);
  assert.deepEqual(renamed.templates.front, value.fieldTemplates.Front);
});

test("Automatic and named presets materialize only discovered fields with visible source-backed templates", () => {
  const basic = applyAnkiPreset(config(), ["Word", "Term", "Meaning", "Unused"], "automatic");
  assert.equal(basic.fieldTemplates.Word.value, "{expression}");
  assert.equal(basic.fieldTemplates.Term.value, "");
  assert.equal(basic.fieldTemplates.Meaning.value, "{definition}");
  assert.equal(basic.fieldTemplates.Unused.value, "");
  const aliases = applyAnkiPreset(config(), ["ExpressionReading", "Reading", "ExpressionAudio", "WordAudio"], "automatic");
  assert.equal(aliases.fieldTemplates.Reading.value, "");
  assert.equal(aliases.fieldTemplates.WordAudio.value, "");
  const stockFields = ["Expression", "ExpressionFurigana", "MainDefinition", "PitchPosition", "FreqSort",
    "SentenceFurigana", "SentenceAudio", "Picture"];
  const kiku = applyAnkiPreset(config(), stockFields, "kiku");
  const lapis = applyAnkiPreset(config(), stockFields, "lapis");
  for (const result of [kiku, lapis]) {
    assert.equal(result.fieldTemplates.ExpressionFurigana.value, "{furigana-plain}");
    assert.equal(result.fieldTemplates.MainDefinition.value, "{main-definition}");
    assert.equal(result.fieldTemplates.PitchPosition.value, "{pitch-accent-positions}");
    assert.equal(result.fieldTemplates.FreqSort.value, "{frequency-harmonic-rank}");
    assert.equal(result.fieldTemplates.SentenceAudio.value, "");
    assert.equal(result.fieldTemplates.Picture.value, "{screenshot}");
    assert.equal(Object.keys(result.fieldTemplates).length, stockFields.length);
  }
  assert.equal(kiku.fieldTemplates.SentenceFurigana.value, "{sentence-furigana-plain}");
  assert.equal(lapis.fieldTemplates.SentenceFurigana.value, "");
  const senren = applyAnkiPreset(config(),
    ["word", "sentence", "sentenceFurigana", "definition", "wordAudio", "pitchPositions", "sentenceAudio",
      "sentenceTranslation", "picture"], "senren");
  assert.equal(senren.fieldTemplates.word.value, "{expression}");
  assert.equal(senren.fieldTemplates.sentence.value,
    '<span class="group">{cloze-prefix}<span class="highlight">{cloze-body}</span>{cloze-suffix}</span>');
  assert.equal(senren.fieldTemplates.sentenceFurigana.value, '<span class="group">{sentence-furigana}</span>');
  assert.equal(senren.fieldTemplates.definition.value, "{main-definition}");
  assert.equal(senren.fieldTemplates.wordAudio.value, "{audio}");
  assert.equal(senren.fieldTemplates.pitchPositions.value, "{pitch-accent-positions}");
  assert.equal(senren.fieldTemplates.sentenceAudio.value, "");
  assert.equal(senren.fieldTemplates.sentenceTranslation.value, "");
  assert.equal(senren.fieldTemplates.picture.value, "{screenshot}");
});

test("resolved saved templates never migrate a blank SentenceAudio field", () => {
  const fields = ["Expression", "ExpressionReading", "Sentence", "Glossary", "SentenceAudio"];
  const saved = applyAnkiPreset(config(), fields, "kiku");
  assert.equal(saved.fieldTemplates.SentenceAudio.value, "");
  assert.equal(resolveAnkiTemplates(saved, fields).templates.SentenceAudio.value, "");
});

test("marker validation retains unknown tokens as errors and recognizes nonempty dictionary-specific markers", () => {
  assert.deepEqual(ankiTemplateErrors("{Expression}<br>{single-glossary-辞典-plain}{single-frequency-number-辞典}"), []);
  assert.deepEqual(ankiTemplateErrors("{capture-animation}{capture-audio}"), []);
  const source = "literal {unknown} {single-glossary-} {screenshot} {unknown}";
  // {screenshot} is a real marker; the other two are not.
  assert.deepEqual(ankiTemplateErrors(source), ["Unknown marker: {unknown}", "Unknown marker: {single-glossary-}"]);
  assert.equal(source, "literal {unknown} {single-glossary-} {screenshot} {unknown}");
  assert.deepEqual(ankiTemplateErrors("text {} and an unmatched { brace"), []);
});

test("Automatic capture aliases produce valid hyphenated markers even before capture is enabled", () => {
  for (const [animation, audio] of [["Capture Animation", "SentenceAudio"], ["SentenceAnimation", "Capture Audio"]]) {
    const fields = ["Front", animation, audio];
    const applied = applyAnkiPreset(config(), fields, "automatic");
    assert.equal(applied.fieldTemplates[animation].value, "{capture-animation}");
    assert.equal(applied.fieldTemplates[audio].value, "{capture-audio}");
    assert.deepEqual(resolveAnkiTemplates(applied, fields).errors, []);
  }
});

test("template rendering substitutes once, preserves literal HTML and removes only empty marker-only breaks", () => {
  assert.equal(renderAnkiTemplate("<b>{EXPRESSION}</b><br>{audio}<BR />literal<br>{single-glossary-missing}",
    { expression: "&lt;語&gt;", audio: "" }), "<b>&lt;語&gt;</b><br>literal");
  assert.equal(renderAnkiTemplate("{expression}", { expression: "{reading}" }), "{reading}");
  assert.throws(() => renderAnkiTemplate("{unknown}", {}), /Unknown marker/u);
});

test("revisioned Anki options retain uncapped templates and validate every overwrite mode", () => {
  const value = config({ fieldTemplates: { Front: { value: "text ".repeat(14000), overwriteMode: "coalesce-new" } } });
  assert.deepEqual(globalThis.HDReaderOptions.validateOptionsPatch({ anki: value }),
    { anki: globalThis.HDReaderOptions.normaliseOptions({ anki: value }).anki });
  for (const mode of globalThis.HDReaderOptions.ANKI_OVERWRITE_MODES) {
    value.fieldTemplates.Front.overwriteMode = mode;
    assert.deepEqual(globalThis.HDReaderOptions.validateOptionsPatch({ anki: value }),
      { anki: globalThis.HDReaderOptions.normaliseOptions({ anki: value }).anki });
  }
  for (const templates of [[], "", { Front: { value: 2, overwriteMode: "coalesce" } },
    { Front: { value: "x", overwriteMode: "guess" } }, { "": { value: "x", overwriteMode: "skip" } }]) {
    assert.throws(() => globalThis.HDReaderOptions.validateOptionsPatch({ anki: config({ fieldTemplates: templates }) }));
  }
});
