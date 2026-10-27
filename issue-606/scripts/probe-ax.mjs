// Scratch probe (not committed): Chrome's accessibility tree under a headword.
// node probe-ax.mjs <extension>...
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const entry = (expression, reading, position) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, rules: "", score: 0, frequencies: [], glossaries: [{ dictionary: "S",
    definitionTags: "", termTags: "", glossary: JSON.stringify(["g"]) }],
  pitches: [{ dictionary: "P", pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }] } });
for (const extension of process.argv.slice(2).map(path => resolve(path))) {
  for (const word of [entry("てくてく", "てくてく", 1), entry("食べる", "たべる", 2)]) {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><p>x</p><div id="host"></div>');
    for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: resolve(extension, file) });
    }
    await page.evaluate((css, word) => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList });
      const anchor = document.querySelector("p");
      view.renderResults([word], { anchor, query: word.term.expression, sentence: "", sourceElements: [anchor],
        matchOffset: 0 }, HDReaderOptions.normaliseOptions({}));
      popup.querySelector(".gsm-hoshidicts-expression").id = "probe-expression";
    }, readFileSync(resolve(extension, "render/reader.css"), "utf8"), word);
    const cdp = await page.createCDPSession();
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const root = nodes.find(node => node.name?.value === word.term.expression || node.name?.value?.startsWith(`${word.term.expression},`));
    const lines = [];
    const walk = (node, depth) => {
      if (!node) return;
      if (!node.ignored) lines.push(`${"  ".repeat(depth)}${node.role?.value} ${JSON.stringify(node.name?.value ?? "")}`);
      for (const child of node.childIds ?? []) walk(byId.get(child), node.ignored ? depth : depth + 1);
    };
    walk(root, 0);
    console.log(`${extension.includes("/main/") ? "main" : "fix"} ${word.term.expression}:\n${lines.join("\n")}`);
    await page.close();
  }
}
await browser.close();
