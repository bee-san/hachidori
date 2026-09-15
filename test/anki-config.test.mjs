// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANKI_CONFIG_SCHEMA_VERSION, DEFAULT_ANKI_CONFIG, normaliseAnkiConfig,
} from "../extension/anki-config.js";

test("missing Anki configuration migrates to the current versioned defaults", () => {
  assert.deepEqual(normaliseAnkiConfig(undefined), DEFAULT_ANKI_CONFIG);
  assert.equal(DEFAULT_ANKI_CONFIG.schemaVersion, ANKI_CONFIG_SCHEMA_VERSION);
  assert.equal(DEFAULT_ANKI_CONFIG.url, "http://127.0.0.1:8765");
  assert.equal(DEFAULT_ANKI_CONFIG.apiKey, "");
  assert.equal(DEFAULT_ANKI_CONFIG.deck, "Default");
  assert.equal(DEFAULT_ANKI_CONFIG.model, "");
});

test("current Anki configuration preserves valid fields and canonicalises its URL", () => {
  assert.deepEqual(normaliseAnkiConfig({
    schemaVersion: 1,
    url: " http://localhost:9999/anki#fragment ",
    apiKey: "key",
    deck: "Mining",
    model: "Japanese",
    ignored: "value",
  }), {
    schemaVersion: 1,
    url: "http://localhost:9999/anki",
    apiKey: "key",
    deck: "Mining",
    model: "Japanese",
  });
});

test("invalid endpoints and malformed stored values fail closed without changing defaults", () => {
  for (const url of ["", "ftp://127.0.0.1:8765", "http://user:pass@localhost:8765", "not a url"]) {
    assert.equal(normaliseAnkiConfig({ schemaVersion: 1, url }).url, "");
  }
  assert.throws(() => normaliseAnkiConfig({ schemaVersion: 99, url: "https://example.com" }),
    /newer Anki configuration/u);
  for (const schemaVersion of [null, "1", 1.5, -1]) {
    assert.throws(() => normaliseAnkiConfig({ schemaVersion }), /invalid Anki configuration version/u);
  }
});
