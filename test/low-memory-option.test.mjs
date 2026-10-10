// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const { DEFAULT_OPTIONS, KEYBIND_TOGGLE_OPTIONS, normaliseOptions, projectStoredOptions, validateOptionsPatch }
  = globalThis.HDReaderOptions;

test("useLessRamByDefault starts off for new and existing installs and accepts only boolean changes", () => {
  assert.equal(DEFAULT_OPTIONS.useLessRamByDefault, false);
  assert.equal(normaliseOptions({}).useLessRamByDefault, false);
  assert.equal(normaliseOptions({ useLessRamByDefault: false }).useLessRamByDefault, false);
  assert.equal(normaliseOptions({ useLessRamByDefault: true }).useLessRamByDefault, true, "preserve explicit opt-in");
  assert.deepEqual(validateOptionsPatch({ useLessRamByDefault: true }), { useLessRamByDefault: true });
  for (const garbage of ["false", 0, null]) {
    assert.equal(normaliseOptions({ useLessRamByDefault: garbage }).useLessRamByDefault, false);
  }
  assert.deepEqual(projectStoredOptions({ useLessRamByDefault: "off" }), { useLessRamByDefault: false });
  assert.deepEqual(validateOptionsPatch({ useLessRamByDefault: false }), { useLessRamByDefault: false });
  assert.throws(() => validateOptionsPatch({ useLessRamByDefault: "off" }), /invalid reader option/);
  assert.ok(!KEYBIND_TOGGLE_OPTIONS.includes("useLessRamByDefault"));
});

test("lowMemoryMode is a boolean option that starts off", () => {
  assert.equal(DEFAULT_OPTIONS.lowMemoryMode, false);
  assert.equal(normaliseOptions({}).lowMemoryMode, false, "missing");
  assert.equal(normaliseOptions({ lowMemoryMode: true }).lowMemoryMode, true, "stored on");
  for (const garbage of ["true", 1, null, {}, []]) {
    assert.equal(normaliseOptions({ lowMemoryMode: garbage }).lowMemoryMode, false, `garbage ${JSON.stringify(garbage)}`);
  }
  assert.deepEqual(projectStoredOptions({ lowMemoryMode: "yes" }), { lowMemoryMode: false },
    "stored garbage falls back to the default without throwing");
});

test("lowMemoryMode patches accept only booleans", () => {
  assert.deepEqual(validateOptionsPatch({ lowMemoryMode: true }), { lowMemoryMode: true });
  assert.deepEqual(validateOptionsPatch({ lowMemoryMode: false }), { lowMemoryMode: false });
  assert.throws(() => validateOptionsPatch({ lowMemoryMode: "on" }), /invalid reader option/);
});

test("lowMemoryMode is not offered as a hotkey toggle", () => {
  assert.ok(!KEYBIND_TOGGLE_OPTIONS.includes("lowMemoryMode"));
  assert.ok(KEYBIND_TOGGLE_OPTIONS.includes("hoverEnabled"), "reader toggles stay");
});


test("dictionary entry storage defaults to automatic and validates explicit policies", () => {
  assert.equal(DEFAULT_OPTIONS.dictionaryEntryStorage, "auto");
  assert.equal(normaliseOptions({ lowMemoryMode: false }).dictionaryEntryStorage, "auto",
    "existing installations adopt the OPFS default without rewriting stored options");
  for (const value of ["auto", "paged", "resident"]) {
    assert.equal(normaliseOptions({ dictionaryEntryStorage: value }).dictionaryEntryStorage, value);
    assert.deepEqual(validateOptionsPatch({ dictionaryEntryStorage: value }), { dictionaryEntryStorage: value });
  }
  for (const value of [true, "disk", null]) {
    assert.equal(normaliseOptions({ dictionaryEntryStorage: value }).dictionaryEntryStorage, "auto");
    assert.throws(() => validateOptionsPatch({ dictionaryEntryStorage: value }), /invalid reader option/);
  }
});
test("dictionary index storage defaults to automatic and validates explicit policies", () => {
  assert.equal(DEFAULT_OPTIONS.dictionaryIndexStorage, "auto");
  assert.equal(normaliseOptions({ lowMemoryMode: false }).dictionaryIndexStorage, "auto",
    "existing installations keep automatic index selection without rewriting stored options");
  for (const value of ["auto", "paged", "resident"]) {
    assert.equal(normaliseOptions({ dictionaryIndexStorage: value }).dictionaryIndexStorage, value);
    assert.deepEqual(validateOptionsPatch({ dictionaryIndexStorage: value }), { dictionaryIndexStorage: value });
  }
  for (const value of [true, "disk", null]) {
    assert.equal(normaliseOptions({ dictionaryIndexStorage: value }).dictionaryIndexStorage, "auto");
    assert.throws(() => validateOptionsPatch({ dictionaryIndexStorage: value }), /invalid reader option/);
  }
});
