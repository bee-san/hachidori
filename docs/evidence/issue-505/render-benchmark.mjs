// Times the production Default renderer (renderResults plus forced style and
// layout) for a primary and a later entry carrying N frequency sources.
// Usage: node bench.mjs <extension dir> <label>
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
await page.setContent('<!doctype html><meta charset="utf-8"><p>答案</p><div id="host"></div>');
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
  const candidate = { anchor: document.querySelector("p"), query: "答案" };
  const result = (count, expression) => ({ matched: expression, deinflected: expression, trace: [], preprocessorSteps: 0,
    term: { expression, reading: "とうあん", rules: "", score: 0, pitches: [],
      frequencies: Array.from({ length: count }, (_, index) => ({ dictionary: `Frequency ${index + 1}`,
        frequencies: [{ value: 1000 + index, displayValue: `${1000 + index}/37459` }] })),
      glossaries: [{ dictionary: "JMdict", definitionTags: "n", glossary: JSON.stringify(["answer (to an exam question)"]) }] } });
  const rows = {};
  for (const count of [0, 12, 13, 20, 60]) {
    const results = [result(count, "答案"), result(count, "答")];
    const samples = [];
    for (let index = 0; index < 330; index += 1) {
      const start = performance.now();
      view.renderResults(results, candidate, { expandAll: true });
      popup.getBoundingClientRect();
      void popup.offsetHeight;
      const ms = performance.now() - start;
      if (index >= 30) samples.push(ms);
      view.clear?.();
      await new Promise(done => setTimeout(done, 0));
    }
    view.renderResults(results, candidate, { expandAll: true });
    const tags = popup.querySelectorAll(".gsm-hoshidicts-tag-frequency").length;
    samples.sort((a, b) => a - b);
    const at = q => samples[Math.min(samples.length - 1, Math.ceil(samples.length * q) - 1)];
    rows[count] = { tags, n: samples.length, median: (samples[149] + samples[150]) / 2, p95: at(0.95),
      height: Math.round(popup.scrollHeight) };
  }
  return rows;
}, readFileSync(resolve(extension, "render/reader.css"), "utf8"));
console.log(JSON.stringify({ label, rows: out }));
await browser.close();
