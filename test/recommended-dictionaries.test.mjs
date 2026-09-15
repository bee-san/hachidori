// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { RECOMMENDED_DICTIONARIES, describeRecommendedCatalogue } from "../extension/recommended-dictionaries.js";
import { FIRST_INSTALL_SELECTIONS } from "../extension/setup-state.js";
import {
  assertRecommendedDictionary, managedDictionarySource, recommendedDictionaryInstalled,
  recommendedDownloadUrlMatches,
} from "../extension/managed-dictionary-source.js";

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
    count: "six",
    topics: "words, names, kanji, frequency, grammar and translated definitions",
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
      for (const literal of [`"${entry.sourceId}"`, entry.downloadUrl, entry.indexUrl].filter(Boolean)) {
        assert.ok(!source.includes(literal), `${name} repeats the catalogue value ${literal}`);
      }
    }
  }
});

test("Sankoku English is a pinned recommendation without invented update metadata", () => {
  const entry = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "sankoku8-eng");
  assert.ok(entry);
  assert.equal(entry.downloadUrl, "https://github.com/shoui520/sankoku8-eng/releases/download/latest/en.zip");
  assert.equal(entry.githubRepositoryId, "1371843420");
  assert.equal(entry.indexUrl, null);
  const dictionary = { title: "sankoku8-gpt-5.6-luna", revision: "sankoku8-gpt-5.6-luna",
    indexUrl: null, termCount: 1 };
  assert.doesNotThrow(() => assertRecommendedDictionary(entry, dictionary));
  assert.throws(() => assertRecommendedDictionary(entry, { ...dictionary, title: `${dictionary.title} en-jp` }), /title/u);
  assert.throws(() => assertRecommendedDictionary(entry, { ...dictionary, indexUrl: "https://example.com/index.json" }), /update source/u);
  assert.throws(() => assertRecommendedDictionary(entry, { ...dictionary, termCount: 0 }), /capability/u);
  assert.equal(recommendedDictionaryInstalled(entry, [dictionary]), false);
  const installed = { ...dictionary, sourceId: entry.sourceId, downloadUrl: entry.downloadUrl, isUpdatable: false };
  assert.equal(recommendedDictionaryInstalled(entry, [installed]), true);
  assert.equal(managedDictionarySource(installed), null);
  assert.equal(managedDictionarySource({ ...installed, isUpdatable: true, indexUrl: "https://example.com/index.json" }), null);
  assert.equal(recommendedDownloadUrlMatches(entry, entry.downloadUrl), true);
  const finalUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/1371843420/id?rscd=attachment%3B%20filename%3Den.zip";
  assert.equal(recommendedDownloadUrlMatches(entry, finalUrl), true);
  assert.equal(recommendedDownloadUrlMatches(entry, finalUrl.replace("1371843420", "1")), false);
  assert.equal(recommendedDownloadUrlMatches(entry, entry.downloadUrl.replace("en.zip", "en-jp.zip")), false);
});
