// In-process comparison for #641: main's glossary.js and the branch's, loaded as
// separate modules, timed in alternating rounds over the 64,000 most frequent
// JMdict pairs. Prints the median per-pair time of each variant.
// node micro2.mjs <main glossary.js> <branch glossary.js> <checkout> <JmdictFurigana.txt> <jiten-global-frequency.csv> [rounds]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [mainPath, branchPath, checkout, corpus, frequency, roundsArg = "21"] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const rank = new Map();
for (const line of readFileSync(frequency, "utf8").split("\n").slice(1)) {
  const [word, , value] = line.split(",");
  const number = Number(value);
  if (word && Number.isFinite(number) && !(rank.get(word) <= number)) rank.set(word, number);
}
const pairs = [];
for (const line of readFileSync(corpus, "utf8").replace(/^\ufeff/u, "").split("\n")) {
  const [expression, reading] = line.split("|");
  if (expression && reading && rank.has(expression)) pairs.push([rank.get(expression), expression, reading]);
}
pairs.sort((left, right) => left[0] - right[0]);
const words = pairs.slice(0, 64_000);
const kanjidic = JSON.parse(readFileSync(`${checkout}/extension/vendor/kanjidic/kanji-readings.json`, "utf8")).readings;
const table = JSON.parse(readFileSync(`${checkout}/extension/vendor/kanwa/kanwa-readings.json`, "utf8"));
const main = require(mainPath);
const branch = require(branchPath);
const mainReadings = main.createKanjiReadings(kanjidic);
const branchReadings = branch.createKanjiReadings(kanjidic);
const kanwa = branch.createKanwaReadings(table, branchReadings);
const variants = {
  main: () => { for (const [, e, r] of words) main.kanjiFurigana(e, r, mainReadings); },
  branchWithoutKanwa: () => { for (const [, e, r] of words) branch.kanjiFurigana(e, r, branchReadings); },
  branchWithKanwa: () => { for (const [, e, r] of words) branch.kanjiFurigana(e, r, branchReadings, kanwa); },
};
const samples = Object.fromEntries(Object.keys(variants).map(name => [name, []]));
for (const run of Object.values(variants)) { run(); run(); }
const rounds = Number(roundsArg);
for (let round = 0; round < rounds; round += 1) {
  const order = Object.keys(variants);
  if (round % 2) order.reverse();
  for (const name of order) {
    const started = performance.now();
    variants[name]();
    samples[name].push(performance.now() - started);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify(Object.fromEntries(Object.entries(samples).map(([name, values]) =>
  [name, +(median(values) * 1000 / words.length).toFixed(3)]))));
