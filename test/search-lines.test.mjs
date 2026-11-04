// SPDX-License-Identifier: GPL-3.0-or-later
// The searched text's cursor (extension/search-lines.js), the port of Rubi's
// core/text_rows.c, on cases from Rubi's host/tests/test_text_rows.c with its
// offsets in UTF-16 units: rows of ten 24 px cells in a 240 px box, with soft
// wraps, hard line breaks and 12 px Latin cells.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createNavigation, firstSelectable, ROW_MOVED, ROW_STAY, ROW_UNAVAILABLE, ROW_WRAPPED, rowKey, rowStep, rowVertical,
  selectable, WORD_HISTORY, wordStep,
} from "../extension/search-lines.js";

// Rubi's layout double: a line break starts a row, and so does a cell that
// would cross the box's right edge.
function layout(text, width = 240) {
  const cells = new Map();
  let x = 0;
  let line = 0;
  for (let at = 0; at < text.length;) {
    const codePoint = text.codePointAt(at);
    const length = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x0a) {
      x = 0;
      line += 1;
    } else if (codePoint !== 0x0d) {
      const advance = codePoint >= 0x2e80 ? 24 : 12;
      if (x > 0 && x + advance > width) {
        x = 0;
        line += 1;
      }
      cells.set(at, { x, end: x + advance, line });
      x += advance;
    }
    at += length;
  }
  return { cell: at => cells.get(at) ?? null };
}

// A line as search.js gives one: its text, its layout and the Japanese-only switch.
const laidOut = (text, rows = layout(text), japaneseOnly = true) => ({ text, rows, japaneseOnly });
const step = (text, cursor, direction, japaneseOnly = true, wrap = true, rows = layout(text)) =>
  rowStep(laidOut(text, rows, japaneseOnly), cursor, cursor + 1, direction, wrap);
const vertical = (text, cursor, direction, japaneseOnly = true, goal = { x: 0, at: 0 }) =>
  rowVertical(laidOut(text, layout(text), japaneseOnly), cursor, direction, goal);

test("Up and Down go to the row above or below, soft wraps included, and keep the column across a short row", () => {
  // 14 kana: a soft wrap after the tenth.
  const wrapped = "あいうえおかきくけこさしすせ";
  assert.deepEqual(vertical(wrapped, 2, 1), { result: ROW_MOVED, to: 12 }); // う (column 2) -> す
  assert.deepEqual(vertical(wrapped, 12, -1), { result: ROW_MOVED, to: 2 });
  assert.deepEqual(vertical(wrapped, 9, 1), { result: ROW_MOVED, to: 13 }); // こ -> せ, the short row's last
  assert.deepEqual(vertical(wrapped, 13, -1), { result: ROW_MOVED, to: 3 }); // せ's own column: え
  assert.deepEqual(vertical(wrapped, 0, -1), { result: ROW_STAY, to: 0 }); // no row above
  assert.deepEqual(vertical(wrapped, 13, 1), { result: ROW_STAY, to: 13 }); // none below

  // Hard breaks: ten kana, two, ten. け is column 8 (192..216).
  const short = "あいうえおかきくけこ\nさし\nたちつてとなにぬねの";
  const goal = { x: 0, at: 0 };
  assert.deepEqual(vertical(short, 8, 1, true, goal), { result: ROW_MOVED, to: 12 }); // し, the short row's last
  assert.deepEqual(goal, { x: 204, at: 13 });
  assert.deepEqual(vertical(short, 12, 1, true, goal), { result: ROW_MOVED, to: 22 }); // ね: the column, not し's
  assert.deepEqual(vertical(short, 22, -1, true, goal), { result: ROW_MOVED, to: 12 });
  assert.deepEqual(vertical(short, 12, -1, true, goal), { result: ROW_MOVED, to: 8 });
  // Another cursor, or a column kept for another one: the cell's own middle.
  assert.deepEqual(vertical(short, 12, 1), { result: ROW_MOVED, to: 15 }); // し's middle 36: ち
  assert.deepEqual(vertical(short, 12, 1, true, { x: 204, at: 1 }), { result: ROW_MOVED, to: 15 });
});

