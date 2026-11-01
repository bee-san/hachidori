// Fixtures for the language-aware theme contract (docs/languages.md 11.7),
// shared by test/theme-languages.test.mjs (jsdom) and
// test/chrome-theme-languages.mjs (real Chrome). Results are shaped like
// `hdw_lookup` replies: the reading equals the expression where a language
// has none, and dictionaries declare `targetLanguage` as real ones do.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";

// Pack descriptors as the generated registry carries them (engine contract
// section 4, class references expanded). The registry replaces them once
// hachi-lang-core vendors the real packs (extension/vendor/languages/).
export const PACKS = Object.fromEntries(["ja", "en", "ar", "ko", "zh"].map(code =>
  [code, JSON.parse(readFileSync(new URL(`./data/theme-languages/${code}.json`, import.meta.url), "utf8"))]));

export const THEMES = ["default", "nazeka", "plain", "jl", "bee", "crystal"];
// Crystal's colour variants; the others have none.
export const VARIANTS = { crystal: ["grey", "beige", "blue"] };
export const TEXT_THEMES = new Set(["nazeka", "plain", "jl"]);
// The element that holds one dictionary's block in each theme (10.2).
export const BLOCKS = {
  default: ".gsm-hoshidicts-glossary-card",
  jl: ".jl-entry > .gsm-hoshidicts-definitions",
  bee: ".bee-rich-content",
  crystal: ".crystal-senses",
  nazeka: ".nazeka-sense",
  plain: ".gsm-hoshidicts-definitions > [data-hoshidicts-dictionary]",
};

const sc = content => JSON.stringify([{ type: "structured-content", content }]);
const strings = (...items) => JSON.stringify(items);
const row = (dictionary, glossary, definitionTags = "") => ({ dictionary, glossary, definitionTags, termTags: "",
  tags: definitionTags.split(" ").filter(Boolean).map((name, order) => ({ name, category: "partOfSpeech", order, score: 0, notes: "" })) });
const term = ({ expression, reading = expression, matched = expression, trace = [], glossaries, frequencies = [], rules = "" }) => ({
  matched, deinflected: expression, trace: trace.map(name => ({ name, description: "" })), preprocessorSteps: 0,
  term: { expression, reading, rules, score: 0, glossaries, frequencies, pitches: [] },
});
const frequency = (dictionary, value) => ({ dictionary, frequencies: [{ value, displayValue: String(value) }] });

