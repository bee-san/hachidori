// Scratch probe (not committed): double-click each character of a kana
// headword's own text (not its readings) and read the selection.
// EXTRA_CSS=... node probe-dblclick-text.mjs <extension>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const extension = resolve(process.argv[2]);
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const entry = (expression, reading, position) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, rules: "", score: 0, frequencies: [], glossaries: [{ dictionary: "S",
    definitionTags: "", termTags: "", glossary: JSON.stringify(["g"]) }],
  pitches: [{ dictionary: "P", pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }] } });
const page = await browser.newPage();
await page.setViewport({ width: 700, height: 400 });
await page.setContent('<!doctype html><meta charset="utf-8"><p>x</p><div id="host"></div>');
for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
  await page.addScriptTag({ path: resolve(extension, file) });
}
await page.evaluate(css => {
  const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  shadow.adoptedStyleSheets = [sheet];
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  popup.style.cssText = "left:20px;top:20px;width:560px;height:300px";
  shadow.append(popup);
  window.fixture = { popup, view: HDPopup.createPopupView({ document, window, popup, positionPopup() {},
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList }) };
}, readFileSync(resolve(extension, "render/reader.css"), "utf8") + (process.env.EXTRA_CSS ?? ""));
for (const style of ["contour", "overline"]) {
  for (const word of [entry("てくてく", "てくてく", 1), entry("コーヒー", "コーヒー", 3)]) {
    const points = await page.evaluate((word, style) => {
      const { popup, view } = window.fixture;
      const anchor = document.querySelector("p");
      view.renderResults([word], { anchor, query: word.term.expression, sentence: "", sourceElements: [anchor],
        matchOffset: 0 }, { ...HDReaderOptions.normaliseOptions({}), pitchAccentFuriganaStyle: style });
      getSelection().removeAllRanges();
      const expression = popup.querySelector(".gsm-hoshidicts-expression");
      const walker = document.createTreeWalker(expression, NodeFilter.SHOW_TEXT);
      const out = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest("rt, .gsm-hoshidicts-pitch-reading")) continue;
        for (let index = 0; index < node.data.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const box = range.getBoundingClientRect();
          out.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        }
      }
      return out;
    }, word, style);
    const each = [];
    for (const at of points) {
      await page.mouse.click(at.x, at.y, { count: 2 });
      each.push(await page.evaluate(() => getSelection().toString()));
      await page.evaluate(() => getSelection().removeAllRanges());
      await new Promise(done => setTimeout(done, 600));
    }
    console.log(`${style} ${word.term.expression}: ${each.map(text => JSON.stringify(text)).join(",")}`);
  }
}
await browser.close();
