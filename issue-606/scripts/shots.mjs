// Screenshots for #606 (scratch, not committed): the production Default
// renderer (createPopupView + reader.css) of main and of this branch, side by
// side, for synthetic sample terms built like the unit tests' (no dictionary
// content), in several palettes.
// node shots.mjs <before-extension> <after-extension> <output-dir>
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [before, after, output] = process.argv.slice(2).map(path => resolve(path));
mkdirSync(output, { recursive: true });
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;

const entry = (expression, reading, position, rules = "", furigana, pattern = "") => ({ matched: expression,
  deinflected: expression, trace: [], term: { expression, reading, furigana, rules, score: 0, frequencies: [],
    pitches: [{ dictionary: "Sample pitch", pitches: [{ position, pattern, nasal: [], devoice: [] }], transcriptions: [] }],
    glossaries: [{ dictionary: "Sample", definitionTags: "", termTags: "", glossary: JSON.stringify(["sample gloss"]) }] } });
const SUKIKIRAI = [{ text: "好", reading: "す" }, { text: "き", reading: "" }, { text: "嫌", reading: "きら" },
  { text: "い", reading: "" }];
export const WORDS = [
  entry("好き嫌い", "すききらい", 2, "", SUKIKIRAI),
  entry("食べる", "たべる", 2, "v1"),
  entry("てくてく", "てくてく", 1),
  entry("立ち上がる", "たちあがる", 0, "v5"),
  entry("見る", "みる", 1, "v1"),
  entry("テレビ", "てれび", 1),
];

const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none"] });

async function render(extension, { theme, style, colours, blur = "revealed", words = WORDS, width = 300, forced = false }) {
  const page = await browser.newPage();
  if (forced) await page.emulateMediaFeatures([{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "dark" }]);
  await page.setViewport({ width: width + 40, height: 900, deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#808080">'
    + '<p style="display:none">x</p><div id="host"></div>');
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ path: resolve(extension, file) });
  }
  const rect = await page.evaluate(({ css, theme, style, colours, blur, words, width }) => {
    const host = document.querySelector("#host");
    host.dataset.hoshidictsTheme = theme;
    if (colours) host.dataset.hoshidictsPitchColors = "on";
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = `left:20px;top:20px;width:${width}px;height:auto;max-height:none`;
    shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList });
    const anchor = document.querySelector("p");
    const options = HDReaderOptions.normaliseOptions({});
    // Only the headwords: each as the first result of its own popup section.
    const headers = [];
    for (const word of words) {
      view.renderResults([word], { anchor, query: word.term.expression, sentence: "", sourceElements: [anchor],
        matchOffset: 0 }, { ...options, pitchAccentFuriganaStyle: style, showPitchAccentBadge: false });
      view.setDefinitionBlurState(blur);
      const header = popup.querySelector(".gsm-hoshidicts-primary-header");
      headers.push(header.cloneNode(true));
    }
    // Lay the cloned headers out in one popup-styled column.
    popup.replaceChildren(...headers);
    popup.style.display = "flex";
    popup.style.flexDirection = "column";
    popup.style.gap = "2px";
    for (const node of popup.querySelectorAll(".gsm-hoshidicts-entry-actions")) node.remove();
    const box = popup.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, { css: readFileSync(resolve(extension, "render/reader.css"), "utf8"), theme, style, colours, blur, words, width });
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(output, `${extension === before ? "main" : "branch"}-${theme}-${style}${colours ? "-colours" : ""}${blur !== "revealed" ? `-${blur}` : ""}${forced ? "-forced" : ""}.png`);
  await page.screenshot({ path, clip: rect });
  await page.close();
  return path;
}

const shots = [];
if (process.env.FORCED_ONLY) {
  for (const extension of [before, after]) {
    for (const style of ["contour", "overline"]) shots.push(await render(extension, { theme: "default", style, forced: true }));
    shots.push(await render(extension, { theme: "default", style: "contour", forced: true, blur: "blurred" }));
  }
  await browser.close();
  console.log(shots.join("\n"));
  process.exit(0);
}
for (const theme of ["light", "default", "girlypop", "high-contrast"]) {
  for (const style of ["contour", "overline"]) {
    for (const extension of [before, after]) shots.push(await render(extension, { theme, style }));
  }
}
for (const extension of [before, after]) {
  shots.push(await render(extension, { theme: "default", style: "contour", colours: true }));
  shots.push(await render(extension, { theme: "light", style: "contour", blur: "blurred" }));
}
await browser.close();
console.log(shots.join("\n"));
