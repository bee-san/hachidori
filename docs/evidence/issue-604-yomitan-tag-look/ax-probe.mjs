// Real-Chrome probe: the accessibility tree of a card on the branch and on main,
// plain and with the click reveal (#598) active.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const REPO = "/local/home/skerraut/herd-synth3/clones/hachi-604";
const require = createRequire(resolve(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = resolve(REPO, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"],
  env: { ...process.env, FONTCONFIG_FILE: "/tmp/hachi-604/fonts.conf" } });
const NBSP = "\u00a0";
for (const [label, ext] of [["main", "/tmp/hachi-604/base/extension"], ["branch", resolve(REPO, "extension")]]) {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><p id="w">今日</p><div id="host"></div>');
  for (const f of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ content: readFileSync(resolve(ext, f), "utf8") });
  }
  const css = readFileSync(resolve(ext, "render/reader.css"), "utf8");
  await page.evaluate((css, NBSP) => {
    const host = document.querySelector("#host");
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div"); popup.className = "gsm-hoshidicts-popup"; shadow.append(popup);
    window.view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
      appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent });
    const tags = [{ name: `priority${NBSP}form`, category: "frequent", order: 1, notes: "high priority spelling", score: 1 },
      { name: "★", category: "popular", order: 2, notes: "high priority entry", score: 2 }];
    view.renderResults([{ matched: "今日", deinflected: "今日", trace: [], term: { expression: "今日", reading: "きょう", rules: "",
      frequencies: [], pitches: [], glossaries: [
        { dictionary: "Jitendex.org [2026-10-03]", glossary: JSON.stringify(["today", "this day"]), definitionTags: tags.map(t => t.name).join(" "), termTags: "", tags },
        { dictionary: "JMdict (English)", glossary: JSON.stringify(["these days"]), definitionTags: "", termTags: "" },
      ] } }], { anchor: document.querySelector("#w"), query: "今日" }, HDReaderOptions.normaliseOptions({}));
    window.revealSync = HDPopup.createDefinitionReveal(popup, { revealMode: () => window.mode, blurred: () => window.blurred, reveal() { window.revealed = (window.revealed ?? 0) + 1; } }).sync;
    window.shadowRoot = shadow;
  }, css, NBSP);
  const cdp = await page.createCDPSession();
  const dump = async () => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    return nodes.filter(n => !n.ignored && (n.name?.value || ["button", "list", "listitem", "StaticText"].includes(n.role?.value)))
      .map(n => `${n.role?.value}:${JSON.stringify(n.name?.value ?? "")}`).filter(s => !s.startsWith("StaticText:\"\"") && !s.startsWith("generic"))
      .join(" | ");
  };
  console.log(`== ${label} plain:`, (await dump()).slice(0, 900));
  await page.evaluate(() => { window.mode = "click"; window.blurred = true; window.view.setDefinitionBlurState("blurred"); window.revealSync(); });
  console.log(`== ${label} click-reveal blurred:`, (await dump()).slice(0, 700));
  // Click the dictionary tag (branch) or the title (main) of the first card.
  const point = await page.evaluate(() => {
    const target = shadowRoot.querySelector(".gsm-hoshidicts-dictionary-tag, .gsm-hoshidicts-glossary-card-title");
    const r = target.getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2, cls: target.className };
  });
  await page.mouse.click(point.x, point.y);
  console.log(`== ${label} click on ${point.cls}: reveal() calls =`, await page.evaluate(() => window.revealed ?? 0));
  await page.close();
}
await browser.close();
