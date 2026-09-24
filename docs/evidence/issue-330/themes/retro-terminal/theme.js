// themes/retro-terminal/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis/timers/observers — only
//    `view` and `api`;
//  - a hook that throws switches this module off for the page; CSS keeps working,
//    so nothing below relies on throwing: every lookup is null-checked and every
//    column degrades to "—".
//
// The popup becomes a text-mode UI built only from what the reader rendered: the
// reader's title bar (headword + inline ＼ reading + deinflection trace), a
// candidate list `idx | word▮ | reading | LHL[2] | #rank | senses · dicts`, the
// reader's entries as flat records, and an inverse-video status line.
//
// Keyboard, while focus is inside the popup (click a row or Tab in): j/k, ↑/↓ in
// the list, g/G, Home/End, 1-9 pick a candidate, Enter mines the selected entry
// to Anki, m presses "Show more". The selection also follows the body's scroll
// position, `less`-style, so the reader's own entry keybinds (Alt+↑/↓) move it too.

const SLUG = "retro-terminal";

// Metadata the list and status line absorb. The nodes stay in the DOM (hidden), so
// the reader's own references and later repaints keep working.
const HIDE_IN_TERM_ENTRIES = [
  ".gsm-hoshidicts-primary-metadata-row",   // lookup count (moved to the status line) + frequency capsule
  ".gsm-hoshidicts-metadata",               // frequency / pitch / IPA badges → list columns + status line
];

// Per-popup state. A popup outlives its renders; rows and entries are replaced by
// every onRender, listeners are attached once.
const states = new WeakMap();
const boundPopups = new Set();

const text = node => (node ? node.textContent.trim() : "");

// The renderer labels the headword "<expression>, <reading>" (popup.js
// createEntryHeader); that is the one place the reading exists as plain text.
function headwordOf(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { word: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { word: label, reading: "" };
}

// A pitch contour is a run of .gsm-hoshidicts-pitch-mora spans with
// data-pitch-level (high|low) and data-pitch-transition (rise|drop) — the nodes
// the graph is drawn from — written out as LHL and たべ＼る (NHK notation).
function contourText(morae) {
  let pattern = "";
  let notation = "";
  for (const mora of morae) {
    pattern += mora.dataset.pitchLevel === "high" ? "H" : "L";
    notation += mora.textContent;
    if (mora.dataset.pitchTransition === "drop") notation += "＼";
  }
  return { pattern, notation };
}

// Every pitch the reader rendered for an entry: its pitch badges (all
// dictionaries, deduplicated by the reader), else the furigana contour in the
// header (the user's preferred pitch dictionary).
function pitchesOf(entry, header) {
  const pitches = [];
  for (const tag of entry?.querySelectorAll(".gsm-hoshidicts-pitch-metadata .gsm-hoshidicts-tag-pitch") ?? []) {
    const morae = tag.querySelectorAll(".gsm-hoshidicts-pitch-mora");
    const position = text(tag.querySelector(".gsm-hoshidicts-pitch-position"));
    if (morae.length > 0) pitches.push({ ...contourText(morae), position });
    else if (tag.dataset.pronunciation) {
      // A pattern the reader could not draw (e.g. a raw "LHH" position): keep its text.
      pitches.push({ pattern: "", notation: "", position: tag.dataset.pronunciation.replace(/^\S+\s*/u, "") });
    }
  }
  if (pitches.length === 0 && header) {
    const morae = header.querySelectorAll(".gsm-hoshidicts-pitch-ruby .gsm-hoshidicts-pitch-mora");
    const reading = header.querySelector(".gsm-hoshidicts-pitch-reading");
    if (morae.length > 0 && reading) pitches.push({ ...contourText(morae), position: `[${reading.dataset.pitchPosition}]` });
  }
  return pitches;
}

// Frequency badges: one per dictionary, values already formatted by the reader
// ("142", "12k", "142位" when dictionary names are shown).
function frequenciesOf(entry) {
  const frequencies = [];
  for (const tag of entry?.querySelectorAll(".gsm-hoshidicts-tag-frequency") ?? []) {
    const values = [...tag.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(text).filter(Boolean);
    if (values.length > 0) frequencies.push({ dictionary: tag.dataset.dictionary || "", values });
  }
  return frequencies;
}

// One glossary card per dictionary; the <li> count is the sense count. The cards
// exist at hook time even when their glosses are still being filled in.
function dictionariesOf(entry) {
  return [...entry.querySelectorAll(".gsm-hoshidicts-glossary-card")].map(card => ({
    name: text(card.querySelector(".gsm-hoshidicts-glossary-card-title")),
    senses: card.querySelectorAll(".gsm-hoshidicts-definitions > li").length,
  }));
}

// "Why this matched": the reader's <details> with matched → deinflected endpoints
// and the rule names, flattened to one dim line.
function traceOf(header) {
  const details = header?.querySelector(".gsm-hoshidicts-deinflection");
  if (!details) return null;
  const [from, to] = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint")].map(text);
  const steps = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map(text).filter(Boolean);
  return { details, from, to, steps };
}

function hideAll(root, selectors, api) {
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) api.hide(node);
  }
}

