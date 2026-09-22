// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const { normaliseKanjiSelection, normaliseOptions, resolveKanjiDictionary, validateOptionsPatch }
  = globalThis.HDReaderOptions;

function dictionary(id, title, counts = {}) {
  return { id, title, enabled: true, termCount: 0, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, ...counts };
}

const dictionaries = [
  dictionary("kanjidic", "KANJIDIC", { kanjiCount: 1 }),
  dictionary("bees", "Bee's Kanji", { termCount: 1, frequencyCount: 1 }),
  dictionary("disabled", "Disabled kanji", { kanjiCount: 1, enabled: false }),
  dictionary("pitch", "Pitch only", { pitchCount: 1 }),
  dictionary("legacy", "Legacy counts"),
];
const groups = [
  { id: "g1", name: "Kanji", dictionaryIds: ["bees", "missing", "disabled", "pitch", "kanjidic", "legacy"] },
  { id: "empty", name: "Empty", dictionaryIds: ["pitch", "disabled"] },
];

test("a group reference round-trips through the clicked-kanji option", () => {
  const group = { kind: "tabGroup", id: "g1" };
  assert.deepEqual(normaliseKanjiSelection(group), group);
  assert.deepEqual(normaliseKanjiSelection({ ...group, ignored: true }), group, "unknown fields are dropped");
  assert.deepEqual(normaliseOptions({ kanjiClickDictionary: group }).kanjiClickDictionary, group);
  assert.deepEqual(validateOptionsPatch({ kanjiClickDictionary: group }), { kanjiClickDictionary: group });
  assert.deepEqual(normaliseKanjiSelection({ title: "KANJIDIC", kind: "kanji" }), { title: "KANJIDIC", kind: "kanji" },
    "dictionary selections are unchanged");
  assert.equal(normaliseKanjiSelection("KANJIDIC"), "KANJIDIC", "legacy titles are unchanged");
  for (const garbage of [{ kind: "tabGroup", id: "" }, { kind: "tabGroup", title: "g1" }, { kind: "tabGroup", id: 3 }]) {
    assert.equal(normaliseKanjiSelection(garbage), "", `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ kanjiClickDictionary: garbage }), /invalid reader option/);
  }
});

test("a group resolves to its eligible members in group order with a kind per member", () => {
  assert.deepEqual(resolveKanjiDictionary({ kind: "tabGroup", id: "g1" }, dictionaries, groups), {
    kind: "group",
    members: [
      { kind: "term", title: "Bee's Kanji" },
      { kind: "kanji", title: "KANJIDIC" },
      { kind: "term", title: "Legacy counts" },
    ],
  }, "uninstalled, disabled and metadata-only members are skipped");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "empty" }, dictionaries, groups), null,
    "a group without an eligible member falls back to native kanji");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "gone" }, dictionaries, groups), null,
    "a removed group falls back to native kanji");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "g1" }, dictionaries), null,
    "callers without group state resolve no group");
});

test("dictionary selections still resolve to one capability", () => {
  assert.deepEqual(resolveKanjiDictionary({ title: "KANJIDIC", kind: "kanji" }, dictionaries, groups),
    { kind: "kanji", title: "KANJIDIC" });
  assert.deepEqual(resolveKanjiDictionary("Bee's Kanji", dictionaries, groups), { kind: "term", title: "Bee's Kanji" },
    "a legacy title infers its kind");
  assert.equal(resolveKanjiDictionary({ title: "Disabled kanji", kind: "kanji" }, dictionaries, groups), null);
  assert.equal(resolveKanjiDictionary({ title: "KANJIDIC", kind: "term" }, dictionaries, groups), null,
    "a requested kind the dictionary lacks is unavailable");
  assert.equal(resolveKanjiDictionary("", dictionaries, groups), null);
});
