// Times the production Default renderer for #607: renderResults plus forced
// style and layout for 非常に with 非常 as its later entry, and a live Average
// switch on an open popup, in headless Chrome.
// Usage: HACHIDORI_CHROME=... HACHIDORI_TOOLING=<repo>/test/tooling node render-benchmark.mjs <extension dir> <label>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [extension, label] = process.argv.slice(2);
const require = createRequire(resolve(process.env.HACHIDORI_TOOLING, "package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
await page.setContent('<!doctype html><meta charset="utf-8"><p>非常に</p><div id="host"></div>');
for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
  await page.addScriptTag({ path: resolve(extension, file) });
}
const out = await page.evaluate(async css => {
  const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  shadow.adoptedStyleSheets = [sheet];
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  popup.style.cssText = "left:20px;top:20px;width:420px;height:640px";
  shadow.append(popup);
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {} });
  const candidate = { anchor: document.querySelector("p"), query: "非常に" };
  const pitch = (dictionary, ...positions) => ({ dictionary, transcriptions: [],
    pitches: positions.map(position => ({ position, pattern: "", nasal: [], devoice: [] })) });
  const result = (expression, reading, frequencyCount, pitches) => ({ matched: expression, deinflected: expression,
    trace: [], preprocessorSteps: 0, term: { expression, reading, rules: "", score: 0, pitches,
      frequencies: Array.from({ length: frequencyCount }, (_, index) => ({ dictionary: `Frequency ${index + 1}`,
        frequencies: [{ value: 1000 + index, displayValue: String(1000 + index) }] })),
      glossaries: [{ dictionary: "Sample terms", definitionTags: "", glossary: JSON.stringify(["sample"]) }] } });
  const two = [pitch("Pitch A", 0), pitch("Pitch B", 0, 1)];
  const seven = Array.from({ length: 7 }, (_, index) => pitch(`Pitch ${index + 1}`, 0, 1));
  const cases = [
    ["0 frequencies, 2 pitch dictionaries", 0, [pitch("Pitch A", 0)], two],
    ["12 frequencies, 2 pitch dictionaries", 12, [pitch("Pitch A", 0)], two],
    ["20 frequencies, 2 pitch dictionaries", 20, [pitch("Pitch A", 0)], two],
    ["0 frequencies, 14 accents per entry", 0, seven, seven],
  ];
  const time = async (action, reset) => {
    const samples = [];
    for (let index = 0; index < 330; index += 1) {
      const start = performance.now();
      action(index);
      popup.getBoundingClientRect();
      void popup.offsetHeight;
      const ms = performance.now() - start;
      if (index >= 30) samples.push(ms);
      reset?.();
      await new Promise(done => setTimeout(done, 0));
    }
    samples.sort((a, b) => a - b);
    const at = q => samples[Math.min(samples.length - 1, Math.ceil(samples.length * q) - 1)];
    return { n: samples.length, median: (samples[149] + samples[150]) / 2, p95: at(0.95) };
  };
  const rows = {};
  for (const [name, count, first, later] of cases) {
    const results = [result("非常に", "ひじょうに", count, first), result("非常", "ひじょう", count, later)];
    const timing = await time(() => view.renderResults(results, candidate, { showPitchAccentBadge: true, expandAll: true }), () => view.clear?.());
    view.renderResults(results, candidate, { showPitchAccentBadge: true, expandAll: true });
    rows[name] = { ...timing, accents: [...popup.querySelectorAll(".gsm-hoshidicts-entry")]
      .map(entry => entry.querySelectorAll(".pronunciation").length) };
  }
  // The Average switch on an open popup: on main a later entry's change in
  // visible frequency tags also rebuilt its pitch badges.
  const results = [result("非常に", "ひじょうに", 12, [pitch("Pitch A", 0)]), result("非常", "ひじょう", 12, two)];
  view.renderResults(results, candidate, { showPitchAccentBadge: true, expandAll: true });
  const presentation = Array.from({ length: 12 }, (_, index) => ({ title: `Frequency ${index + 1}`, frequencyMode: "rank-based" }));
  rows["Average switch, 12 frequencies"] = await time(index => view.updateDictionaryPresentation({
    averageFrequency: index % 2 === 0, dictionaryPresentation: presentation }));
  return rows;
}, ["render/reader.css", "icons.css"].map(file => readFileSync(resolve(extension, file), "utf8")).join("\n"));
console.log(JSON.stringify({ label, rows: out }));
await browser.close();
