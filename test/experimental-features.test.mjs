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
  assert.ok(!EXPERIMENTAL_FEATURES.some(feature => feature.id === "mediaMining"));
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
  const complete = { ...DEFAULT_OPTIONS.experimental, mdxImport: true };
  assert.deepEqual(validateOptionsPatch({ experimental: complete }), { experimental: complete });
  // A complete record prevents a writer from silently dropping another flag.
  for (const invalid of [null, [], "on", {}, { mdxImport: true }, { ...complete, mdxImport: "yes" },
    { ...complete, unknown: true }]) {
    assert.throws(() => validateOptionsPatch({ experimental: invalid }), /invalid reader option/);
  }
  assert.deepEqual(projectStoredOptions({ experimental: { mediaMining: 1, extra: true } }).experimental,
    DEFAULT_OPTIONS.experimental, "stored garbage falls back to the default without throwing");
});

test("legacy recorder settings do not reappear when options are normalised", () => {
  const options = normaliseOptions({ experimental: { mediaMining: true }, mediaCapture: { enabled: true } });
  assert.equal(Object.hasOwn(options, "mediaCapture"), false);
  assert.equal(Object.hasOwn(options.experimental, "mediaMining"), false);
  assert.deepEqual(options.experimental, DEFAULT_OPTIONS.experimental);
});
