// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const { DEFAULT_OPTIONS, KEYBIND_TOGGLE_OPTIONS, normaliseOptions, projectStoredOptions, validateOptionsPatch }
  = globalThis.HDReaderOptions;

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
