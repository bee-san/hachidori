import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { ankiSetupFamily, detectAnkiSetup } from "../extension/anki-setup.js";

const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "SelectionText", "MainDefinition",
  "Glossary", "Sentence", "SentenceFurigana", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo", "Picture"];
const SENREN_FIELDS = ["word", "reading", "sentence", "definition", "wordAudio", "picture", "glossary", "frequencies", "freqSort", "miscInfo"];
const baseConfig = () => globalThis.HDReaderOptions.normaliseOptions({}).anki;

// A tiny collection: note IDs per model, cards per note, and each card's deck.
function collection({ models, fields, notes, decks }) {
  const calls = [];
  const noteOfCard = new Map();
  for (const [noteId, cardIds] of Object.entries(notes.cards ?? {})) for (const card of cardIds) noteOfCard.set(card, Number(noteId));
  const invoke = async (action, params) => {
    calls.push({ action, params });
    switch (action) {
      case "modelNamesAndIds": return models;
      case "modelFieldNames": return fields[params.modelName];
      case "findNotes": {
        const id = Number(/^mid:(\d+)$/u.exec(params.query)[1]);
        return notes.byModel[id] ?? [];
      }
      case "findCards": {
        const id = Number(/^mid:(\d+) -deck:filtered$/u.exec(params.query)[1]);
        return (notes.byModel[id] ?? []).flatMap((noteId) => (notes.cards[noteId] ?? []).filter((card) => decks[card] !== "filtered"));
      }
      case "getDecks": {
        const grouped = {};
        for (const card of params.cards) (grouped[decks[card]] ??= []).push(card);
        return grouped;
      }
      case "cardsToNotes": return [...new Set(params.cards.map((card) => noteOfCard.get(card)))];
      default: throw new Error(`unexpected action ${action}`);
    }
  };
  return { invoke, calls };
}

test("family names lead the model name and versioned names match while substrings do not", () => {
  assert.equal(ankiSetupFamily("Kiku"), "kiku");
  assert.equal(ankiSetupFamily("kiku v2.1"), "kiku");
  assert.equal(ankiSetupFamily("Lapis-1.4"), "lapis");
  assert.equal(ankiSetupFamily("Senren (2025)"), "senren");
  assert.equal(ankiSetupFamily("  Senren"), "senren");
  assert.equal(ankiSetupFamily("Kikuchi"), null);
  assert.equal(ankiSetupFamily("My Kiku"), null);
  assert.equal(ankiSetupFamily("Lapis2"), null);
  assert.equal(ankiSetupFamily("Basic"), null);
});

test("the note type with the unique highest distinct-note count wins and its busiest ordinary deck is chosen", async () => {
  const { invoke, calls } = collection({
    models: { Basic: 1, "Kiku v2": 2, Lapis: 3, Kikuchi: 4, Senren: 5 },
    fields: { Basic: ["Front", "Back"], "Kiku v2": KIKU_FIELDS, Lapis: KIKU_FIELDS, Kikuchi: KIKU_FIELDS, Senren: ["Front", "Back"] },
    notes: {
      byModel: { 2: [21, 22, 23, 24], 3: [31, 32], 5: [51, 52, 53, 54, 55, 56] },
      // Note 21 has two cards in Mining; note 24 sits in a filtered deck; 23 is in a child deck.
      cards: { 21: [211, 212], 22: [221], 23: [231], 24: [241], 31: [311], 32: [321] },
    },
    decks: { 211: "Mining", 212: "Mining", 221: "Mining", 231: "Mining::Old", 241: "filtered", 311: "Japanese", 321: "Japanese" },
  });
  const result = await detectAnkiSetup(invoke, baseConfig());
  assert.equal(result.status, "configured");
  assert.equal(result.model, "Kiku v2");
  assert.equal(result.deck, "Mining");
  assert.equal(result.fieldTemplates.Expression.value, "{expression}");
  assert.equal(result.fieldTemplates.Picture.value, "");
  assert.equal(Object.keys(result.fieldTemplates).length, KIKU_FIELDS.length);
  // Senren is named like a family but lacks its fields; Basic and Kikuchi are never consulted for notes.
  assert.deepEqual(calls.filter((call) => call.action === "findNotes").map((call) => call.params.query), ["mid:2", "mid:3"]);
  assert.deepEqual(calls.filter((call) => call.action === "findCards").map((call) => call.params.query), ["mid:2 -deck:filtered"]);
  assert.deepEqual(calls.filter((call) => call.action === "getDecks").map((call) => call.params.cards), [[211, 212, 221, 231]]);
  assert.deepEqual(calls.filter((call) => call.action === "cardsToNotes").map((call) => call.params.cards), [[211, 212, 221], [231]]);
  assert.ok(calls.every((call) => !["notesInfo", "cardsInfo", "deckNames", "addNote", "createDeck"].includes(call.action)));
});

