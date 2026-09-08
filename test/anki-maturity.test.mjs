// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";

const template = value => ({ value, overwriteMode: "coalesce" });
const term = { expression: "猫", reading: "ねこ" };

function fixture(anki = {}, enabled = true) {
  const calls = [];
  const options = { ...globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Japanese", apiKey: "fixture-key",
    fields: { expression: "Expression" }, ...anki } }), definitionBlurAnkiMature: enabled };
  let result = [12], error = null;
  const gateway = { async invoke(...args) {
    calls.push(args);
    if (error) throw error;
    return result;
  } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    readDictionaries() { throw new Error("Maturity must not read dictionaries"); },
    engine() { throw new Error("Maturity must not reach the engine"); },
    offscreen() { throw new Error("Maturity must not render or prepare media"); } });
  return { service, calls, options, setResult(value) { result = value; }, fail(value) { error = value; } };
}

test("maturity uses one read-only exact expression search for review intervals of at least 21 days", async () => {
  const f = fixture({ deck: "Mining::New", duplicateScope: "deck", checkForDuplicates: false });
  assert.deepEqual(await f.service.maturity({ term }), { mature: true });
  assert.deepEqual(f.calls, [["findCards", {
    query: '"note:Japanese" "Expression:猫" is:review -is:learn prop:ivl>=21',
  }, "fixture-key"]]);
  f.setResult([]);
  assert.deepEqual(await f.service.maturity({ term }), { mature: false });
});

test("plain expression templates work across presets while mixed, missing and disabled mappings make no request", async () => {
  for (const field of ["Expression", "word", "Front"]) {
    const f = fixture({ fields: {}, fieldTemplates: { [field]: template("{ExPrEsSiOn}"), Other: template("{sentence}") } });
    assert.deepEqual(await f.service.maturity({ term }), { mature: true });
    assert.equal(f.calls[0][1].query, `"note:Japanese" "${field}:猫" is:review -is:learn prop:ivl>=21`);
  }
  const multiple = fixture({ fieldTemplates: { Expression: template("{expression}"), Word: template("{expression}") } });
  assert.deepEqual(await multiple.service.maturity({ term }), { mature: true });
  assert.equal(multiple.calls[0][1].query,
    '"note:Japanese" ("Expression:猫" or "Word:猫") is:review -is:learn prop:ivl>=21');
  for (const [anki, enabled] of [
    [{}, false], [{ model: "" }, true], [{ fields: {} }, true],
    [{ fields: { expression: "Expression", sentence: "expression" } }, true],
    [{ fieldTemplates: { Front: template("{expression}<br>{reading}") } }, true],
    [{ fieldTemplates: { Front: template("<b>{expression}</b>") } }, true],
    [{ fieldTemplates: { Front: template("") } }, true],
  ]) {
    const f = fixture(anki, enabled);
    assert.deepEqual(await f.service.maturity({ term }), { mature: false });
    assert.deepEqual(f.calls, []);
  }
});

test("maturity quotes literal names and HTML expression values without letting them change search semantics", async () => {
  const f = fixture({ model: 'Japanese "*_:\\', fields: { expression: 'Word "*_:\\' } });
  assert.deepEqual(await f.service.maturity({ term: { expression: `re:猫<&>"'*_:\\ (or)`, reading: "" } }), { mature: true });
  assert.equal(f.calls[0][1].query,
    String.raw`"note:Japanese \"\*\_\:\\" "Word \"\*\_\:\\:re\:猫&lt;&amp;&gt;&quot;&#x27;\*\_\:\\ (or)" is:review -is:learn prop:ivl>=21`);
});

test("reserved Anki search operator field names fail open instead of searching a different identity", async () => {
  for (const expression of ["note", "Deck", "is", "prop", "re", "mid", "has-cd"]) {
    const f = fixture({ fields: { expression } });
    assert.deepEqual(await f.service.maturity({ term }), { mature: false });
    assert.deepEqual(f.calls, []);
  }
});

test("Anki errors, malformed card IDs and missing lookup terms fail open without other work", async () => {
  const f = fixture();
  for (const result of [null, {}, ["12"], [0], [-1], [12, "invalid"], [Number.MAX_SAFE_INTEGER + 1]]) {
    f.setResult(result);
    assert.deepEqual(await f.service.maturity({ term }), { mature: false });
  }
  f.fail(new Error("AnkiConnect timed out"));
  assert.deepEqual(await f.service.maturity({ term }), { mature: false });
  const before = f.calls.length;
  for (const request of [undefined, {}, { term: {} }, { term: { expression: "" } }]) {
    assert.deepEqual(await f.service.maturity(request), { mature: false });
  }
  assert.equal(f.calls.length, before);
});
