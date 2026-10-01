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
import { AnkiConnectError, ankiInvokeFake } from "./anki-connect-fake.mjs";

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
const SENREN_FIELDS = ["word", "reading", "sentence", "sentenceFurigana", "sentenceAudio", "definition", "wordAudio",
  "picture", "glossary", "frequencies", "freqSort", "miscInfo"];

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
  // The rendered {expression} field encodes braces so they cannot form a cloze deletion.
  assert.equal(ankiWordKey("{{c1::猫}}"), "&#123;&#123;c1::猫&#125;&#125;");
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
  for (const field of ["note", "Deck", "is", "prop", "re", "mid", "has-cd"]) {
    assert.equal(await ankiIndexSource(baseConfig({
      fieldTemplates: { [field]: template("{expression}") },
    })), null);
  }
});

test("a complete refresh stores compact sorted rows across recognized note types and aggregates maturity", async () => {
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "all" }));
  const calls = [];
  const answer = ankiInvokeFake(async (action, params) => {
    calls.push({ action, params });
    if (action === "modelNamesAndIds") return { Japanese: 1, "Kiku v2": 2, Basic: 3 };
    if (action === "modelFieldNames") {
      assert.equal(params.modelName, "Kiku v2");
      return KIKU_FIELDS;
    }
    if (action === "findNotes") return params.query.includes("is:review") ? [8, 11] : [11, 9, 7, 8];
    if (action === "notesInfo") {
      assert.deepEqual(params.notes, [7, 8, 9, 11]);
      return [
        note(11, "Japanese", { Expression: "犬", Sentence: "ignored" }),
        note(9, "Kiku v2", { Expression: "猫", Sentence: "ignored" }),
        note(7, "Japanese", { Expression: "猫", Sentence: "ignored" }),
        note(8, "Kiku v2", { Expression: "猫", Sentence: "ignored" }),
      ];
    }
    throw new Error(`Unexpected ${action}`);
  });
  const requests = [];
  const invoke = async (action, params) => { requests.push(action); return answer(action, params); };
  assert.deepEqual(await fetchAnkiIndex(invoke, source), [
    ["犬", true, [11]],
    ["猫", true, [7, 8, 9]],
  ]);
  assert.deepEqual(requests, ["modelNamesAndIds", "multi", "findNotes", "findNotes", "notesInfo"]);
  assert.match(calls.find(call => call.action === "findNotes"
    && !call.params.query.includes("is:review")).params.query,
    /note:Japanese.*note:Kiku v2/iu);
  assert.doesNotMatch(calls.find(call => call.action === "findNotes"
    && !call.params.query.includes("is:review")).params.query,
    /Basic/u);
});

test("live lookup filters the configured deck and subdecks, verifies exact field values and batches maturity with the candidate search", async () => {
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "deck" }));
  const calls = [];
  const invoke = ankiInvokeFake(async (action, params) => {
    calls.push({ action, params });
    if (action === "modelNamesAndIds") return { Japanese: 1, Lapis: 2, Other: 3 };
    if (action === "modelFieldNames") return KIKU_FIELDS;
    // Note 30 is mature but its value is not an exact match, so it must not count.
    if (action === "findNotes") return params.query.includes("is:review") ? [30, 20] : [30, 20, 10];
    if (action === "notesInfo") {
      assert.deepEqual(params.notes, [10, 20, 30]);
      return [
        note(30, "Japanese", { Expression: "猫です" }),
        note(20, "Lapis", { Expression: "猫" }),
        note(10, "Japanese", { Expression: "猫" }),
      ];
    }
    throw new Error(`Unexpected ${action}`);
  });
  const requests = [];
  const counted = async (action, params) => { requests.push(action); return invoke(action, params); };
  assert.deepEqual(await lookupAnkiIndex(counted, source, "猫"), {
    wordKey: "猫",
    mature: true,
    noteIds: [10, 20],
  });
  // Two AnkiConnect round trips after discovery: one multi, then notesInfo.
  assert.deepEqual(requests, ["modelNamesAndIds", "multi", "multi", "notesInfo"]);
  const [lookup, mature] = calls.filter(call => call.action === "findNotes").map(call => call.params.query);
  assert.match(lookup, /deck:Mining\\:\\:Words/u);
  assert.match(lookup, /expression:猫/iu);
  assert.equal(mature, `${lookup} is:review -is:learn prop:ivl>=21`);

  const immature = ankiInvokeFake(async (action, params) => action === "notesInfo"
    ? [note(10, "Japanese", { Expression: "猫" }), note(30, "Japanese", { Expression: "猫です" })]
    : action === "findNotes" ? (params.query.includes("is:review") ? [30] : [10, 30]) : { Japanese: 1 });
  assert.deepEqual(await lookupAnkiIndex(immature, source, "猫"), { wordKey: "猫", mature: false, noteIds: [10] });
});

