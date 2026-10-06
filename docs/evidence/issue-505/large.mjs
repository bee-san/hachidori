// One-off #505 layout evidence: 60 frequency sources through the production
// renderer and stylesheet, at 280px and 480px popup widths, with the popup
// scrolled to its top and to its definitions.
// Usage: node large.mjs <repo> <output dir>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [repo, output] = process.argv.slice(2);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"] });
for (const width of [280, 480]) {
  const page = await browser.newPage();
  await page.setViewport({ width: width + 40, height: 520, deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#888}</style><p hidden>答案</p><div id="host"></div>');
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ path: resolve(repo, "extension", file) });
  }
  const state = await page.evaluate((css, width) => {
    const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = `left:10px;top:10px;width:${width}px;max-height:480px`;
    shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup,
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, positionPopup() {} });
    const frequencies = Array.from({ length: 59 }, (_, index) => ({ dictionary: `Frequency ${String(index + 1).padStart(2, "0")}`,
      frequencies: [{ value: 1000 * (index + 1) + 7, displayValue: String(1000 * (index + 1) + 7) }] }));
    frequencies.push({ dictionary: "monogatari", frequencies: [{ value: 13337, displayValue: "13337/37459" }] });
    view.renderResults([{ matched: "答案", deinflected: "答案", trace: [], preprocessorSteps: 0, term: {
      expression: "答案", reading: "とうあん", rules: "n", score: 0, pitches: [], frequencies,
      glossaries: [{ dictionary: "JMdict", definitionTags: "n", glossary: JSON.stringify(["answer (to an examination question)", "examination paper"]) }],
    } }], { anchor: document.querySelector("p"), query: "答案" }, {});
    window.scrollPane = () => {
      const card = popup.querySelector(".gsm-hoshidicts-glossary-card");
      card.scrollIntoView({ block: "end" });
      return card.getBoundingClientRect().bottom <= popup.getBoundingClientRect().bottom + 1;
    };
    return { tags: popup.querySelectorAll(".gsm-hoshidicts-tag-frequency").length,
      last: [...popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")].at(-1)?.textContent,
      overflow: [...popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")].some(tag => {
        const box = tag.getBoundingClientRect(), pane = popup.getBoundingClientRect();
        return box.left < pane.left || box.right > pane.right;
      }) };
  }, readFileSync(resolve(repo, "extension/render/reader.css"), "utf8"), width);
  await page.screenshot({ path: resolve(output, `sixty-${width}-top.png`) });
  const reached = await page.evaluate(() => window.scrollPane());
  await page.screenshot({ path: resolve(output, `sixty-${width}-definitions.png`) });
  console.log(JSON.stringify({ width, ...state, definitionsReachable: reached }));
  await page.close();
}
await browser.close();
