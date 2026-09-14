// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import {
  ankiIndexSource,
  ankiWordKey,
  fetchAnkiIndex,
  inspectAnkiNoteIds,
  lookupAnkiIndex,
} from "../extension/anki-index.js";

const template = value => ({ value, overwriteMode: "coalesce" });
const baseConfig = patch => globalThis.HDReaderOptions.normaliseOptions({ anki: {
  model: "Japanese",
  deck: "Mining::Words",
  fieldTemplates: {
    Expression: template("{expression}"),
    Sentence: template("{sentence}"),
  },
  ...patch,
} }).anki;
const note = (noteId, modelName, fields) => ({
  noteId,
  modelName,
  fields: Object.fromEntries(Object.entries(fields)
    .map(([name, value], order) => [name, { value, order }])),
});
const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "Picture",
  "SelectionText", "MainDefinition", "Glossary", "Sentence", "SentenceFurigana", "PitchPosition",
  "PitchCategories", "Frequency", "FreqSort", "MiscInfo"];

test("index identity keeps the direct expression mapping and exact Hachidori word key", async () => {
  const source = await ankiIndexSource(baseConfig());
  assert.match(source.key, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ ...source, key: undefined }, {
    key: undefined,
    url: "http://127.0.0.1:8765",
    apiKey: "",
    scope: "model",
    model: "Japanese",
    fields: ["expression"],
  });
  assert.equal(ankiWordKey(`re:猫<&>"'*_:\\ (or)`),
    "re:猫&lt;&amp;&gt;&quot;&#x27;*_:\\ (or)");
  assert.equal(ankiWordKey("HELLO"), "hello");
  assert.equal(ankiWordKey("か\u3099"), "が");
  assert.equal(ankiWordKey(""), null);

  const same = await ankiIndexSource(baseConfig({
    deck: "Elsewhere",
    duplicateBehavior: "overwrite",
    fieldTemplates: {
      EXPRESSION: template("{ExPrEsSiOn}"),
      Other: template("{sentence}"),
    },
  }));
  assert.equal(same.key, source.key);
  assert.equal(await ankiIndexSource(baseConfig({
    fieldTemplates: { Front: template("<b>{expression}</b>") },
  })), null);
});

test("a complete refresh stores compact sorted rows across recognized note types and aggregates maturity", async () => {
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "all" }));
  const calls = [];
  const invoke = async (action, params) => {
    calls.push({ action, params });
    if (action === "modelNamesAndIds") return { Japanese: 1, "Kiku v2": 2, Basic: 3 };
    if (action === "modelFieldNames") {
      assert.equal(params.modelName, "Kiku v2");
      return KIKU_FIELDS;
    }
    if (action === "notesInfo") return [
      note(11, "Japanese", { Expression: "犬", Sentence: "ignored" }),
      note(9, "Kiku v2", { Expression: "猫", Sentence: "ignored" }),
      note(7, "Japanese", { Expression: "猫", Sentence: "ignored" }),
      note(8, "Kiku v2", { Expression: "猫", Sentence: "ignored" }),
    ];
    if (action === "findNotes") return [8, 11];
    throw new Error(`Unexpected ${action}`);
  };
  assert.deepEqual(await fetchAnkiIndex(invoke, source), [
    ["犬", true, [11]],
    ["猫", true, [7, 8, 9]],
  ]);
  assert.deepEqual(calls.map(call => call.action),
    ["modelNamesAndIds", "modelFieldNames", "notesInfo", "findNotes"]);
  assert.match(calls.find(call => call.action === "notesInfo").params.query,
    /note:Japanese.*note:Kiku v2/iu);
  assert.doesNotMatch(calls.find(call => call.action === "notesInfo").params.query,
    /Basic/u);
});

test("live lookup filters the configured deck and subdecks, verifies exact field values and calculates maturity", async () => {
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "deck" }));
  const calls = [];
  const invoke = async (action, params) => {
    calls.push({ action, params });
    if (action === "modelNamesAndIds") return { Japanese: 1, Lapis: 2, Other: 3 };
    if (action === "modelFieldNames") return KIKU_FIELDS;
    if (action === "notesInfo") return [
      note(30, "Japanese", { Expression: "猫です" }),
      note(20, "Lapis", { Expression: "猫" }),
      note(10, "Japanese", { Expression: "猫" }),
    ];
    if (action === "findNotes") return [20];
    throw new Error(`Unexpected ${action}`);
  };
  assert.deepEqual(await lookupAnkiIndex(invoke, source, "猫"), {
    wordKey: "猫",
    mature: true,
    noteIds: [10, 20],
  });
  const lookup = calls.find(call => call.action === "notesInfo").params.query;
  assert.match(lookup, /deck:Mining\\:\\:Words/u);
  assert.match(lookup, /expression:猫/iu);
  assert.deepEqual(calls.find(call => call.action === "findNotes").params,
    { query: "nid:10,20 is:review -is:learn prop:ivl>=21" });
});

test("cached note inspection selects only an exact configured-type overwrite target and reports stale IDs", async () => {
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "all" }));
  const invoke = async (action, params) => {
    assert.equal(action, "notesInfo");
    assert.deepEqual(params, { notes: [7, 8, 9] });
    return [
      note(7, "Kiku", { Expression: "猫" }),
      note(8, "Japanese", { Expression: "猫", Sentence: "old" }),
    ];
  };
  const inspected = await inspectAnkiNoteIds(invoke, source, "猫", [9, 8, 7]);
  assert.equal(inspected.stale, true);
  assert.deepEqual(inspected.target, {
    noteId: 8,
    fields: { Expression: "猫", Sentence: "old" },
  });

  const changed = await inspectAnkiNoteIds(async () => [
    note(8, "Japanese", { Expression: "犬", Sentence: "old" }),
  ], source, "猫", [8]);
  assert.equal(changed.stale, true);
  assert.equal(changed.target, null);
});
