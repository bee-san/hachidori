// Screenshots for hachidori #608: the production renderer, popup view and
// reader.css of one extension checkout, in headless Chrome, with Show pitch
// accent colours on. Each lookup is a synthetic term in the shape the engine
// returns: the word classes a dictionary can give it (講談社 日本語大辞典 gives
// 自由 "adj-i n", 精選版 日本国語大辞典 gives 料理 "vs") and one pitch.
//
//   node shots.mjs <extension directory> <output prefix>
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const REPO = "/local/home/skerraut/herd-synth3/clones/hachi-608";
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const [extension, prefix] = process.argv.slice(2);
const executablePath = join(REPO, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");

export const WORDS = [
  { expression: "自由", reading: "じゆう", rules: "adj-i n", position: 2, gloss: "freedom; liberty" },
  { expression: "料理", reading: "りょうり", rules: "vs", position: 1, gloss: "cooking; cuisine" },
  { expression: "高い", reading: "たかい", rules: "adj-i", position: 2, gloss: "high; tall; expensive" },
];

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] });
const css = readFileSync(join(extension, "render/reader.css"), "utf8");
try {
  for (const theme of ["light", "default"]) {
    for (const word of WORDS) {
      const page = await browser.newPage();
      await page.setViewport({ width: 420, height: 260, deviceScaleFactor: 2 });
      await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:${theme === "light" ? "#fff" : "#111"}">`
        + `<p id="text" lang="ja" style="margin:8px;font-size:18px">${word.expression}</p><div id="host"></div>`);
      for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
        await page.addScriptTag({ path: join(extension, file) });
      }
      await page.evaluate(({ css, theme, word }) => {
        const host = document.querySelector("#host");
        const shadow = host.attachShadow({ mode: "open" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        const popup = document.createElement("div");
        popup.className = "gsm-hoshidicts-popup";
        popup.style.cssText = "left:8px;top:40px;width:400px;height:210px";
        shadow.append(popup);
        const options = { ...HDReaderOptions.normaliseOptions({}), popupTheme: theme, showPitchAccentColors: true,
          // Their icons are extension URLs this page cannot load.
          showPopupAudioButton: false, personalDictionaryEnabled: false };
        HDPopup.createPopupAppearance(host).update({ ...options, popupWidthPx: 400, popupHeightPx: 210 });
        const view = HDPopup.createPopupView({ document, window, popup,
          appendExpressionRuby: HDGlossary.appendExpressionRuby,
          createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
          appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
          parseTagList: HDGlossary.parseTagList, positionPopup() {} });
        const source = document.querySelector("#text");
        view.renderResults([{ matched: word.expression, deinflected: word.expression, trace: [], preprocessorSteps: 0, term: {
          expression: word.expression, reading: word.reading, rules: word.rules, score: 0, frequencies: [],
          pitches: [{ dictionary: "Pitch fixture", transcriptions: [],
            pitches: [{ position: word.position, pattern: "", nasal: [], devoice: [] }] }],
          glossaries: [{ dictionary: "Term fixture", definitionTags: "", termTags: "", glossary: JSON.stringify([word.gloss]) }],
        } }], { anchor: source, query: word.expression, sentence: word.expression, sourceElements: [source], matchOffset: 0 }, options);
        window.reported = {
          headword: shadow.querySelector(".gsm-hoshidicts-expression").dataset.pitchCategory ?? null,
          badges: [...shadow.querySelectorAll(".pronunciation")].map(node => node.dataset.pitchCategory ?? null),
        };
      }, { css, theme, word });
      await page.evaluate(() => document.fonts.ready);
      const reported = await page.evaluate(() => window.reported);
      console.log(JSON.stringify({ theme, word: word.expression, rules: word.rules, ...reported }));
      await page.screenshot({ path: `${prefix}-${theme}-${WORDS.indexOf(word)}.png`, clip: { x: 0, y: 32, width: 420, height: 226 } });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
