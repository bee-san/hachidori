// Scratch probe (not committed): select a headword, press Ctrl+C, read the
// clipboard. node probe-clipboard.mjs <extension>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const extension = resolve(process.argv[2]);
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><meta charset="utf-8"><p>x</p><div id="host"></div>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const entry = (expression, reading, position) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, rules: "", score: 0, frequencies: [], glossaries: [{ dictionary: "S",
    definitionTags: "", termTags: "", glossary: JSON.stringify(["g"]) }],
  pitches: [{ dictionary: "P", pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }] } });
const page = await browser.newPage();
await page.goto(origin);
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
  shadow.append(popup);
  window.popupFixture = { popup, view: HDPopup.createPopupView({ document, window, popup, positionPopup() {},
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList }) };
}, readFileSync(resolve(extension, "render/reader.css"), "utf8"));
for (const style of ["contour", "overline"]) {
  for (const word of [entry("てくてく", "てくてく", 1), entry("食べる", "たべる", 2)]) {
    await page.evaluate((word, style) => {
      const { popup, view } = window.popupFixture;
      const anchor = document.querySelector("p");
      view.renderResults([word], { anchor, query: word.term.expression, sentence: "", sourceElements: [anchor],
        matchOffset: 0 }, { ...HDReaderOptions.normaliseOptions({}), pitchAccentFuriganaStyle: style });
      const range = document.createRange();
      range.selectNodeContents(popup.querySelector(".gsm-hoshidicts-expression"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, word, style);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    console.log(`${style} ${word.term.expression}: ${JSON.stringify(copied)}`);
  }
}
await browser.close();
server.close();
