// Targeted timing for #606 (scratch, not committed): Default's renderResults
// plus a forced layout for six headwords with a pitch accent, main against
// this branch, in one Chrome with one page per revision. Order alternates on
// every round. Excludes engine lookup, messaging, paint and media.
// node bench-headword.mjs <before-extension> <after-extension> <rounds> <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [before, after] = process.argv.slice(2, 4).map(path => resolve(path));
const rounds = Number(process.argv[4] ?? 40);
const output = resolve(process.argv[5] ?? "/tmp/hachi-606/bench.json");
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;

const entry = (expression, reading, position, furigana) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, furigana, rules: "", score: 0, frequencies: [],
    pitches: [{ dictionary: "Sample pitch", pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }],
    glossaries: [{ dictionary: "Sample", definitionTags: "", termTags: "", glossary: JSON.stringify(["sample gloss"]) }] } });
const WORDS = [
  entry("好き嫌い", "すききらい", 2, [{ text: "好", reading: "す" }, { text: "き", reading: "" },
    { text: "嫌", reading: "きら" }, { text: "い", reading: "" }]),
  entry("食べる", "たべる", 2), entry("てくてく", "てくてく", 1), entry("立ち上がる", "たちあがる", 0),
  entry("見る", "みる", 1), entry("お見舞い", "おみまい", 0),
];

const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
async function open(extension) {
  const page = await browser.newPage();
  await page.setViewport({ width: 700, height: 700 });
  await page.setContent('<!doctype html><meta charset="utf-8"><p>x</p><div id="host"></div>');
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    await page.addScriptTag({ path: resolve(extension, file) });
  }
  await page.evaluate((css, words) => {
    const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = "left:20px;top:20px;width:560px;height:420px";
    shadow.append(popup);
    const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList });
    const anchor = document.querySelector("p");
    const base = HDReaderOptions.normaliseOptions({});
    window.measure = (style, repeats) => {
      const samples = [];
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        for (const word of words) {
          const start = performance.now();
          view.renderResults([word], { anchor, query: word.term.expression, sentence: "", sourceElements: [anchor],
            matchOffset: 0 }, { ...base, pitchAccentFuriganaStyle: style });
          popup.querySelector(".gsm-hoshidicts-expression").getBoundingClientRect();
          samples.push(performance.now() - start);
        }
      }
      return samples;
    };
  }, readFileSync(resolve(extension, "render/reader.css"), "utf8"), WORDS);
  return page;
}
const pages = { before: await open(before), after: await open(after) };
const samples = { before: { contour: [], overline: [] }, after: { contour: [], overline: [] } };
// Excluded warmup.
for (const page of Object.values(pages)) for (const style of ["contour", "overline"]) await page.evaluate((s) => window.measure(s, 20), style);
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 ? ["after", "before"] : ["before", "after"];
  for (const style of ["contour", "overline"]) {
    for (const revision of order) {
      samples[revision][style].push(...await pages[revision].evaluate((s) => window.measure(s, 10), style));
    }
  }
}
await browser.close();
const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: at(0.5), p25: at(0.25), p75: at(0.75), p95: at(0.95) };
};
const summary = Object.fromEntries(Object.entries(samples).map(([revision, styles]) =>
  [revision, Object.fromEntries(Object.entries(styles).map(([style, values]) => [style, stats(values)]))]));
writeFileSync(output, JSON.stringify({ rounds, words: WORDS.map(word => word.term.expression), summary, samples }));
console.log(JSON.stringify(summary, null, 1));
