// Scratch: before/after palette screenshots for the #429 PR (not committed).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.env.REPO;
const out = process.env.OUT || "/tmp/hd429/shots";
mkdirSync(out, { recursive: true });
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chrome = resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const css = readFileSync(resolve(root, "extension/render/reader.css"), "utf8");
const icons = readFileSync(resolve(root, "extension/icons.css"), "utf8");
const jitendexCss = readFileSync("/tmp/hd429/jitendex-styles.css", "utf8");
const row = JSON.parse(readFileSync("/tmp/hd429/jitendex-rows.json", "utf8")).find(entry => entry[0] === "食べる");
const palettes = (process.env.PALETTES || "default,high-contrast,light,solarized-light").split(",");

const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--force-device-scale-factor=1"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 1000, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#777"><p id="anchor" style="margin:0;height:0;overflow:hidden">食べる</p><div id="host"></div></body>');
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ path: resolve(root, "extension", file) });
  }
  await page.evaluate(({ css, icons, jitendexCss, glossary }) => {
    const host = document.querySelector("#host");
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${css}\n${icons}`);
    shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = "left:20px;top:20px";
    shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup,
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, positionPopup() {} });
    view.renderResults([{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0, term: {
      expression: "食べる", reading: "たべる", rules: "v1", score: 0, frequencies: [], pitches: [], glossaries: [
        { dictionary: "JMdict (plain)", definitionTags: "v1 vt",
          glossary: JSON.stringify(["to eat", "to live on (e.g. a salary)", "to have a meal"]) },
        { dictionary: "Jitendex.org [2026-08-11]", definitionTags: "★", glossary: JSON.stringify(glossary) },
      ] } }], { anchor: document.querySelector("#anchor"), query: "食べる" }, {});
    HDGlossary.applyDictionaryStyles(document, shadow, 1, [{ dictionary: "Jitendex.org [2026-08-11]", styles: jitendexCss }]);
    const appearance = HDPopup.createPopupAppearance(host);
    window.setLayout = (glossaryLayoutMode, popupTheme) => appearance.update({ popupTheme, popupWidthPx: 560,
      popupHeightPx: 940, popupScalePercent: 100, popupOpacityPercent: 100, showPopupAudioButton: true, glossaryLayoutMode });
  }, { css, icons, jitendexCss, glossary: row[5] });
  const files = [];
  for (const palette of palettes) {
    for (const mode of ["default", "compact"]) {
      await page.evaluate((mode, palette) => setLayout(mode, palette), mode, palette);
      await new Promise(done => setTimeout(done, 150));
      const clip = await page.evaluate(() => {
        const shadow = document.querySelector("#host").shadowRoot;
        const popup = shadow.querySelector(".gsm-hoshidicts-popup");
        const cards = [...shadow.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        const top = popup.getBoundingClientRect().top;
        const bottom = Math.max(...cards.map(card => card.getBoundingClientRect().bottom)) + 8;
        const rect = popup.getBoundingClientRect();
        return { x: rect.x + scrollX, y: top + scrollY, width: rect.width, height: bottom - top };
      });
      const file = resolve(out, `${palette}-${mode}.png`);
      writeFileSync(file, await page.screenshot({ clip }));
      files.push({ palette, mode, file, height: clip.height });
    }
  }
  console.log(JSON.stringify(files));
} finally {
  await browser.close();
}
