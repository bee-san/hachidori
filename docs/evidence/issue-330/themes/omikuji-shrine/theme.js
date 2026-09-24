// themes/omikuji-shrine/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis, no timers — only `view`
//    and `api`; DOM is made with api.el() and reparented with api.move();
//  - a hook that throws switches this module off for the page; CSS keeps working.
//
// Omikuji Shrine: the popup is a fortune slip (御神籤) pulled from a shrine box.
// The JavaScript does what CSS cannot:
//  1. reads the entry's frequency rank and turns it into a fortune grade
//     (大吉 … 大凶), the slip number (第○番 = the rank) and one line of learner
//     advice, so the learner sees at a glance whether the word is worth a card;
//  2. re-orders the popup: box lid → fortune → headword (with a hanko seal) →
//     glosses as verses → an ema shelf holding the reader's own Note / Anki /
//     audio / custom buttons, then a torii;
//  3. gives every secondary entry its own miniature fortune from its rank;
//  4. turns the kanji view into an ema board: the glyph brushed on wood, On and
//     Kun readings on ribbons, the kanji's own newspaper-frequency grade;
//  5. remembers the last headword per popup, so only a NEW word slides a fresh
//     slip out of the box (tab switches, Show more and Back do not); the slide
//     is a Web Animations call on the slip's parts, which needs no forced
//     layout and no @keyframes (theme CSS may not declare any).

// Fortune grades for a word's frequency rank (rank-based dictionaries such as
// Jiten or JPDB: 1 = most common). The bands follow how learners usually triage
// vocabulary: the first thousand words are unavoidable, beyond ~25k a word is a
// curiosity. Each grade carries the one line of advice printed as the verse.
const WORD_GRADES = [
  { max: 1000, grade: "大吉", id: "daikichi", verse: "An everyday word. Learn it now — you will meet it everywhere." },
  { max: 3000, grade: "中吉", id: "chukichi", verse: "Common. Well worth a card." },
  { max: 6000, grade: "小吉", id: "shokichi", verse: "Useful. You will meet it again soon." },
  { max: 12000, grade: "吉", id: "kichi", verse: "Fairly common in fiction. Mine it if it fits your deck." },
  { max: 25000, grade: "末吉", id: "suekichi", verse: "Uncommon. Recognise it; no need to drill it." },
  { max: 60000, grade: "凶", id: "kyo", verse: "Rare. Read on and skip the card." },
  { max: Infinity, grade: "大凶", id: "daikyo", verse: "Very rare. Let this one go." },
];

// KANJIDIC's `freq` ranks the 2,501 most used kanji in newspapers.
const KANJI_GRADES = [
  { max: 250, grade: "大吉", id: "daikichi", verse: "Among the 250 most used kanji." },
  { max: 500, grade: "中吉", id: "chukichi", verse: "Among the 500 most used kanji." },
  { max: 1000, grade: "小吉", id: "shokichi", verse: "Among the 1,000 most used kanji." },
  { max: 1500, grade: "吉", id: "kichi", verse: "Among the 1,500 most used kanji." },
  { max: 2000, grade: "末吉", id: "suekichi", verse: "Among the 2,000 most used kanji." },
  { max: Infinity, grade: "凶", id: "kyo", verse: "Outside the 2,000 most used kanji." },
];

const UNRANKED = { grade: "未詳", id: "unranked", verse: "No frequency dictionary ranks this word." };

const GRADE_LEGEND = "Fortune grade from frequency rank — 大吉 ≤ 1,000 · 中吉 ≤ 3,000 · 小吉 ≤ 6,000 · "
  + "吉 ≤ 12,000 · 末吉 ≤ 25,000 · 凶 ≤ 60,000 · 大凶 beyond";

const SHRINE_NAME = "蜂鳥神社";                 // Hachidori (蜂鳥) Shrine — original name for this theme
const HAN_CHARACTER = /\p{Script=Han}/u;

// Per popup element: the headword shown last, so a re-render of the same word
// (tab switch, Show more, Back) does not pull another slip from the box.
const lastHeadword = new WeakMap();

// The slip's parts travel down out of the box together: transform and opacity
// only, so the animation runs on the compositor.
const SLIDE = [{ transform: "translateY(-44px)", opacity: 0 }, { transform: "none", opacity: 1 }];
const SLIDE_TIMING = { duration: 460, easing: "cubic-bezier(0.22, 0.85, 0.25, 1)" };

