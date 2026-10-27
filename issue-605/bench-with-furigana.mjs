// Targeted timing of the engine service's withFurigana for hachidori #605.
// node bench-with-furigana.mjs <checkout> <JmdictFurigana.txt> <jiten-global-frequency.csv> <out.json>
// One fresh process per call: the first reply includes the one-time table
// import and createKanjiReadings; then 2,000 replies of 32 results each, built
// from the 64,000 most frequent JMdict headword/reading pairs (cycled), are
// timed one at a time after 200 excluded warmups.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [checkout, corpus, frequency, out] = process.argv.slice(2);
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
const words = pairs.slice(0, 64_000).map(([, expression, reading]) => ({ expression, reading }));
const reply = (start) => {
  const results = [];
  for (let index = 0; index < 32; index += 1) {
    const { expression, reading } = words[(start + index) % words.length];
    results.push({ matched: expression, term: { expression, reading, glossaries: [] } });
  }
  return { results, dictionaryCount: 1, nativeJsonLength: 1000 };
};

const { withFurigana } = await import(pathToFileURL(`${checkout}/extension/engine-service.js`).href);
let started = performance.now();
await withFurigana({ results: [{ matched: "好き嫌い", term: { expression: "好き嫌い", reading: "すききらい", glossaries: [] } }],
  dictionaryCount: 1, nativeJsonLength: 0 });
const first = performance.now() - started;
for (let index = 0; index < 200; index += 1) await withFurigana(reply(index * 32));
const samples = [];
let added = 0;
for (let index = 0; index < 2000; index += 1) {
  const value = reply((index + 200) * 32);
  started = performance.now();
  const result = await withFurigana(value);
  samples.push(performance.now() - started);
  added += result.results.filter(({ term }) => term.furigana).length;
}
samples.sort((left, right) => left - right);
const quantile = q => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const summary = { checkout, first, median: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99),
  mean: samples.reduce((sum, value) => sum + value, 0) / samples.length, replies: samples.length,
  resultsWithFurigana: added, heapUsedMiB: process.memoryUsage().heapUsed / 1048576 };
writeFileSync(out, `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
