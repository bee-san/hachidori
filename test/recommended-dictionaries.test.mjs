// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { RECOMMENDED_DICTIONARIES, describeRecommendedCatalogue } from "../extension/recommended-dictionaries.js";
import { FIRST_INSTALL_SELECTIONS } from "../extension/setup-state.js";

const EXTENSION = new URL("../extension/", import.meta.url);

test("every catalogue entry declares its topic and first-install option", () => {
  const sourceIds = RECOMMENDED_DICTIONARIES.map((entry) => entry.sourceId);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  for (const entry of RECOMMENDED_DICTIONARIES) {
    assert.equal(typeof entry.topic, "string");
    assert.notEqual(entry.topic, "");
    assert.ok(entry.firstInstallOption === null || typeof entry.firstInstallOption === "string");
  }
  assert.deepEqual(
    Object.entries(FIRST_INSTALL_SELECTIONS).map(([sourceId, rule]) => [sourceId, rule.option]),
    RECOMMENDED_DICTIONARIES.filter((entry) => entry.firstInstallOption !== null)
      .map((entry) => [entry.sourceId, entry.firstInstallOption]),
  );
});

test("the catalogue summary follows its entries", () => {
  assert.deepEqual(describeRecommendedCatalogue(), {
    count: "five",
    topics: "words, names, kanji, frequency and grammar",
  });
});

// Startup and Settings both describe the catalogue, so a count, source ID or
// catalogue URL written anywhere else in the extension drifts when the
// catalogue changes.
test("no extension page or script keeps its own copy of the catalogue", async () => {
  const names = (await readdir(EXTENSION, { recursive: true }))
    .filter((name) => /\.(?:js|html)$/u.test(name) && !name.startsWith("vendor/") && name !== "recommended-dictionaries.js");
  const countPhrase = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:trusted|recommended|default)\s+)?(?:dictionaries|sources)\b/iu;
  for (const name of names) {
    const source = await readFile(new URL(name, EXTENSION), "utf8");
    assert.doesNotMatch(source, countPhrase, `${name} hardcodes the catalogue size`);
    for (const entry of RECOMMENDED_DICTIONARIES) {
      for (const literal of [`"${entry.sourceId}"`, entry.downloadUrl, entry.indexUrl]) {
        assert.ok(!source.includes(literal), `${name} repeats the catalogue value ${literal}`);
      }
    }
  }
});