test("Left and Right go across rows in reading order and stop at the ends of a text on several rows", () => {
  const wrapped = "あいうえおかきくけこさしすせ";
  assert.deepEqual(step(wrapped, 9, 1), { result: ROW_MOVED, to: 10 }); // a row's last -> the next row's first
  assert.deepEqual(step(wrapped, 10, -1), { result: ROW_MOVED, to: 9 });
  assert.deepEqual(step(wrapped, 0, -1), { result: ROW_STAY, to: 0 });
  assert.deepEqual(step(wrapped, 13, 1), { result: ROW_STAY, to: 13 });
  // One row goes round its ends, for a fresh press (wrap), not without it.
  const row = "猫が好きです。";
  assert.deepEqual(step(row, 5, 1), { result: ROW_WRAPPED, to: 0 });
  assert.deepEqual(step(row, 0, -1), { result: ROW_WRAPPED, to: 5 });
  assert.deepEqual(step(row, 5, 1, true, false), { result: ROW_STAY, to: 5 });
  // Without a layout the line breaks stand for the rows.
  assert.deepEqual(step(row, 5, 1, true, true, null), { result: ROW_UNAVAILABLE, to: 0 });
  assert.deepEqual(step("ねこ\nいぬ", 3, 1, true, true, null), { result: ROW_MOVED, to: 4 });
  assert.deepEqual(step("ねこ\nいぬ", 4, 1, true, true, null), { result: ROW_UNAVAILABLE, to: 4 });

  // Japanese only: the Latin cells and the punctuation hold no cursor.
  const mixed = "ABCDEFGHIJ猫犬\nあいうえお";
  assert.deepEqual(step(mixed, 11, 1), { result: ROW_MOVED, to: 13 }); // 犬 -> あ, over the line break
  assert.deepEqual(step(mixed, 10, -1), { result: ROW_STAY, to: 10 }); // 猫, the first Japanese letter
  assert.deepEqual(step(mixed, 9, 1, false), { result: ROW_MOVED, to: 10 });
  assert.deepEqual(step(mixed, 0, -1, false), { result: ROW_STAY, to: 0 });
  assert.deepEqual(vertical(mixed, 15, -1, true), { result: ROW_MOVED, to: 10 }); // う -> 猫, the nearest Japanese cell
  assert.deepEqual(vertical(mixed, 15, -1, false), { result: ROW_MOVED, to: 4 }); // う (48..72) -> E (48..60)
  assert.equal(firstSelectable("「４７７８万」", 0, true), 5);
  assert.equal(firstSelectable("「４７７８万」", 0, false), 0);
  assert.deepEqual([0x3000, 0x20, 0x0a, 0x3001, 0x30fb].map(codePoint => selectable(codePoint, false)),
    [false, false, false, true, true]);
  assert.deepEqual([0x30fc, 0x3005, 0x3001, 0x30fb, 0x41, 0x20b9f].map(codePoint => selectable(codePoint, true)),
    [true, true, false, false, false, true]);
});