test("ties, zero usage, missing families and incompatible layouts ask for Settings instead of guessing", async () => {
  const tie = collection({ models: { Kiku: 1, Lapis: 2 }, fields: { Kiku: KIKU_FIELDS, Lapis: KIKU_FIELDS },
    notes: { byModel: { 1: [11, 12], 2: [21, 22] }, cards: {} }, decks: {} });
  assert.match((await detectAnkiSetup(tie.invoke, baseConfig())).detail, /share the highest note count/u);
  const empty = collection({ models: { Kiku: 1 }, fields: { Kiku: KIKU_FIELDS }, notes: { byModel: {}, cards: {} }, decks: {} });
  assert.match((await detectAnkiSetup(empty.invoke, baseConfig())).detail, /no notes yet/u);
  const none = collection({ models: { Basic: 1, "Core 2k": 2 }, fields: { Basic: ["Front", "Back"], "Core 2k": ["Word"] },
    notes: { byModel: { 1: [11] }, cards: {} }, decks: {} });
  assert.match((await detectAnkiSetup(none.invoke, baseConfig())).detail, /No Senren, Lapis or Kiku/u);
  const shape = collection({ models: { Kiku: 1 }, fields: { Kiku: ["Front", "Back"] }, notes: { byModel: { 1: [11] }, cards: {} }, decks: {} });
  assert.match((await detectAnkiSetup(shape.invoke, baseConfig())).detail, /No Senren, Lapis or Kiku/u);
  // A namesake carrying only part of the layout is not that setup: the family's
  // core (expression, reading, sentence and a definition) has to be there.
  for (const partial of [["Expression"], ["Expression", "Sentence"], ["Expression", "ExpressionReading", "Sentence"]]) {
    const namesake = collection({ models: { Kiku: 1 }, fields: { Kiku: partial },
      notes: { byModel: { 1: [11, 12] }, cards: { 11: [111], 12: [121] } }, decks: { 111: "Mining", 121: "Mining" } });
    assert.match((await detectAnkiSetup(namesake.invoke, baseConfig())).detail, /No Senren, Lapis or Kiku/u);
    assert.deepEqual(namesake.calls.filter((call) => call.action === "findNotes"), []);
  }
  // The core alone is enough, so a trimmed but usable layout still configures.
  const core = collection({ models: { "Kiku mini": 1 }, fields: { "Kiku mini": ["Expression", "ExpressionReading", "Sentence", "Glossary"] },
    notes: { byModel: { 1: [11] }, cards: { 11: [111] } }, decks: { 111: "Mining" } });
  assert.equal((await detectAnkiSetup(core.invoke, baseConfig())).status, "configured");
  const deckTie = collection({ models: { Senren: 1 }, fields: { Senren: SENREN_FIELDS },
    notes: { byModel: { 1: [11, 12] }, cards: { 11: [111], 12: [121] } }, decks: { 111: "A", 121: "B" } });
  assert.match((await detectAnkiSetup(deckTie.invoke, baseConfig())).detail, /Two decks share/u);
  const filteredOnly = collection({ models: { Senren: 1 }, fields: { Senren: SENREN_FIELDS },
    notes: { byModel: { 1: [11] }, cards: { 11: [111] } }, decks: { 111: "filtered" } });
  assert.match((await detectAnkiSetup(filteredOnly.invoke, baseConfig())).detail, /no cards in an ordinary deck/u);
  for (const outcome of [tie, empty, none, shape, deckTie, filteredOnly]) {
    assert.ok(outcome.calls.every((call) => !["addNote", "createDeck", "createModel", "updateNoteFields"].includes(call.action)));
  }
  const senren = collection({ models: { "Senren 3": 9 }, fields: { "Senren 3": SENREN_FIELDS },
    notes: { byModel: { 9: [91] }, cards: { 91: [911] } }, decks: { 911: "Words::Mined" } });
  const configured = await detectAnkiSetup(senren.invoke, baseConfig());
  assert.equal(configured.status, "configured");
  assert.deepEqual([configured.model, configured.deck, configured.fieldTemplates.word.value, configured.fieldTemplates.picture.value],
    ["Senren 3", "Words::Mined", "{expression}", ""]);
  await assert.rejects(detectAnkiSetup(async () => ["Kiku"], baseConfig()), /invalid note type list/u);
});
