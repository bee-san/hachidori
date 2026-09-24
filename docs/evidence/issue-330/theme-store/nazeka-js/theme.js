// themes/nazeka/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis — only `view` and `api`;
//  - a hook that throws switches this module off for the page; CSS keeps working.
//
// Nazeka shows 「食べる たべる」 on one line and the glosses under it — no bar of
// buttons, tags, frequency, pitch graphs, images or dictionary titles.

const HIDE_IN_TERM_ENTRIES = [
  ".gsm-hoshidicts-primary-metadata-row",   // lookup count + frequency capsule
  ".gsm-hoshidicts-metadata",               // frequency / pitch / IPA badges
  ".gsm-hoshidicts-tags",                   // grammar tag row
  ".gsm-hoshidicts-definition-tags",        // per-definition tags
  ".gsm-hoshidicts-glossary-card-title",    // dictionary name above each card
  ".gsm-hoshidicts-deinflection",           // "Why this matched" disclosure
  ".gsm-hoshidicts-compact-definition-summary",
  ".gsm-hoshidicts-entry-actions",          // per-entry audio / mine buttons
  ".gloss-image-container",                 // dictionary images
];

const HIDE_IN_KANJI_ENTRIES = [
  ".gsm-hoshidicts-kanji-dictionary",       // <h3> dictionary name
  ".gsm-hoshidicts-tags",
  "h4",                                     // "Meanings" heading
  ".gsm-hoshidicts-kanji-stats",            // strokes / grade / freq
];

// The renderer labels the headword "<expression>, <reading>" (popup.js:3199-3204);
// that is the one place the reading exists as plain text.
function splitLabel(expression) {
  const label = expression.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { text: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { text: label, reading: "" };
}

function inlineReading(expression, api) {
  if (!expression || expression.parentNode.querySelector(":scope > .nazeka-reading")) return;
  const { text, reading } = splitLabel(expression);
  if (reading && reading !== text) expression.after(api.el("span", "nazeka-reading", reading));
}

function hideAll(root, selectors, api) {
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) api.hide(node);
  }
}

// Term view: lift the primary headword out of the top bar into the body, put the
// reading beside it, then remove the bar. Secondary entries keep their own
// header; only its buttons go.
function renderTerm(view, api) {
  const { chrome, content } = view;
  const headword = chrome?.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-headword");
  if (headword && !content.querySelector(":scope > .nazeka-head")) {
    const head = api.el("header", "nazeka-head");
    const expression = headword.querySelector(".gsm-hoshidicts-expression");
    if (expression) {
      api.move(expression, head);
      inlineReading(expression, api);
    }
    api.move(head, content, content.firstChild);
    api.hide(chrome);
  }
  for (const entry of view.entries) {
    inlineReading(entry.querySelector(".gsm-hoshidicts-entry-header .gsm-hoshidicts-expression"), api);
    hideAll(entry, HIDE_IN_TERM_ENTRIES, api);
  }
}

// Kanji view: glyph and Back on one line, readings and meanings under it.
function renderKanji(view, api) {
  const { chrome, content } = view;
  if (chrome && !content.querySelector(":scope > .nazeka-head")) {
    const head = api.el("header", "nazeka-head");
    const glyph = chrome.querySelector(".gsm-hoshidicts-kanji-glyph");
    const back = chrome.querySelector(".gsm-hoshidicts-kanji-back");
    if (glyph) api.move(glyph, head);
    if (back) api.move(back, head);
    api.move(head, content, content.firstChild);
    api.hide(chrome);
  }
  for (const entry of view.entries) hideAll(entry, HIDE_IN_KANJI_ENTRIES, api);
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