test("Right goes past the matched word and Left goes back over the Rights, across rows, up to sixteen of them", () => {
  // Row 0: 猫が好きです。犬も好 | row 1: きです。 (好き crosses the wrap).
  const text = "猫が好きです。犬も好きです。";
  const words = [[0, 1], [1, 2], [2, 4], [4, 6], [7, 8], [8, 9], [9, 11], [11, 13]];
  const line = laidOut(text);
  const navigation = createNavigation();
  let cursor = 0;
  for (const [index, [start, end]] of words.entries()) {
    assert.equal(cursor, start);
    const moved = wordStep(navigation, line, cursor, end, 1, true);
    assert.equal(moved.result, index + 1 < words.length ? ROW_MOVED : ROW_STAY);
    cursor = moved.to;
  }
  // The last word: its match runs to the end, and 。 holds no cursor.
  assert.equal(cursor, 11);
  assert.equal(navigation.words.length, 7);
  for (let index = words.length - 1; index-- > 0;) {
    const moved = wordStep(navigation, line, cursor, 0, -1, true);
    assert.deepEqual(moved, { result: ROW_MOVED, to: words[index][0] });
    cursor = moved.to;
  }
  assert.equal(navigation.words.length, 0);
  assert.deepEqual(wordStep(navigation, line, 0, 0, -1, true), { result: ROW_STAY, to: 0 });
  // A pending or failed lookup, or a match ending inside a character: one character.
  assert.deepEqual(wordStep(navigation, line, 2, 0, 1, true).to, 3);
  assert.deepEqual(wordStep(navigation, laidOut("𠮟る𠮟る", null), 0, 1, 1, true).to, 2);
  assert.deepEqual(wordStep(navigation, laidOut("猫𠮟る", null), 0, 2, 1, true).to, 1); // 2 splits 𠮟: one character
  assert.deepEqual(wordStep(navigation, line, 2, text.length + 1, 1, true).to, 3);
  // Left from where a Right started forgets that Right and steps back.
  const left = { words: [0, 2], goal: { x: 0, at: 0 } };
  assert.deepEqual(wordStep(left, laidOut("あいうえお"), 2, 0, -1, true), { result: ROW_MOVED, to: 1 });
  assert.deepEqual(left.words, []);
  // Only the newest sixteen Rights are kept.
  const long = laidOut("あ".repeat(40), layout("あ".repeat(40), 2400));
  const kept = createNavigation();
  for (let at = 0; at < 20; at += 1) wordStep(kept, long, at, 0, 1, true);
  assert.equal(kept.words.length, WORD_HISTORY);
  assert.deepEqual(kept.words, Array.from({ length: WORD_HISTORY }, (_, index) => index + 4));
});

test("the arrow keys: Up and Down forget Right's history, and Left and Right take Up and Down's column afresh", () => {
  const text = "猫が好きです。犬も好きです。";
  const line = laidOut(text);
  const navigation = createNavigation();
  assert.deepEqual(rowKey(navigation, line, 0, 1, 1, 0), { result: ROW_MOVED, to: 1 });
  assert.deepEqual(rowKey(navigation, line, 1, 2, 1, 0), { result: ROW_MOVED, to: 2 });
  assert.equal(navigation.words.length, 2);
  assert.deepEqual(rowKey(navigation, line, 2, 4, 0, 1), { result: ROW_MOVED, to: 12 }); // 好 -> す
  assert.equal(navigation.words.length, 0);
  assert.deepEqual(rowKey(navigation, line, 12, 0, 0, 1), { result: ROW_STAY, to: 12 }); // no row below
  assert.deepEqual(rowKey(navigation, laidOut(text, null), 12, 0, 0, -1), { result: ROW_UNAVAILABLE, to: 12 });
  // け Down to し keeps 204; Right goes on to た, Left comes back to し; Down
  // then goes by し's own middle (36) to ち, not ね.
  const short = laidOut("あいうえおかきくけこ\nさし\nたちつてとなにぬねの");
  const kept = createNavigation();
  assert.deepEqual(rowKey(kept, short, 8, 0, 0, 1), { result: ROW_MOVED, to: 12 });
  assert.deepEqual(rowKey(kept, short, 12, 0, 1, 0), { result: ROW_MOVED, to: 14 });
  assert.deepEqual(rowKey(kept, short, 14, 0, -1, 0), { result: ROW_MOVED, to: 12 });
  assert.deepEqual(rowKey(kept, short, 12, 0, 0, 1), { result: ROW_MOVED, to: 15 });
});