function gradeFor(rank, table) {
  if (!Number.isFinite(rank) || rank <= 0) return UNRANKED;
  return table.find(band => rank <= band.max);
}

function groupDigits(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

// The renderer puts the numeric value on every frequency chip
// (popup.js createFrequencyTag: `value.dataset.frequency`) and names the
// dictionary on the chip's tag. The first tag is the user's first frequency
// dictionary; inside it the kana-spelling rank (Jiten's ㋕, titled "Kana
// frequency: …") is skipped in favour of the word's own rank.
function readFrequency(scope) {
  const tag = scope?.querySelector(".gsm-hoshidicts-tag-frequency");
  if (!tag) return null;
  const values = [...tag.querySelectorAll(".gsm-hoshidicts-frequency-value[data-frequency]")];
  const preferred = values.find(value => !value.title.startsWith("Kana frequency")) || values[0];
  const rank = Number(preferred?.dataset.frequency);
  if (!Number.isFinite(rank) || rank <= 0) return null;
  return { rank, dictionary: tag.dataset.dictionary || "" };
}

// The renderer labels the headword "<expression>, <reading>" (popup.js
// createEntryHeader); that is the one place the plain expression text exists.
function headwordText(expression) {
  const label = expression?.getAttribute("aria-label") || expression?.textContent || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? label.slice(0, comma) : label;
}

function sealCharacter(text) {
  const characters = Array.from(text);
  return characters.find(character => HAN_CHARACTER.test(character)) || characters[0] || "印";
}

function removeOwn(parent, selector) {
  for (const node of parent.querySelectorAll(selector)) node.remove();
}

// The lacquered box the slip is drawn from (a lid with the shrine's label) and
// the washi sheet itself, both decorative. The reader clears the popup on every
// full render, so both are rebuilt when missing.
function ensureBox(popup, api) {
  if (!popup.querySelector(":scope > .omikuji-box")) {
    const box = api.el("div", "omikuji-box");
    box.setAttribute("aria-hidden", "true");
    box.append(api.el("span", "omikuji-box-label", "御神籤"));
    api.move(box, popup, popup.firstChild);
  }
  if (!popup.querySelector(":scope > .omikuji-paper")) {
    const paper = api.el("div", "omikuji-paper");
    paper.setAttribute("aria-hidden", "true");
    api.move(paper, popup, popup.firstChild);
  }
}

// The fortune printed at the top of the slip: shrine name, slip number (= rank),
// grade, and the verse. `source` names the frequency dictionary under the rank.
function buildFortune(api, { rank, dictionary, table, legend, kind, source = null }) {
  const band = gradeFor(rank, table);
  const fortune = api.el("header", "omikuji-fortune");
  fortune.dataset.omikujiGrade = band.id;
  fortune.dataset.omikujiKind = kind;
  fortune.setAttribute("role", "note");
  fortune.setAttribute("aria-label", rank
    ? `Fortune ${band.grade}: ${dictionary || "frequency"} rank ${groupDigits(rank)}. ${band.verse}`
    : `Fortune ${band.grade}: ${band.verse}`);
  fortune.append(api.el("div", "omikuji-shrine", `${SHRINE_NAME} 御神籤`));
  const number = api.el("div", "omikuji-number");
  number.append(api.el("span", "omikuji-number-prefix", "第"),
    api.el("span", "omikuji-number-value", rank ? groupDigits(rank) : "―"),
    api.el("span", "omikuji-number-suffix", "番"));
  fortune.append(number);
  const grade = api.el("div", "omikuji-grade", band.grade);
  grade.title = legend;
  fortune.append(grade);
  fortune.append(api.el("p", "omikuji-verse", band.verse));
  source ??= rank ? `${dictionary ? `${dictionary} · ` : ""}rank ${groupDigits(rank)}` : "";
  if (source) fortune.append(api.el("div", "omikuji-source", source));
  return fortune;
}

// The reader's own action buttons (Note, Anki, audio, custom links, Back/Close)
// hang from a rope as ema plaques under the glosses. The header re-adopts the
// actions on every projection, so this always re-moves them.
function ensureShelf(popup, actions, api) {
  let shelf = popup.querySelector(":scope > .omikuji-shelf");
  if (!shelf) {
    shelf = api.el("div", "omikuji-shelf");
    const torii = api.el("div", "omikuji-torii");
    torii.setAttribute("aria-hidden", "true");
    torii.append(api.el("span", "omikuji-torii-kasagi"), api.el("span", "omikuji-torii-nuki"));
    shelf.append(torii);
    api.move(shelf, popup);
  }
  if (actions && actions.parentNode !== shelf) api.move(actions, shelf);
  return shelf;
}

// Only a different word slides a new slip out of the box. Nothing here reads
// layout or computed style: under prefers-reduced-motion theme.css pins the
// parts' transform and opacity with !important, which an animation cannot
// override, so the slip simply appears in place.
function drawSlip(popup, headword) {
  const previous = lastHeadword.get(popup);
  lastHeadword.set(popup, headword);
  if (previous === headword) return;
  for (const part of popup.children) {
    if (part.matches(".omikuji-box") || part.hidden || typeof part.animate !== "function") continue;
    part.animate(SLIDE, SLIDE_TIMING);
  }
}

function renderTerm(view, api) {
  const { popup, chrome, content } = view;
  const primaryEntry = view.entries.find(entry => entry.matches(".gsm-hoshidicts-entry")) || null;
  const primaryHeader = chrome?.querySelector(".gsm-hoshidicts-primary-header") || null;
  const expression = primaryHeader?.querySelector(".gsm-hoshidicts-expression") || null;
  const headword = headwordText(expression);

  ensureBox(popup, api);

  // Fortune: recomputed on every render because a tab switch can change which
  // entry is primary.
  removeOwn(popup, ":scope > .omikuji-fortune");
  const frequency = readFrequency(primaryEntry?.querySelector(".gsm-hoshidicts-primary-metadata-capsule"));
  const fortune = buildFortune(api, { rank: frequency?.rank ?? 0, dictionary: frequency?.dictionary ?? "",
    table: WORD_GRADES, legend: GRADE_LEGEND, kind: "term" });
  api.move(fortune, popup, chrome || content);
  // The lookup count belongs to the reader (it repaints the text); it just moves
  // under the verse as the "visits" line.
  const stats = primaryEntry?.querySelector(".gsm-hoshidicts-lookup-stats");
  if (stats) api.move(stats, fortune);
  // The rank now reads on the slip; the chip row would repeat it. Grammar tags stay.
  api.hide(primaryEntry?.querySelector(".gsm-hoshidicts-primary-frequencies"));

  // Hanko seal beside the headword, stamped with its first kanji.
  if (expression && !primaryHeader.querySelector(".omikuji-seal")) {
    const seal = api.el("span", "omikuji-seal", sealCharacter(headword));
    seal.setAttribute("aria-hidden", "true");
    api.move(seal, expression.parentNode, expression.nextSibling);
  }

  // Secondary entries: a miniature fortune from their own rank, after the headword.
  for (const entry of view.entries) {
    if (entry === primaryEntry || !entry.matches(".gsm-hoshidicts-entry")) continue;
    const header = entry.querySelector(":scope > .gsm-hoshidicts-entry-header .gsm-hoshidicts-headword");
    if (!header || header.querySelector(".omikuji-mini")) continue;
    const secondary = readFrequency(entry.querySelector(".gsm-hoshidicts-frequency-metadata"));
    const band = gradeFor(secondary?.rank ?? 0, WORD_GRADES);
    const mini = api.el("span", "omikuji-mini", band.grade);
    mini.dataset.omikujiGrade = band.id;
    mini.title = secondary ? `${band.grade} — ${secondary.dictionary} rank ${groupDigits(secondary.rank)}` : band.verse;
    mini.setAttribute("aria-label", secondary
      ? `Fortune ${band.grade}, rank ${groupDigits(secondary.rank)}` : `Fortune ${band.grade}`);
    const own = header.querySelector(":scope > .gsm-hoshidicts-expression");
    api.move(mini, header, own ? own.nextSibling : null);
    api.hide(entry.querySelector(".gsm-hoshidicts-frequency-metadata"));
  }

  ensureShelf(popup, primaryHeader?.querySelector(".gsm-hoshidicts-entry-actions") || null, api);
  api.hide(popup.querySelector(":scope > .gsm-hoshidicts-resize-handle"));
  drawSlip(popup, `term:${headword}`);
}

// Kanji view: the glyph brushed on an ema board, On readings on a vermilion
// ribbon, Kun readings on an indigo ribbon, the kanji's own grade in the corner.
function renderKanji(view, api) {
  const { popup, chrome, content } = view;
  const primaryHeader = chrome?.querySelector(".gsm-hoshidicts-primary-header") || null;
  const glyph = primaryHeader?.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent?.trim() || "";
  const first = view.entries.find(entry => entry.matches(".gsm-hoshidicts-kanji-entry")) || null;

  ensureBox(popup, api);
  removeOwn(popup, ":scope > .omikuji-fortune, :scope > .omikuji-ema");

  // KANJIDIC-style stats are a <dl>: "freq" is the newspaper rank of 2,501.
  let rank = 0;
  const stats = [];
  for (const term of first?.querySelectorAll(".gsm-hoshidicts-kanji-stats dt") || []) {
    const name = term.textContent.trim();
    const value = term.nextElementSibling?.textContent?.trim() || "";
    if (name === "freq") rank = Number(value.replace(/[^\d]/gu, ""));
    else if (name === "grade" || name === "strokes" || name === "jlpt") stats.push({ name, value });
  }
  const dictionary = first?.querySelector(".gsm-hoshidicts-kanji-dictionary")?.textContent?.trim() || "";
  const fortune = buildFortune(api, { rank, dictionary, table: KANJI_GRADES,
    legend: "Kanji grade from its newspaper frequency rank (1–2,501) — 大吉 ≤ 250 · 中吉 ≤ 500 · 小吉 ≤ 1,000 · 吉 ≤ 1,500 · 末吉 ≤ 2,000",
    kind: "kanji",
    source: rank ? `${dictionary} · newspaper rank ${groupDigits(rank)} of 2,501` : dictionary });

  const ema = api.el("section", "omikuji-ema");
  ema.setAttribute("aria-label", `Kanji ${glyph}`);
  const board = api.el("div", "omikuji-ema-board");
  board.append(api.el("span", "omikuji-ema-string"));
  board.append(api.el("div", "omikuji-ema-glyph", glyph));
  const stamp = api.el("span", "omikuji-ema-stamp", gradeFor(rank, KANJI_GRADES).grade);
  stamp.dataset.omikujiGrade = gradeFor(rank, KANJI_GRADES).id;
  stamp.title = fortune.getAttribute("aria-label");
  board.append(stamp);
  ema.append(board);

  const ribbons = api.el("div", "omikuji-ribbons");
  for (const group of first?.querySelectorAll(".gsm-hoshidicts-kanji-reading-group") || []) {
    const label = group.querySelector("strong")?.textContent?.trim() || "";
    const readings = group.querySelector("span")?.textContent?.trim() || "";
    if (!readings) continue;
    const ribbon = api.el("span", `omikuji-ribbon omikuji-ribbon-${label.toLowerCase()}`);
    ribbon.append(api.el("span", "omikuji-ribbon-label", label === "On" ? "音" : label === "Kun" ? "訓" : label));
    ribbon.append(api.el("span", "omikuji-ribbon-text", readings));
    ribbons.append(ribbon);
  }
  if (ribbons.childNodes.length) ema.append(ribbons);
  if (stats.length) {
    const tags = api.el("div", "omikuji-kanji-tags");
    for (const stat of stats) {
      const tag = api.el("span", "omikuji-kanji-tag");
      tag.append(api.el("span", "omikuji-kanji-tag-name",
        { grade: "school grade", strokes: "strokes", jlpt: "JLPT" }[stat.name]), api.el("span", "omikuji-kanji-tag-value", stat.value));
      tags.append(tag);
    }
    ema.append(tags);
  }
  api.move(fortune, popup, chrome || content);
  api.move(ema, popup, chrome || content);

  // The board carries the glyph and the readings; the reader's copies fold away.
  // With its buttons on the shelf the bar is empty unless it holds dictionary tabs.
  api.hide(primaryHeader?.querySelector(".gsm-hoshidicts-kanji-navigation"));
  if (chrome && !chrome.querySelector(".gsm-hoshidicts-tab-list")) api.hide(chrome);
  for (const entry of view.entries) {
    if (!entry.matches(".gsm-hoshidicts-kanji-entry")) continue;
    if (entry === first) api.hide(entry.querySelector(".gsm-hoshidicts-kanji-readings"));
    api.hide(entry.querySelector(".gsm-hoshidicts-kanji-dictionary"));
  }

  ensureShelf(popup, primaryHeader?.querySelector(".gsm-hoshidicts-entry-actions") || null, api);
  api.hide(popup.querySelector(":scope > .gsm-hoshidicts-resize-handle"));
  drawSlip(popup, `kanji:${glyph}`);
}

export default {
  schema: 1,
  slug: "omikuji-shrine",
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    else return;
    api.requestLayout();
  },
};
