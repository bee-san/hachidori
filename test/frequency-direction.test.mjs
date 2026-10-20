// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { inferFrequencyDirection } from "../extension/frequency-direction.js";

const dictionary = { title: "Frequency", language: "ja" };
const result = (term, values, title = dictionary.title) => ({ term: { expression: term,
  frequencies: [{ dictionary: title, frequencies: values.map(value => ({ value })) }] } });

test("unsupported languages do not get sampled", async () => {
  const unexpected = () => { throw new Error("unexpected lookup"); };
  assert.equal(await inferFrequencyDirection({ ...dictionary, language: "en" }, unexpected), null);
});

for (const [common, rare, expected] of [[10, 9000, "ascending"], [9000, 10, "descending"]]) {
  test(`missing frequency metadata is inferred as ${expected} from exact words in the selected dictionary`, async () => {
    let count = 0;
    const direction = await inferFrequencyDirection(dictionary, async term => {
      const value = count++ < 10 ? common : rare;
      return { results: [result(term, [value, value + 1]), result(term, [999999], "Other"), result(term + "別", [999999])] };
    });
    assert.equal(direction, expected);
    assert.equal(count, 20);
  });
}

test("missing or tied samples leave direction undecided, and missing language uses Japanese samples", async () => {
  for (const values of [[], [42], [NaN, Infinity]]) {
    assert.equal(await inferFrequencyDirection({ title: dictionary.title }, async term => ({ results: [result(term, values)] })), null);
  }
});
