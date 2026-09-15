// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../extension/reader-options.js";
import { applyAnkiPreset, resolveAnkiTemplates } from "../extension/anki-templates.js";
import { checkModel, checkReport, contracts } from "../scripts/anki-note-type-compatibility.mjs";

const snapshot = JSON.parse(readFileSync(
  new URL("./data/anki-note-types/upstream-snapshot.json", import.meta.url), "utf8",
));
const modelFor = contract => snapshot.results.find(({ id }) => id === contract.id)
  ?.models?.find(({ name }) => contract.modelNames.includes(name));

for (const contract of contracts) {
  test(`${contract.id}: every field from the extracted upstream package matches production`, () => {
    checkModel(contract, modelFor(contract));
  });
}

test("the complete report selects the reviewed model rather than an unrelated first model", () => {
  checkReport(snapshot);
});

test("Kiku and Lapis keep their package-specific sentence furigana behavior", () => {
  const fields = ["Expression", "SentenceFurigana", "SentenceAudio", "Picture"];
  const config = globalThis.HDReaderOptions.normaliseOptions({}).anki;
  const kiku = applyAnkiPreset(config, fields, "kiku").fieldTemplates;
  const lapis = applyAnkiPreset(config, fields, "lapis").fieldTemplates;
  assert.equal(kiku.SentenceFurigana.value, "{sentence-furigana-plain}");
  assert.equal(lapis.SentenceFurigana.value, "");
  for (const mapped of [kiku, lapis]) {
    assert.equal(mapped.SentenceAudio.value, "");
    assert.equal(mapped.Picture.value, "{screenshot}");
  }
});

test("Senren keeps publisher wrappers while retaining Hachidori screenshot routing", () => {
  const contract = contracts.find(({ id }) => id === "senren");
  const mapped = checkModel(contract, modelFor(contract));
  assert.equal(mapped.sentence.value,
    '<span class="group">{cloze-prefix}<span class="highlight">{cloze-body}</span>{cloze-suffix}</span>');
  assert.equal(mapped.sentenceFurigana.value, '<span class="group">{sentence-furigana}</span>');
  assert.equal(mapped.picture.value, "{screenshot}");
});

test("added, removed, renamed, duplicated and reordered fields fail closed", () => {
  const contract = contracts[0];
  const fields = Object.keys(contract.expected);
  const changed = [
    [...fields, "NewField"],
    fields.slice(1),
    ["RenamedExpression", ...fields.slice(1)],
    [...fields, fields[0]],
    [fields[0], fields[2], fields[1], ...fields.slice(3)],
  ];
  for (const next of changed) assert.throws(() => checkModel(contract, { name: "Kiku", fields: next }));
});

test("wrong model selection, first field and ambiguous reports fail closed", () => {
  const contract = contracts[0];
  const fields = Object.keys(contract.expected);
  assert.throws(() => checkModel(contract, { name: "Kiku 2.1.0", fields }), /unreviewed model/u);
  assert.throws(() => checkModel(contract, { name: "Kiku", fields: [...fields.slice(1), fields[0]] }));
  const valid = { name: "Kiku", fields };
  for (const replacement of [
    { id: "kiku", status: "error", error: "Network unavailable" },
    { id: "kiku", status: "downloaded", models: [{ name: "Basic", fields: ["Front", "Back"] }] },
    { id: "kiku", status: "downloaded", models: [valid, valid] },
  ]) {
    assert.throws(() => checkReport({ results: [replacement, ...snapshot.results.slice(1)] }), AggregateError);
  }
  assert.throws(() => checkReport({ results: snapshot.results.slice(1) }));
  assert.throws(() => checkReport({ results: [snapshot.results[0], ...snapshot.results.slice(0, 2)] }));
});

test("wrong mappings, markers, overwrite modes and intentional blanks fail", () => {
  const contract = contracts[0];
  const model = modelFor(contract);
  const changedMapper = (field, patch) => (config, fields, family) => {
    const mapped = applyAnkiPreset(config, fields, family);
    mapped.fieldTemplates[field] = { ...mapped.fieldTemplates[field], ...patch };
    return mapped;
  };
  assert.throws(() => checkModel(contract, model, changedMapper("ExpressionAudio", { value: "{reading}" })),
    /incorrect field mapping/u);
  assert.throws(() => checkModel(contract, model, changedMapper("ExpressionAudio", { value: "{unsupported-marker}" })),
    /unsupported marker/u);
  assert.throws(() => checkModel(contract, model, changedMapper("ExpressionAudio", { overwriteMode: "skip" })),
    /overwrite mode/u);
  assert.throws(() => checkModel(contract, model, changedMapper("RelatedExpression", { value: "{expression}" })),
    /incorrect field mapping/u);
});

test("applying corrected presets does not rewrite an existing customized mapping", () => {
  const config = globalThis.HDReaderOptions.normaliseOptions({}).anki;
  const saved = { ...config, fieldTemplates: {
    Expression: { value: "custom {expression}", overwriteMode: "append" },
    SentenceFurigana: { value: "custom furigana", overwriteMode: "skip" },
  } };
  const before = structuredClone(saved.fieldTemplates);
  applyAnkiPreset(saved, ["Expression", "SentenceFurigana"], "kiku");
  assert.deepEqual(saved.fieldTemplates, before);
  assert.deepEqual(resolveAnkiTemplates(saved, ["Expression", "SentenceFurigana"]).templates, before);
});
