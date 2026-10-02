// SPDX-License-Identifier: GPL-3.0-or-later
// Kanji-aware furigana (#459): where the kana alone leave more than one split,
// the split whose kanji runs read by their KANJIDIC readings wins, if it is the
// only one. The engine adds it to the lookup reply; the popup, Anki and the
// API read it through termFurigana.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { createKanjiReadings, distributeFurigana, segmentFurigana } = require("../extension/render/glossary.js");

// Rows of the shipped table for the kanji below.
const READINGS = {
  好: "こう この.む す.く よ.い い.い", 嫌: "けん げん きら.う きら.い いや", 願: "がん ねが.う ねがい",
  致: "ち いた.す", 長: "ちょう なが.い おさ", 間: "かん けん あいだ ま あい", 指: "し ゆび さ.す さ.し",
  示: "じ し しめ.す", 聞: "ぶん もん き.く き.こえる", 取: "しゅ と.る と.り とり ど.り",
  果: "か は.たす はた.す は.てる は.て", 物: "ぶつ もつ もの", 王: "おう のう", 様: "よう しょう さま さん",
};
const pairs = segments => segments?.map(({ text, reading }) => (reading ? [text, reading] : [text])) ?? null;
const SPLITS = [
  ["好き嫌い", "すききらい", [["好", "す"], ["き"], ["嫌", "きら"], ["い"]]],
  ["お願い致します", "おねがいいたします", [["お"], ["願", "ねが"], ["い"], ["致", "いた"], ["します"]]],
  ["長い間", "ながいあいだ", [["長", "なが"], ["い"], ["間", "あいだ"]]],
  ["指し示す", "さししめす", [["指", "さ"], ["し"], ["示", "しめ"], ["す"]]],
];
const SUKIKIRAI = [{ text: "好", reading: "す" }, { text: "き", reading: "" },
  { text: "嫌", reading: "きら" }, { text: "い", reading: "" }];

test("kanji readings settle a split that the kana alone leave ambiguous", () => {
  const kanjiReadings = createKanjiReadings(READINGS);
  for (const [expression, reading, expected] of SPLITS) {
    // Without readings this is the whole-word fallback, as in Yomitan.
    assert.equal(distributeFurigana(expression, reading), null, expression);
    assert.deepEqual(pairs(segmentFurigana(expression, reading)), [[expression, reading]], expression);
    assert.deepEqual(pairs(distributeFurigana(expression, reading, kanjiReadings)), expected, expression);
  }
});

test("readings leave a settled split alone and keep one ruby where no single split reads", () => {
  const kanjiReadings = createKanjiReadings(READINGS);
  const kikitori = [["聞", "き"], ["き"], ["取", "と"], ["り"]];
  assert.deepEqual(pairs(distributeFurigana("聞き取り", "ききとり")), kikitori);
  assert.deepEqual(pairs(distributeFurigana("聞き取り", "ききとり", kanjiReadings)), kikitori);
  // 果物 is jukujikun: no reading of 果 or 物 spells くだもの.
  assert.equal(distributeFurigana("果物の王様", "くだもののおうさま", kanjiReadings), null);
  assert.deepEqual(pairs(segmentFurigana("果物の王様", "くだもののおうさま")), [["果物の王様", "くだもののおうさま"]]);
});

