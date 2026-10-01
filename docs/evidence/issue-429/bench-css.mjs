// Scratch benchmark for #429 (not committed): render + forced style/layout of
// real Jitendex cards with the base commit's reader.css and this branch's, and
// the cost of a live layout switch. Configurations are interleaved per round.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";

const root = process.env.REPO;
const base = process.env.BASE || "0061a5a5";
const rounds = Number(process.env.ROUNDS || 60);
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const branchCss = readFileSync(resolve(root, "extension/render/reader.css"), "utf8");
const baseCss = execFileSync("git", ["show", `${base}:extension/render/reader.css`], { cwd: root, encoding: "utf8" });
const icons = readFileSync(resolve(root, "extension/icons.css"), "utf8");
const jitendexCss = readFileSync("/tmp/hd429/jitendex-styles.css", "utf8");
const rows = JSON.parse(readFileSync("/tmp/hd429/jitendex-rows.json", "utf8"));
const glossaries = [
  { dictionary: "JMdict (plain)", definitionTags: "v1 vt", glossary: JSON.stringify(["to see", "to look", "to watch", "to view", "to observe"]) },
  ...["見る", "掛ける", "食べる"].map(word => {
    const row = rows.find(entry => entry[0] === word);
    return { dictionary: "Jitendex.org [2026-08-11]", definitionTags: row[2], termTags: row[7], glossary: JSON.stringify(row[5]) };
  }),
];
const configs = [
  { name: "base-default", css: baseCss, layout: "default" },
  { name: "branch-default", css: branchCss, layout: "default" },
  { name: "branch-compact", css: branchCss, layout: "compact" },
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const samples = Object.fromEntries(configs.map(config => [config.name, { render: [], switchOn: [], switchOff: [] }]));
try {
  const pages = [];
  for (const config of configs) {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p id="anchor">見る</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: resolve(root, "extension", file) });
    }
    await page.evaluate(({ css, icons, jitendexCss, glossaries, layout }) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`${css}\n${icons}`);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {} });
      HDGlossary.applyDictionaryStyles(document, shadow, 1, [{ dictionary: "Jitendex.org [2026-08-11]", styles: jitendexCss }]);
      const appearance = HDPopup.createPopupAppearance(host);
      const options = mode => ({ popupTheme: "default", popupWidthPx: 560, popupHeightPx: 420, popupScalePercent: 100,
        popupOpacityPercent: 85, showPopupAudioButton: true, glossaryLayoutMode: mode });
      appearance.update(options(layout));
      const results = [{ matched: "見る", deinflected: "見る", trace: [], preprocessorSteps: 0, term: {
        expression: "見る", reading: "みる", rules: "v1", score: 0, frequencies: [], pitches: [], glossaries } }];
      const candidate = { anchor: document.querySelector("#anchor"), query: "見る" };
      // Production view work plus the style and layout it dirties.
      window.renderOnce = () => {
        const start = performance.now();
        view.renderResults(results, candidate, {});
        void popup.querySelector(".gsm-hoshidicts-glossary-grid").getBoundingClientRect().height;
        return performance.now() - start;
      };
      // The live switch on an open popup: attribute, then style and layout.
      window.switchTo = mode => {
        const start = performance.now();
        appearance.update(options(mode));
        void popup.querySelector(".gsm-hoshidicts-glossary-grid").getBoundingClientRect().height;
        return performance.now() - start;
      };
      window.restore = () => appearance.update(options(layout));
    }, { css: config.css, icons, jitendexCss, glossaries, layout: config.layout });
    pages.push({ config, page });
  }
  // Warm up each page.
  for (const { page } of pages) for (let i = 0; i < 5; i++) await page.evaluate(() => renderOnce());
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...pages].reverse() : pages;
    for (const { config, page } of order) {
      await page.bringToFront();
      samples[config.name].render.push(await page.evaluate(() => renderOnce()));
      if (config.name !== "base-default") {
        // From the page's own layout to the other one and back.
        const [there, back] = config.layout === "compact" ? ["default", "compact"] : ["compact", "default"];
        samples[config.name].switchOn.push(await page.evaluate(mode => switchTo(mode), there));
        samples[config.name].switchOff.push(await page.evaluate(mode => switchTo(mode), back));
        await page.evaluate(() => restore());
      }
    }
  }
  const heights = {};
  for (const { config, page } of pages) {
    heights[config.name] = await page.evaluate(() => [...document.querySelector("#host").shadowRoot
      .querySelectorAll(".gsm-hoshidicts-glossary-card")].map(card => Math.round(card.getBoundingClientRect().height)));
  }
  const stats = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, median: Number(at(0.5).toFixed(2)), p10: Number(at(0.1).toFixed(2)), p90: Number(at(0.9).toFixed(2)) };
  };
  const summary = Object.fromEntries(Object.entries(samples).map(([name, value]) => [name, {
    render: stats(value.render), ...(value.switchOn.length ? { switchOn: stats(value.switchOn), switchOff: stats(value.switchOff) } : {}) }]));
  const report = { chrome: await browser.version(), cpu: cpus()[0].model, logicalCpus: cpus().length, load: loadavg(),
    base, branch: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), dirty: true,
    rounds, glossaries: glossaries.map(entry => entry.dictionary), heights, summary, samples };
  writeFileSync(process.env.OUT || "/tmp/hd429/bench-css.json", JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ chrome: report.chrome, load: report.load, heights, summary }, null, 1));
} finally {
  await browser.close();
}
