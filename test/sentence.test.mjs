import assert from "node:assert/strict";
import test from "node:test";
import "../extension/sentence.js";
import { buildAnkiFields } from "../extension/anki-values.js";

const { SENTENCE_SCAN_EXTENT, extractSentence } = globalThis.HDSentence;

// [name, text, match, expected sentence, expected offset of the match in it].
// `match` is the matched word; the text contains it once. The comments name
// Yomitan's rule (text-source-generator.js extractSentence) each row pins.
const cases = [
  // Terminators end the sentence and belong to it.
  ["two sentences in one text node", "今日は雨だ。明日は晴れる。", "晴れる", "明日は晴れる。", 3],
  ["ASCII terminators and trimmed spaces", "Hello world. Foo bar! Baz? Qux", "bar", "Foo bar!", 4],
  ["a run of terminators is kept whole", "本当に！？そう。", "本当に", "本当に！？", 0],
  ["an ellipsis run ends the sentence before it", "待って……そして。", "そして", "そして。", 0],
  ["vertical presentation forms terminate too", "雨だ︒晴れる︕", "晴れる", "晴れる︕", 0],
  ["a match at the start", "食べる。雨だ", "食べる", "食べる。", 0],
  ["a match at the end", "雨だ。食べる", "食べる", "食べる", 0],
  ["a match that is the whole text", "食べる", "食べる", "食べる", 0],
  // Quotes and brackets that enclose the match are excluded; a terminator
  // inside them still ends the sentence.
  ["a match inside quotes drops them", "彼は「今日は雨だ。」と言った。", "雨", "今日は雨だ。", 3],
  ["a match inside a quoted line drops the quotes", "「あ、やっぱり……」", "やっぱり", "あ、やっぱり……", 2],
  ["a match inside parentheses", "彼（かれ）は来た。", "かれ", "かれ", 0],
  ["a match inside the inner of nested brackets", "「彼は『行く』と言った。」", "行く", "行く", 0],
  // A pair inside the sentence is kept whole, so a terminator inside a quoted
  // clause does not end the sentence around it.
  ["a quoted clause inside the sentence", "彼は「今日は雨だ。」と言った。明日は晴れる。", "言った", "彼は「今日は雨だ。」と言った。", 11],
  ["a preceding quoted clause is part of the sentence", "「今日は雨だ。」明日は晴れる。", "晴れる", "「今日は雨だ。」明日は晴れる。", 11],
  ["nested brackets inside an enclosing quote", "「彼は『行く』と言った。」", "言った", "彼は『行く』と言った。", 7],
  ["three levels of nesting", "「あ『い（う）え』お」か。", "お", "あ『い（う）え』お", 8],
  ["an unbalanced closer before the match is read as a quoted clause", "雨だ」晴れる", "晴れる", "雨だ」晴れる", 3],
  // Line breaks terminate; spaces do not.
  ["a line break on either side", "一行目\n二行目の食べる\n三行目", "食べる", "二行目の食べる", 4],
  ["spaces are kept inside the sentence", "一行目 二行目の食べる 三行目", "食べる", "一行目 二行目の食べる 三行目", 8],
  ["surrounding whitespace is trimmed", "  食べる。  ", "食べる", "食べる。", 0],
  ["a carriage return is trimmed", "食べる\r\n次", "食べる", "食べる", 0],
];

for (const [name, text, match, sentence, offset] of cases) {
  test(`extractSentence: ${name}`, () => {
    const matchOffset = text.indexOf(match);
    assert.notEqual(matchOffset, -1);
    assert.deepEqual(extractSentence(text, matchOffset, match.length), { sentence, matchOffset: offset });
    assert.equal(sentence.slice(offset, offset + match.length), match);
  });
}

test("extractSentence caps the sentence at the extent when nothing terminates it", () => {
  const text = `${"あ".repeat(500)}食べる${"い".repeat(500)}`;
  assert.equal(SENTENCE_SCAN_EXTENT, 200);
  const capped = extractSentence(text, 500, 3);
  assert.equal(capped.matchOffset, 200);
  assert.equal(capped.sentence, `${"あ".repeat(200)}食べる${"い".repeat(200)}`);
  const narrow = extractSentence(text, 500, 3, 10);
  assert.deepEqual(narrow, { sentence: `${"あ".repeat(10)}食べる${"い".repeat(10)}`, matchOffset: 10 });
  // Room the backward walk does not use goes to the forward walk, as in Yomitan.
  const early = extractSentence(text.slice(495), 5, 3, 10);
  assert.deepEqual(early, { sentence: `${"あ".repeat(5)}食べる${"い".repeat(15)}`, matchOffset: 5 });
});

test("extractSentence never splits a surrogate pair at the extent window", () => {
  assert.deepEqual(extractSentence("𠮷野家で食べる。", 5, 3, 4), { sentence: "野家で食べる。", matchOffset: 3 });
  assert.deepEqual(extractSentence("あ食べる𠮷野", 1, 3, 1), { sentence: "あ食べる", matchOffset: 1 });
  assert.deepEqual(extractSentence("🍵 食べます。", 3, 4), { sentence: "🍵 食べます。", matchOffset: 3 });
});

test("extractSentence does not scan inside the match", () => {
  // The dotted abbreviation is the matched word, so its dots are not terminators.
  assert.deepEqual(extractSentence("The U.S.A. is big. Yes.", 4, 6), { sentence: "The U.S.A. is big.", matchOffset: 4 });
  assert.deepEqual(extractSentence("The U.S.A. is big. Yes.", 4, 1), { sentence: "The U.", matchOffset: 4 });
});

test("extractSentence offsets compose with the Anki sentence field", async () => {
  const text = "「今日は雨だ。」明日は晴れる。天気予報を見た。";
  const matched = "晴れる";
  const { sentence, matchOffset } = extractSentence(text, text.indexOf(matched), matched.length);
  const fields = await buildAnkiFields({
    term: { expression: "晴れる", reading: "はれる", rules: "v1", glossaries: [], frequencies: [], pitches: [] },
    trace: [], sentence, matchOffset, matched, popupSelectionText: "", searchQuery: matched, documentTitle: "",
    dictionaryAliases: {}, dictionaryIds: {}, frequencyDictionaries: [],
  }, { Sentence: { value: "{sentence}", overwriteMode: "overwrite" } }, {
    definition: () => { throw new Error("Unexpected rich glossary work"); },
  });
  assert.equal(fields.Sentence, "「今日は雨だ。」明日は<b>晴れる</b>。");
});
