// themes/nazeka/theme.js — Hachidori theme module, schema 1. v1.1.0
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis — only `view` and `api`;
//  - a hook that throws switches this module off for the page; CSS keeps working.
//
// Layout mirrors wareya/nazeka texthook.js build_div_inner (:646-1133) and
// build_div_kanji (:1188-1303) with Nazeka's default settings:
//   [context …looked up… context      ♪ + ✎]   ← .nazeka_original, float right, 70 %
//   食べる《たべる》～-たい→-た  #142          ← .nazeka_word: 18 px keb, 15 px reb, deconj, freq
//   (vt) (1) to eat; to live on; (2) …          ← compact senses, plain text (CSS)
// Nazeka has no visible buttons (audio is the "p" key, mining the "m" key); the
// 24 px icons it does draw in the same row on Android/sticky mode
// (texthook.js:676-716) are the model for the audio / Anki / Note buttons here.

const HIDE_IN_TERM_ENTRIES = [
  ".gsm-hoshidicts-primary-metadata-row",   // lookup count + frequency capsule (freq is re-rendered as #n)
  ".gsm-hoshidicts-metadata",               // frequency / pitch / IPA badges
  ".gsm-hoshidicts-tags",                   // grammar tag row (Nazeka shows pos inline per sense)
  ".gsm-hoshidicts-deinflection",           // re-rendered as ～…
  ".gsm-hoshidicts-compact-definition-summary",
  ".gsm-hoshidicts-entry-header",           // secondary headers: their expression moves into .nazeka-word
];

const HIDE_IN_KANJI_ENTRIES = [
  ".gsm-hoshidicts-kanji-dictionary", ".gsm-hoshidicts-tags", ".gsm-hoshidicts-kanji-readings",
  "h4", ".gsm-hoshidicts-kanji-meanings", ".gsm-hoshidicts-kanji-stats",
];

// The renderer labels the headword "<expression>, <reading>" (popup.js:3199-3204);
// textContent would include the furigana <rt> text, so the label is the source.
function headword(expression) {
  const label = expression.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? { keb: label.slice(0, comma), reb: label.slice(comma + 2) }
    : { keb: label || expression.textContent.trim(), reb: "" };
}

function hideAll(root, selectors, api) {
  for (const selector of selectors) for (const node of root.querySelectorAll(selector)) api.hide(node);
}

// Nazeka's "looked up" row (texthook.js:650-676): up to three characters of
// context either side, "…" beyond that, the matched text bold in hlcolor.
function originalRow(view, api) {
  const row = api.el("header", "nazeka-original");
  const lookup = view.lookup;
  if (lookup?.text) {
    let before = lookup.offset >= 0 ? lookup.sentence.slice(0, lookup.offset) : "";
    let after = lookup.offset >= 0 ? lookup.sentence.slice(lookup.offset + lookup.text.length) : "";
    if (before.length > 5) before = `…${before.slice(-3)}`;
    if (after.length > 5) after = `${after.slice(0, 3)}…`;
    row.append(before, api.el("span", "nazeka-lookup", lookup.text), after);
  }
  return row;
}

// Move the reader's action group next to the headword; theme.css then shows
// only the audio and Anki buttons in it (Note, custom and close stay hidden).
// The Anki button is bound after this hook runs, so the group is moved whole
// and the button lands in place when it appears. Listeners and keybinds stay.
function adoptActions(row, source, api) {
  const actions = source?.querySelector(".gsm-hoshidicts-entry-actions");
  if (!actions) return;
  const group = api.el("span", "nazeka-actions");
  api.move(actions, group);
  row.append(group);
}

