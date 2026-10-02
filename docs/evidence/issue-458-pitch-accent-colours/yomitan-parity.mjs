// Scratch (not committed): compare HDGlossary.pitchAccentCategory with Yomitan's
// getPitchCategory + isNonNounVerbOrAdjective at 67db60d.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const clone = process.argv[2];
const glossary = require(process.argv[3]);
const { getPitchCategory } = await import(`${clone}/ext/js/language/ja/japanese.js`);
// dictionary-data-util.js imports anki-note-data-creator; copy only the pure function.
const source = readFileSync(`${clone}/ext/js/dictionary/dictionary-data-util.js`, "utf8");
const body = source.slice(source.indexOf("export function isNonNounVerbOrAdjective"));
const isNonNounVerbOrAdjective = new Function(`${body.slice(0, body.indexOf("\n}\n") + 2).replace("export ", "")}; return isNonNounVerbOrAdjective;`)();
const readings = ["き", "はし", "しぜん", "どうぐ", "じんせい", "じゃくてん", "おどろく", "しょくぶつ", "ちゅうかくせい"];
const classSets = [[], ["n"], ["v1"], ["v5"], ["vk"], ["vz"], ["adj-i"], ["vs"], ["vs", "n"], ["adj-na"], ["v5", "n"]];
const patterns = length => {
  const out = [];
  for (let n = length; n <= length + 1; n += 1) {
    for (let bits = 0; bits < 2 ** n; bits += 1) out.push([...Array(n)].map((_, i) => (bits >> i) & 1 ? "H" : "L").join(""));
  }
  return out;
};
let cases = 0, mismatches = 0;
for (const reading of readings) {
  const morae = glossary.splitPitchAccentMorae(reading).length;
  const values = [...Array(morae + 2).keys(), ...patterns(morae)];
  for (const value of values) {
    for (const classes of classSets) {
      const pitch = typeof value === "string" ? { position: 0, pattern: value, nasal: [], devoice: [] }
        : { position: value, pattern: "", nasal: [], devoice: [] };
      const ours = glossary.pitchAccentCategory(reading, pitch, classes);
      const theirs = getPitchCategory(reading, value, isNonNounVerbOrAdjective(classes));
      cases += 1;
      if (ours !== theirs) { mismatches += 1; if (mismatches < 10) console.log("MISMATCH", reading, value, classes, ours, theirs); }
    }
  }
}
console.log({ cases, mismatches });
for (const [reading, position, classes] of [["しぜん", 0, []], ["じんせい", 1, []], ["じゃくてん", 3, []], ["どうぐ", 3, []],
  ["おどろく", 3, ["v5"]], ["しょくぶつ", 2, []], ["あした", 0, []]]) {
  console.log(reading, position, classes.join(" "), glossary.pitchAccentCategory(reading, { position, pattern: "", nasal: [], devoice: [] }, classes));
}
