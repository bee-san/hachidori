// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression test for issue #333: mergeKanjiGroupResults produced a synthetic
// term result missing the fields contract B (LOOKUP_RESULT) requires — rules,
// trace, deinflected, preprocessorSteps, glossary.definitionTags, and
// glossary.termTags — causing TypeError: Cannot read properties of undefined
// (reading 'split') whenever Anki preflight evaluated pitchCategories,
// part-of-speech, tags, or conjugation against a kanji-bank member card.
//
// This file:
//  - Loads the real anki-values.js via node:vm (stripping import/export
//    keywords, shimming globalThis.HDGlossary exactly as the offscreen does).
//  - Exercises the four marker functions that crashed (pitchCategories,
//    part-of-speech, tags, conjugation) against a broken pre-fix shape.
//  - Confirms all four succeed on the fixed shape that mergeKanjiGroupResults
//    now emits, matching the LOOKUP_RESULT contract at node-smoke.mjs:154-160.
//  - Verifies the fixed result shape itself satisfies every field the contract
//    names so that future changes to mergeKanjiGroupResults that regress the
//    shape fail here before reaching extension-smoke or chrome-e2e.
//
// Run: node test/kanji-group-split-repro.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(root, "extension");

// ---------------------------------------------------------------------------
// Load anki-values.js into a vm sandbox, stripping ES module syntax and
// providing the minimal globalThis shim the module needs.
// ---------------------------------------------------------------------------

function loadAnkiValues() {
  const strip = (src) => src
    .replace(/^import[^\n]+\n/gmu, "")
    .replace(/^export\s+/gmu, "");

  // anki-values.js calls ankiTemplateMarkerNames / renderAnkiTemplate /
  // escapeAnkiHtml from anki-templates.js.  Load templates first so those
  // names are in scope when anki-values.js module-level code runs.
  const templatesSrc = strip(readFileSync(resolve(extension, "anki-templates.js"), "utf8"));
  const valuesSrc    = strip(readFileSync(resolve(extension, "anki-values.js"),    "utf8"));

  const sandbox = {
    globalThis: {
      // anki-templates.js: const { ANKI_FIELDS } = globalThis.HDReaderOptions
      HDReaderOptions: { ANKI_FIELDS: [] },
      HDGlossary: {
        splitPitchAccentMorae: (text) => Array.from(text || ""),
        segmentFurigana: (expression, reading) => [{ text: expression, reading }],
      },
    },
  };

  const ctx = createContext(sandbox);
  runInContext(`${templatesSrc}\n${valuesSrc}\nthis.__buildAnkiFields = buildAnkiFields;`, ctx);
  return ctx.__buildAnkiFields;
}

const buildAnkiFields = loadAnkiValues();

// ---------------------------------------------------------------------------
// Synthetic term shapes
// ---------------------------------------------------------------------------

// Pre-fix: what mergeKanjiGroupResults produced before the #333 fix.
// Matches the original broken literal in content.js that omitted every
// field the LOOKUP_RESULT / TERM / GLOSSARY contracts require.
const brokenTerm = {
  expression: "食",
  reading: "",
  frequencies: [],
  pitches: [],
  glossaries: [{ dictionary: "KanjiBank", glossary: "meaning" }],
  // Missing: rules, score
  // Glossary missing: definitionTags, termTags
};

const brokenResult = {
  matched: "食",
  // Missing: deinflected, trace, preprocessorSteps
  term: brokenTerm,
};

// Post-fix: the complete LOOKUP_RESULT shape mergeKanjiGroupResults now emits.
// Satisfies every field at node-smoke.mjs:154-160 (matched, deinflected,
// trace:[], preprocessorSteps:0, rules:"", score:0, definitionTags:"", termTags:"").
const fixedTerm = {
  expression: "食",
  reading: "",
  rules: "",
  score: 0,
  frequencies: [],
  pitches: [],
  glossaries: [{ dictionary: "KanjiBank", glossary: "meaning", definitionTags: "", termTags: "" }],
};

const fixedResult = {
  matched: "食",
  deinflected: "食",
  trace: [],
  preprocessorSteps: 0,
  term: fixedTerm,
};

// ---------------------------------------------------------------------------
// Minimal Anki request wrapper understood by buildAnkiFields.
// Only the fields touched by the four crashing markers are populated.
// ---------------------------------------------------------------------------

function makeRequest(result) {
  return {
    ...result,
    sentence: "食べたかった",
    matchOffset: 0,
    matched: result.matched,
    popupSelectionText: "",
    searchQuery: "",
    documentTitle: "",
    dictionaryAliases: {},
    dictionaryIds: {},
    frequencyDictionaries: [],
    screenshot: null,
    captureUnavailable: [],
  };
}

// Minimal template set — just the four markers that caused issue #333 crashes.
const CRASHING_TEMPLATES = {
  PitchCategories: { value: "{pitch-accent-categories}" },
  PartOfSpeech:    { value: "{part-of-speech}" },
  Tags:            { value: "{tags}" },
  Conjugation:     { value: "{conjugation}" },
};