// Reading beside the headword, in ＼ notation when a pitch is known. The furigana
// itself is hidden by theme.css.
function inlineReading(headword, expression, pitches, api) {
  if (!expression || headword.querySelector(":scope > .rt-reading")) return;
  const { word, reading } = headwordOf(expression);
  if (!reading || reading === word) return;
  const pitch = pitches.find(item => item.notation);
  api.move(api.el("span", "rt-reading", pitch ? pitch.notation : reading), headword, expression.nextSibling);
}

// Title bar: the primary headword stays where the reader put it (it is the first
// .gsm-hoshidicts-expression in DOM order); the reading goes beside it and the
// deinflection disclosure becomes a trace line.
function renderTitle(view, header, api) {
  const headword = header?.querySelector(".gsm-hoshidicts-headword");
  if (!headword) return;
  const expression = headword.querySelector(":scope > .gsm-hoshidicts-expression");
  if (!headword.querySelector(":scope > .rt-reading")) inlineReading(headword, expression, pitchesOf(view.entries[0], header), api);
  const trace = traceOf(header);
  if (!trace || headword.querySelector(":scope > .rt-trace")) return;
  const line = api.el("span", "rt-trace");
  line.append("← ", api.el("b", null, trace.from));
  if (trace.steps.length > 0) line.append(` · ${trace.steps.join(" › ")}`);
  api.move(line, headword, null);
  api.hide(trace.details);
}

// One candidate row: idx | word▮ | reading | LHL[2] | #rank | senses · dictionaries.
function buildRow(entry, index, header, pitches, api) {
  const expression = (index === 0 ? header : entry)?.querySelector(".gsm-hoshidicts-expression");
  const { word, reading } = headwordOf(expression);
  const pitch = pitches[0];
  const frequency = frequenciesOf(entry)[0];
  const dictionaries = dictionariesOf(entry);
  const senses = dictionaries.reduce((total, dictionary) => total + dictionary.senses, 0);
  const row = api.el("div", "rt-row");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  row.dataset.rtIndex = String(index);
  const wordCell = api.el("span", "rt-word", word);
  wordCell.append(api.el("span", "rt-cur"));
  row.append(
    api.el("span", "rt-idx", String(index + 1)),
    wordCell,
    api.el("span", "rt-read", reading && reading !== word ? reading : "—"),
    api.el("span", "rt-pitch", pitch ? `${pitch.pattern}${pitch.position}` : "—"),
    api.el("span", "rt-freq", frequency ? `#${frequency.values[0]}` : "—"),
    api.el("span", "rt-dict", `${senses} ${senses === 1 ? "sense" : "senses"} · ${dictionaries.map(item => item.name).join(", ")}`),
  );
  return row;
}

