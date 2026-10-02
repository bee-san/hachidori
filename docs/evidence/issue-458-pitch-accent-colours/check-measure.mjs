// Scratch: check measurements.json from measure.mjs against the expected colours.
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const LIGHT = { heiban: "096abd", atamadaka: "bb3a3a", nakadaka: "a75113", odaka: "007a16", kifuku: "7b51c0" };
const DARK = { heiban: "59b2ff", atamadaka: "ff8686", nakadaka: "ff9b54", odaka: "67e47d", kifuku: "bc99f6" };
const LIGHT_THEMES = new Set(["girlypop", "solarized-light", "light", "cupcake", "bumblebee", "emerald", "corporate",
  "retro", "cyberpunk", "valentine", "garden", "lofi", "pastel", "fantasy", "wireframe", "cmyk", "autumn", "acid",
  "lemonade", "winter", "nord", "caramellatte", "silk"]);
const EXPECTED_CATEGORIES = ["heiban", "atamadaka", "nakadaka", "odaka", "kifuku"];
const problems = [];
let checked = 0;
for (const [theme, { on, off, blurred, overlineOn, overlineOff }] of Object.entries(data.palettes)) {
  const colours = LIGHT_THEMES.has(theme) ? LIGHT : DARK;
  if (on.length !== 5) problems.push(`${theme}: ${on.length} entries`);
  on.forEach((entry, index) => {
    const group = EXPECTED_CATEGORIES[index];
    const want = colours[group];
    const was = off[index];
    checked += 1;
    if (entry.category !== group || entry.badgeCategory !== group) problems.push(`${theme} ${index} category ${entry.category}/${entry.badgeCategory}`);
    for (const key of ["headword", "kanji", "kanjiUnderline", "contourLine", "badgeLine", "graphStroke"]) {
      if (entry[key] !== want) problems.push(`${theme} ${group} on ${key} ${entry[key]} != ${want}`);
    }
    // Unchanged by the switch: reading kana, badge text and the dictionary tag.
    for (const key of ["reading", "badgeText", "tagText"]) {
      if (entry[key] !== was[key]) problems.push(`${theme} ${group} ${key} changed ${was[key]} -> ${entry[key]}`);
    }
    // Off: the headword is the text colour, the same as its badge text.
    if (was.headword !== was.badgeText) problems.push(`${theme} ${group} off headword ${was.headword} vs text ${was.badgeText}`);
    if (was.badgeLine !== was.badgeText) problems.push(`${theme} ${group} off badge line ${was.badgeLine} vs text ${was.badgeText}`);
    // The Overline style's line takes the group with the switch on, the text colour off.
    if (overlineOn[index].overlineLine !== want) problems.push(`${theme} ${group} overline on ${overlineOn[index].overlineLine}`);
    if (overlineOff[index].overlineLine !== was.badgeText) problems.push(`${theme} ${group} overline off ${overlineOff[index].overlineLine}`);
    if (overlineOn[index].reading !== overlineOff[index].reading) problems.push(`${theme} ${group} overline reading changed`);
    // Blurred: the headword waits, the badge keeps its colour.
    const hidden = blurred[index];
    if (hidden.headword !== was.headword || hidden.contourLine !== was.contourLine) problems.push(`${theme} ${group} blurred headword ${hidden.headword}`);
    if (hidden.badgeLine !== want) problems.push(`${theme} ${group} blurred badge ${hidden.badgeLine}`);
  });
}
console.log("chrome", data.chrome, "palettes", Object.keys(data.palettes).length, "entries", checked);
console.log("focus on", JSON.stringify(data.focusOn), "focus off", JSON.stringify(data.focusOff));
for (const [scheme, { on, off }] of Object.entries(data.forced)) {
  const same = on.every((entry, index) => ["headword", "kanji", "kanjiUnderline", "contourLine", "badgeLine", "graphStroke", "reading", "tagText"].every(key => entry[key] === off[index][key]));
  console.log("forced", scheme, same ? "on == off" : "DIFFERS", JSON.stringify(on[0]));
}
console.log(problems.length ? problems.slice(0, 40).join("\n") : "no problems");
