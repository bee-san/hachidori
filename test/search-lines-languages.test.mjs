// SPDX-License-Identifier: GPL-3.0-or-later
// Rubi's cursor on the search page in a language read word by word
// (docs/languages.md 8.3, 8.5): a lookup there starts at a word's first
// letter, so the cursor rests only on word starts. Japanese, which passes no
// word rules, keeps Rubi's stops on every character.
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/vendor/languages/registry.js";
import { firstSelectable, stopAt } from "../extension/search-lines.js";

const rules = code => {
  const { text } = globalThis.HDLanguages.get(code);
  return { word: new RegExp(text.wordCharacters ?? text.pattern, "u"), internal: text.wordInternal ? new RegExp(text.wordInternal, "u") : null };
};

test("in English the cursor rests on word starts, and a click inside a word moves to its start", () => {
  const words = rules("en");
  const text = "They run late.";
  const stops = [];
  for (let at = 0; at !== null && at < text.length; at = firstSelectable(text, at + 1, false, words)) stops.push(at);
  assert.deepEqual(stops, [0, 5, 9, 13], "They, run, late and the full stop");
  assert.equal(stopAt("running late", 3, false, words), 0, "the second n of running");
  assert.equal(stopAt("running late", 8, false, words), 8);
  assert.equal(stopAt("co\u00ADoperate", 3, false, words), 0, "English's word-internal soft hyphen continues the word");
  assert.equal(stopAt("don't", 3, false, words), 3, "an apostrophe is not word-internal in English");
});

test("without word rules every visible character is a stop, as Rubi's are", () => {
  assert.equal(firstSelectable("食べる", 1, true), 1);
  assert.equal(stopAt("食べる", 2, true, null), 2);
  assert.equal(firstSelectable("They run", 1, false), 1);
});
