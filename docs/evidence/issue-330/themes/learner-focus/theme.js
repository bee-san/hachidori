// themes/learner-focus/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (hachidori-themes CI lint + the reader's host): one default export,
// synchronous hooks, only `view` and `api`; no import, no globals, no network,
// no timers, no observers, no HTML strings. A hook that throws switches this
// module off for the page; theme.css keeps working on its own.
//
// Learner Focus — progressive disclosure. The renderer produces the complete
// popup; this module decides what a learner sees first and reveals the rest in
// layers:
//
//   0 focus         big headword · reading with the pitch drawn on it · one gloss
//   1 senses        every sense of the first dictionary
//   2 details       frequency, pitch badge, tags, examples
//   3 dictionaries  the other dictionaries, shorter matches, dictionary tabs
//   4 kanji         one row per kanji of the word (reading, meaning when a
//                   single-kanji entry is among the results, tap to open it)
//   ✓ known         after "Knew it": the whole popup is one line
//
// Renderer nodes are never removed or re-ordered: layers toggle the theme's own
// `lf-collapsed` class (theme.css collapses it), so Back, tab switches and the
// definition blur keep working on the same DOM. Everything the theme adds is its
// own `api.el()` element, rebuilt on every render, which keeps the hook
// idempotent.

const SLUG = "learner-focus";
const LAYERS = [
  { label: "Focus", hint: "one gloss" },
  { label: "Senses", hint: "every sense of the first dictionary" },
  { label: "Details", hint: "frequency, pitch, tags, examples" },
  { label: "Dictionaries", hint: "other dictionaries and shorter matches" },
  { label: "Kanji", hint: "the kanji of this word" },
];
const KNOWN = -1;
const ACCENT_TYPES = {
  heiban: { ja: "平板", romaji: "heiban", note: "flat: rises after the first mora and stays high" },
  atamadaka: { ja: "頭高", romaji: "atamadaka", note: "high on the first mora, then falls" },
  nakadaka: { ja: "中高", romaji: "nakadaka", note: "rises, then falls inside the word" },
  odaka: { ja: "尾高", romaji: "odaka", note: "high to the end, falls on the particle" },
};
const KANJI_STATS = [
  ["strokes", value => `${value} strokes`],
  ["grade", value => {
    const grade = Number(value);
    if (grade >= 1 && grade <= 6) return `Grade ${grade} (elementary)`;
    if (grade === 8) return "Secondary school";
    if (grade === 9 || grade === 10) return "Used in names";
    return `Grade ${value}`;
  }],
  ["freq", value => `#${value} most used`],
  ["jlpt", value => `JLPT N${value}`],
];

// Session memory. The theme API has no storage (see the proposal's API gaps), so
// this module — loaded once per page — is the memory: it lasts for the page.
const known = new Set();          // "expression|reading" of words marked "knew it"
const seen = new Set();           // words looked up on this page
const states = new WeakMap();     // popup element -> { key, layer, reveal, handler }

// ---------------------------------------------------------------------------
// Small helpers

function text(node) {
  return node ? node.textContent.replace(/\s+/gu, " ").trim() : "";
}

