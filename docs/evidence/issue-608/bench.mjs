// Targeted benchmark for hachidori #608: main's and this
// branch's HDGlossary.pitchAccentCategory over every (term, pitch) of a dumped
// case file, alternating revisions round by round in one process.
//   node bench.mjs <main glossary.js> <branch glossary.js> <cases.jsonl> [rounds]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [mainPath, branchPath, casesPath, roundsArg = "21"] = process.argv.slice(2);
const sides = { main: require(mainPath), branch: require(branchPath) };
const calls = [];
for (const line of readFileSync(casesPath, "utf8").split("\n").filter(Boolean)) {
  const term = JSON.parse(line);
  const wordClasses = term.rules.split(" ").filter(Boolean);
  for (const value of term.pitches) {
    calls.push([term.reading, /^\d+$/u.test(value) ? { position: Number(value), pattern: "" } : { position: 0, pattern: value },
      wordClasses, term.expression]);
  }
}
const run = api => {
  let sink = 0;
  const started = process.hrtime.bigint();
  for (const [reading, pitch, wordClasses, expression] of calls) {
    sink += (api.pitchAccentCategory(reading, pitch, wordClasses, expression) ?? "").length;
  }
  return [Number(process.hrtime.bigint() - started) / calls.length, sink];
};
for (let warm = 0; warm < 5; warm += 1) { run(sides.main); run(sides.branch); }
const samples = { main: [], branch: [] };
const rounds = Number(roundsArg);
for (let round = 0; round < rounds; round += 1) {
  for (const name of round % 2 ? ["branch", "main"] : ["main", "branch"]) samples[name].push(run(sides[name])[0]);
}
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(q * (sorted.length - 1))]; };
console.log(`calls per round: ${calls.length}; rounds: ${rounds} per side, alternating; Node ${process.version}`);
for (const [name, values] of Object.entries(samples)) {
  console.log(`${name.padEnd(6)} ns per call: median ${quantile(values, 0.5).toFixed(1)}, p25 ${quantile(values, 0.25).toFixed(1)}, p75 ${quantile(values, 0.75).toFixed(1)}`);
}