// 食べる《たべる》～-たい→-た  #142
function wordRow(entry, header, api) {
  const expression = header?.querySelector(".gsm-hoshidicts-expression");
  if (!expression) return null;
  const word = api.el("span", "nazeka-word");
  api.move(expression, word);
  const { keb, reb } = headword(expression);
  if (reb && reb !== keb) word.append("《", api.el("span", "nazeka-reading", reb), "》");
  const steps = [...header.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map(step => step.textContent.trim());
  if (steps.length) word.append(`～${steps.reverse().join("→")}`);
  // "#142 (食べる:たべる)" — Nazeka prints keb:reb after the rank when they differ (texthook.js:1052-1066).
  const frequency = entry.querySelector(".gsm-hoshidicts-frequency-value");
  if (frequency) {
    const rank = frequency.textContent.trim().replace(/位$/u, "");
    word.append(api.el("span", "nazeka-freq", `#${rank} (${reb && reb !== keb ? `${keb}:${reb}` : keb})`));
  }
  return word;
}

function renderTerm(view, api) {
  const { chrome, content, entries } = view;
  if (chrome && !content.querySelector(":scope > .nazeka-original")) {
    const row = originalRow(view, api);
    adoptActions(row, chrome, api);
    api.move(row, content, content.firstChild);
    api.hide(chrome);
  }
  entries.forEach((entry, index) => {
    if (entry.querySelector(":scope > .nazeka-word")) return;
    // The first entry's header lives in the top bar; later ones carry their own.
    const header = index === 0 && chrome ? chrome : entry.querySelector(".gsm-hoshidicts-entry-header");
    const word = wordRow(entry, header, api);
    if (word) {
      if (index > 0) adoptActions(word, header, api);
      api.move(word, entry, entry.firstChild);
    }
    hideAll(entry, HIDE_IN_TERM_ENTRIES, api);
  });
}

// Nazeka's grade wording (texthook.js:1213-1224).
function gradeLabel(grade) {
  if (grade === "X") return "Hyougai";
  if (grade === "9" || grade === "10") return "Jinmeiyou";
  if (grade === "8") return "Jouyou";
  if ("123456".includes(grade)) return "Kyouiku";
  return "Unknown (Hyougai)";
}

// Kanji mode as Nazeka prints it (texthook.js:1188-1303): the glyph, then
// "Grade: …", "Strokes: …", "Jouyou readings:", "On'yomi: …", "Kun'yomi: …" as
// plain lines with the readings in hlcolor2. Meanings stay as one more line;
// Nazeka has no meanings, Hachidori has no composition data.
function renderKanji(view, api) {
  const { chrome, content, entries } = view;
  if (chrome && !content.querySelector(":scope > .nazeka-kanji-mode")) {
    // "Currently in individual kanji mode. Press [k] to cancel." — Hachidori's Back
    // button stands in for the [k] key; nothing else from the top bar is kept.
    const head = api.el("div", "nazeka-kanji-mode", "Currently in individual kanji mode. ");
    const back = chrome.querySelector(".gsm-hoshidicts-kanji-back");
    if (back) api.move(back, head);
    api.move(head, content, content.firstChild);
    const glyph = chrome.querySelector(".gsm-hoshidicts-kanji-glyph");
    if (glyph) {
      glyph.classList.add("nazeka-kanji-glyph");
      api.move(glyph, content, head.nextSibling);
    }
    api.hide(chrome);
  }
  for (const entry of entries) {
    if (entry.querySelector(":scope > .nazeka-kanji-info")) continue;
    const info = api.el("div", "nazeka-kanji-info");
    const line = text => info.append(api.el("div", null, text));
    const stats = new Map([...entry.querySelectorAll(".gsm-hoshidicts-kanji-stats dt")]
      .map(name => [name.textContent.trim().toLowerCase(), name.nextElementSibling?.textContent.trim() ?? ""]));
    if (stats.has("grade")) line(`Grade: ${gradeLabel(stats.get("grade"))}`);
    if (stats.has("strokes")) line(`Strokes: ${stats.get("strokes")}`);
    const groups = [...entry.querySelectorAll(".gsm-hoshidicts-kanji-reading-group")];
    if (groups.length) line("Jouyou readings:");
    for (const group of groups) {
      const label = group.querySelector("strong")?.textContent.trim();
      const values = (group.querySelector("span")?.textContent ?? "").split("·").map(value => value.trim()).filter(Boolean);
      if (!label || !values.length) continue;
      const row = api.el("div", null, `${label === "On" ? "On'yomi" : label === "Kun" ? "Kun'yomi" : label}: `);
      values.forEach((value, index) => {
        if (index) row.append("、");
        row.append(api.el("span", "nazeka-reading", value));
      });
      info.append(row);
    }
    const meanings = [...entry.querySelectorAll(".gsm-hoshidicts-kanji-meanings li")].map(item => item.textContent.trim());
    if (meanings.length) line(`Meanings: ${meanings.join("; ")}`);
    api.move(info, entry, entry.firstChild);
    hideAll(entry, HIDE_IN_KANJI_ENTRIES, api);
  }
}

export default {
  schema: 1,
  slug: "nazeka",
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    api.hide(view.popup.querySelector(":scope > .gsm-hoshidicts-resize-handle"));
    api.requestLayout();
  },
};
