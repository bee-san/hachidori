// The searched text's cursor (docs/search-history.md): Rubi's overlay cursor
// (bee-san/Rubi_for_vita@6b5e276 core/text_rows.c, used by shell/overlay.cpp
// input_overlay), ported to the search page's text. Left/Right go in reading
// order across the rows, Right over the word the last lookup matched
// (vjo_word_step) and Left back over up to 16 of those Rights, and stop at the
// text's first and last characters, except that a text on one row goes round
// its ends (vjo_text_row_step). Up/Down go to the displayed row above or below,
// soft-wrapped rows included, keeping the column (vjo_text_row_vertical).
// Offsets are UTF-16 indexes into the text, where Rubi's are UTF-8 bytes; the
// rows are the browser's own layout (textRows), so nothing is estimated.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a move did (VJO_ROW_*): no layout to decide by, nowhere to go, moved,
// or went round a one-row text's end.
export const ROW_UNAVAILABLE = -1;
export const ROW_STAY = 0;
export const ROW_MOVED = 1;
export const ROW_WRAPPED = 2;
// How many Rights a Left retraces (VjoWordNavigation.previous).
export const WORD_HISTORY = 16;

// Rubi's japanese_letters (core/utf.c): Han, Hiragana and Katakana letters
// and letter numbers, and the combining sound marks. Punctuation is never a stop.
const JAPANESE_LETTER = /^(?:(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])[\p{L}\p{Nl}]|[\u3099\u309a])$/u;

// Whether the cursor can rest on `codePoint` (vjo_text_selectable): a
// Japanese letter with `japaneseOnly`, otherwise any visible character;
// spaces (U+3000 too), line breaks and controls never.
export function selectable(codePoint, japaneseOnly) {
  if (japaneseOnly) return JAPANESE_LETTER.test(String.fromCodePoint(codePoint));
  return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f) && codePoint !== 0x3000;
}

// Each rendered character of `text` in reading order: its offset, the offset
// after it and its code point. A CR is not rendered.
function* characters(text) {
  for (let at = 0; at < text.length;) {
    const codePoint = text.codePointAt(at);
    const end = at + (codePoint > 0xffff ? 2 : 1);
    if (codePoint !== 0x0d) yield { at, end, codePoint };
    at = end;
  }
}

const stay = to => ({ result: ROW_STAY, to });

// The first character the cursor can rest on at or after `from`, or null.
export function firstSelectable(text, from, japaneseOnly) {
  for (const { at, codePoint } of characters(text)) if (at >= from && selectable(codePoint, japaneseOnly)) return at;
  return null;
}

// Left/Right in reading order (vjo_text_row_step). direction > 0: the first
// stop at or after `from` (past the cursor: the next character, or the end of
// the matched word); direction < 0: the last stop before the cursor. Past the
// text's last (first) stop the cursor stays, except that with `wrap` a text
// whose stops are all on one row goes round to its first (last). Only that end
// asks the layout, for the rows of the first and last stops; without one
// (`rows` null), the line breaks stand for the rows. Returns { result, to }.
export function rowStep(text, rows, cursor, from, direction, japaneseOnly, wrap) {
  if (cursor >= text.length || !direction) return stay(cursor);
  let first = null;
  let last = null;
  let to = null;
  let broken = false;
  let split = false;
  for (const { at, codePoint } of characters(text)) {
    if (codePoint === 0x0a) {
      broken = first !== null; // a line break after the first stop
      continue;
    }
    if (!selectable(codePoint, japaneseOnly)) continue;
    if ((direction > 0 && at >= from) || (direction < 0 && at >= cursor && to !== null)) {
      if (direction > 0) to = at;
      break;
    }
    if (direction < 0 && at < cursor) to = at;
    first ??= at;
    split ||= broken; // a line break between the first stop and this one
    last = at;
  }
  let result = ROW_MOVED;
  if (to === null) {
    if (!wrap || first === null || (direction > 0 ? first : last) === cursor) return stay(cursor);
    const firstCell = rows?.cell(first);
    const lastCell = rows?.cell(last);
    if (firstCell && lastCell) {
      if (firstCell.line !== lastCell.line) return stay(cursor);
      result = ROW_WRAPPED;
    } else {
      result = ROW_UNAVAILABLE;
      if (split) return { result, to: cursor };
    }
    to = direction > 0 ? first : last;
  }
  return to === cursor ? stay(cursor) : { result, to };
}

