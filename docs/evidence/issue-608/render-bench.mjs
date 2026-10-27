// Real-Chrome timing for hachidori #608 (evidence only): renderResults of the
// production popup view and reader.css, main and branch in two pages of one
// Chrome, alternating sample by sample. The reply is 16 results, each with
// word classes and three pitches from two pitch dictionaries, so every result
// classifies a headword and three badges.
//   node render-bench.mjs <main extension dir> <branch extension dir> [samples]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const REPO = "/local/home/skerraut/herd-synth3/clones/hachi-608";
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const [mainDir, branchDir, samplesArg = "300"] = process.argv.slice(2);
const WORDS = [["自由", "じゆう", "adj-i n"], ["静か", "しずか", "adj-i"], ["料理", "りょうり", "vs"], ["高い", "たかい", "adj-i"],
  ["食べる", "たべる", "v1"], ["驚く", "おどろく", "v5"], ["勉強", "べんきょう", "vs n"], ["綺麗", "きれい", "adj-i"],
  ["来る", "くる", "vk"], ["信ずる", "しんずる", "vz"], ["面倒", "めんどう", "v5"], ["ダンス", "ダンス", "vs"],
  ["好き", "すき", "adj-i n"], ["読む", "よむ", "v5"], ["大切", "たいせつ", "adj-i"], ["愛する", "あいする", "vs"]];
const results = WORDS.map(([expression, reading, rules]) => ({ matched: expression, deinflected: expression, trace: [],
  preprocessorSteps: 0, term: { expression, reading, rules, score: 0, frequencies: [],
    pitches: [{ dictionary: "Pitch A", transcriptions: [], pitches: [1, 2].map(position => ({ position, pattern: "", nasal: [], devoice: [] })) },
      { dictionary: "Pitch B", transcriptions: [], pitches: [{ position: 0, pattern: "", nasal: [], devoice: [] }] }],
    glossaries: [{ dictionary: "Term fixture", definitionTags: "", termTags: "", glossary: JSON.stringify([`${expression} gloss`]) }] } }));

const browser = await puppeteer.launch({ executablePath: join(REPO, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  headless: true, args: ["--no-sandbox"] });
try {
  const pages = {};
  for (const [name, dir] of [["main", mainDir], ["branch", branchDir]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p id="text">自由</p><div id="host"></div>');
    for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: join(dir, file) });
    }
    await page.evaluate(({ css, results }) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:8px;top:40px;width:560px;height:700px";
      shadow.append(popup);
      const options = { ...HDReaderOptions.normaliseOptions({}), showPitchAccentColors: true, expandAll: true };
      HDPopup.createPopupAppearance(host).update({ ...options, popupWidthPx: 560, popupHeightPx: 700 });
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {} });
      const source = document.querySelector("#text");
      window.sample = () => {
        const started = performance.now();
        view.renderResults(results, { anchor: source, query: "自由", sentence: "自由", sourceElements: [source], matchOffset: 0 }, options);
        const rendered = performance.now();
        void popup.offsetHeight;
        return [rendered - started, performance.now() - started,
          [...shadow.querySelectorAll(".gsm-hoshidicts-expression[data-pitch-category]")].length];
      };
    }, { css: readFileSync(join(dir, "render/reader.css"), "utf8"), results });
    pages[name] = page;
  }
  const samples = { main: [], branch: [] };
  const total = Number(samplesArg);
  for (let index = 0; index < total + 20; index += 1) {
    for (const name of index % 2 ? ["branch", "main"] : ["main", "branch"]) {
      await pages[name].bringToFront();
      const value = await pages[name].evaluate(() => window.sample());
      if (index >= 20) samples[name].push(value);
    }
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  for (const [name, values] of Object.entries(samples)) {
    console.log(`${name.padEnd(6)} n=${values.length} renderResults median ${median(values.map(v => v[0])).toFixed(2)} ms,`
      + ` + style and layout median ${median(values.map(v => v[1])).toFixed(2)} ms, coloured headwords ${values[0][2]}`);
  }
} finally {
  await browser.close();
}
