// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { ankiMaturitySource, ankiMaturityWordKey, fetchAnkiMatureWords } from "../extension/anki-maturity.js";

const template = value => ({ value, overwriteMode: "coalesce" });
const config = patch => globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Japanese", apiKey: "fixture-key",
  fields: { expression: "Expression" }, ...patch } }).anki;
const note = (fields, noteId = 12) => ({ noteId, modelName: "Japanese",
  fields: Object.fromEntries(Object.entries(fields).map(([name, value], order) => [name, { value, order }])) });

test("a mature snapshot uses one read-only note query across all decks with its own refresh timeout", async () => {
  const source = await ankiMaturitySource(config({ deck: "Mining::New", duplicateScope: "deck", checkForDuplicates: false }));
  const calls = [];
  const words = await fetchAnkiMatureWords({ async invoke(...args) {
    calls.push(args);
    return [note({ Expression: "猫", Sentence: "ignore this" }), note({ Expression: "猫" }, 13), note({ Expression: "犬" }, 14)];
  } }, source);
  assert.deepEqual(words, ["猫", "犬"]);
  assert.deepEqual(calls, [["notesInfo", {
    query: '"note:Japanese" is:review -is:learn prop:ivl>=21',
  }, "fixture-key", 25_000]]);
  assert.deepEqual(await fetchAnkiMatureWords({ invoke: async () => [] }, source), []);
});

test("source identity includes only the note type, eligible expression fields and API key", async () => {
  const source = await ankiMaturitySource(config());
  assert.match(source.key, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ ...source, key: undefined }, { key: undefined, model: "Japanese", fields: ["expression"], apiKey: "fixture-key" });
  for (const change of [{ deck: "Other" }, { tags: "new" }, { duplicateScope: "deck" },
    { fields: { expression: "EXPRESSION", sentence: "Sentence" } },
    { fieldTemplates: { Expression: template("{ExPrEsSiOn}"), Other: template("{sentence}") } }]) {
    assert.equal((await ankiMaturitySource(config(change))).key, source.key);
  }
  for (const change of [{ model: "Other" }, { apiKey: "new-key" }, { fields: { expression: "Word" } },
    { fieldTemplates: { Expression: template("{expression}"), Word: template("{expression}") } }]) {
    assert.notEqual((await ankiMaturitySource(config(change))).key, source.key);
  }
  const first = await ankiMaturitySource(config({ fieldTemplates: { Word: template("{expression}"), Expression: template("{expression}") } }));
  const second = await ankiMaturitySource(config({ fieldTemplates: { expression: template("{expression}"), WORD: template("{expression}") } }));
  assert.equal(first.key, second.key);
});

test("plain expression templates resolve case-insensitively across presets and multiple fields", async () => {
  for (const field of ["Expression", "word", "Front"]) {
    const source = await ankiMaturitySource(config({ fields: {}, fieldTemplates: { [field]: template("{ExPrEsSiOn}"), Other: template("{sentence}") } }));
    assert.deepEqual(source.fields, [field.toLowerCase()]);
    assert.deepEqual(await fetchAnkiMatureWords({ invoke: async () => [note({ [field.toUpperCase()]: "猫", Other: "犬" })] }, source), ["猫"]);
  }
  const source = await ankiMaturitySource(config({ fieldTemplates: {
    Expression: template("{expression}"), Word: template("{expression}"), Stale: template("{expression}"),
  } }));
  assert.deepEqual(await fetchAnkiMatureWords({ invoke: async () => [note({ Expression: "猫", WORD: "犬" })] }, source), ["猫", "犬"]);
});

test("mixed, missing, disabled and operator mappings cannot identify mature words", async () => {
  for (const change of [{ model: "" }, { fields: {} },
    { fields: { expression: "Expression", sentence: "expression" } },
    { fieldTemplates: { Front: template("{expression}<br>{reading}") } },
    { fieldTemplates: { Front: template("<b>{expression}</b>") } },
    { fieldTemplates: { Front: template("") } },
    ...["note", "Deck", "is", "prop", "re", "mid", "has-cd"].map(expression => ({ fields: { expression } }))]) {
    assert.equal(await ankiMaturitySource(config(change)), null);
  }
  for (const expression of [undefined, null, "", 12]) assert.equal(ankiMaturityWordKey(expression), null);
});

test("the snapshot preserves exact stored HTML and literal names without substring or search interpretation", async () => {
  const source = await ankiMaturitySource(config({ model: 'Japanese "*_:\\', fields: { expression: 'Word "*_:\\' } }));
  const expression = `re:猫<&>"'*_:\\ (or)`;
  const stored = 're:猫&lt;&amp;&gt;&quot;&#x27;*_:\\ (or)';
  const words = await fetchAnkiMatureWords({ async invoke(action, params) {
    assert.equal(params.query, String.raw`"note:Japanese \"\*\_\:\\" is:review -is:learn prop:ivl>=21`);
    return [{ ...note({ 'Word "*_:\\': stored }), modelName: source.model }];
  } }, source);
  assert.equal(new Set(words).has(ankiMaturityWordKey(expression)), true);
  const plainSource = await ankiMaturitySource(config());
  const htmlWords = new Set(await fetchAnkiMatureWords({ invoke: async () => [note({ Expression: "<b>猫</b>" }),
    note({ Expression: "猫です" }, 13), note({ Expression: "'" }, 14), note({ Expression: "&apos;" }, 15)] }, plainSource));
  for (const value of ["猫", "<b>猫</b>", "'"]) assert.equal(htmlWords.has(ankiMaturityWordKey(value)), false);
});

test("membership follows Anki's ASCII-only case folding and default query NFC normalization", async () => {
  const source = await ankiMaturitySource(config());
  const words = new Set(await fetchAnkiMatureWords({ invoke: async () => [note({ Expression: "HELLO" }),
    note({ Expression: "É" }, 13), note({ Expression: "が" }, 14), note({ Expression: "は\u3099" }, 15)] }, source));
  for (const value of ["hello", "HeLLo", "É", "が", "か\u3099"]) assert.equal(words.has(ankiMaturityWordKey(value)), true, value);
  for (const value of ["é", "ば", "は\u3099"]) assert.equal(words.has(ankiMaturityWordKey(value)), false, value);
  assert.equal(words.has("は\u3099"), true, "stored NFD is retained without turning it into matching NFC");
});

test("failed or partially malformed bulk replies reject instead of publishing partial words", async () => {
  const source = await ankiMaturitySource(config());
  for (const result of [null, {}, [null], [{}], [{ ...note({ Expression: "猫" }), noteId: "12" }],
    [{ ...note({ Expression: "猫" }), modelName: "Other" }], [{ ...note({ Expression: "猫" }), fields: [] }],
    [note({ Expression: "猫" }), note({ Expression: 12 }, 13)],
    [note({ Expression: "猫" }), note({ Expression: "犬", Other: null }, 13)]]) {
    await assert.rejects(fetchAnkiMatureWords({ invoke: async () => result }, source), /invalid mature note/iu);
  }
  await assert.rejects(fetchAnkiMatureWords({ invoke: async () => { throw new Error("AnkiConnect timed out"); } }, source), /timed out/u);
});
