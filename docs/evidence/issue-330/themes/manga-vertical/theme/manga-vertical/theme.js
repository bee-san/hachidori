// themes/manga-vertical/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tategaki: the popup is a vertical margin note beside a manga speech bubble.
// theme.css turns the popup into `writing-mode: vertical-rl`; this module does
// what CSS cannot:
//   1. puts furigana on the word *as it appears in the bubble* (食べたかった,
//      not only the dictionary form 食べる) by reusing the renderer's ruby
//      segments, and lists the inflection steps beside it;
//   2. moves the frequency/pitch/grammar capsule into the headword column, the
//      renderer's compact summary to the head of the glosses as a numbered
//      gist, and the audio / note / custom-link buttons into a vertical
//      toolbar strip;
//   3. rewrites the kanji view into a 漢和辞典 colophon: 音/訓 readings with the
//      okurigana marked, 画数・学年・頻度・旧JLPT with kanji numerals and
//      tate-chū-yoko digits, built from the renderer's stats <dl>;
//   4. points the bubble's tail at the hovered word and pops the bubble out of
//      it (from `view.anchor`, a proposed API addition — no anchor, no tail);
//   5. remembers the words looked up on this page and shows the last five in
//      the toolbar strip, with a ×n mark for a word looked up again.
//
// Contract (hachidori-themes CI lint + the reader's host): one default export,
// synchronous hooks, no imports, no globals beyond `view` and `api`, no HTML
// strings, no network, no timers. A hook that throws switches this module off
// for the page and the CSS layer keeps working — nothing below relies on
// throwing. Every step is idempotent: the host runs onRender again after tab
// switches, Show more and Back.

const HISTORY_LIMIT = 5;
const TAIL_SIZE = 18;                 // the rotated square; the visible tail is ~12 px deep
const TAIL_CORNER_CLEARANCE = 26;     // keep the tail off the 16 px rounded corners
const TAIL_CLIPS = {                  // the half of the rotated square that pokes out
  left: "polygon(0 0, 0 100%, 100% 100%)",
  right: "polygon(0 0, 100% 0, 100% 100%)",
  top: "polygon(0 0, 100% 0, 0 100%)",
  bottom: "polygon(100% 0, 100% 100%, 0 100%)",
};
const KANJI_DIGITS = "〇一二三四五六七八九";
const KANJI_READING_LABELS = { On: "音", Kun: "訓" };

// Page memory: [{ expression, reading, count }], most recent first. Lives as
// long as the module, i.e. the page; nothing is stored anywhere.
const history = [];

// ---------------------------------------------------------------------------
// Small helpers

function kanjiNumeral(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(value);
  if (n < 10) return KANJI_DIGITS[n];
  const tens = Math.floor(n / 10), ones = n % 10;
  return `${tens > 1 ? KANJI_DIGITS[tens] : ""}十${ones ? KANJI_DIGITS[ones] : ""}`;
}

// Digits read upright in a vertical line (tate-chū-yoko) when they are short
// enough to share one character cell; longer numbers stay rotated with the
// Latin text around them.
function numberSpan(api, text) {
  return api.el("span", text.length <= 3 ? "mv-tcy" : null, text);
}

// The renderer labels the headword "<expression>, <reading>" (popup.js:3199-3204).
function splitLabel(expression) {
  const label = expression.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { expression: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { expression: label, reading: "" };
}

// The renderer's ruby segments, in order: [{ text, reading }]. A <ruby> per
// kanji run (or per segment when pitch furigana is on); kana between runs is
// plain text or, with pitch furigana, a ruby whose reading equals its base.
function readSegments(expression) {
  const segments = [];
  const push = (text, reading) => {
    const last = segments[segments.length - 1];
    if (!reading && last && !last.reading) last.text += text;
    else if (text) segments.push({ text, reading });
  };
  for (const node of expression.childNodes) {
    if (node.nodeType === 3) { push(node.nodeValue, ""); continue; }
    if (node.tagName !== "RUBY") { push(node.textContent, ""); continue; }
    let base = "", reading = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) base += child.nodeValue;
      else if (child.tagName === "RT") reading += child.textContent;
      else if (child.tagName !== "RP") base += child.textContent;
    }
    push(base, reading === base ? "" : reading);
  }
  return segments;
}

