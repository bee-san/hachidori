// Evidence for hachidori #596: classifies every pronunciation of a dumped case
// file with main's and this branch's HDGlossary.pitchAccentCategory.
//
//   node compare.mjs <main glossary.js> <branch glossary.js> <nhk-patterns.jsonl> [kanjium term_meta_bank dir]
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const [mainPath, branchPath, casesPath, kanjiumDir] = process.argv.slice(2);
const main = require(mainPath);
const branch = require(branchPath);
const pattern = value => ({ position: 0, pattern: value, nasal: [], devoice: [] });
const counts = {};
const examples = {};
const count = (key, example) => {
  counts[key] = (counts[key] ?? 0) + 1;
  if (example && (examples[key] ??= []).length < 4) examples[key].push(example);
};

for (const line of readFileSync(casesPath, "utf8").split("\n").filter(Boolean)) {
  const term = JSON.parse(line);
  const phrases = term.accents.length > 1 ? "several phrases" : "one phrase";
  for (const [form, value] of [["without particle", term.pattern], ["with particle", term.patternWithParticle]]) {
    const before = main.pitchAccentCategory(term.reading, pattern(value), [], term.expression);
    const after = branch.pitchAccentCategory(term.reading, pattern(value), [], term.expression);
    const example = `${term.expression} ${term.reading} [${term.accents.join("・")}] ${value}: ${before} → ${after}`;
    if (term.accents.length === 1) {
      count(`${phrases}, ${form}: ${before === after ? "unchanged" : "CHANGED"}`, before === after ? null : example);
      if (before !== term.phraseGroups[0]) count(`${phrases}, ${form}: main's group is not NHK's`, example);
      continue;
    }
    const groups = new Set(term.phraseGroups);
    const fit = groups.size === 1 && groups.has(before) ? "the group of every phrase"
      : groups.has(before) ? "the group of some phrases" : "the group of no phrase";
    if (after === null) count(`${phrases}, ${form}: main gave ${fit}; branch gives none`, example);
    else count(`${phrases}, ${form}: ${before === after ? "unchanged" : "CHANGED"} (main gave ${fit})`, example);
  }
}

// Kanjium Pitch Accents: downstep numbers only, so nothing may change.
if (kanjiumDir) {
  for (const file of readdirSync(kanjiumDir).filter(name => /^term_meta_bank_\d+\.json$/u.test(name))) {
    for (const [expression, , data] of JSON.parse(readFileSync(join(kanjiumDir, file), "utf8"))) {
      for (const { position } of data.pitches) {
        const pitch = { position, pattern: "", nasal: [], devoice: [] };
        const before = main.pitchAccentCategory(data.reading, pitch, [], expression);
        const after = branch.pitchAccentCategory(data.reading, pitch, [], expression);
        count(`Kanjium downstep numbers: ${before === after ? "unchanged" : "CHANGED"}`,
          before === after ? null : `${expression} ${data.reading} ${position}: ${before} → ${after}`);
      }
    }
  }
}

for (const key of Object.keys(counts).sort()) {
  console.log(`${String(counts[key]).padStart(7)}  ${key}${examples[key] ? `\n           e.g. ${examples[key].join("; ")}` : ""}`);
}
