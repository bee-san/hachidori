// Targeted benchmark for hachidori #596: main's and this branch's
// HDGlossary.pitchAccentCategory over real inputs, alternating the revisions
// round by round in one process.
//
//   node bench.mjs <main glossary.js> <branch glossary.js> <nhk-patterns.jsonl> <kanjium term_meta_bank dir> [rounds]
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const [mainPath, branchPath, casesPath, kanjiumDir, roundsArg = "31"] = process.argv.slice(2);
const sides = { main: require(mainPath), branch: require(branchPath) };
const entry = (position, pattern) => ({ position, pattern, nasal: [], devoice: [] });

const nhk = readFileSync(casesPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const inputs = {
  "NHK pronunciations as H/L patterns with the particle's level": nhk
    .map(term => [term.reading, entry(0, term.patternWithParticle), [], term.expression]),
  "only those of several accent phrases (x50)": Array.from({ length: 50 }, () => nhk.filter(term => term.accents.length > 1)
    .map(term => [term.reading, entry(0, term.patternWithParticle), [], term.expression])).flat(),
  "Kanjium Pitch Accents downstep numbers": readdirSync(kanjiumDir).filter(name => /^term_meta_bank_\d+\.json$/u.test(name))
    .flatMap(file => JSON.parse(readFileSync(join(kanjiumDir, file), "utf8"))
      .flatMap(([expression, , data]) => data.pitches.map(({ position }) => [data.reading, entry(position, ""), [], expression]))),
};

const run = (api, calls) => {
  let sink = 0;
  const started = process.hrtime.bigint();
  for (const [reading, pitch, wordClasses, expression] of calls) {
    sink += (api.pitchAccentCategory(reading, pitch, wordClasses, expression) ?? "").length;
  }
  return [Number(process.hrtime.bigint() - started) / calls.length, sink];
};
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))];
const rounds = Number(roundsArg);
console.log(`Node ${process.version}; ${rounds} rounds per side, alternating`);
for (const [name, calls] of Object.entries(inputs)) {
  for (let warm = 0; warm < 5; warm += 1) { run(sides.main, calls); run(sides.branch, calls); }
  const samples = { main: [], branch: [] };
  for (let round = 0; round < rounds; round += 1) {
    for (const side of round % 2 ? ["branch", "main"] : ["main", "branch"]) samples[side].push(run(sides[side], calls)[0]);
  }
  console.log(`${name}: ${calls.length} calls per round`);
  for (const [side, values] of Object.entries(samples)) {
    console.log(`  ${side.padEnd(6)} ns per call: median ${quantile(values, 0.5).toFixed(1)}, p25 ${quantile(values, 0.25).toFixed(1)}, p75 ${quantile(values, 0.75).toFixed(1)}`);
  }
}