// The reader renders the first entry, appends the rest in 8 ms batches and calls
// onRender after each batch (and after Show more). Rows are built once per entry
// node and the list is kept, so a lookup costs O(n) across all its hook calls.
function renderTerm(view, api, state) {
  renderTitle(view, state.header, api);
  if (!state.list?.isConnected) {          // a fresh render: the reader's clear() removed the old list
    state.list = api.el("div", "rt-list");
    state.list.setAttribute("role", "listbox");
    state.list.setAttribute("aria-label", "Candidates");
    state.rowsByEntry = new Map();
    api.move(state.list, view.popup, view.content);   // between the title bar and the body
  }
  state.rows = state.entries.map((entry, index) => {
    let row = state.rowsByEntry.get(entry);
    if (row) return row;
    const header = index === 0 ? state.header : entry.querySelector(":scope > .gsm-hoshidicts-entry-header");
    const pitches = pitchesOf(entry, index === 0 ? header : null);
    const headword = header?.querySelector(".gsm-hoshidicts-headword");
    if (index > 0 && headword) inlineReading(headword, headword.querySelector(".gsm-hoshidicts-expression"), pitches, api);
    row = buildRow(entry, index, state.header, pitches, api);
    state.list.append(row);
    hideAll(entry, HIDE_IN_TERM_ENTRIES, api);
    state.rowsByEntry.set(entry, row);
    return row;
  });
}

// Kanji view: the essentials from the "Details" disclosure become one line under
// the meanings; the disclosure stays for the other indexes (KANJIDIC has 34).
const KANJI_STATS_LINE = ["strokes", "grade", "jlpt", "freq"];

function renderKanji(view, api, state) {
  state.list?.remove();
  state.list = null;
  state.rows = [];
  for (const entry of state.entries) {
    const stats = entry.querySelector(":scope > .gsm-hoshidicts-kanji-stats");
    if (!stats || entry.querySelector(":scope > .rt-stats")) continue;
    const values = new Map([...stats.querySelectorAll("dt")].map(name => [text(name).toLowerCase(), text(name.nextElementSibling)]));
    const line = api.el("div", "rt-stats");
    for (const name of KANJI_STATS_LINE) {
      if (!values.has(name)) continue;
      if (line.childNodes.length > 0) line.append(" · ");
      line.append(`${name} `, api.el("b", null, values.get(name)));
    }
    if (line.childNodes.length === 0) continue;
    api.move(line, entry, stats);
    if (values.size <= KANJI_STATS_LINE.length) api.hide(stats);   // nothing left to disclose
  }
}

// Status line: mode, position, the selected entry's word/pitch/rank/IPA, the
// reader's own lookup count (moved in, so its later repaint lands here) and keys.
function buildStatus(view, api, state) {
  if (!state.status?.isConnected) {
    state.status = api.el("div", "rt-status");
    state.status.append(api.el("span", "rt-mode"), api.el("span", "rt-info"), api.el("span", "rt-keys"));
    api.move(state.status, view.popup, null);
  }
  const keys = state.status.querySelector(":scope > .rt-keys");
  state.status.querySelector(":scope > .rt-mode").textContent = view.kind === "kanji" ? "KANJI" : "TERM";
  keys.textContent = view.kind === "kanji" ? "Alt+B back · Esc" : "j/k · 1-9 · ⏎ anki · m more";
  const stats = view.popup.querySelector(".gsm-hoshidicts-lookup-stats");
  if (stats && stats.parentNode !== state.status) api.move(stats, state.status, keys);
}

// At most two items, then "+n": the status line is one row of a 560 px screen.
function capped(items) {
  const unique = [...new Set(items)];
  return unique.length > 2 ? `${unique.slice(0, 2).join(" ")} +${unique.length - 2}` : unique.join(" ");
}