test("the shipped KANJIDIC table matches its source record and splits 好き嫌い and お願い致します", () => {
  const table = readFileSync(new URL("../extension/vendor/kanjidic/kanji-readings.json", import.meta.url));
  const source = JSON.parse(readFileSync(new URL("../extension/vendor/kanjidic/source.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(table).digest("hex"), source.files["kanji-readings.json"].sha256);
  const kanjiReadings = createKanjiReadings(JSON.parse(table).readings);
  for (const [expression, reading, expected] of SPLITS.slice(0, 2)) {
    assert.deepEqual(pairs(distributeFurigana(expression, reading, kanjiReadings)), expected, expression);
  }
});

test("the engine adds term.furigana only where the plain split falls back, and counts it in the reply", async () => {
  const { withFurigana } = await import("../extension/engine-service.js");
  const term = (expression, reading) => ({ matched: expression, term: { expression, reading, glossaries: [] } });
  const kikitori = term("聞き取り", "ききとり");
  const reply = await withFurigana({ results: [term("好き嫌い", "すききらい"), kikitori], dictionaryCount: 1,
    nativeJsonLength: 100 });
  assert.deepEqual(reply.results[0].term.furigana, SUKIKIRAI);
  assert.deepEqual(reply.results[1], term("聞き取り", "ききとり"));
  assert.equal(reply.nativeJsonLength, 100 + `,"furigana":${JSON.stringify(SUKIKIRAI)}`.length);
  const settled = { results: [kikitori], dictionaryCount: 1, nativeJsonLength: 100 };
  assert.equal(await withFurigana(settled), settled);
});

test("the popup headword draws the engine's split as ruby and as one pitch column per segment", t => {
  const { window } = new JSDOM('<p>好き嫌い</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/" });
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const { document, HDGlossary, HDPopup, HDReaderOptions } = window;
  const popup = document.getElementById("popup");
  const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
    appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent });
  t.after(() => { view.destroy(); window.close(); });
  const source = document.querySelector("p");
  const render = (furigana, options = {}) => {
    view.renderResults([{ matched: "好き嫌い", deinflected: "好き嫌い", trace: [], term: { expression: "好き嫌い",
      reading: "すききらい", furigana, rules: "", frequencies: [], glossaries: [{ dictionary: "D",
        glossary: JSON.stringify(["likes and dislikes"]), termTags: "" }],
      pitches: [{ dictionary: "NHK", pitches: [{ position: 2, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }],
    } }], { anchor: source, query: "好き嫌い", sentence: "好き嫌い", sourceElements: [source], matchOffset: 0 },
    { ...HDReaderOptions.normaliseOptions({}), showPitchAccentFurigana: false, ...options });
    return popup.querySelector(".gsm-hoshidicts-expression");
  };
  const markup = expression => expression.innerHTML.replaceAll(/<button[^>]*>/gu, "<button>");
  assert.equal(markup(render(SUKIKIRAI)),
    "<ruby><button>好</button><rt>す</rt></ruby>き<ruby><button>嫌</button><rt>きら</rt></ruby>い");
  // A split that does not spell the headword, from a stale or linked term, is not drawn.
  for (const furigana of [[{ text: "好き", reading: "すき" }], [{ text: "好き嫌い", reading: 1 }], "好(す)き"]) {
    assert.equal(markup(render(furigana)), "<ruby><button>好</button>き<button>嫌</button>い<rt>すききらい</rt></ruby>",
      JSON.stringify(furigana));
  }
  const columns = [...render(SUKIKIRAI, { showPitchAccentFurigana: true }).querySelectorAll(".gsm-hoshidicts-pitch-ruby")];
  assert.deepEqual(columns.map(ruby => [ruby.querySelector(".gsm-hoshidicts-pitch-base").textContent,
    ruby.querySelectorAll(".gsm-hoshidicts-pitch-mora").length]), [["好", 1], ["き", 1], ["嫌", 2], ["い", 1]]);
  assert.deepEqual([...popup.querySelectorAll(".pronunciation-group")].map(group => group.dataset.dictionary), ["NHK"]);
  // The Overline style shares the reading's morae out to the same segments,
  // and the headword keeps the pitch group of its furigana's accent.
  const overline = render(SUKIKIRAI, { showPitchAccentFurigana: true, pitchAccentFuriganaStyle: "overline" });
  assert.deepEqual([...overline.querySelectorAll(".gsm-hoshidicts-pitch-contour")]
    .map(contour => [contour.dataset.pitchStyle, contour.textContent]), [["overline", "す"], ["overline", "き"],
    ["overline", "きら"], ["overline", "い"]]);
  assert.equal(overline.dataset.pitchCategory, "nakadaka");
});