// Furigana for the surface form: each dictionary-form segment that still
// begins the surface form keeps its reading. Conjugation only rewrites the
// trailing kana, so 食(た)べる carries 食(た) over to 食べたかった. The one
// verb whose kanji itself changes reading is 来る (く→き/こ): its 来 stays bare
// when the kana after it changed. Whatever no longer matches is appended as it
// is — whole-word fallback, no invented reading.
function buildSurfaceWord(api, surface, segments) {
  const word = api.el("span", "mv-surface-word");
  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!surface.startsWith(segment.text, index)) break;
    const next = segments[i + 1];
    const tailChanged = next && !surface.startsWith(next.text, index + segment.text.length);
    const irregular = segment.text === "来" && segment.reading === "く" && tailChanged;
    if (segment.reading && !irregular) {
      const ruby = api.el("ruby", null, segment.text);
      api.move(api.el("rt", null, segment.reading), ruby);
      api.move(ruby, word);
    } else {
      api.move(api.el("span", null, segment.text), word);
    }
    index += segment.text.length;
  }
  if (index < surface.length) api.move(api.el("span", "mv-surface-rest", surface.slice(index)), word);
  return word;
}

// The strip sits in the DOM right after the top bar, so Tab reaches the buttons
// before the glosses' links; theme.css gives it `order: 1`, which puts it at
// the block end — the left edge — visually.
function ensureToolbar(view, api) {
  let toolbar = view.popup.querySelector(":scope > .mv-toolbar");
  if (!toolbar) {
    toolbar = api.el("div", "mv-toolbar");
    api.move(toolbar, view.popup, view.content);
  }
  return toolbar;
}

// The primary header's buttons (audio, note, custom links; Back in the kanji
// view) become the vertical toolbar. The node keeps its identity, so the
// reader's bindings, keybinds and the Note form keep working.
function moveActions(header, toolbar, api) {
  const actions = header?.querySelector(":scope > .gsm-hoshidicts-entry-actions");
  if (actions && actions.parentNode !== toolbar) api.move(actions, toolbar, toolbar.firstChild);
}

// ---------------------------------------------------------------------------
// The bubble tail. `view.anchor` (proposed) is the hovered word's box relative
// to the popup, in popup pixels, plus the popup's own size. The tail sits on
// the edge that faces the word, and the pop-in transition grows from it.
function pointTail(view, api) {
  const anchor = view.anchor;
  let side = null, at = 0;
  if (anchor) {
    const { x, y, width, height, boxWidth, boxHeight } = anchor;
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    if (x + width <= 0) { side = "left"; at = clamp(y + height / 2, TAIL_CORNER_CLEARANCE, boxHeight - TAIL_CORNER_CLEARANCE); }
    else if (x >= boxWidth) { side = "right"; at = clamp(y + height / 2, TAIL_CORNER_CLEARANCE, boxHeight - TAIL_CORNER_CLEARANCE); }
    else if (y + height <= 0) { side = "top"; at = clamp(x + width / 2, TAIL_CORNER_CLEARANCE, boxWidth - TAIL_CORNER_CLEARANCE); }
    else if (y >= boxHeight) { side = "bottom"; at = clamp(x + width / 2, TAIL_CORNER_CLEARANCE, boxWidth - TAIL_CORNER_CLEARANCE); }
  }
  if (!side) {
    api.setVariable("--theme-tail-display", "none");
    api.setVariable("--theme-tail-origin", "100% 0");
    return;
  }
  const half = TAIL_SIZE / 2;
  const along = `${Math.round(at)}px`;
  const vertical = side === "left" || side === "right";
  api.setVariable("--theme-tail-display", "block");
  api.setVariable("--theme-tail-clip", TAIL_CLIPS[side]);
  api.setVariable("--theme-tail-x", vertical ? (side === "left" ? `${-half}px` : `calc(100% - ${half}px)`) : `calc(${along} - ${half}px)`);
  api.setVariable("--theme-tail-y", vertical ? `calc(${along} - ${half}px)` : (side === "top" ? `${-half}px` : `calc(100% - ${half}px)`));
  api.setVariable("--theme-tail-origin", vertical ? `${side === "left" ? "0%" : "100%"} ${along}` : `${along} ${side === "top" ? "0%" : "100%"}`);
}