// The renderer labels the headword "<expression>, <reading>" (popup.js:3193).
function splitLabel(expression) {
  const label = expression.getAttribute("aria-label") || text(expression);
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { expression: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { expression: label, reading: label };
}

function setCollapsed(node, collapsed) {
  if (node) node.classList.toggle("lf-collapsed", collapsed);
}

function button(api, className, label, title) {
  const element = api.el("button", className, label);
  element.type = "button";
  if (title) element.title = title;
  return element;
}

// ---------------------------------------------------------------------------
// Reading + pitch

// Pitch furigana (glossary.js:428-470) puts one <rt> per furigana segment, each
// holding the morae of that segment; concatenated in order they are the whole
// reading with high/low levels and the drop. The pitch badge (popup.js:610-664)
// carries the same morae when the furigana is switched off.
function readPitch(expression, entry) {
  const collect = root => root
    ? [...root.querySelectorAll(".gsm-hoshidicts-pitch-mora")].map(mora => ({
        text: text(mora), level: mora.dataset.pitchLevel || null, transition: mora.dataset.pitchTransition || null,
      }))
    : [];
  let morae = collect(expression);
  let position = null;
  const rt = expression.querySelector("rt[data-pitch-position]");
  if (morae.length && rt) position = Number(rt.dataset.pitchPosition);
  if (!morae.length && entry) {
    const badge = entry.querySelector(".gsm-hoshidicts-tag-pitch");
    morae = collect(badge);
    const match = /\[(\d+)\]/u.exec(badge?.dataset.pronunciation || "");
    if (match) position = Number(match[1]);
  }
  return { morae, position: Number.isInteger(position) ? position : null };
}

function accentType(position, moraCount) {
  if (position === 0) return ACCENT_TYPES.heiban;
  if (position === 1) return ACCENT_TYPES.atamadaka;
  if (position === moraCount) return ACCENT_TYPES.odaka;
  return ACCENT_TYPES.nakadaka;
}

// The reading as one <span> per mora; theme.css draws the pitch on them (high
// morae carry the line above, low morae the line below, the drop a tick).
function buildReading(api, reading, pitch) {
  const line = api.el("span", "lf-morae");
  line.lang = "ja";
  if (pitch.morae.length) {
    for (const mora of pitch.morae) {
      const span = api.el("span", "lf-mora", mora.text);
      if (mora.level) span.dataset.level = mora.level;
      if (mora.transition) span.dataset.transition = mora.transition;
      line.appendChild(span);
    }
  } else {
    for (const character of Array.from(reading)) line.appendChild(api.el("span", "lf-mora", character));
  }
  const type = pitch.position === null ? null : accentType(pitch.position, pitch.morae.length);
  line.setAttribute("aria-label", type
    ? `Reading ${reading}, pitch accent ${pitch.position}, ${type.romaji}`
    : `Reading ${reading}`);
  return { line, type };
}

// ---------------------------------------------------------------------------
// Glossary text

// The first sense of a glossary card as plain text. Jitendex/JMdict mark their
// structure with data-sc-content (glossary.js:963-1000); other dictionaries give
// their first list item, or their text.
function firstSense(content) {
  if (!content) return "";
  const glossary = content.querySelector('[data-sc-content="glossary"]');
  if (glossary) {
    const items = [...glossary.children].map(text).filter(Boolean);
    return items.slice(0, 3).join("; ") + (items.length > 3 ? " …" : "");
  }
  const item = content.querySelector(".gloss-item, ol > li, ul > li");
  return text(item || content);
}

function senseCount(content) {
  if (!content) return 0;
  const marked = content.querySelectorAll('[data-sc-content="sense"]').length;
  if (marked) return marked;
  return content.querySelectorAll(":scope > .gloss-list > .gloss-item, :scope > ol > li, :scope > ul > li").length || 1;
}

// Part-of-speech chips: Jitendex's tags inside the first sense group, else the
// renderer's grammar tags when the user shows them.
function partsOfSpeech(entry, content) {
  const group = content?.querySelector('[data-sc-content="sense-group"]') || content;
  const spans = group ? [...group.querySelectorAll(':scope > [data-sc-content="part-of-speech-info"]')] : [];
  if (spans.length) return spans.map(span => ({ text: text(span), title: span.title || "" }));
  const tags = entry?.querySelectorAll(".gsm-hoshidicts-primary-grammar-tag-term, .gsm-hoshidicts-tags .gsm-hoshidicts-tag-term") || [];
  return [...tags].map(tag => ({ text: text(tag), title: tag.title || "" }));
}

// The results also hold the shorter matches (食べる → 食): a single-kanji entry
// from any term dictionary gives that kanji a meaning without a lookup. Bee's
// Ultimate Kanji Dictionary marks its keyword and meaning (data-sc-bee-role).
function kanjiMeaning(character, entries) {
  let fallback = null;
  for (const entry of entries) {
    if (entry.dataset.expression !== character) continue;
    for (const card of entry.querySelectorAll(".gsm-hoshidicts-glossary-card")) {
      const content = card.querySelector(".gsm-hoshidicts-glossary-content");
      const dictionary = text(card.querySelector(".gsm-hoshidicts-glossary-card-title"));
      const keyword = content?.querySelector('[data-sc-bee-role="hero-keyword"]');
      if (keyword) {
        return { meaning: text(content.querySelector('[data-sc-bee-role="meaning"]')) || text(keyword), dictionary };
      }
      const sense = firstSense(content);
      if (sense && !fallback) fallback = { meaning: sense, dictionary };
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Term view

function termState(popup, key) {
  let state = states.get(popup);
  if (!state || state.key !== key) {
    state = { key, layer: known.has(key) ? KNOWN : 0, reveal: null, handler: state?.handler ?? null };
    states.set(popup, state);
  }
  return state;
}

function collectTerm(view) {
  const header = view.chrome?.querySelector(".gsm-hoshidicts-primary-header");
  const expression = header?.querySelector(".gsm-hoshidicts-expression");
  if (!header || !expression) return null;
  const entry = view.entries[0] || null;
  const cards = entry ? [...entry.querySelectorAll(":scope > .gsm-hoshidicts-glossary-grid > .gsm-hoshidicts-glossary-card")] : [];
  const word = splitLabel(expression);
  return {
    header, expression, entry, cards, word,
    content: cards[0]?.querySelector(".gsm-hoshidicts-glossary-content") || null,
    key: `${word.expression}|${word.reading}`,
    panel: view.content.querySelector(":scope > .gsm-hoshidicts-tab-panel"),
    strip: view.chrome.querySelector(".gsm-hoshidicts-metadata-strip"),
  };
}

function renderReadingRow(api, term, pitch, stats) {
  const row = api.el("div", "lf-reading");
  const { line, type } = buildReading(api, term.word.reading, pitch);
  row.appendChild(line);
  if (type) {
    const badge = api.el("span", "lf-accent", `${type.ja} [${pitch.position}]`);
    badge.title = `${type.romaji}: ${type.note}`;
    row.appendChild(badge);
  }
  const pos = partsOfSpeech(term.entry, term.content);
  if (pos.length) {
    const list = api.el("span", "lf-pos");
    for (const item of pos.slice(0, 4)) {
      const chip = api.el("span", "lf-pos-chip", item.text);
      if (item.title) chip.title = item.title;
      list.appendChild(chip);
    }
    row.appendChild(list);
  }
  // The reader paints "Looked up N times" into this node whenever the count
  // arrives (content.js:2398); moving it keeps that working and shows it here.
  if (stats) api.move(stats, row);
  return row;
}

function renderFocus(api, term) {
  const focus = api.el("section", "lf-focus");
  focus.setAttribute("aria-label", "Focus");
  const gloss = firstSense(term.content);
  focus.appendChild(api.el("p", "lf-gloss", gloss || "No definition in the first dictionary"));
  const senses = senseCount(term.content);
  const others = term.cards.length - 1;
  const bits = [];
  if (term.cards[0]) bits.push(text(term.cards[0].querySelector(".gsm-hoshidicts-glossary-card-title")));
  if (senses > 1) bits.push(`sense 1 of ${senses}`);
  if (others > 0) bits.push(`${others} more ${others === 1 ? "dictionary" : "dictionaries"}`);
  if (bits.length) focus.appendChild(api.el("p", "lf-gloss-meta", bits.join(" · ")));
  focus.appendChild(api.el("p", "lf-prompt", "Did you know it?"));
  return focus;
}

function renderKnownLine(api, term, pitch, actions) {
  const line = api.el("section", "lf-known");
  line.setAttribute("aria-label", "Known word");
  line.appendChild(api.el("span", "lf-known-mark", "✓"));
  const word = api.el("span", "lf-known-word", term.word.expression);
  word.lang = "ja";
  line.appendChild(word);
  const { line: reading } = buildReading(api, term.word.reading, pitch);
  reading.classList.add("lf-morae-small");
  line.appendChild(reading);
  line.appendChild(api.el("span", "lf-known-gloss", firstSense(term.content)));
  const show = button(api, "lf-link", "Show", "Show the definition anyway (2)");
  show.addEventListener("click", () => actions.setLayer(1));
  const forget = button(api, "lf-link lf-link-muted", "Forget", "Take this word off the known list (1)");
  forget.addEventListener("click", actions.toggleKnown);
  line.append(show, forget);
  return line;
}

function renderKanjiTable(api, term, entries) {
  const links = [...term.expression.querySelectorAll(".gsm-hoshidicts-kanji-link")];
  if (!links.length) return null;
  const table = api.el("section", "lf-kanji");
  table.setAttribute("aria-label", "Kanji in this word");
  table.appendChild(api.el("h3", "lf-section-title", "Kanji in this word"));
  const rows = api.el("div", "lf-kanji-rows");
  rows.setAttribute("role", "list");
  for (const link of links) {
    const character = text(link);
    const ruby = link.closest("ruby");
    const siblings = ruby ? ruby.querySelectorAll(".gsm-hoshidicts-kanji-link").length : 0;
    const rt = ruby?.querySelector("rt");
    const segment = rt ? [...rt.querySelectorAll(".gsm-hoshidicts-pitch-mora")].map(text).join("") || text(rt) : "";
    // A segment that reads several kanji at once (図書館 → としょかん) says
    // nothing about this kanji alone; the header already shows the word.
    const reading = siblings === 1 ? segment : "";
    const found = kanjiMeaning(character, entries);
    const row = button(api, "lf-kanji-row", null, `Open the kanji view for ${character}`);
    row.setAttribute("role", "listitem");
    const glyph = api.el("span", "lf-kanji-glyph", character);
    glyph.lang = "ja";
    const readingCell = api.el("span", "lf-kanji-reading", reading);
    readingCell.lang = "ja";
    row.append(glyph, readingCell,
      api.el("span", found ? "lf-kanji-meaning" : "lf-kanji-meaning lf-kanji-meaning-empty", found ? found.meaning : "tap to look up"),
      api.el("span", "lf-kanji-source", found ? found.dictionary : ""));
    // The renderer's own kanji button opens the kanji view (glossary.js:404).
    row.addEventListener("click", () => link.click());
    rows.appendChild(row);
  }
  table.appendChild(rows);
  return table;
}

function renderFooter(api, state, actions) {
  const footer = api.el("footer", "lf-footer");
  const rail = api.el("div", "lf-rail");
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "Detail layers");
  LAYERS.forEach((layer, index) => {
    const current = index === state.layer;
    const step = button(api, "lf-rail-step", current ? layer.label : null, `${layer.label}: ${layer.hint}`);
    step.setAttribute("aria-label", layer.label);
    if (current) step.setAttribute("aria-current", "true");
    if (index < state.layer) step.classList.add("lf-rail-step-open");
    step.addEventListener("click", () => actions.setLayer(index));
    rail.appendChild(step);
  });
  const controls = api.el("div", "lf-controls");
  const knew = button(api, "lf-btn lf-btn-knew", null, "Mark this word as known; next time it renders as one line");
  knew.append(api.el("kbd", "lf-kbd", "1"), api.el("span", null, "Knew it"));
  knew.addEventListener("click", actions.toggleKnown);
  const next = LAYERS[state.layer + 1];
  const more = button(api, "lf-btn lf-btn-more", null, next ? `${next.label}: ${next.hint}` : "Back to the focus view");
  more.append(api.el("kbd", "lf-kbd", "2"), api.el("span", null, next ? `${next.label} ▸` : "◂ Focus"));
  more.addEventListener("click", () => actions.setLayer(next ? state.layer + 1 : 0));
  controls.append(knew, more);
  footer.append(rail, controls);
  return footer;
}

// "3 new · 1 known": words looked up on this page that were not marked known,
// and words marked known. Sits in the header band under the action buttons.
function renderSession(api) {
  const fresh = [...seen].filter(key => !known.has(key)).length;
  const session = api.el("span", "lf-session", `${fresh} new · ${known.size} known`);
  session.title = `${fresh} new ${fresh === 1 ? "word" : "words"} looked up on this page · ${known.size} marked known`;
  return session;
}

// Which renderer nodes each layer shows. Anything not listed stays as the
// renderer left it.
function applyLayers(term, view, state) {
  const layer = state.layer;
  const knownLine = layer === KNOWN;
  setCollapsed(view.chrome, knownLine);
  setCollapsed(term.panel, layer < 1);
  setCollapsed(term.strip, layer < 3);
  view.entries.forEach((entry, index) => {
    if (index > 0) {
      setCollapsed(entry, layer < 3);
      return;
    }
    for (const node of entry.querySelectorAll(":scope > .gsm-hoshidicts-primary-metadata-row, :scope > .gsm-hoshidicts-metadata, :scope > .gsm-hoshidicts-tags")) {
      setCollapsed(node, layer < 2);
    }
    const cards = entry.querySelectorAll(":scope > .gsm-hoshidicts-glossary-grid > .gsm-hoshidicts-glossary-card");
    cards.forEach((card, cardIndex) => {
      setCollapsed(card, cardIndex === 0 ? layer < 1 : layer < 3);
      if (cardIndex !== 0) return;
      setCollapsed(card.querySelector(":scope > .gsm-hoshidicts-glossary-card-title"), layer < 2);
      for (const node of card.querySelectorAll('.gsm-hoshidicts-definition-tags, [data-sc-content="extra-info"], [data-sc-content="attribution"], [data-sc-content="forms"]')) {
        setCollapsed(node, layer < 2);
      }
      // The header chips repeat the first sense group's part-of-speech tags.
      const group = card.querySelector('.gsm-hoshidicts-glossary-content [data-sc-content="sense-group"]');
      for (const node of group?.querySelectorAll(':scope > [data-sc-content="part-of-speech-info"]') || []) setCollapsed(node, true);
    });
  });
  setCollapsed(term.panel?.querySelector(":scope > .gsm-hoshidicts-show-more"), layer < 3);
}

function renderTerm(view, api, focusAfter = false) {
  const term = collectTerm(view);
  if (!term) return;
  const state = termState(view.popup, term.key);
  seen.add(term.key);
  const pitch = readPitch(term.expression, term.entry);

  // The reader's lookup-count node: a fresh render puts one in the first entry;
  // between renders it lives in the theme's reading row. It must stay connected
  // (content.js:2394 checks isConnected before painting the count).
  const stats = term.entry?.querySelector(".gsm-hoshidicts-lookup-stats")
    || view.popup.querySelector(".lf-reading .gsm-hoshidicts-lookup-stats") || null;
  // The theme's nodes from the previous render go; each is rebuilt below.
  for (const node of view.popup.querySelectorAll(".lf-reading, .lf-focus, .lf-known, .lf-kanji, .lf-footer, .lf-session")) node.remove();

  const actions = {
    setLayer(next) {
      const from = state.layer;
      state.layer = Math.max(0, Math.min(LAYERS.length - 1, next));
      state.reveal = state.layer > from;
      renderTerm(view, api, true);
    },
    toggleKnown() {
      if (known.has(term.key)) known.delete(term.key); else known.add(term.key);
      state.layer = known.has(term.key) ? KNOWN : 0;
      state.reveal = false;
      renderTerm(view, api, true);
    },
  };

  if (state.layer === KNOWN) {
    const home = term.entry?.querySelector(":scope > .gsm-hoshidicts-primary-metadata-row");
    if (stats && home && stats.parentNode !== home) api.move(stats, home, home.firstChild);
    view.content.insertBefore(renderKnownLine(api, term, pitch, actions), view.content.firstChild);
  } else {
    term.expression.after(renderReadingRow(api, term, pitch, stats));
    if (state.layer === 0) view.content.insertBefore(renderFocus(api, term), view.content.firstChild);
    if (state.layer === LAYERS.length - 1) {
      const table = renderKanjiTable(api, term, view.entries);
      if (table) view.content.insertBefore(table, view.content.firstChild);
    }
    view.content.appendChild(renderFooter(api, state, actions));
    view.chrome.appendChild(renderSession(api));
  }
  for (const node of view.popup.querySelectorAll(".gsm-hoshidicts-compact-definition-summary")) api.hide(node);
  applyLayers(term, view, state);

  // Newly revealed nodes slide in (theme.css transitions, none under
  // prefers-reduced-motion): reading the layout flushes the entering style so
  // that removing the class right away is a transition, not a jump. Themes have
  // no timers, so this is the one way to start one.
  if (state.reveal) {
    const revealed = [...view.content.querySelectorAll(".gsm-hoshidicts-glossary-card, .gsm-hoshidicts-entry, .lf-kanji")]
      .filter(node => !node.closest(".lf-collapsed"));
    for (const node of revealed) node.classList.add("lf-enter");
    void view.content.getBoundingClientRect().width;
    for (const node of revealed) node.classList.remove("lf-enter");
    // Layer 3 starts below the first dictionary: bring the other dictionaries
    // to the top of the body; every other layer starts at the top.
    const target = state.layer === 3 ? (term.cards[1] || view.entries[1] || null) : null;
    view.content.scrollTop = target
      ? target.getBoundingClientRect().top - view.content.getBoundingClientRect().top + view.content.scrollTop - 8
      : 0;
    state.reveal = false;
  }
  // After a click or a key the popup keeps the focus so 1 / 2 / 0 keep working;
  // a hover never takes focus away from the page.
  if (focusAfter) view.popup.querySelector(".lf-btn-more, .lf-link")?.focus({ preventScroll: true });
  bindKeys(view, state, actions);
}

// 1 knew it · 2 next layer · 0 back to focus — while focus is inside the popup
// (after a click on it, or Tab). The host owns the page's keyboard; forwarding
// keys to a theme while the popup is open is one of the proposal's API gaps.
function bindKeys(view, state, actions) {
  if (state.handler) view.popup.removeEventListener("keydown", state.handler);
  state.handler = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
    if (event.key === "1") actions.toggleKnown();
    else if (event.key === "2") actions.setLayer(state.layer >= LAYERS.length - 1 ? 0 : state.layer + 1);
    else if (event.key === "0") actions.setLayer(0);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  view.popup.addEventListener("keydown", state.handler);
}

// ---------------------------------------------------------------------------
// Kanji view: a breadcrumb back to the word, and the few statistics a learner
// reads (strokes, school grade, frequency rank, JLPT) lifted out of the
// "Details" list into chips. theme.css lays the rest out.

function renderKanji(view, api) {
  const state = states.get(view.popup);
  for (const node of view.popup.querySelectorAll(".lf-crumb, .lf-kanji-stats")) node.remove();
  const glyph = view.chrome?.querySelector(".gsm-hoshidicts-kanji-glyph");
  if (glyph && state?.key) {
    const [expression, reading] = state.key.split("|");
    const crumb = api.el("span", "lf-crumb");
    crumb.lang = "ja";
    crumb.append(api.el("span", "lf-crumb-label", "in"), api.el("span", "lf-crumb-word", expression));
    if (reading && reading !== expression) crumb.appendChild(api.el("span", "lf-crumb-reading", reading));
    glyph.after(crumb);
  }
  for (const entry of view.entries) {
    const stats = entry.querySelector(":scope > .gsm-hoshidicts-kanji-stats dl");
    if (!stats) continue;
    const values = new Map();
    for (const dt of stats.querySelectorAll("dt")) values.set(text(dt), text(dt.nextElementSibling));
    const chips = api.el("div", "lf-kanji-stats");
    for (const [key, format] of KANJI_STATS) {
      if (values.get(key)) chips.appendChild(api.el("span", "lf-stat", format(values.get(key))));
    }
    if (chips.childNodes.length) entry.querySelector(":scope > .gsm-hoshidicts-kanji-readings")?.before(chips);
  }
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    api.hide(view.popup.querySelector(":scope > .gsm-hoshidicts-resize-handle"));
    api.requestLayout();
  },
};