function updateStatus(state) {
  const info = state.status?.querySelector(".rt-info");
  const entry = state.entries[state.selected];
  if (!info || !entry) return;
  const parts = [`${state.selected + 1}/${state.entries.length}`];
  if (state.kind === "term") {
    const header = state.selected === 0 ? state.header : entry;
    const { word, reading } = headwordOf(header?.querySelector(".gsm-hoshidicts-expression"));
    const pitches = pitchesOf(entry, state.selected === 0 ? state.header : null);
    parts.push([word, pitches.find(item => item.notation)?.notation || (reading !== word ? reading : "")].filter(Boolean).join(" "));
    if (pitches.length > 0) parts.push(capped(pitches.map(item => `${item.pattern}${item.position}`)));
    const frequencies = frequenciesOf(entry);
    if (frequencies.length === 1) parts.push(`#${frequencies[0].values[0]}`);
    else if (frequencies.length > 1) parts.push(capped(frequencies.map(item => `#${item.values[0]} ${item.dictionary}`.trim())));
    const ipa = text(entry.querySelector(".gsm-hoshidicts-ipa-body"));
    if (ipa) parts.push(ipa);
  } else {
    parts.push(text(state.popup.querySelector(".gsm-hoshidicts-kanji-glyph")), text(entry.querySelector(".gsm-hoshidicts-kanji-dictionary")));
    for (const group of entry.querySelectorAll(".gsm-hoshidicts-kanji-reading-group")) {
      parts.push(`${text(group.querySelector("strong")).toUpperCase()} ${text(group.querySelector("span"))}`);
    }
    const stats = text(entry.querySelector(".rt-stats"));
    if (stats) parts.push(stats);
  }
  info.textContent = parts.filter(Boolean).join(" │ ");
}

// Selection = inverse-video row + gutter mark on the entry + status line. With
// `scroll` (user navigation) the entry is brought to the top of the body, as the
// reader's own scrollToEntry does, and that programmatic scroll is remembered so
// the scroll listener does not re-derive the selection from it. onRender selects
// without `scroll`, so the render path reads no layout and never forces one.
function select(state, index, { scroll = true, focus = false } = {}) {
  const count = state.entries.length;
  if (count === 0) return;
  const next = Math.max(0, Math.min(count - 1, index));
  state.entries.forEach((entry, position) => {
    if (position === next) entry.dataset.rtSelected = "";
    else delete entry.dataset.rtSelected;
  });
  state.rows.forEach((row, position) => {
    row.setAttribute("aria-selected", String(position === next));
    row.tabIndex = position === next ? 0 : -1;
  });
  state.selected = next;
  updateStatus(state);
  const row = state.rows[next];
  if (row && state.list && scroll) {
    // Keep the row inside the six-row window (.rt-list is position: relative).
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < state.list.scrollTop) state.list.scrollTop = top;
    else if (bottom > state.list.scrollTop + state.list.clientHeight) state.list.scrollTop = bottom - state.list.clientHeight;
  }
  if (scroll) {
    const content = state.content;
    const target = Math.max(0, Math.min(state.entries[next].offsetTop, content.scrollHeight - content.clientHeight));
    state.expectedScrollTop = target;
    content.scrollTop = target;
  }
  if (focus && row) row.focus({ preventScroll: true });
}

// `less` model: the current record is the last one whose top is at or above the
// body's top edge, so the reader's own entry keybinds (which scroll) move it too.
function syncFromScroll(state) {
  const top = state.content.scrollTop;
  if (state.expectedScrollTop !== null && Math.abs(top - state.expectedScrollTop) < 1) return;
  state.expectedScrollTop = null;
  let index = 0;
  for (let position = 1; position < state.entries.length; position += 1) {
    if (state.entries[position].offsetTop <= top + 4) index = position;
  }
  if (index !== state.selected) select(state, index, { scroll: false });
}

