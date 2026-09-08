import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLookupStatsRows, emptyLookupStats, incrementLookupStats, lookupStatsKey,
  lookupStatsPrefix, normaliseLookupTerm,
} from "../extension/lookup-stats.js";

test("lookup statistics use canonical term/reading keys without conflating readings or delimiters", () => {
  assert.deepEqual(normaliseLookupTerm("  は\u3099  ", " は\u3099 "), { term: "ば", reading: "ば" });
  assert.deepEqual(normaliseLookupTerm("猫"), { term: "猫", reading: "" });
  assert.throws(() => normaliseLookupTerm("  "), /term/u);
  const descriptor = { generation: "one", revision: 1 };
  assert.notEqual(lookupStatsKey(descriptor, { term: "生", reading: "せい" }),
    lookupStatsKey(descriptor, { term: "生", reading: "なま" }));
  assert.notEqual(lookupStatsKey(descriptor, { term: 'a","b', reading: "c" }),
    lookupStatsKey(descriptor, { term: "a", reading: 'b","c' }));
  assert.ok(lookupStatsKey(descriptor, normaliseLookupTerm("猫")).startsWith(lookupStatsPrefix(descriptor)));
  assert.notEqual(lookupStatsPrefix(descriptor), lookupStatsPrefix({ generation: 'one":', revision: 1 }));
});

test("recording increments one row and preserves earliest/latest timestamps across clock movement", () => {
  const term = normaliseLookupTerm("猫", "ねこ");
  const first = incrementLookupStats(undefined, term, 100);
  assert.deepEqual(first, { ...term, lookupCount: 1, firstLookedUpAt: 100, lastLookedUpAt: 100 });
  const second = incrementLookupStats(first, term, 90);
  const third = incrementLookupStats(second, term, 110);
  assert.deepEqual(third, { ...term, lookupCount: 3, firstLookedUpAt: 90, lastLookedUpAt: 110 });
  assert.equal(first.lookupCount, 1, "do not mutate the committed row");
  assert.throws(() => incrementLookupStats({ ...first, lookupCount: -1 }, term, 120), /statistics/u);
  assert.throws(() => incrementLookupStats(first, normaliseLookupTerm("犬"), 120), /statistics/u);
});

test("backup statistics reject malformed or duplicate rows without silently repairing counts", () => {
  const row = incrementLookupStats(undefined, normaliseLookupTerm("猫", "ねこ"), 100);
  assertLookupStatsRows(emptyLookupStats(), []);
  const descriptor = { generation: "one", revision: 3 };
  assertLookupStatsRows(descriptor, [row, { ...row, reading: "" }]);
  for (const rows of [[row, row], [{ ...row, term: " 猫" }], [{ ...row, lookupCount: 1.5 }],
    [{ ...row, lastLookedUpAt: 99 }], [{ ...row, firstLookedUpAt: Infinity }]]) {
    assert.throws(() => assertLookupStatsRows(descriptor, rows), /statistics/u);
  }
  assert.throws(() => assertLookupStatsRows(emptyLookupStats(), [row]), /statistics/u);
  assert.throws(() => assertLookupStatsRows({ generation: "one", revision: -1 }, []), /statistics/u);
});
