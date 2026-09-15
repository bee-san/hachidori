// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const {
  DEFAULT_OPTIONS,
  definitionBlurFrequencyEvidence,
  definitionBlurQualifies,
  normaliseOptions,
  validateOptionsPatch,
} = globalThis.HDReaderOptions;

const options = overrides => ({ ...DEFAULT_OPTIONS,
  definitionBlurFrequencyEnabled: true,
  definitionBlurFrequencyDictionary: "Frequency",
  definitionBlurFrequencyThreshold: 100,
  ...overrides,
});
const groups = values => [{ dictionary: "Frequency", frequencies: values.map(value =>
  typeof value === "object" ? value : { value, displayValue: String(value) }) }];
const source = (frequencyMode, overrides = {}) => [{ title: "Frequency", frequencyMode, frequencyCount: 2, ...overrides }];

test("frequency blur options are backward-compatible, bounded, and strict", () => {
  const defaults = normaliseOptions({});
  assert.equal(defaults.definitionBlurFrequencyEnabled, false);
  assert.equal(defaults.definitionBlurFrequencyDictionary, "");
  assert.equal(defaults.definitionBlurFrequencyOrder, "auto");
  assert.equal(defaults.definitionBlurFrequencyThreshold, 10000);
  assert.equal(normaliseOptions({ definitionBlurFrequencyThreshold: 0 }).definitionBlurFrequencyThreshold, 1);
  assert.equal(normaliseOptions({ definitionBlurFrequencyOrder: "sideways" }).definitionBlurFrequencyOrder, "auto");
  assert.deepEqual(validateOptionsPatch({
    definitionBlurFrequencyEnabled: true,
    definitionBlurFrequencyDictionary: "Frequency",
    definitionBlurFrequencyOrder: "descending",
    definitionBlurFrequencyThreshold: 12345,
  }), {
    definitionBlurFrequencyEnabled: true,
    definitionBlurFrequencyDictionary: "Frequency",
    definitionBlurFrequencyOrder: "descending",
    definitionBlurFrequencyThreshold: 12345,
  });
  assert.throws(() => validateOptionsPatch({ definitionBlurFrequencyThreshold: Infinity }), /invalid reader option/u);
  assert.throws(() => validateOptionsPatch({ definitionBlurFrequencyOrder: "sideways" }), /invalid reader option/u);
});

test("auto uses the minimum rank and maximum occurrence value at inclusive boundaries", () => {
  assert.deepEqual(definitionBlurFrequencyEvidence(options(), groups([100, 250]), source("rank-based")),
    { qualified: true, value: 100, order: "ascending" });
  assert.deepEqual(definitionBlurFrequencyEvidence(options({ definitionBlurFrequencyThreshold: 99 }),
    groups([100, 20]), source("rank-based")),
  { qualified: true, value: 20, order: "ascending" });
  assert.deepEqual(definitionBlurFrequencyEvidence(options({ definitionBlurFrequencyThreshold: 250 }),
    groups([100, 250]), source("occurrence-based")),
  { qualified: true, value: 250, order: "descending" });
  assert.deepEqual(definitionBlurFrequencyEvidence(options({ definitionBlurFrequencyThreshold: 251 }),
    groups([100, 250]), source(null)),
  { qualified: false, value: 250, order: "descending" });
});

test("explicit order overrides metadata and only positive finite native values count", () => {
  assert.deepEqual(definitionBlurFrequencyEvidence(options({
    definitionBlurFrequencyOrder: "descending",
    definitionBlurFrequencyThreshold: 200,
  }), groups([100, 250]), source("rank-based")),
  { qualified: true, value: 250, order: "descending" });
  assert.deepEqual(definitionBlurFrequencyEvidence(options({
    definitionBlurFrequencyOrder: "ascending",
    definitionBlurFrequencyThreshold: 100,
  }), groups([
    { value: 140, displayValue: "1" },
    { value: 90, displayValue: "999999" },
    { value: 0, displayValue: "0" },
    { value: -4, displayValue: "-4" },
    { value: Infinity, displayValue: "infinite" },
    { value: "1", displayValue: "1" },
  ]), source("occurrence-based")),
  { qualified: true, value: 90, order: "ascending" });
});

test("missing, disabled, nonnumeric, and unselected frequency sources fail open", () => {
  const unavailable = { qualified: false, value: null, order: null };
  assert.deepEqual(definitionBlurFrequencyEvidence(options({ definitionBlurFrequencyEnabled: false }),
    groups([100]), source("rank-based")), unavailable);
  assert.deepEqual(definitionBlurFrequencyEvidence(options({ definitionBlurFrequencyDictionary: "" }),
    groups([100]), source("rank-based")), unavailable);
  assert.deepEqual(definitionBlurFrequencyEvidence(options(), groups([100]), []), unavailable);
  assert.deepEqual(definitionBlurFrequencyEvidence(options(), groups([100]), source("rank-based", { enabled: false })),
    unavailable);
  assert.deepEqual(definitionBlurFrequencyEvidence(options(), groups([100]), source("rank-based", { frequencyCount: 0 })),
    unavailable);
  assert.deepEqual(definitionBlurFrequencyEvidence(options(), groups([{ displayValue: "100" }]), source("rank-based")),
    unavailable);
});

test("frequency qualification ORs independently with count and Anki evidence", () => {
  const combined = options({ definitionBlurEnabled: true, definitionBlurAnkiMature: true,
    definitionBlurDirection: "atLeast", definitionBlurThreshold: 5 });
  assert.equal(definitionBlurQualifies(combined, 1, false, true), true);
  assert.equal(definitionBlurQualifies(combined, 5, false, false), true);
  assert.equal(definitionBlurQualifies(combined, 1, true, false), true);
  assert.equal(definitionBlurQualifies(combined, 1, false, false), false);
  assert.equal(definitionBlurQualifies({ ...combined, definitionBlurFrequencyEnabled: false }, 1, false, true), false);
});