function onKeyDown(event, state) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const target = event.target;
  if (typeof target?.closest !== "function" || target.closest("input, textarea, select, [contenteditable]")) return;
  const inList = Boolean(state.list && target.closest(".rt-list"));
  const key = event.key;
  let next = null;
  if (key === "j" || (inList && key === "ArrowDown")) next = state.selected + 1;
  else if (key === "k" || (inList && key === "ArrowUp")) next = state.selected - 1;
  else if (key === "g" || (inList && key === "Home")) next = 0;
  else if (key === "G" || (inList && key === "End")) next = state.entries.length - 1;
  else if (key.length === 1 && key >= "1" && key <= "9") next = Number(key) - 1;
  else if (key === "m") {
    const more = state.content.querySelector(".gsm-hoshidicts-show-more");
    if (!more) return;
    event.preventDefault();
    more.click();
    return;
  } else if (key === "Enter" && inList) {
    // IME metaphor: Enter commits the candidate — here, to Anki, through the
    // reader's own mine button for that entry (no-op while it is disabled).
    const scope = state.selected === 0 ? state.header : state.entries[state.selected];
    const mine = scope?.querySelector(".gsm-hoshidicts-mine-button");
    if (!mine) return;
    event.preventDefault();
    mine.click();
    return;
  } else return;
  if (next < 0 || next >= state.entries.length) {
    // j/k past either end are swallowed so the body does not jump; an unused
    // digit is left to whoever else wants it.
    if (key === "j" || key === "k" || inList) event.preventDefault();
    return;
  }
  event.preventDefault();
  select(state, next, { scroll: true, focus: inList });
}

function onClick(event, state) {
  const target = event.target;
  if (typeof target?.closest !== "function") return;
  const row = target.closest(".rt-row");
  if (row && state.list?.contains(row)) {
    select(state, Number(row.dataset.rtIndex), { scroll: true, focus: true });
    return;
  }
  // A click inside a record makes it current, as the reader does for its keybinds.
  const entry = target.closest(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry");
  const index = entry ? state.entries.indexOf(entry) : -1;
  if (index >= 0 && index !== state.selected) select(state, index, { scroll: false });
}

// Listeners live on the popup, which persists across renders; scroll does not
// bubble, so it is captured there (the reader listens the same way).
function bind(popup, state) {
  state.onKeyDown = event => onKeyDown(event, state);
  state.onClick = event => onClick(event, state);
  state.onScroll = event => { if (event.target === state.content) syncFromScroll(state); };
  popup.addEventListener("keydown", state.onKeyDown);
  popup.addEventListener("click", state.onClick);
  popup.addEventListener("scroll", state.onScroll, { capture: true, passive: true });
  boundPopups.add(popup);
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind !== "term" && view.kind !== "kanji") return;
    const popup = view.popup;
    let state = states.get(popup);
    if (!state) {
      state = { popup, content: view.content, kind: view.kind, header: null, entries: [], rows: [], rowsByEntry: new Map(),
        list: null, status: null, selected: 0, expectedScrollTop: null };
      states.set(popup, state);
      bind(popup, state);
    }
    // A new lookup, dictionary tab or Back starts at the first record; "Show more"
    // keeps the current one (its first entry is the same node).
    const fresh = state.kind !== view.kind || state.entries[0] !== view.entries[0];
    state.kind = view.kind;
    state.content = view.content;
    state.entries = [...view.entries];
    state.header = view.chrome?.querySelector(".gsm-hoshidicts-primary-header") ?? null;
    if (view.kind === "term") renderTerm(view, api, state);
    else renderKanji(view, api, state);
    buildStatus(view, api, state);
    select(state, fresh ? 0 : state.selected, { scroll: false });
    api.requestLayout();
  },
  onDeactivate() {
    for (const popup of boundPopups) {
      const state = states.get(popup);
      if (state) {
        popup.removeEventListener("keydown", state.onKeyDown);
        popup.removeEventListener("click", state.onClick);
        popup.removeEventListener("scroll", state.onScroll, { capture: true });
        states.delete(popup);
      }
      for (const node of popup.querySelectorAll(".rt-list, .rt-status, .rt-reading, .rt-trace, .rt-stats")) node.remove();
      for (const node of popup.querySelectorAll(`[data-theme-hidden="${SLUG}"]`)) {
        node.hidden = false;
        delete node.dataset.themeHidden;
      }
      for (const node of popup.querySelectorAll("[data-rt-selected]")) delete node.dataset.rtSelected;
    }
    boundPopups.clear();
  },
};