// Up (direction < 0) or Down (vjo_text_row_vertical): the nearest row above or
// below with a stop, and on it the stop whose cell is nearest the column (in
// it, else its nearest edge; the earlier on a tie). `goal` ({ x, at }) keeps
// the column while the cursor stays where Up/Down left it (at is 1 + that
// offset), so repeated moves keep it across a short row; otherwise the column
// is the middle of the cursor's cell.
export function rowVertical(text, rows, cursor, direction, japaneseOnly, goal) {
  if (cursor >= text.length || !direction) return stay(cursor);
  const here = rows?.cell(cursor);
  if (!here) return { result: ROW_UNAVAILABLE, to: cursor };
  const column = goal.at === cursor + 1 ? goal.x : (here.x + here.end) / 2;
  let best = null;
  let bestLine = 0;
  let bestDistance = 0;
  // In reading order: the rows above end at the cursor's row, the row below
  // at the next one after it. A nearer row starts the choice again.
  for (const { at, codePoint } of characters(text)) {
    if (!selectable(codePoint, japaneseOnly)) continue;
    const cell = rows.cell(at);
    if (!cell) return { result: ROW_UNAVAILABLE, to: cursor };
    if (direction < 0 ? cell.line >= here.line : best !== null && cell.line > bestLine) break;
    if (direction < 0 || cell.line > here.line) {
      const distance = Math.max(cell.x - column, column - cell.end, 0);
      if (best === null || cell.line > bestLine || distance < bestDistance) {
        best = at;
        bestLine = cell.line;
        bestDistance = distance;
      }
    }
  }
  if (best === null) return stay(cursor);
  goal.x = column;
  goal.at = best + 1;
  return { result: ROW_MOVED, to: best };
}

// Whether `at` starts a character rather than splitting a surrogate pair.
const boundary = (text, at) => at === text.length
  || !((text.charCodeAt(at) & 0xfc00) === 0xdc00 && (text.charCodeAt(at - 1) & 0xfc00) === 0xd800);

// Left/Right by word (vjo_word_step). Right goes past the matched word
// [cursor, matchedEnd), wherever it ends, and remembers where it started; Left
// goes back to the last of those, else one stop back, and forgets them. A
// pending or failed lookup passes matchedEnd 0: one character.
export function wordStep(navigation, text, cursor, matchedEnd, direction, japaneseOnly, rows, wrap) {
  const { words } = navigation;
  if (cursor >= text.length || !direction) return stay(cursor);
  if (direction < 0 && words.length > 0 && words.at(-1) !== cursor && words.at(-1) < text.length) {
    return { result: ROW_MOVED, to: words.pop() };
  }
  const from = direction > 0 && matchedEnd > cursor && matchedEnd <= text.length && boundary(text, matchedEnd)
    ? matchedEnd : cursor + 1;
  const step = rowStep(text, rows, cursor, from, direction, japaneseOnly, wrap);
  if (step.to !== cursor && direction < 0) words.length = 0;
  else if (step.to !== cursor) {
    if (words.length === WORD_HISTORY) words.shift();
    words.push(cursor);
  }
  return step;
}

// One navigation per shown text: Right's history and Up/Down's column.
export const createNavigation = () => ({ words: [], goal: { x: 0, at: 0 } });

// The arrow keys over the text (vjo_text_row_key): Left/Right (dx) by word,
// which drops Up/Down's column, else Up/Down (dy) by row, which forgets
// Right's history, so Left then retraces only the Rights made since.
export function rowKey(navigation, text, rows, cursor, matchedEnd, dx, dy, japaneseOnly) {
  if (dx) {
    navigation.goal.at = 0;
    return wordStep(navigation, text, cursor, matchedEnd, dx, japaneseOnly, rows, true);
  }
  const step = rowVertical(text, rows, cursor, dy, japaneseOnly, navigation.goal);
  if (step.result > 0) navigation.words.length = 0;
  return step;
}

// The layout of a rendered text node, as Rubi's renderer reports it: each
// character's cell, from the left of its glyph to its right, and its row,
// counted from the top as the browser broke them. Null while it is not laid
// out (hidden, or detached).
export function textRows(node) {
  const range = node.ownerDocument.createRange();
  const cells = new Map();
  let row = null;
  let line = -1;
  for (const { at, end, codePoint } of characters(node.data)) {
    if (codePoint === 0x0a) continue;
    range.setStart(node, at);
    range.setEnd(node, end);
    const rect = range.getClientRects()[0];
    if (!rect) continue;
    // A glyph from another font sits a little higher or lower on its row.
    if (row === null || rect.top >= row.top + row.height / 2) {
      row = rect;
      line += 1;
    }
    cells.set(at, { x: rect.left, end: rect.right, line });
  }
  return line < 0 ? null : { cell: at => cells.get(at) ?? null };
}
