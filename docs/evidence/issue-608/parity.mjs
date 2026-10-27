// Parity check for hachidori #608: the branch's
// HDGlossary.pitchAccentCategory against Yomitan d3c54c1's getPitchCategory and
// isNonNounVerbOrAdjective. Where every verb or adjective class fits the
// expression the results must be equal; otherwise the branch may only turn
// Yomitan's kifuku into the positional group.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HDGlossary = require(process.argv[2]);
const { getPitchCategory } = await import("/tmp/hachi-608/yomitan/ext/js/language/ja/japanese.js");
const { isNonNounVerbOrAdjective } = await import("/tmp/hachi-608/yomitan/ext/js/dictionary/dictionary-data-util.js");

// Expressions with readings: verbs and adjectives in each class's form, then
// nouns, na-adjectives and suru nouns that some dictionaries tag anyway.
const TERMS = [
  ["食べる", "たべる"], ["驚く", "おどろく"], ["来る", "くる"], ["愛する", "あいする"], ["期す", "きす"],
  ["信ずる", "しんずる"], ["禁ず", "きんず"], ["高い", "たかい"], ["キツイ", "キツイ"], ["遅し", "おそし"],
  ["聞こゆ", "きこゆ"], ["相語らふ", "あいかたらう"], ["き", "き"], ["ちゅうかくせい", "ちゅうかくせい"],
  ["自由", "じゆう"], ["面倒", "めんどう"], ["料理", "りょうり"], ["ダンス", "ダンス"], ["静か", "しずか"],
  ["わくわく", "わくわく"], ["下", "した"], ["凡例", "はんれい"],
];
const CLASS_SETS = [[], ["n"], ["v1"], ["v5"], ["vk"], ["vs"], ["vz"], ["adj-i"], ["vs", "n"], ["adj-na"], ["v5", "n"],
  ["v5", "vs"], ["v1", "v5"], ["adj-i", "v5"]];
const morae = reading => HDGlossary.splitPitchAccentMorae(reading).length;
const patterns = length => Array.from({ length: 2 ** length }, (_, bits) =>
  Array.from({ length }, (_, index) => (bits >> index) & 1 ? "H" : "L").join(""));

let cases = 0;
let equal = 0;
let demoted = 0;
const problems = [];
for (const [expression, reading] of TERMS) {
  const count = morae(reading);
  const values = [...Array.from({ length: count + 2 }, (_, index) => index), ...patterns(count), ...patterns(count + 1)];
  for (const classes of CLASS_SETS) {
    const fits = classes.filter(rule => ["v1", "v5", "vk", "vs", "vz", "adj-i"].includes(rule))
      .every(rule => HDGlossary.pitchAccentCategory(reading, { position: 1, pattern: "" }, [rule], expression) === "kifuku");
    for (const value of values) {
      cases += 1;
      const yomitan = getPitchCategory(reading, value, isNonNounVerbOrAdjective(classes));
      const positional = getPitchCategory(reading, value, false);
      const pitch = typeof value === "string" ? { position: 0, pattern: value } : { position: value, pattern: "" };
      const branch = HDGlossary.pitchAccentCategory(reading, pitch, classes, expression);
      if (branch === yomitan) equal += 1;
      else if (yomitan === "kifuku" && branch === positional) demoted += 1;
      if ((fits && branch !== yomitan) || (branch !== yomitan && !(yomitan === "kifuku" && branch === positional))) {
        problems.push({ expression, reading, classes, value, yomitan, branch });
      }
    }
  }
}
console.log(JSON.stringify({ cases, equal, demoted, problems: problems.length }));
for (const problem of problems.slice(0, 20)) console.log(JSON.stringify(problem));
