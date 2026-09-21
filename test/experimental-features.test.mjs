// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const {
  DEFAULT_OPTIONS,
  EXPERIMENTAL_FEATURES,
  normaliseOptions,
  projectStoredOptions,
  validateOptionsPatch,
} = globalThis.HDReaderOptions;

test("experimental features are registered with defaults that start off", () => {
  assert.ok(EXPERIMENTAL_FEATURES.some(feature => feature.id === "mediaMining"));
  for (const feature of EXPERIMENTAL_FEATURES) {
    assert.equal(typeof feature.label, "string");
    assert.equal(typeof feature.description, "string");
    assert.equal(DEFAULT_OPTIONS.experimental[feature.id], false);
  }
  assert.deepEqual(Object.keys(DEFAULT_OPTIONS.experimental), EXPERIMENTAL_FEATURES.map(feature => feature.id));
  const first = normaliseOptions({}).experimental;
  const second = normaliseOptions({}).experimental;
  assert.deepEqual(first, DEFAULT_OPTIONS.experimental);
  assert.notEqual(first, second, "each normalised view owns its experimental object");
});

test("experimental patches accept only registered boolean flags", () => {
  assert.deepEqual(validateOptionsPatch({ experimental: { mediaMining: true } }),
    { experimental: { mediaMining: true } });
  // A complete record is required, as for mediaCapture, so a writer cannot silently drop a flag.
  for (const invalid of [null, [], "on", {}, { mediaMining: "yes" }, { mediaMining: true, unknown: true }]) {
    assert.throws(() => validateOptionsPatch({ experimental: invalid }), /invalid reader option/);
  }
  assert.deepEqual(projectStoredOptions({ experimental: { mediaMining: 1, extra: true } }).experimental,
    { mediaMining: false }, "stored garbage falls back to the default without throwing");
});

test("a missing experimental record inherits media mining from the legacy capture switch", () => {
  assert.equal(normaliseOptions({ mediaCapture: { enabled: true } }).experimental.mediaMining, true);
  assert.equal(normaliseOptions({ mediaCapture: { enabled: false } }).experimental.mediaMining, false);
  assert.equal(normaliseOptions({ experimental: { mediaMining: false }, mediaCapture: { enabled: true } })
    .experimental.mediaMining, false, "a stored record wins over the legacy switch");
  assert.equal(normaliseOptions({ experimental: { mediaMining: true }, mediaCapture: { enabled: false } })
    .experimental.mediaMining, true);
});
