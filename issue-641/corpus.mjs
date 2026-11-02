// Corpus comparison for hachidori #641, on the real glossary.js of two revisions.
// node corpus.mjs <main glossary.js> <branch glossary.js> <kanji-readings.json> <kanwa-readings.json>
//   <JmdictFurigana-format file> <jiten-global-frequency.csv> [out prefix]
// A headword's split is what the popup draws: term.furigana from the engine
// (kanjiFurigana) or else the local split (segmentFurigana).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [mainPath, branchPath, tablePath, kanwaPath, corpus, frequency, out = ""] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const load = path => { delete require.cache[require.resolve(path)]; return require(path); };
const main = load(mainPath);
const branch = load(branchPath);
const table = JSON.parse(readFileSync(tablePath, "utf8")).readings;
const kanwaTable = JSON.parse(readFileSync(kanwaPath, "utf8"));
const mainReadings = main.createKanjiReadings(table);
const branchReadings = branch.createKanjiReadings(table);
const kanwa = branch.createKanwaReadings(kanwaTable, branchReadings);
const KANA = /[\u3040-\u30ff]/u;
const rank = new Map();
for (const line of readFileSync(frequency, "utf8").split("\n").slice(1)) {
  const [word, form, value] = line.split(",");
  const number = Number(value);
  const key = `${word}|${form}`;
  if (word && Number.isFinite(number) && !(rank.get(key) <= number)) rank.set(key, number);
}

const mainSplit = (e, r) => main.kanjiFurigana(e, r, mainReadings) ?? main.segmentFurigana(e, r);
const branchSplit = (e, r) => branch.kanjiFurigana(e, r, branchReadings, kanwa) ?? branch.segmentFurigana(e, r);

// Furigana over non-kana text as JmdictFurigana writes it: start[-end]:reading.
const ranges = segments => {
  const result = [];
  let position = 0;
  for (const { text, reading } of segments) {
    const characters = Array.from(text);
    if (reading && !characters.every(c => KANA.test(c))) {
      result.push(`${position}${characters.length > 1 ? `-${position + characters.length - 1}` : ""}:${reading}`);
    }
    position += characters.length;
  }
  return result.join(";");
};
const referenceRanges = (expression, furigana) => {
  const characters = Array.from(expression);
  return furigana.split(";").filter(Boolean).filter(part => {
    const [start, end = start] = part.split(":")[0].split("-").map(Number);
    return !characters.slice(start, end + 1).every(c => KANA.test(c));
  }).join(";");
};
// Pairs with one ruby over two or more non-kana characters.
const hasRun = segments => segments.some(({ text, reading }) => reading && Array.from(text).length > 1
  && !Array.from(text).every(c => KANA.test(c)));
const show = segments => segments.map(({ text, reading }) => (reading ? `${text}(${reading})` : text)).join("");
// Whether `after` only divides `before`'s segments: each before-segment is a
// run of after-segments whose texts and readings join to it.
const onlyDivides = (before, after) => {
  let index = 0;
  for (const segment of before) {
    let text = "";
    let reading = "";
    while (text.length < segment.text.length && index < after.length) {
      text += after[index].text;
      reading += after[index].reading;
      index += 1;
    }
    if (text !== segment.text || reading !== segment.reading) return false;
  }
  return index === after.length;
};

const stats = { pairs: 0, mainAgree: 0, branchAgree: 0, changed: 0, changedAgree: 0, changedDisagree: 0,
  mainWithRun: 0, branchWithRun: 0, notDividing: 0, misspelt: 0 };
const disagreements = [];
const changes = [];
for (const line of readFileSync(corpus, "utf8").replace(/^\ufeff/u, "").split("\n")) {
  const [expression, reading, furigana = ""] = line.split("|");
  if (!expression || !reading || expression === reading || Array.from(expression).every(c => KANA.test(c))) continue;
  stats.pairs += 1;
  const before = mainSplit(expression, reading);
  const after = branchSplit(expression, reading);
  const reference = referenceRanges(expression, furigana);
  const b = ranges(before);
  const a = ranges(after);
  if (hasRun(before)) stats.mainWithRun += 1;
  if (hasRun(after)) stats.branchWithRun += 1;
  if (b === reference) stats.mainAgree += 1;
  if (a === reference) stats.branchAgree += 1;
  if (after.map(s => s.text).join("") !== expression) stats.misspelt += 1;
  if (a === b) continue;
  stats.changed += 1;
  if (!onlyDivides(before, after)) stats.notDividing += 1;
  const row = [rank.get(`${expression}|${reading}`) ?? Infinity, expression, reading, show(before), show(after),
    reference, a === reference ? "agree" : "DISAGREE"];
  changes.push(row);
  if (a === reference) stats.changedAgree += 1;
  else {
    stats.changedDisagree += 1;
    disagreements.push(row);
  }
}
console.log(JSON.stringify(stats));
changes.sort((left, right) => left[0] - right[0]);
disagreements.sort((left, right) => left[0] - right[0]);
if (out) {
  writeFileSync(`${out}.changes.tsv`, `${changes.map(row => row.join("\t")).join("\n")}\n`);
  writeFileSync(`${out}.disagree.tsv`, `${disagreements.map(row => row.join("\t")).join("\n")}\n`);
}