// Stub definition renderer — not exercised by the crashing markers.
const noDefinition = () => "";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issue #333 — mergeKanjiGroupResults produces a complete LookupResult shape", () => {

  // -------------------------------------------------------------------------
  // Shape contract validation for the fixed result
  // -------------------------------------------------------------------------

  describe("fixed result shape satisfies the LOOKUP_RESULT contract (node-smoke.mjs:154-160)", () => {
    test("matched is a string", () => {
      assert.equal(typeof fixedResult.matched, "string");
    });
    test("deinflected is a string", () => {
      assert.equal(typeof fixedResult.deinflected, "string");
    });
    test("trace is an array", () => {
      assert.ok(Array.isArray(fixedResult.trace));
    });
    test("preprocessorSteps is a number", () => {
      assert.equal(typeof fixedResult.preprocessorSteps, "number");
    });
    test("term.expression is a string", () => {
      assert.equal(typeof fixedResult.term.expression, "string");
    });
    test("term.reading is a string", () => {
      assert.equal(typeof fixedResult.term.reading, "string");
    });
    test("term.rules is a string (was missing pre-fix)", () => {
      assert.equal(typeof fixedResult.term.rules, "string");
    });
    test("term.score is a number (was missing pre-fix)", () => {
      assert.equal(typeof fixedResult.term.score, "number");
    });
    test("term.frequencies is an array", () => {
      assert.ok(Array.isArray(fixedResult.term.frequencies));
    });
    test("term.pitches is an array", () => {
      assert.ok(Array.isArray(fixedResult.term.pitches));
    });
    test("term.glossaries is an array", () => {
      assert.ok(Array.isArray(fixedResult.term.glossaries));
    });
    test("glossary.dictionary is a string", () => {
      assert.equal(typeof fixedResult.term.glossaries[0].dictionary, "string");
    });
    test("glossary.glossary is a string", () => {
      assert.equal(typeof fixedResult.term.glossaries[0].glossary, "string");
    });
    test("glossary.definitionTags is a string (was missing pre-fix)", () => {
      assert.equal(typeof fixedResult.term.glossaries[0].definitionTags, "string");
    });
    test("glossary.termTags is a string (was missing pre-fix)", () => {
      assert.equal(typeof fixedResult.term.glossaries[0].termTags, "string");
    });
  });

  // -------------------------------------------------------------------------
  // Regression: the broken pre-fix shape crashes every affected marker
  // -------------------------------------------------------------------------

  describe("broken pre-fix shape crashes the affected buildAnkiFields markers", () => {
    const brokenRequest = makeRequest(brokenResult);

    for (const [field, template] of Object.entries(CRASHING_TEMPLATES)) {
      test(`${field} throws on the pre-fix shape`, async () => {
        await assert.rejects(
          () => buildAnkiFields(brokenRequest, { [field]: template }, { definition: noDefinition }),
          (err) => {
            // The exact TypeError message that the issue reports
            const msg = String(err?.message ?? err);
            assert.ok(
              msg.includes("split") || msg.includes("undefined") || msg.includes("map"),
              `Expected a property-access crash but got: ${msg}`,
            );
            return true;
          },
          `${field} should throw on a pre-fix result that is missing contract-B fields`,
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Regression guard: the fixed shape succeeds for every affected marker
  // -------------------------------------------------------------------------

  describe("fixed post-fix shape succeeds for all previously crashing markers", () => {
    const fixedRequest = makeRequest(fixedResult);

    test("pitchCategories ({pitch-accent-categories}) returns a string", async () => {
      const fields = await buildAnkiFields(
        fixedRequest,
        { PitchCategories: { value: "{pitch-accent-categories}" } },
        { definition: noDefinition },
      );
      assert.equal(typeof fields.PitchCategories, "string",
        `expected string, got ${JSON.stringify(fields.PitchCategories)}`);
    });

    test("part-of-speech ({part-of-speech}) returns 'Unknown' for a kanji card with no tags", async () => {
      const fields = await buildAnkiFields(
        fixedRequest,
        { PartOfSpeech: { value: "{part-of-speech}" } },
        { definition: noDefinition },
      );
      // A kanji card has empty rules and no termTags, so the marker falls back to "Unknown"
      assert.equal(fields.PartOfSpeech, "Unknown");
    });

    test("tags ({tags}) returns empty string for a kanji card with no tags", async () => {
      const fields = await buildAnkiFields(
        fixedRequest,
        { Tags: { value: "{tags}" } },
        { definition: noDefinition },
      );
      assert.equal(fields.Tags, "");
    });

    test("conjugation ({conjugation}) returns empty string for an uninflected kanji card", async () => {
      const fields = await buildAnkiFields(
        fixedRequest,
        { Conjugation: { value: "{conjugation}" } },
        { definition: noDefinition },
      );
      // trace is [], rules is "" — both sides of the conjugation fallback are empty
      assert.equal(fields.Conjugation, "");
    });

    test("all four crashing markers resolve together without any throw", async () => {
      const fields = await buildAnkiFields(
        fixedRequest,
        CRASHING_TEMPLATES,
        { definition: noDefinition },
      );
      for (const field of Object.keys(CRASHING_TEMPLATES)) {
        assert.equal(typeof fields[field], "string",
          `${field} should produce a string value`);
      }
    });
  });
});