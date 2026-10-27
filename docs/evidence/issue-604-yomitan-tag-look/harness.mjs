// Scratch harness for hachidori #604: render the same Jitendex-shaped entry
// through Yomitan d3c54c1's markup and CSS, and through Hachidori's Default
// renderer (production popup.js + reader.css in a shadow root, as theme-host.js
// installs it), in real Chrome. Writes PNGs and a JSON of computed tag styles.
//
// node harness.mjs <label> <extensionDir> [palette ...]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/local/home/skerraut/herd-synth3/clones/hachi-604";
const require = createRequire(resolve(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = resolve(REPO, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const YOMITAN = "/tmp/hachi-604/yomitan/ext";
const OUT = "/tmp/hachi-604/shots";
mkdirSync(OUT, { recursive: true });

const [label = "branch", extensionDir = resolve(REPO, "extension"), ...paletteArgs] = process.argv.slice(2);
const palettes = paletteArgs.length ? paletteArgs : ["light", "default"];
const NBSP = "\u00a0";
const JITENDEX = "Jitendex.org [2026-10-03]";
const JMDICT = "JMdict (English)";
const tag = (name, category, order, notes, score = 0) => ({ name, category, order, notes, score });
// Jitendex's tag bank rows for these names (abridged in test/yomitan-parity.test.mjs).
const JITENDEX_TAGS = [
  tag(`priority${NBSP}form`, "frequent", 1, "high priority spelling or reading of this term", 1),
  tag(`special${NBSP}reading`, "expression", 1, "jukujikun (idiomatic reading of a kanji compound) or gikun", 0),
  tag("★", "popular", 2, "high priority entry", 2),
];
const ROWS = [
  { dictionary: JITENDEX, tags: JITENDEX_TAGS, glosses: ["today", "this day"] },
  { dictionary: JMDICT, tags: [tag("n", "partOfSpeech", 0, "noun"), tag("adv", "partOfSpeech", 0, "adverb")],
    glosses: ["today", "this day"] },
  { dictionary: JMDICT, tags: [tag("n", "partOfSpeech", 0, "noun"), tag("adv", "partOfSpeech", 0, "adverb")],
    glosses: ["these days", "recently", "nowadays"] },
  { dictionary: JMDICT, tags: [tag(`rarely${NBSP}used${NBSP}form`, "archaism", 0, "rarely used form of this term")],
    glosses: ["(archaic) this present day"] },
];

function yomitanHtml(theme) {
  const css = ["material.css", "display.css", "structured-content.css"]
    .map(file => readFileSync(`${YOMITAN}/css/${file}`, "utf8")).join("\n");
  const escape = text => text.replace(/[&<>"]/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  // DisplayGenerator._createTag and createTermEntry's dictionary tag.
  const tagHtml = (name, category, title, redundant = false) => `<span class="tag" title="${escape(title)}" data-details="${escape(title || name)}" data-category="${category}"${redundant ? ' data-redundant="true"' : ""}><span class="tag-label"><span class="tag-label-content">${escape(name)}</span></span></span>`;
  const seen = new Set();
  const items = ROWS.map((row, index) => {
    const redundant = seen.has(row.dictionary);
    seen.add(row.dictionary);
    const tags = [...row.tags.map(t => tagHtml(t.name, t.category, t.notes)), tagHtml(row.dictionary, "dictionary", row.dictionary, redundant)].join("");
    const glosses = row.glosses.map(g => `<li class="gloss-item click-scannable"><span class="gloss-separator"> </span><span class="gloss-content">${escape(g)}</span></li>`).join("");
    return `<li class="definition-item" data-dictionary="${escape(row.dictionary)}" data-index="${index}"><div class="definition-item-inner"><div class="definition-item-content"><div class="definition-tag-list tag-list">${tags}</div><div class="definition-disambiguation-list" data-count="0"></div><ul class="gloss-list" data-count="${row.glosses.length}">${glosses}</ul></div></div></li>`;
  }).join("");
  return `<!doctype html><html data-theme="${theme}" data-page-type="popup" data-compact-tags="false" data-glossary-layout-mode="default"><head><meta charset="utf-8"><style>${css}
body { overflow: visible; padding: 8px; background: var(--background-color); }</style></head>
<body><div class="entry" data-type="term"><ol class="definition-list" data-count="${ROWS.length}" id="target">${items}</ol></div></body></html>`;
}

async function hachidoriPage(browser, palette) {
  const page = await browser.newPage();
  await page.setViewport({ width: 620, height: 700, deviceScaleFactor: Number(process.env.HARNESS_DSF || 2) });
  if (process.env.HARNESS_FORCED) await page.emulateMediaFeatures([{ name: "forced-colors", value: "active" },
    { name: "prefers-color-scheme", value: process.env.HARNESS_FORCED }]);
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:${palette === "light" ? "#ffffff" : "#1e1e1e"}}</style><p id="word">今日</p><div id="host"></div>`);
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ content: readFileSync(resolve(extensionDir, file), "utf8") });
  }
  const css = readFileSync(resolve(extensionDir, "render/reader.css"), "utf8")
    + (process.env.HARNESS_EXTRA_CSS ? `\n${readFileSync(process.env.HARNESS_EXTRA_CSS, "utf8")}` : "");
  await page.evaluate(({ css, rows, palette, layoutMode }) => {
    const host = document.querySelector("#host");
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = "left:10px;top:10px";
    shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup,
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, positionPopup() {} });
    const appearance = HDPopup.createPopupAppearance(host);
    appearance.update({ popupTheme: palette, popupWidthPx: 560, popupHeightPx: 640, popupScalePercent: 100,
      popupOpacityPercent: 100, showPopupAudioButton: true, glossaryLayoutMode: layoutMode });
    view.renderResults([{ matched: "今日", deinflected: "今日", trace: [], preprocessorSteps: 0, term: {
      expression: "今日", reading: "きょう", rules: "", score: 0, frequencies: [], pitches: [],
      glossaries: rows.map(row => ({ dictionary: row.dictionary, glossary: JSON.stringify(row.glosses),
        definitionTags: row.tags.map(t => t.name).join(" "), termTags: "", tags: row.tags })),
    } }], { anchor: document.querySelector("#word"), query: "今日" }, HDReaderOptions.normaliseOptions({}));
    window.shadowQuery = (selector, all = false) => all ? [...shadow.querySelectorAll(selector)] : shadow.querySelector(selector);
  }, { css, rows: ROWS, palette, layoutMode: process.env.HARNESS_LAYOUT || "default" });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const describeRows = root => [...root.querySelectorAll(".definition-tag-list")].map(row => {
  const rect = row.getBoundingClientRect();
  const next = row.nextElementSibling?.matches(".definition-disambiguation-list") ? row.parentNode.querySelector(".gloss-list") : row.nextElementSibling;
  const firstGloss = (next?.querySelector(".gloss-content") ?? next)?.getBoundingClientRect();
  return { height: Math.round(rect.height * 100) / 100, glossGap: firstGloss ? Math.round((firstGloss.top - rect.bottom) * 100) / 100 : null };
});
const describeTags = root => [...root.querySelectorAll(".definition-tag-list > *")].map(node => {
  const label = node.querySelector(".tag-label") ?? node;
  const text = node.querySelector(".tag-label-content") ?? node;
  const style = getComputedStyle(label);
  const textStyle = getComputedStyle(text);
  const rect = node.getBoundingClientRect();
  return { text: node.textContent, category: node.dataset.category, background: style.backgroundColor,
    color: textStyle.color, fontSize: textStyle.fontSize, fontWeight: textStyle.fontWeight,
    width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100,
    marginRight: getComputedStyle(node).marginRight, radius: style.borderTopLeftRadius,
    padding: style.padding };
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  env: { ...process.env, FONTCONFIG_FILE: "/tmp/hachi-604/fonts.conf" },
  args: ["--no-sandbox", "--font-render-hinting=none"] });
const report = {};
try {
  for (const palette of palettes) {
    const page = await hachidoriPage(browser, palette);
    const scheme = await page.evaluate(() => getComputedStyle(shadowQuery(".gsm-hoshidicts-popup")).colorScheme);
    const box = await page.evaluate(() => {
      const grid = shadowQuery(".gsm-hoshidicts-glossary-grid");
      const rect = grid.getBoundingClientRect();
      return { x: rect.x - 6, y: rect.y - 6, width: rect.width + 12, height: rect.height + 12 };
    });
    await page.screenshot({ path: `${OUT}/${label}-${palette}.png`, clip: box });
    const popupBox = await page.evaluate(() => {
      const rect = shadowQuery(".gsm-hoshidicts-popup").getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 420) };
    });
    await page.screenshot({ path: `${OUT}/${label}-${palette}-popup.png`, clip: popupBox });
    report[`${label}/${palette}`] = { scheme,
      cardHeights: await page.evaluate(() => shadowQuery(".gsm-hoshidicts-glossary-card", true).map(card => card.getBoundingClientRect().height)),
      rows: await page.evaluate(`(${describeRows})(shadowQuery(".gsm-hoshidicts-popup"))`), tags: await page.evaluate(`(${describeTags})(shadowQuery(".gsm-hoshidicts-popup"))`),
      titles: await page.evaluate(() => shadowQuery(".gsm-hoshidicts-glossary-card-title", true).map(node => node.textContent)) };
    await page.close();
    if (label === "base") {
      const theme = scheme.includes("light") ? "light" : "dark";
      const yomitan = await browser.newPage();
      await yomitan.setViewport({ width: 620, height: 700, deviceScaleFactor: 2 });
      await yomitan.setContent(yomitanHtml(theme));
      await yomitan.evaluate(() => document.fonts.ready);
      const yBox = await yomitan.evaluate(() => {
        const rect = document.querySelector("#target").getBoundingClientRect();
        return { x: 0, y: 0, width: Math.ceil(rect.right + 16), height: Math.ceil(rect.bottom + 12) };
      });
      await yomitan.screenshot({ path: `${OUT}/yomitan-${theme}.png`, clip: yBox });
      report[`yomitan/${theme}`] = { rows: await yomitan.evaluate(`(${describeRows})(document)`), tags: await yomitan.evaluate(`(${describeTags})(document)`) };
      await yomitan.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/${label}-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
