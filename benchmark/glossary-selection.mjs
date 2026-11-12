// Production resource-field planning for a twenty-dictionary result. Measures
// export rendering, style planning and media references; excludes dictionary
// lookup, network/upload, capture and Anki writes.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = resolve(option("--source", ".")), runs = Number(option("--runs", 30));
const require = createRequire(resolve(import.meta.dirname, "../test/tooling/package.json"));
const { JSDOM } = require("jsdom");
const { buildAnkiResourceFields } = await import(pathToFileURL(resolve(source, "extension/anki-resources.js")));
const dom = new JSDOM("<!doctype html>");
const request = { generation: 3, term: { expression: "猫", reading: "ねこ", rules: "", frequencies: [], pitches: [],
  glossaries: Array.from({ length: 20 }, (_, dictionary) => Array.from({ length: 3 }, (_, row) => ({
    dictionary: `Dictionary ${dictionary + 1}`, definitionTags: "common", termTags: "n", glossary: JSON.stringify([
      { type: "structured-content", content: { tag: "div", content: Array.from({ length: 4 }, (_, sense) => ({ tag: "p",
        content: [`猫 definition ${sense + 1}, dictionary ${dictionary + 1} row ${row + 1}. `,
          { tag: "em", content: "A repeated passage for precise highlighting." }] })) } },
      { type: "image", path: `row-${row}.png`, width: 100, height: 50 },
    ]) }))).flat() }, trace: [], dictionaryAliases: {} };
const dictionaryPaths = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`Dictionary ${index + 1}`, `/dicts/generation-${index + 1}`]));
const modes = args.includes("--plain") ? ["plain"] : args.includes("--legacy-only") ? ["legacy"] : ["legacy", "selected", "fallback"];
const values = { legacy: "{glossary}", selected: "{selected-glossary}", fallback: "{selected-glossary}" };
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
const samples = Object.fromEntries(modes.map(mode => [mode, []]));
try {
  for (let run = -2; run < runs; run++) {
    // Rotate mode order to avoid assigning every cold or warm sample to one mode.
    const offset = (run + 2) % modes.length;
    for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
      const selected = mode === "selected" ? { ...request, glossarySelection: { dictionary: "Dictionary 7", index: 1,
        ranges: [{ path: ["glossary", 0, "content", "content", 0, "content", 1, "content"], start: 2, end: 10 }] } } : request;
      const start = performance.now();
      if (mode === "plain") {
        let characters = 0;
        for (let index = 0; index < 2000; index++) characters += globalThis.HDGlossary.glossaryToPlainText(
          request.term.glossaries[index % request.term.glossaries.length].glossary).length;
        const ms = performance.now() - start;
        assert.ok(characters > 0);
        if (run >= 0) samples[mode].push(ms);
        continue;
      }
      const result = await buildAnkiResourceFields(selected, {
        Front: { value: "{expression}", overwriteMode: "coalesce" }, Back: { value: values[mode], overwriteMode: "coalesce" },
      }, { document: dom.window.document, dictionaryPaths, styles: async () => [] });
      const ms = performance.now() - start;
      assert.equal(result.media.length, mode === "legacy" ? 60 : 1);
      if (mode === "selected") assert.ok(result.fields.Back.includes("<b>repeated</b>"));
      if (run >= 0) samples[mode].push(ms);
    }
  }
  console.log(JSON.stringify({ commit: args.includes("--revision") ? option("--revision") : execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    node: process.version, os: `${platform()}/${arch()}`, cpu: cpus()[0]?.model, runs,
    input: { dictionaries: 20, rowsPerDictionary: 3, sensesPerRow: 4, imageReferencesPerRow: 1 },
    boundary: modes[0] === "plain" ? "production glossaryToPlainText, 2000 conversions per sample; no DOM or media"
      : "production buildAnkiResourceFields, DOM export and media-reference planning; no lookup, capture, network or Anki",
    results: Object.fromEntries(modes.map(mode => [mode, { samplesMs: samples[mode], medianMs: percentile(samples[mode], .5),
      p95Ms: percentile(samples[mode], .95), media: mode === "plain" ? 0 : mode === "legacy" ? 60 : 1 }])) }, null, 2));
} finally { dom.window.close(); }
