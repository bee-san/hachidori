import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

test("popup scale persists as a Design percentage with an unchanged default", () => {
  const { DEFAULT_OPTIONS, DESIGN_OPTION_KEYS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
  assert.equal(DEFAULT_OPTIONS.popupScalePercent, 100);
  assert.ok(DESIGN_OPTION_KEYS.includes("popupScalePercent"));
  for (const popupScalePercent of [25, 67, 75, 100, 125, 500]) {
    assert.equal(normaliseOptions({ popupScalePercent }).popupScalePercent, popupScalePercent);
    assert.deepEqual(validateOptionsPatch({ popupScalePercent }), { popupScalePercent });
  }
  assert.equal(normaliseOptions({}).popupScalePercent, 100);
  assert.equal(normaliseOptions({ popupScalePercent: NaN }).popupScalePercent, 100);
  for (const popupScalePercent of [0, 24, 501, Infinity]) {
    assert.throws(() => validateOptionsPatch({ popupScalePercent }), /invalid reader option/u);
  }
});
