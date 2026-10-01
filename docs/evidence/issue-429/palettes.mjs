// Scratch: the compact plain-gloss card in every palette, with the bar's
// measured contrast against the card (not committed).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.env.REPO;
const out = process.env.OUT || "/tmp/hd429/shots/palettes";
mkdirSync(out, { recursive: true });
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
await import(new URL(`file://${resolve(root, "extension/reader-options.js")}`).href);
const palettes = globalThis.HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id))
  .filter(theme => theme !== "auto");
const css = readFileSync(resolve(root, "extension/render/reader.css"), "utf8");
const icons = readFileSync(resolve(root, "extension/icons.css"), "utf8");
const luminance = pixel => pixel.map(value => value / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const browser = await puppeteer.launch({ executablePath: resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  headless: true, args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 400, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setContent('<!doctype html><meta charset="utf-8"><p id="anchor" style="margin:0;height:0;overflow:hidden">食べる</p><div id="host"></div>');
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) await page.addScriptTag({ path: resolve(root, "extension", file) });
  await page.evaluate(({ css, icons }) => {
    const host = document.querySelector("#host");
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(`${css}\n${icons}`); shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div"); popup.className = "gsm-hoshidicts-popup"; popup.style.cssText = "left:20px;top:20px"; shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup, appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, positionPopup() {} });
    view.renderResults([{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0, term: { expression: "食べる", reading: "たべる",
      rules: "v1", score: 0, frequencies: [], pitches: [], glossaries: [{ dictionary: "JMdict (plain)", definitionTags: "v1 vt",
        glossary: JSON.stringify(["to eat", "to live on (e.g. a salary)", "to have a meal"]) }] } }],
    { anchor: document.querySelector("#anchor"), query: "食べる" }, {});
    const appearance = HDPopup.createPopupAppearance(host);
    window.setPalette = popupTheme => appearance.update({ popupTheme, popupWidthPx: 560, popupHeightPx: 300, popupScalePercent: 100,
      popupOpacityPercent: 85, showPopupAudioButton: true, glossaryLayoutMode: "compact" });
  }, { css, icons });
  const rows = [];
  for (const palette of palettes) {
    const probe = await page.evaluate(palette => {
      setPalette(palette);
      const shadow = document.querySelector("#host").shadowRoot;
      const card = shadow.querySelector(".gsm-hoshidicts-glossary-card").getBoundingClientRect();
      const item = shadow.querySelector(".gloss-item:last-child");
      const [lead] = item.getClientRects();
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      context.fillStyle = getComputedStyle(item, "::before").color; context.fillRect(0, 0, 1, 1);
      return { bar: [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)], x: lead.left + 2, y: lead.top + lead.height / 2,
        clip: { x: card.x, y: card.y, width: card.width, height: card.height } };
    }, palette);
    await new Promise(done => setTimeout(done, 60));
    const pixel = await page.evaluate(async png => {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      context.drawImage(await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob()), 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, await page.screenshot({ clip: { x: probe.x, y: probe.y, width: 1, height: 1 }, encoding: "base64" }));
    const file = resolve(out, `${palette}.png`);
    writeFileSync(file, await page.screenshot({ clip: probe.clip }));
    rows.push({ palette, file, ratio: Number(contrast(probe.bar, pixel).toFixed(2)) });
  }
  writeFileSync(resolve(out, "palettes.json"), JSON.stringify(rows, null, 1));
  console.log(rows.map(row => `${row.palette}:${row.ratio}`).join(" "));
} finally { await browser.close(); }
