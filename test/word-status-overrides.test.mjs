// SPDX-License-Identifier: GPL-3.0-or-later
// Word status overrides (#520): the stored record's shape, and one headword's
// change at a time, as the service worker writes them.
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/word-status-overrides.js";

const { emptyWordStatusOverrides, normaliseWordStatusOverrides, wordStatusOverrideMap, withWordStatusOverride } =
  globalThis.HDWordStatusOverrides;

test("a stored record normalises to its valid headwords, each under one status", () => {
  assert.deepEqual(normaliseWordStatusOverrides(undefined), emptyWordStatusOverrides());
  assert.deepEqual(normaliseWordStatusOverrides("garbage"), emptyWordStatusOverrides());
  assert.deepEqual(normaliseWordStatusOverrides({ revision: -1, known: "猫", ignored: null }), emptyWordStatusOverrides());
  assert.deepEqual(normaliseWordStatusOverrides({ revision: 4, known: ["猫", "", 7, "猫", "犬"], ignored: ["犬", "さん"] }),
    { revision: 4, known: ["猫", "犬"], ignored: ["さん"] });
  // __proto__ is an ordinary headword, never a prototype.
  const map = wordStatusOverrideMap({ revision: 1, known: ["__proto__"], ignored: ["constructor"] });
  assert.deepEqual([...map], [["__proto__", "known"], ["constructor", "ignored"]]);
});

test("one headword is set, moved and cleared at the next revision, and a no-op keeps the record", () => {
  const empty = emptyWordStatusOverrides();
  const known = withWordStatusOverride(empty, "猫", "known");
  assert.deepEqual(known, { revision: 1, known: ["猫"], ignored: [] });
  assert.equal(withWordStatusOverride(known, "猫", "known"), known, "setting the same status changes nothing");
  assert.equal(withWordStatusOverride(known, "犬", null), known, "clearing an absent headword changes nothing");
  const moved = withWordStatusOverride(withWordStatusOverride(known, "犬", "known"), "猫", "ignored");
  assert.deepEqual(moved, { revision: 3, known: ["犬"], ignored: ["猫"] });
  assert.deepEqual(withWordStatusOverride(moved, "猫", null), { revision: 4, known: ["犬"], ignored: [] });
  assert.deepEqual(known, { revision: 1, known: ["猫"], ignored: [] }, "the earlier record is not changed");
  for (const [headword, status] of [["", "known"], [null, "known"], ["猫", "learning"], ["猫", undefined]]) {
    assert.throws(() => withWordStatusOverride(empty, headword, status), TypeError);
  }
});
