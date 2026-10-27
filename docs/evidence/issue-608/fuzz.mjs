// Fuzz check for hachidori #608: the final classifier against the one that
// converted the expression with toHiragana, on random mixed-script expressions.
//   node fuzz.mjs (with glossary-noshi.cjs and glossary-new.cjs beside it)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const reference = require("./glossary-noshi.cjs");
const candidate = require("./glossary-new.cjs");
const pool = Array.from("うくぐすずつづぬふぶむゆるいしウクグスズツヅヌフブムユルイシ為来為自由面倒得遠回ーゃャーるルするスルずるズルかカ𠀋A1");
const classes = [[], ["v1"], ["v5"], ["vk"], ["vs"], ["vz"], ["adj-i"], ["vs", "n"], ["v5", "vs"], ["adj-i", "n"], ["v1", "v5"], ["n"]];
let seed = 608;
const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
let cases = 0, differences = 0;
for (let index = 0; index < 400000; index += 1) {
  const length = 1 + random(4);
  let expression = "";
  for (let k = 0; k < length; k += 1) expression += pool[random(pool.length)];
  const reading = "あいうえ".slice(0, 1 + random(4));
  const wordClasses = classes[random(classes.length)];
  const pitch = random(3) === 0 ? { position: 0, pattern: ["HL", "LHL", "LH", "HLL"][random(4)] } : { position: random(5), pattern: "" };
  cases += 1;
  const a = reference.pitchAccentCategory(reading, pitch, wordClasses, expression);
  const b = candidate.pitchAccentCategory(reading, pitch, wordClasses, expression);
  if (a !== b && differences++ < 10) console.log("DIFF", JSON.stringify({ expression, reading, wordClasses, pitch, a, b }));
}
for (const expression of ["スる", "為ル", "ズル", "期ス", "禁ズ", "ムカツク", "キツイ", "サクラサク", "ハッスル", "遠回し", "聞こゆ", "𠀋す"]) {
  for (const wordClasses of [["v5"], ["vs"], ["vz"], ["adj-i"]]) {
    const pitch = { position: 1, pattern: "" };
    cases += 1;
    const a = reference.pitchAccentCategory("あい", pitch, wordClasses, expression);
    const b = candidate.pitchAccentCategory("あい", pitch, wordClasses, expression);
    if (a !== b && differences++ < 20) console.log("DIFF", expression, wordClasses, a, b);
  }
}
console.log(JSON.stringify({ cases, differences }));