// Each scenario: the profile's pack and settings, the page, the dictionaries
// with their target languages, a term reply, an optional character reply,
// and the language 10.3 gives each fixture string. `richOnly` strings share
// a text-mode line with a tag of another script, a stated text-mode limit
// (11.2), so the per-line check skips them in text-mode themes.
export const SCENARIOS = {
  ja: {
    profile: "ja", page: { lang: "ja", dir: "ltr" }, packSettings: {},
    dictionaries: [
      { title: "Jitendex.org [2026-08-11]", targetLanguage: "en" },
      { title: "研究社 新和英大辞典 第5版", targetLanguage: "en" },
      { title: "大辞林 第四版", targetLanguage: "ja" },
      { title: "JPDB", targetLanguage: null },
    ],
    results: [term({ expression: "食べる", reading: "たべる", matched: "食べたかった", trace: ["-たい", "-た"], rules: "v1",
      frequencies: [frequency("JPDB", 1500)],
      glossaries: [
        row("Jitendex.org [2026-08-11]", sc([{ tag: "ol", content: [{ tag: "li", content: "to eat" },
          { tag: "li", content: "to live on (e.g. a salary)" }] },
        { tag: "div", data: { content: "example-sentence" }, content: [{ tag: "div", content: "朝ごはんを食べる。" },
          { tag: "div", content: "I eat breakfast." }] },
        { tag: "div", content: "See also 食う" }]), "v1 vt"),
        row("研究社 新和英大辞典 第5版", strings("to have (a meal)"), "他動"),
        row("大辞林 第四版", strings("食物を口に入れて飲み込む。"), "動下一"),
      ] })],
    kanji: { character: "食", frequencies: [], entries: [
      { dictionary: "KANJIDIC", onyomi: "ショク ジキ", kunyomi: "く.う た.べる", tags: "jouyou",
        definitions: ["eat", "food"], stats: [{ name: "grade", value: "2" }] },
      { dictionary: "漢字源", onyomi: "ショク", kunyomi: "くう", tags: "", definitions: ["くう。たべる。"], stats: [] },
    ] },
    expected: [["to eat", "en"], ["to live on (e.g. a salary)", "en"], ["朝ごはんを食べる。", "ja"], ["I eat breakfast.", "en"],
      ["See also 食う", "ja"], ["to have (a meal)", "en", "richOnly"], ["食物を口に入れて飲み込む。", "ja"]],
  },
  en: {
    profile: "en", page: { lang: "en", dir: "ltr" }, packSettings: {},
    dictionaries: [
      { title: "Kaikki English", targetLanguage: "en" },
      { title: "English-Arabic Wiktionary", targetLanguage: "ar" },
      { title: "English-Persian Glossary", targetLanguage: "fa" },
      { title: "Old Glossary", targetLanguage: null },
      { title: "Word Frequency", targetLanguage: null },
    ],
    results: [term({ expression: "run", matched: "running", trace: ["-ing"], rules: "v",
      frequencies: [frequency("Word Frequency", 210)],
      glossaries: [
        row("Kaikki English", strings("to move swiftly on foot"), "v"),
        row("English-Arabic Wiktionary", sc([{ tag: "div", content: "يَجْرِي" }, { tag: "div", content: "I run every morning." }])),
        row("English-Persian Glossary", strings("دویدن")),
        row("English-Persian Glossary", strings("I run fast.")),
        row("Old Glossary", strings("to run (archaic)")),
      ] })],
    kanji: null,
    expected: [["to move swiftly on foot", "en"], ["يَجْرِي", "ar"], ["I run every morning.", "en"], ["دویدن", "fa"],
      ["I run fast.", "en"], ["to run (archaic)", "en"]],
    rtlDictionaries: ["English-Arabic Wiktionary", "English-Persian Glossary"],
  },
  ar: {
    profile: "ar", page: { lang: "ar", dir: "rtl" }, packSettings: {},
    dictionaries: [
      { title: "المعجم الوسيط", targetLanguage: "ar" },
      { title: "Kaikki Arabic-English", targetLanguage: "en" },
      { title: "Hans Wehr (converted)", targetLanguage: null },
      { title: "تردد الكلمات", targetLanguage: null },
      { title: "Arabic Frequency", targetLanguage: null },
    ],
    results: [term({ expression: "كِتَاب", matched: "والكتاب", trace: ["and", "the"], rules: "n",
      frequencies: [frequency("تردد الكلمات", 95), frequency("Arabic Frequency", 312)],
      glossaries: [
        row("المعجم الوسيط", sc([{ tag: "ol", content: [{ tag: "li", content: "صحائف مجموعة مكتوبة." },
          { tag: "li", content: "الرسالة المكتوبة إلى شخص." }] }]), "n"),
        row("المعجم الوسيط", sc([{ tag: "div", content: "n. صحائف مجموعة مكتوبة." },
          { tag: "div", content: "From Aramaic ktāḇā (writing)." }])),
        row("المعجم الوسيط", sc([{ tag: "ul", content: [{ tag: "li", content: "كتاب مقدس" },
          { tag: "li", content: "Bible (Christianity)" }] }])),
        row("Kaikki Arabic-English", strings("book", "letter, note"), "noun"),
        row("Kaikki Arabic-English", sc([{ tag: "div", data: { content: "example-sentence" }, content: [
          { tag: "div", content: "قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ." }, { tag: "div", content: "I read it all." }] }])),
        row("Kaikki Arabic-English", sc([{ tag: "div", content: "كِتَاب kitāb pl. كُتُب kutub writing; letter, note; book." }])),
        row("Kaikki Arabic-English", sc([{ tag: "ul", content: [{ tag: "li", content: ["أهلُ الكتابِ",
          { tag: "ul", content: [{ tag: "li", content: "the people of the Book." }] }] }] }])),
        row("Hans Wehr (converted)", strings("writing; letter, note")),
      ] })],
    kanji: null,
    expected: [["صحائف مجموعة مكتوبة.", "ar"], ["الرسالة المكتوبة إلى شخص.", "ar"], ["n. صحائف مجموعة مكتوبة.", "ar"],
      // A Latin etymology in a monolingual Arabic dictionary takes its target language (section 21).
      ["From Aramaic ktāḇā (writing).", "ar"], ["كتاب مقدس", "ar"], ["Bible (Christianity)", "ar"], ["book", "en", "richOnly"],
      ["letter, note", "en", "richOnly"], ["قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ.", "ar"], ["I read it all.", "en"],
      ["كِتَاب kitāb pl. كُتُب kutub writing; letter, note; book.", "ar"], ["أهلُ الكتابِ", "ar"],
      ["the people of the Book.", "en"], ["writing; letter, note", "en"]],
    rtlDictionaries: ["المعجم الوسيط"],
    rtlNames: ["المعجم الوسيط", "تردد الكلمات"],
    displaySettings: { vowelMarks: "hide" }, displayedExpression: "كتاب",
  },
  ko: {
    profile: "ko", page: { lang: "ko", dir: "ltr" }, packSettings: { hanjaView: true },
    dictionaries: [
      { title: "Kaikki Korean-English", targetLanguage: "en" },
      { title: "Korean-Chinese", targetLanguage: "zh" },
      { title: "표준국어대사전", targetLanguage: "ko" },
    ],
    results: [
      term({ expression: "학교", matched: "학교에", trace: ["-에"], rules: "noun", glossaries: [
        row("Kaikki Korean-English", strings("school"), "noun"),
        row("Kaikki Korean-English", sc([{ tag: "div", content: "학교(學校): 학생을 가르치는 기관." },
          { tag: "div", content: "「학교」라고도 한다." }, { tag: "div", content: "學校" }])),
        row("Korean-Chinese", strings("學校")),
        row("표준국어대사전", strings("학생을 가르치는 기관.")),
      ] }),
      term({ expression: "學校", reading: "학 교", matched: "學校", glossaries: [row("Kaikki Korean-English", strings("school (hanja)"))] }),
    ],
    kanji: { character: "學", frequencies: [], entries: [
      { dictionary: "Hanja Dictionary", onyomi: "학", kunyomi: "배울", tags: "", definitions: ["learn"], stats: [] },
    ] },
    expected: [["school", "en"], ["학교(學校): 학생을 가르치는 기관.", "ko"], ["「학교」라고도 한다.", "ko"],
      // Han alone: the profile's tag in a Korean-English dictionary, Chinese in a Korean-Chinese one.
      ["學校", "ko"], ["學校", "zh", "second"], ["학생을 가르치는 기관.", "ko"], ["school (hanja)", "en"]],
  },
  zh: {
    profile: "zh", page: { lang: "zh-Hans", dir: "ltr" }, packSettings: {},
    dictionaries: [
      { title: "CC-CEDICT", targetLanguage: "en" },
      { title: "现代汉语词典", targetLanguage: "zh" },
      { title: "Chinese-Japanese", targetLanguage: "ja" },
      { title: "Chinese-Korean", targetLanguage: "ko" },
    ],
    results: [term({ expression: "学校", reading: "xué xiào", glossaries: [
      row("CC-CEDICT", strings("school")),
      row("CC-CEDICT", strings("CL:所[suo3]")),
      row("CC-CEDICT", strings("variant of 學校|学校[xue2 xiao4]")),
      row("现代汉语词典", strings("学校，教育机构。")),
      row("Chinese-Japanese", strings("学校へ行きます。")),
      row("Chinese-Korean", strings("학교")),
    ] })],
    kanji: { character: "学", frequencies: [], entries: [
      { dictionary: "Unihan", onyomi: "xué", kunyomi: "", tags: "", definitions: ["learn", "study"], stats: [] },
    ] },
    expected: [["school", "en"], ["CL:所[suo3]", "zh-Hans"], ["variant of 學校|学校[xue2 xiao4]", "zh-Hans"],
      ["学校，教育机构。", "zh-Hans"], ["学校へ行きます。", "ja"], ["학교", "ko"]],
    displaySettings: { readings: "zhuyin" }, displayedReading: "ㄒㄩㄝˊ ㄒㄧㄠˋ",
  },
};

// The Japanese labels and character-view strings that must not appear in
// another language (11.7), derived from the Japanese pack.
export function forbiddenLabels(japanese = PACKS.ja) {
  const view = japanese.capabilities.characterView;
  const labels = japanese.presentation.labels;
  return [view.readingLabels.onyomi, view.readingLabels.kunyomi, view.readingSeparator, labels.listSeparator,
    labels.traceMarker, ...labels.readingBrackets, `Look up ${view.name.toLowerCase()}`].filter(Boolean);
}

// The profile's non-Latin script characters, for the :lang(en) check.
export const NATIVE_TEXT = {
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  en: null,
  ar: /\p{Script=Arabic}/u,
  ko: /[\p{Script=Hangul}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
};
