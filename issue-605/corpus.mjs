// Corpus comparison for hachidori #605, on the real glossary.js of two revisions.
// node corpus.mjs <main glossary.js> <branch glossary.js> <table json> <JmdictFurigana-format file> [out prefix]
// A headword's split is what the popup draws: term.furigana from the engine
// (kanjiFurigana on the branch; the #459 pass on main) or else the local split.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [mainPath, branchPath, tablePath, corpus, out = ""] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const load = path => { delete require.cache[require.resolve(path)]; return require(path); };
const main = load(mainPath);
const branch = load(branchPath);
const table = JSON.parse(readFileSync(tablePath, "utf8")).readings;
const mainReadings = main.createKanjiReadings(table);
const branchReadings = branch.createKanjiReadings(table);
const KANA = /[\u3040-\u30ff]/u;

// main: withFurigana sets term.furigana only where the plain split is null.
const mainSplit = (e, r) => main.distributeFurigana(e, r)
  ?? main.distributeFurigana(e, r, mainReadings) ?? [{ text: e, reading: r }];
const branchSplit = (e, r) => branch.kanjiFurigana(e, r, branchReadings) ?? branch.segmentFurigana(e, r);

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
const hasRun = segments => segments.some(({ text, reading }) => reading && Array.from(text).length > 1
  && !Array.from(text).every(c => KANA.test(c)));

const stats = { pairs: 0, mainAgree: 0, branchAgree: 0, changed: 0, changedAgree: 0, changedDisagree: 0,
  mainWholeWord: 0, branchWholeWord: 0, mainWithRun: 0, branchWithRun: 0 };
const disagreements = [];
for (const line of readFileSync(corpus, "utf8").replace(/^\ufeff/u, "").split("\n")) {
  const [expression, reading, furigana = ""] = line.split("|");
  if (!expression || !reading || expression === reading || Array.from(expression).every(c => KANA.test(c))) continue;
  stats.pairs += 1;
  const before = mainSplit(expression, reading);
  const after = branchSplit(expression, reading);
  const reference = referenceRanges(expression, furigana);
  const b = ranges(before);
  const a = ranges(after);
  if (before.length === 1 && before[0].reading) stats.mainWholeWord += 1;
  if (after.length === 1 && after[0].reading) stats.branchWholeWord += 1;
  if (hasRun(before)) stats.mainWithRun += 1;
  if (hasRun(after)) stats.branchWithRun += 1;
  if (b === reference) stats.mainAgree += 1;
  if (a === reference) stats.branchAgree += 1;
  if (a !== b) {
    stats.changed += 1;
    if (a === reference) stats.changedAgree += 1;
    else {
      stats.changedDisagree += 1;
      disagreements.push(`${expression}|${reading}|main ${b}|branch ${a}|ref ${reference}`);
    }
  }
}
console.log(JSON.stringify(stats));
if (out) writeFileSync(`${out}.disagree.txt`, `${disagreements.join("\n")}\n`);
