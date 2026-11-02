// SPDX-License-Identifier: GPL-3.0-or-later
// Kanji-aware furigana (#459): where the kana alone leave more than one split,
// the split whose kanji runs read by their KANJIDIC readings wins, if it is the
// only one. Each run of kanji is then read one kanji at a time where exactly
// one split of its reading reads (#605), and a run that no split reads by
// KANJIDIC is read again with Jitendex kanwa's readings and compounds (#641).
// The engine adds the result to the lookup reply; the popup, Anki and the API
// read it through termFurigana.
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
const { createKanjiReadings, createKanwaReadings, distributeFurigana, kanjiFurigana, segmentFurigana }
  = require("../extension/render/glossary.js");

// Rows of the shipped table for the kanji below.
const READINGS = {
  好: "こう この.む す.く よ.い い.い", 嫌: "けん げん きら.う きら.い いや", 願: "がん ねが.う ねがい",
  致: "ち いた.す", 長: "ちょう なが.い おさ", 間: "かん けん あいだ ま あい", 指: "し ゆび さ.す さ.し",
  示: "じ し しめ.す", 聞: "ぶん もん き.く き.こえる", 取: "しゅ と.る と.り とり ど.り",
  果: "か は.たす はた.す は.てる は.て", 物: "ぶつ もつ もの", 王: "おう のう", 様: "よう しょう さま さん",
  二: "に じ ふた ふた.つ ふたたび", 十: "じゅう じっ じゅっ とお と そ", 四: "し よ よ.つ よっ.つ よん",
  時: "じ とき どき", 人: "じん にん ひと り と", 世: "せい せ そう よ", 界: "かい", 中: "ちゅう なか うち あた.る",
  植: "しょく う.える う.わる", 木: "ぼく もく き こ", 今: "こん きん いま", 日: "にち じつ ひ び か",
  印: "いん しるし じるし しる.す", 度: "ど と たく たび た.い", 命: "めい みょう いのち", 恩: "おん",
  思: "し おも.う おもえら.く おぼ.す", 出: "しゅつ すい で.る で だ.す い.でる い.だす",
  𠮟: "しつ しち か しか.る", 責: "せき せ.める", 本: "ほん もと", 語: "ご かた.る かた.らう", 部: "ぶ べ",
  屋: "おく や", 河: "か かわ", 原: "げん はら", 者: "しゃ もの",
};
// Rows of the shipped kanwa table (#641): readings KANJIDIC lacks, and compounds.
const KANWA = {
  readings: { "２": "じ つー に ふた ふたたび ふつ", 原: "わら", Ｃ: "しー", Ｐ: "ぴー ぷ ぺー", Ｉ: "あい いち" },
  compounds: { 日本: "に|ほん やまと", 部屋: "へ|や", 今日: "きょう", 河原: "かわら", ＰＩ: "ぴ", 印度: "いんど" },
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

// Each run of kanji read one kanji at a time (#605), on top of the split above.
const PER_KANJI = [
  // The issue's example.
  ["二十四時間", "にじゅうよじかん", [["二", "に"], ["十", "じゅう"], ["四", "よ"], ["時", "じ"], ["間", "かん"]]],
  // 々 reads as the kanji before it, here with rendaku.
  ["人々", "ひとびと", [["人", "ひと"], ["々", "びと"]]],
  // A voiced ち or つ may be written じ or ず.
  ["世界中", "せかいじゅう", [["世", "せ"], ["界", "かい"], ["中", "じゅう"]]],
  // A kanji takes the part of its okurigana that a compound leaves unwritten.
  ["植木", "うえき", [["植", "うえ"], ["木", "き"]]],
  // A katakana reading keeps its script; a kanji beyond U+FFFF is one character.
  ["印度", "インド", [["印", "イン"], ["度", "ド"]]],
  ["𠮟責", "しっせき", [["𠮟", "しっ"], ["責", "せき"]]],
  // The kana leave two splits (#459); then 恩人 is read one kanji at a time.
  ["命の恩人", "いのちのおんじん", [["命", "いのち"], ["の"], ["恩", "おん"], ["人", "じん"]]],
];

test("each run of kanji is read one kanji at a time where exactly one split of its reading reads", () => {
  const kanjiReadings = createKanjiReadings(READINGS);
  for (const [expression, reading, expected] of PER_KANJI) {
    assert.deepEqual(pairs(kanjiFurigana(expression, reading, kanjiReadings)), expected, expression);
  }
  // 好き嫌い's split (#459) has no run of kanji left to read.
  assert.deepEqual(kanjiFurigana("好き嫌い", "すききらい", kanjiReadings), SUKIKIRAI);
  // null keeps the local split. No split of 今日 reads (jukujikun), nor of ２人
  // (a digit has no readings). 思出 reads as 思(おもい)出(だ) and as 思(おも)出(いだ):
  // in 思出す that is the whole run, and in 思出人 the 人 after it still leaves
  // the run two splits. 聞き取り has no run of kanji, and no split of 果物の王様
  // reads (#459).
  for (const [expression, reading] of [["今日", "きょう"], ["２人", "ふたり"], ["思出す", "おもいだす"],
    ["思出人", "おもいだひと"], ["聞き取り", "ききとり"], ["果物の王様", "くだもののおうさま"], ["ありがとう", "ありがとう"]]) {
    assert.equal(kanjiFurigana(expression, reading, kanjiReadings), null, expression);
  }
});

// A run that no split reads by KANJIDIC is read again with Jitendex kanwa's
// readings and compounds (#641).
const BY_KANWA = [
  // The issue's example: KANJIDIC has no に for 日; kanwa reads 日本 に|ほん, also
  // inside a longer run.
  ["日本", "にほん", [["日", "に"], ["本", "ほん"]]],
  ["日本語", "にほんご", [["日", "に"], ["本", "ほん"], ["語", "ご"]]],
  ["部屋", "へや", [["部", "へ"], ["屋", "や"]]],
  // A digit reads by kanwa's numeral readings.
  ["２人", "ふたり", [["２", "ふた"], ["人", "り"]]],
  // A compound read as a whole keeps one ruby inside its run.
  ["今日中", "きょうじゅう", [["今日", "きょう"], ["中", "じゅう"]]],
  // Where a compound and its characters both read, the compound counts (河 か,
  // 原 わら also spell かわら), as Jitendex reads a known compound first.
  ["河原者", "かわらもの", [["河原", "かわら"], ["者", "もの"]]],
  // A compound whose reading leaves the rest of the run unread (ＰＩ ぴ, then
  // ーあい for nothing) does not stop its characters reading.
  ["ＣＰＩ", "シーピーアイ", [["Ｃ", "シー"], ["Ｐ", "ピー"], ["Ｉ", "アイ"]]],
];

test("a run that no split reads by KANJIDIC is read with Jitendex kanwa's readings and compounds", () => {
  const kanjiReadings = createKanjiReadings(READINGS);
  const kanwa = createKanwaReadings(KANWA, kanjiReadings);
  for (const [expression, reading, expected] of BY_KANWA) {
    assert.equal(kanjiFurigana(expression, reading, kanjiReadings), null, expression);
    assert.deepEqual(pairs(kanjiFurigana(expression, reading, kanjiReadings, kanwa)), expected, expression);
  }
  // A run that KANJIDIC reads keeps that split, though kanwa names 日本 and 印度.
  for (const [expression, reading, expected] of [["日本", "にっぽん", [["日", "にっ"], ["本", "ぽん"]]], PER_KANJI[4]]) {
    assert.deepEqual(pairs(kanjiFurigana(expression, reading, kanjiReadings, kanwa)), expected, expression);
  }
  // null keeps the local split: the compound is the whole run (今日 きょう, and
  // 河原 かわら, where it counts before 河(か)原(わら)), or two splits read as many
  // characters by compounds (here 部屋 へ|や and へや).
  for (const [expression, reading] of [["今日", "きょう"], ["河原", "かわら"]]) {
    assert.equal(kanjiFurigana(expression, reading, kanjiReadings, kanwa), null, expression);
  }
  const tied = createKanwaReadings({ readings: {}, compounds: { 部屋: "へ|や へや" } }, kanjiReadings);
  assert.equal(kanjiFurigana("部屋", "へや", kanjiReadings, tied), null);
  // Two ways to the same split are one split: 甲乙 and 乙丙 read as many
  // characters, and both give 甲(こう)乙(おつ)丙(へい).
  const overlapping = createKanwaReadings({ readings: { 甲: "こう", 丙: "へい" },
    compounds: { 甲乙: "こう|おつ", 乙丙: "おつ|へい" } }, kanjiReadings);
  assert.deepEqual(pairs(kanjiFurigana("甲乙丙", "こうおつへい", kanjiReadings, overlapping)),
    [["甲", "こう"], ["乙", "おつ"], ["丙", "へい"]]);
});

test("the shipped kanwa table matches its source record, adds only readings KANJIDIC lacks, and splits 日本 and ２人", () => {
  const read = path => readFileSync(new URL(`../extension/vendor/${path}`, import.meta.url));
  const sha256 = data => createHash("sha256").update(data).digest("hex");
  const [kanjidic, table] = [read("kanjidic/kanji-readings.json"), read("kanwa/kanwa-readings.json")];
  const { files } = JSON.parse(read("kanwa/source.json"));
  // scripts/kanwa-readings.mjs made the table against the shipped KANJIDIC table.
  assert.deepEqual(files["kanwa-readings.json"], { sha256: sha256(table), kanjidic: sha256(kanjidic) },
    "run node scripts/kanwa-readings.mjs after the KANJIDIC table changes");
  const kanjiTable = JSON.parse(kanjidic).readings;
  const kanwaTable = JSON.parse(table);
  for (const [character, readings] of Object.entries(kanwaTable.readings)) {
    const known = new Set(kanjiTable[character]?.split(" "));
    assert.ok(readings.split(" ").every(reading => !known.has(reading)), character);
  }
  const kanjiReadings = createKanjiReadings(kanjiTable);
  const kanwa = createKanwaReadings(kanwaTable, kanjiReadings);
  for (const [expression, reading, expected] of [...BY_KANWA.slice(0, 4),
    // 回 keeps KANJIDIC's かい beside kanwa's めぐ.る.
    ["１回", "いっかい", [["１", "いっ"], ["回", "かい"]]],
    // 輪回 starts like the compound 輪廻 りん|ね but is not it.
    ["輪回", "りんね", null],
    // 々 repeats a character that kanwa gives a reading (予 かね.て).
    ["予々", "かねがね", [["予", "かね"], ["々", "がね"]]],
    // The second Ｐ reads at another place in the reading than the first.
    ["ＰＩＰ", "ピーアイピー", [["Ｐ", "ピー"], ["Ｉ", "アイ"], ["Ｐ", "ピー"]]]]) {
    assert.deepEqual(pairs(kanjiFurigana(expression, reading, kanjiReadings, kanwa)), expected, expression);
  }
});

test("the shipped KANJIDIC table matches its source record and splits 好き嫌い, お願い致します and 二十四時間", () => {
  const table = readFileSync(new URL("../extension/vendor/kanjidic/kanji-readings.json", import.meta.url));
  const source = JSON.parse(readFileSync(new URL("../extension/vendor/kanjidic/source.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(table).digest("hex"), source.files["kanji-readings.json"].sha256);
  const kanjiReadings = createKanjiReadings(JSON.parse(table).readings);
  for (const [expression, reading, expected] of SPLITS.slice(0, 2)) {
    assert.deepEqual(pairs(distributeFurigana(expression, reading, kanjiReadings)), expected, expression);
  }
  const [expression, reading, expected] = PER_KANJI[0];
  assert.deepEqual(pairs(kanjiFurigana(expression, reading, kanjiReadings)), expected);
});

test("the engine adds term.furigana only where the kanji readings change the split, and counts it in the reply", async () => {
  const { withFurigana } = await import("../extension/engine-service.js");
  const term = (expression, reading) => ({ matched: expression, term: { expression, reading, glossaries: [] } });
  const kikitori = term("聞き取り", "ききとり");
  const reply = await withFurigana({ results: [term("好き嫌い", "すききらい"), kikitori,
    term("二十四時間", "にじゅうよじかん"), term("日本", "にほん")], dictionaryCount: 1, nativeJsonLength: 100 });
  const perKanji = reply.results[2].term.furigana;
  // The shipped kanwa table reads 日本 (#641).
  const nihon = reply.results[3].term.furigana;
  assert.deepEqual(reply.results[0].term.furigana, SUKIKIRAI);
  assert.deepEqual(reply.results[1], term("聞き取り", "ききとり"));
  assert.deepEqual(pairs(perKanji), PER_KANJI[0][2]);
  assert.deepEqual(pairs(nihon), BY_KANWA[0][2]);
  assert.equal(reply.nativeJsonLength, 100 + `,"furigana":${JSON.stringify(SUKIKIRAI)}`.length
    + `,"furigana":${JSON.stringify(perKanji)}`.length + `,"furigana":${JSON.stringify(nihon)}`.length);
  const settled = { results: [kikitori], dictionaryCount: 1, nativeJsonLength: 100 };
  assert.equal(await withFurigana(settled), settled);
});

test("the popup headword draws the engine's split as ruby, the same with its pitch drawn on the reading after it", t => {
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
  const ruby = "<ruby><button>好</button><rt>す</rt></ruby>き<ruby><button>嫌</button><rt>きら</rt></ruby>い";
  assert.equal(markup(render(SUKIKIRAI)), ruby);
  // A split that does not spell the headword, from a stale or linked term, is not drawn.
  for (const furigana of [[{ text: "好き", reading: "すき" }], [{ text: "好き嫌い", reading: 1 }], "好(す)き"]) {
    assert.equal(markup(render(furigana)), "<ruby><button>好</button>き<button>嫌</button>い<rt>すききらい</rt></ruby>",
      JSON.stringify(furigana));
  }
  // #606: drawing the pitch leaves the furigana as it is without it, so き and
  // い are not read again, and draws すき＼きらい on the reading after the word.
  const pitched = render(SUKIKIRAI, { showPitchAccentFurigana: true });
  const reading = pitched.lastElementChild;
  assert.ok(reading.matches("span.gsm-hoshidicts-pitch-reading.gsm-hoshidicts-pitch-contour"), reading.outerHTML);
  assert.equal(markup(pitched).replace(reading.outerHTML, ""), ruby);
  assert.deepEqual([...reading.children].map(mora => [mora.className, mora.textContent, mora.dataset.pitchLevel,
    mora.dataset.pitchTransition]), [["gsm-hoshidicts-pitch-mora", "す", "low", "rise"],
    ["gsm-hoshidicts-pitch-mora", "き", "high", "drop"], ["gsm-hoshidicts-pitch-mora", "き", "low", undefined],
    ["gsm-hoshidicts-pitch-mora", "ら", "low", undefined], ["gsm-hoshidicts-pitch-mora", "い", "low", undefined]]);
  assert.deepEqual([reading.dataset.pitchPosition, reading.dataset.pitchDictionary, reading.title],
    ["2", "NHK", "NHK · Pitch accent 2"]);
  assert.deepEqual([...popup.querySelectorAll(".pronunciation-group")].map(group => group.dataset.dictionary), ["NHK"]);
  // The Overline style draws the same reading with the pitch list's Yomitan
  // text, and the headword keeps the pitch group of its reading's accent.
  const overline = render(SUKIKIRAI, { showPitchAccentFurigana: true, pitchAccentFuriganaStyle: "overline" });
  const overlineReading = overline.lastElementChild;
  assert.equal(markup(overline).replace(overlineReading.outerHTML, ""), ruby);
  assert.deepEqual([overlineReading.className, overlineReading.dataset.pitchStyle,
    [...overlineReading.children].map(mora => `${mora.className}:${mora.textContent}`).join(" ")],
  ["gsm-hoshidicts-pitch-reading gsm-hoshidicts-pitch-contour", "overline",
    "pronunciation-mora:す pronunciation-mora:き pronunciation-mora:き pronunciation-mora:ら pronunciation-mora:い"]);
  assert.equal(overline.dataset.pitchCategory, "nakadaka");
});
