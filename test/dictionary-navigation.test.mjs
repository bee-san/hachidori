// Dictionary keybinds must visit short and partially visible cards in order.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import popup from "../extension/render/popup.js";
const card = (dictionary, top, bottom) => ({ dictionary, getBoundingClientRect: () => ({ top, bottom }) });
const scroll = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
const find = (entries, index, sign, current) => popup.findDifferentDictionary(entries, index, sign, scroll,
  entry => entry, item => item.dictionary, current);

test("a partly shown second dictionary is the next stop, even when it fills most of the viewport", () => {
  const a = card("A", -50, 10), b = card("B", 10, 110), c = card("C", 110, 130);
  assert.equal(find([[a, b, c]], 0, 1)?.target, b);
});

test("short dictionaries at the scroll limit advance and reverse without getting stuck", () => {
  const a = card("A", -100, 30), b = card("B", 30, 50), c = card("C", 50, 70), d = card("D", 70, 90);
  const entry = [a, b, c, d];
  const cursor = target => ({ entry, target, scrollTop: 0 });
  assert.equal(find([entry], 0, 1, cursor(b))?.target, c);
  assert.equal(find([entry], 0, 1, cursor(c))?.target, d);
  assert.equal(find([entry], 0, 1, cursor(d)), null);
  assert.equal(find([entry], 0, -1, cursor(d))?.target, c);
  assert.equal(find([entry], 0, -1, cursor(c))?.target, b);
  assert.equal(find([entry], 0, 1, { ...cursor(d), scrollTop: 20 })?.target, b, "manual scrolling retires the cursor");
});

test("scrolling away from the clicked entry still finds the visible dictionary", () => {
  const a = card("A", -150, -50), b = card("B", -50, 50), c = card("C", 50, 150);
  assert.equal(find([[a], [b, c]], 0, 1)?.target, c);
  assert.equal(find([[a], [b, c]], 0, -1)?.target, a);
});
