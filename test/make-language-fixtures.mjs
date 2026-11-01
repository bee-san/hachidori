#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// English and Arabic fixture dictionaries for test/node-smoke-languages.mjs
// (docs/languages.md 18): small Yomitan archives whose index declares
// sourceLanguage and targetLanguage, as real ones do, built with the same
// ZIP writer as the Japanese fixture. Run directly to write them under
// test/fixtures/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitledZip } from "./make-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
// The fixture packs the smoke test loads into the engine (test/data/languages/).
export const PACKS = join(HERE, "data/languages");

// [expression, reading, definitionTags, rules, score, glossary, sequence, termTags]
const term = (expression, rules, glossary, sequence) => [expression, "", "", rules, 0, [glossary], sequence, ""];

export const ENGLISH = {
  title: "hachidori-english-fixture",
  file: "hachidori-english-fixture.zip",
  sourceLanguage: "en",
  targetLanguage: "en",
  terms: [
    term("run", "v", "to move swiftly on foot", 1),
    term("walk", "v", "to move on foot at a moderate pace", 2),
    term("book", "n", "a set of written pages bound together", 3),
    term("go", "v", "to move from one place to another", 4),
    term("look up", "v", "to search for a word in a dictionary", 5),
    term("look", "v", "to direct the eyes toward something", 6),
  ],
};

export const ARABIC = {
  title: "hachidori-arabic-fixture",
  file: "hachidori-arabic-fixture.zip",
  sourceLanguage: "ar",
  targetLanguage: "en",
  terms: [
    term("\u0643\u062A\u0627\u0628", "n", "book", 1),
    term("\u0628\u064A\u062A", "n", "house", 2),
    term("\u0642\u0644\u0645", "n", "pen", 3),
  ],
};

export function buildLanguageFixtureZip(fixture) {
  return buildTitledZip(fixture.title, {
    terms: fixture.terms,
    revision: "1",
    indexOverrides: { sourceLanguage: fixture.sourceLanguage, targetLanguage: fixture.targetLanguage,
      description: `${fixture.title}: test fixture`, author: "Hachidori tests" },
  });
}

export function writeLanguageFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  return [ENGLISH, ARABIC].map(fixture => {
    const bytes = buildLanguageFixtureZip(fixture);
    const path = join(FIXTURES, fixture.file);
    writeFileSync(path, bytes);
    return { path, bytes: bytes.byteLength };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const { path, bytes } of writeLanguageFixtures()) console.log(`${String(bytes).padStart(7)}  ${path}`);
}
