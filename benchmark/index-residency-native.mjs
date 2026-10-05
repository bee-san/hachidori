// SPDX-License-Identifier: GPL-3.0-or-later
// The existing engine benchmark times Lookup.lookup, without WASM serialization.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendJsonlDurable, hostSnapshot } from "./system.mjs";

const [binary, fixtureDirectory, outputDirectory] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(resolve(fixtureDirectory, "fixture.json"), "utf8"));
const output = resolve(outputDirectory);
mkdirSync(output, { recursive: true });
const args = [resolve(fixtureDirectory, "words.txt"), "2"];
for (const kind of ["term", "freq", "pitch", "kanji"]) {
  args.push(`--${kind}`, ...fixture.dictionaries.map(dictionary => dictionary.directory));
}
args.push("--paged-entries", "--json");
writeFileSync(resolve(output, "definition.json"), JSON.stringify({
  binary: resolve(binary), binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  args, environment: hostSnapshot(), fixture, samples: 3,
  boundary: "steady_clock around Lookup.lookup; excludes result serialization, counting and destruction; OS cache uncontrolled",
}, null, 2));
let counts;
for (let repetition = 0; repetition < 3; repetition++) {
  for (const mode of repetition % 2 ? ["paged", "resident"] : ["resident", "paged"]) {
    const command = [...args, ...(mode === "paged" ? ["--paged-index"] : [])];
    const result = JSON.parse(execFileSync(resolve(binary), command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
    assert.equal(result.words, fixture.corpus.length);
    for (const pass of result.passes) assert.ok(pass.every(Number.isFinite));
    const actual = [result.result_count, result.glossary_count];
    if (counts) assert.deepEqual(actual, counts);
    counts = actual;
    appendJsonlDurable(resolve(output, "raw.jsonl"), { repetition, mode, ...result });
    console.log(`${mode} #${repetition + 1}: ${result.words} words, ${result.result_count} results, ${result.glossary_count} glossaries`);
  }
}