// ---------------------------------------------------------------------------
// Page memory: the last few words looked up on this page, shown at the foot
// of the toolbar strip. Only root popups count as reading; a child popup opened
// from a definition does not. Re-renders of the same word (tabs, Show more,
// Back) are not new lookups.
function rememberAndList(view, api, toolbar, expression) {
  const { expression: text, reading } = splitLabel(expression);
  if (view.depth === 0 && text && history[0]?.expression !== text) {
    const seen = history.findIndex(item => item.expression === text);
    const item = seen >= 0 ? history.splice(seen, 1)[0] : { expression: text, reading, count: 0 };
    item.count += 1;
    history.unshift(item);
  }
  toolbar.querySelector(":scope > .mv-history")?.remove();   // the theme's own node
  const earlier = history.filter(item => item.expression !== text).slice(0, HISTORY_LIMIT);
  if (earlier.length === 0) return;
  const list = api.el("ol", "mv-history");
  list.setAttribute("aria-label", "Looked up earlier on this page");
  list.lang = "ja";
  for (const item of earlier) {
    const entry = api.el("li", "mv-history-item");
    entry.title = item.reading ? `${item.expression} (${item.reading})` : item.expression;
    api.move(api.el("span", "mv-history-word", item.expression), entry);
    if (item.count > 1) api.move(api.el("span", "mv-tcy mv-history-count", `×${item.count}`), entry);
    api.move(entry, list);
  }
  api.move(list, toolbar);
}

// ---------------------------------------------------------------------------
// Term view