test("every recognized note type's fields arrive in one multi, and a note type deleted since discovery fails the lookup", async () => {
  const fields = { Lapis: KIKU_FIELDS, "Kiku v2": KIKU_FIELDS, Senren: SENREN_FIELDS };
  let models = { Japanese: 1, Lapis: 2, "Kiku v2": 3, Senren: 4, Basic: 5 }, deleted = null;
  const answer = ankiInvokeFake(async (action, params) => {
    if (action === "modelNamesAndIds") return models;
    if (action === "modelFieldNames") {
      if (params.modelName === deleted) throw new AnkiConnectError(`model was not found: ${deleted}`);
      return fields[params.modelName];
    }
    if (action === "findNotes") return [];
    throw new Error(`Unexpected ${action}`);
  });
  let requests = [];
  const invoke = async (action, params) => {
    requests.push(action === "multi" ? params.actions : action);
    return answer(action, params);
  };
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "all" }));
  assert.deepEqual(await lookupAnkiIndex(invoke, source, "猫"), { wordKey: "猫", mature: false, noteIds: [] });
  assert.equal(requests.length, 3, "modelNamesAndIds, one field multi, one search multi");
  assert.equal(requests[0], "modelNamesAndIds");
  assert.deepEqual(requests[1], ["Lapis", "Kiku v2", "Senren"].map(modelName =>
    ({ action: "modelFieldNames", params: { modelName } })));
  const [{ params: { query } }] = requests[2];
  for (const clause of ['"note:Japanese" "expression:猫"', '"note:Lapis" "expression:猫"',
    '"note:Kiku v2" "expression:猫"', '"note:Senren" "word:猫"']) assert.ok(query.includes(clause), clause);
  assert.doesNotMatch(query, /Basic/u);

  // Without another recognized note type, nothing reads fields.
  requests = [];
  models = { Japanese: 1, Basic: 5 };
  await lookupAnkiIndex(invoke, source, "猫");
  assert.deepEqual(requests.map(request => Array.isArray(request) ? request.map(entry => entry.action) : request),
    ["modelNamesAndIds", ["findNotes", "findNotes"]]);

  models = { Japanese: 1, Lapis: 2, "Kiku v2": 3, Senren: 4 };
  deleted = "Kiku v2";
  const named = { message: "Anki has no note type named “Kiku v2”. Choose an available note type in Anki Settings. "
    + "(AnkiConnect: model was not found: Kiku v2)" };
  await assert.rejects(lookupAnkiIndex(invoke, source, "猫"), named);
  await assert.rejects(fetchAnkiIndex(invoke, source), named);
});

test("deck-scope maturity is judged per card inside the configured deck, identically for the complete index and the live lookup", async () => {
  // Anki searches cards, so a note whose only mature card sits in another deck
  // is not mature within this scope. Both index paths therefore append the
  // maturity predicates to the same deck-scoped card search rather than asking
  // about matched note IDs across all decks.
  const source = await ankiIndexSource(baseConfig({ duplicateScope: "deck" }));
  const queries = [];
  const invoke = ankiInvokeFake(async (action, params) => {
    if (action === "findNotes") { queries.push(params.query); return []; }
    if (action === "modelNamesAndIds") return { Japanese: 1 };
    throw new Error(`Unexpected ${action}`);
  });
  await fetchAnkiIndex(invoke, source);
  await lookupAnkiIndex(invoke, source, "猫");
  assert.equal(queries.length, 4);
  for (const [candidate, mature] of [queries.slice(0, 2), queries.slice(2)]) {
    assert.match(candidate, /"deck:Mining\\:\\:Words"/u);
    assert.equal(mature, `${candidate} is:review -is:learn prop:ivl>=21`);
  }
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

test("compact rows retain stored HTML and Unicode while folding only ASCII case", async () => {
  const source = await ankiIndexSource(baseConfig());
  const values = [
    [1, "HELLO"],
    [2, "É"],
    [3, "が"],
    [4, "は\u3099"],
    [5, "<b>猫</b>"],
  ];
  const rows = await fetchAnkiIndex(async (action, params) => action === "notesInfo"
    ? values.map(([noteId, value]) => note(noteId, "Japanese", { Expression: value }))
    : params.query.includes("is:review") ? [1, 4] : values.map(([noteId]) => noteId), source);
  assert.deepEqual(rows, [
    ["<b>猫</b>", false, [5]],
    ["hello", true, [1]],
    ["É", false, [2]],
    ["が", false, [3]],
    ["は\u3099", true, [4]],
  ]);
  assert.equal(ankiWordKey("HeLLo"), "hello");
  assert.equal(ankiWordKey("é"), "é");
  assert.equal(ankiWordKey("か\u3099"), "が");
  assert.equal(rows.some(([word]) => word === "ば"), false, "stored NFD is not normalized into a new match");
});

test("malformed bulk and live replies reject instead of publishing partial index rows", async () => {
  const source = await ankiIndexSource(baseConfig());
  const invalid = [
    null,
    {},
    [null],
    [{}],
    [{ ...note(1, "Japanese", { Expression: "猫" }), noteId: "1" }],
    [note(1, "Other", { Expression: "猫" })],
    [{ ...note(1, "Japanese", { Expression: "猫" }), fields: [] }],
    [note(1, "Japanese", {})],
    [note(1, "Japanese", { Expression: 12 })],
  ];
  for (const result of invalid) {
    await assert.rejects(fetchAnkiIndex(async (action, params) => action === "notesInfo"
      ? result : params.query.includes("is:review") ? [] : [1], source),
      /invalid note|outside the requested note types/iu);
  }
  await assert.rejects(fetchAnkiIndex(async (action, params) => action === "notesInfo"
    ? [note(1, "Japanese", { Expression: "猫" })] : params.query.includes("is:review") ? [0] : [1], source),
  /invalid mature note IDs/u);
  await assert.rejects(lookupAnkiIndex(ankiInvokeFake(async action => action === "notesInfo" ? invalid[4] : [1]), source, "猫"),
    /invalid note/iu);
  await assert.rejects(lookupAnkiIndex(ankiInvokeFake(async (action, params) => action === "notesInfo"
    ? [note(1, "Japanese", { Expression: "猫" })] : params.query.includes("is:review") ? [2] : [1]), source, "猫"),
  /invalid mature note IDs/u);
  await assert.rejects(lookupAnkiIndex(async action => action === "multi"
    ? [{ result: [1], error: null }, { result: null, error: "collection is not available" }] : [1], source, "猫"),
  /AnkiConnect: collection is not available/u);
});
