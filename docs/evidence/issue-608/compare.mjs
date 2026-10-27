// Impact analysis for hachidori #608: every pitch of
// every dumped term through main's and this branch's HDGlossary.pitchAccentCategory.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [before, after, cases] = process.argv.slice(2);
const load = (path) => { delete require.cache[require.resolve(path)]; return require(path); };
const main = load(before);
const branch = load(after);
const changes = new Map();
const examples = new Map();
let total = 0;
for (const line of readFileSync(cases, "utf8").split("\n").filter(Boolean)) {
  const term = JSON.parse(line);
  const wordClasses = term.rules.split(" ").filter(Boolean);
  for (const value of term.pitches) {
    const pitch = /^\d+$/u.test(value) ? { position: Number(value), pattern: "" } : { position: 0, pattern: value };
    const old = main.pitchAccentCategory(term.reading, pitch, wordClasses);
    const now = branch.pitchAccentCategory(term.reading, pitch, wordClasses, term.expression);
    total += 1;
    if (old === now) continue;
    const key = `${old} -> ${now}`;
    changes.set(key, (changes.get(key) ?? 0) + 1);
    if (!examples.has(key)) examples.set(key, []);
    examples.get(key).push(`${term.expression}|${term.reading}[${value}] ${term.rules}`);
  }
}
console.log(`pitches of terms with word classes: ${total}`);
for (const [key, count] of [...changes].sort((a, b) => b[1] - a[1])) {
  console.log(`${key}: ${count}`);
  for (const example of examples.get(key).slice(0, Number(process.env.EXAMPLES ?? 12))) console.log(`    ${example}`);
}