function renderTerm(view, api) {
  const { chrome, entries } = view;
  const toolbar = ensureToolbar(view, api);
  const header = chrome?.querySelector(":scope > .gsm-hoshidicts-primary-header");
  const headword = header?.querySelector(":scope > .gsm-hoshidicts-headword");
  const expression = headword?.querySelector(":scope > .gsm-hoshidicts-expression");
  moveActions(header, toolbar, api);
  if (headword && expression) {
    // 1. The word as it stands in the bubble, with the furigana it can inherit,
    //    plus the inflection steps — replaces the "Why this matched" disclosure.
    const deinflection = headword.querySelector(":scope > .gsm-hoshidicts-deinflection");
    if (deinflection && !headword.querySelector(":scope > .mv-surface")) {
      const surface = deinflection.querySelector(".gsm-hoshidicts-deinflection-endpoint")?.textContent || "";
      const steps = [...deinflection.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")]
        .map(step => step.textContent.replace(/^-/u, "")).filter(Boolean);
      if (surface) {
        const block = api.el("div", "mv-surface");
        block.lang = "ja";
        block.title = deinflection.querySelector("summary")?.getAttribute("aria-label") || "";
        api.move(buildSurfaceWord(api, surface, readSegments(expression)), block);
        if (steps.length) api.move(api.el("span", "mv-surface-steps", steps.join("・")), block);
        api.move(block, headword, expression.nextSibling);
      }
      api.hide(deinflection);
    }
    // 2. Frequency / pitch / grammar capsule (and the lookup count) join the
    //    headword column.
    const row = entries[0]?.querySelector(":scope > .gsm-hoshidicts-primary-metadata-row");
    if (row) api.move(row, headword);
    // 3. The gist — the renderer's compact summary — opens the scrolling
    //    glosses, so the senses sit right beside the headword and the full
    //    dictionary cards continue to the left. A tab switch rebuilds the
    //    summary; the previous one is hidden, not left as a duplicate.
    const summary = headword.querySelector(":scope > .gsm-hoshidicts-compact-definition-summary");
    if (summary) {
      let gist = view.content.querySelector(":scope > .mv-gist");
      if (!gist) {
        gist = api.el("div", "mv-gist");
        api.move(gist, view.content, view.content.firstChild);
      }
      for (const stale of gist.querySelectorAll(":scope > .gsm-hoshidicts-compact-definition-summary")) {
        if (stale !== summary) api.hide(stale);
      }
      api.move(summary, gist);
    }
    rememberAndList(view, api, toolbar, expression);
  }
  // 4. Secondary entries keep their headword; their button row goes (the
  //    toolbar and keybinds still reach them).
  for (const entry of entries.slice(1)) api.hide(entry.querySelector(".gsm-hoshidicts-entry-actions"));
}

// ---------------------------------------------------------------------------
// Kanji view

function readingRow(api, label, values) {
  const row = api.el("div", "mv-yomi");
  row.lang = "ja";
  api.move(api.el("span", "mv-yomi-label", label), row);
  const list = api.el("span", "mv-yomi-values");
  values.forEach((value, index) => {
    if (index > 0) api.move(api.el("span", "mv-yomi-separator", "・"), list);
    // KANJIDIC marks the okurigana boundary with a dot (た.べる); the run after
    // it becomes the lighter okurigana. Its affix hyphens (-か.ける) stay as
    // they are — rotated in a vertical line they read as a joining dash.
    const [stem, ...okurigana] = value.split(".");
    const reading = api.el("span", "mv-yomi-reading");
    api.move(api.el("span", "mv-yomi-stem", stem), reading);
    if (okurigana.length) api.move(api.el("span", "mv-yomi-okurigana", okurigana.join("")), reading);
    api.move(reading, list);
  });
  api.move(list, row);
  return row;
}

function factRow(api, label, valueNodes) {
  const row = api.el("div", "mv-fact");
  row.lang = "ja";
  api.move(api.el("span", "mv-fact-label", label), row);
  const value = api.el("span", "mv-fact-value");
  for (const node of valueNodes) api.move(node, value);
  api.move(value, row);
  return row;
}

// KANJIDIC's grade: 1–6 elementary school years, 8 the rest of the jōyō set
// (taught in secondary school), 9–10 jinmeiyō (name) kanji.
function gradeLabel(grade) {
  const n = Number(grade);
  if (n >= 1 && n <= 6) return `小${kanjiNumeral(n)}`;
  if (n === 8) return "中学";
  if (n === 9 || n === 10) return "人名用";
  return grade;
}

function renderKanjiEntry(entry, api) {
  if (entry.querySelector(":scope > .mv-yomi, :scope > .mv-facts")) return;
  const readings = entry.querySelector(":scope > .gsm-hoshidicts-kanji-readings");
  if (readings) {
    for (const group of readings.querySelectorAll(".gsm-hoshidicts-kanji-reading-group")) {
      const label = group.querySelector("strong")?.textContent || "";
      const values = (group.querySelector("span")?.textContent || "").split(" · ").filter(Boolean);
      if (values.length) api.move(readingRow(api, KANJI_READING_LABELS[label] || label, values), entry, readings);
    }
    api.hide(readings);
  }
  const meanings = entry.querySelector(":scope > .gsm-hoshidicts-kanji-meanings");
  const heading = meanings?.previousElementSibling;
  if (heading?.tagName === "H4") {
    api.move(api.el("div", "mv-meanings-label", "意味"), entry, meanings);
    api.hide(heading);
  }
  const stats = entry.querySelector(":scope > .gsm-hoshidicts-kanji-stats");
  if (stats) {
    const facts = new Map();
    for (const name of stats.querySelectorAll("dt")) {
      const value = name.nextElementSibling;
      if (value?.tagName === "DD") facts.set(name.textContent.trim(), value.textContent.trim());
    }
    const block = api.el("div", "mv-facts");
    if (facts.has("strokes")) api.move(factRow(api, "画数", [api.el("span", null, `${kanjiNumeral(facts.get("strokes"))}画`)]), block);
    if (facts.has("grade")) api.move(factRow(api, "学年", [api.el("span", null, gradeLabel(facts.get("grade")))]), block);
    if (facts.has("freq")) api.move(factRow(api, "頻度", [numberSpan(api, facts.get("freq")), api.el("span", null, "位")]), block);
    if (facts.has("jlpt")) api.move(factRow(api, "旧JLPT", [api.el("span", null, `${kanjiNumeral(facts.get("jlpt"))}級`)]), block);
    if (block.childNodes.length) api.move(block, entry, stats);   // the full index list stays behind "Details"
  }
}

function renderKanji(view, api) {
  const toolbar = ensureToolbar(view, api);
  const header = view.chrome?.querySelector(":scope > .gsm-hoshidicts-primary-header");
  moveActions(header, toolbar, api);
  toolbar.querySelector(":scope > .mv-history")?.remove();   // no page history while a kanji is open
  for (const entry of view.entries) renderKanjiEntry(entry, api);
  // The first dictionary's 画数・学年・頻度・旧JLPT sit under the glyph, in the
  // headword column, where a 漢和辞典 prints them.
  const navigation = header?.querySelector(".gsm-hoshidicts-kanji-navigation");
  const facts = view.entries[0]?.querySelector(":scope > .mv-facts");
  if (navigation && facts && !navigation.querySelector(":scope > .mv-facts")) api.move(facts, navigation);
}

export default {
  schema: 1,
  slug: "manga-vertical",
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    pointTail(view, api);
    api.requestLayout();
  },
};
