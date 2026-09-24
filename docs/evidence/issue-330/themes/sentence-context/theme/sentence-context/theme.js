// themes/sentence-context/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (hachidori-themes CI lint and the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis/timers — only `view` and
//    `api`; DOM is made with api.el and text with ParentNode.append;
//  - a hook that throws switches this module off for the page; CSS keeps working.
//
// What the JavaScript does that CSS cannot:
//  1. Puts the SENTENCE the word came from at the top of the popup
//     (view.source — the text the Anki mining code already sends), with the
//     looked-up word marked. The paragraph carries the renderer's lookup-text
//     class, so hovering any other word in it opens a child popup.
//  2. Turns the renderer's "Why this matched" <details> into a chip trail
//     食べたかった › -た › -たい › 食べる; a step chip reveals its grammar note.
//  3. Builds a sentence-tools row: Copy sentence (api.copyText), a "Mark words"
//     toggle that underlines the other likely words in the sentence, and the
//     renderer's own Anki / audio / Note buttons moved in whole (the Anki button
//     already carries the sentence; nothing is re-implemented).
//  4. Remembers, for the page, the toggle and the last word › lemma per popup
//     depth so the kanji view can show sentence › word › lemma › kanji.

const SLUG = "sentence-context";

// Per-page memory: module scope lives as long as the content script does.
const state = {
  markWords: false,     // the "Mark words" toggle
  trails: new Map(),    // popup depth -> { matched, lemma } from the last term render
};

// ---- sentence window ---------------------------------------------------------
// The renderer's sentence can run to ~400 characters. The masthead shows a
// window around the word; Copy still copies the whole sentence.
const WINDOW_MAX = 110;
const WINDOW_BEFORE = 44;
const WINDOW_AFTER = 56;
const SNAP = 12;
const BOUNDARY = /[、。！？!?…「」『』（）()\s]/u;

function windowOf(sentence, offset, length) {
  if (sentence.length <= WINDOW_MAX) return { text: sentence, offset, leading: false, trailing: false };
  let start = Math.max(0, offset - WINDOW_BEFORE);
  let end = Math.min(sentence.length, offset + length + WINDOW_AFTER);
  // Prefer to cut just after a punctuation mark or space when one is near.
  for (let i = start; i < Math.min(start + SNAP, offset); i += 1) {
    if (BOUNDARY.test(sentence[i])) { start = i + 1; break; }
  }
  for (let i = end - 1; i > Math.max(end - SNAP, offset + length); i -= 1) {
    if (BOUNDARY.test(sentence[i])) { end = i + 1; break; }
  }
  return { text: sentence.slice(start, end), offset: offset - start, leading: start > 0, trailing: end < sentence.length };
}

// ---- word candidates ---------------------------------------------------------
// A script-run heuristic, not a segmentation: kanji runs keep their okurigana,
// katakana runs are words, kana runs lose a trailing particle. Real dictionary
// confirmation would need the engine (see "API gaps" in the proposal).
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}々〆]/u;
const HIRAGANA = /[\u3041-\u309f]/u;
const KATAKANA = /[\u30a0-\u30fa\u30fd-\u30ff\u31f0-\u31ff]/u;
const EXTENDER = /[ー〜]/u;
const PARTICLE_HEAD = /^[をがはにのとでもへや]/u;
const OKURIGANA_GA = /^が[るっらりれろ]/u;        // 上がる, 曲がった: が that is not a particle
const PARTICLE_TAIL = /(?:から|まで|ので|のに|けど|って|とか|だけ|しか|には|とは|では|へは|にも|とも|でも|[をがはにのとでもへやかねよわ])$/u;

function classOf(character, previous) {
  if (KANJI.test(character)) return "K";
  if (HIRAGANA.test(character)) return "H";
  if (KATAKANA.test(character)) return "T";
  if (EXTENDER.test(character) && (previous === "H" || previous === "T")) return previous;
  return "X";
}

// Splits text into same-script runs: [{ text, kind }].
function runsOf(text) {
  const runs = [];
  let current = null;
  for (const character of text) {
    const kind = classOf(character, current?.kind ?? null);
    if (current && current.kind === kind) current.text += character;
    else runs.push(current = { text: character, kind });
  }
  return runs;
}

function stripTail(text) {
  // Two passes: 上がるのは → 上がるの → 上がる.
  const stripped = text.replace(PARTICLE_TAIL, "").replace(PARTICLE_TAIL, "");
  return stripped.length >= 2 ? stripped : "";
}

// [{ text, word }] covering `text`; `word` marks a likely dictionary word.
function segment(text) {
  const pieces = [];
  const push = (value, word) => { if (value) pieces.push({ text: value, word }); };
  const runs = runsOf(text);
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const next = runs[i + 1];
    if (run.kind === "K") {
      // Kanji keep their okurigana (食べたかった, 新しい) unless the kana that
      // follow start with a particle (本を, 彼女の); が is ambiguous (上がる).
      const okurigana = next?.kind === "H" && (!PARTICLE_HEAD.test(next.text) || OKURIGANA_GA.test(next.text))
        ? next.text.replace(PARTICLE_TAIL, "").replace(PARTICLE_TAIL, "")
        : "";
      push(run.text + okurigana, true);
      if (okurigana) {
        push(next.text.slice(okurigana.length), false);
        i += 1;
      }
    } else if (run.kind === "T") {
      push(run.text, true);
    } else if (run.kind === "H") {
      // A kana run on its own: drop a leading particle, then a trailing one.
      const head = run.text.length > 1 && PARTICLE_HEAD.test(run.text) ? 1 : 0;
      const word = stripTail(run.text.slice(head));
      push(run.text.slice(0, head), false);
      push(word, true);
      push(run.text.slice(head + word.length), false);
    } else {
      push(run.text, false);
    }
  }
  return pieces;
}

function appendRuns(parent, text, api) {
  for (const piece of segment(text)) {
    if (piece.word) parent.appendChild(api.el("span", "sc-word", piece.text));
    else parent.append(piece.text);
  }
}

// The sentence paragraph. `character` (kanji view) gets extra emphasis inside
// the marked word. The lookup-text class makes the paragraph hoverable for
// child popups exactly like a definition.
function buildSentence(source, api, character) {
  const sentence = source.sentence;
  const valid = source.matchLength > 0 && source.matchOffset >= 0 && source.matchOffset + source.matchLength <= sentence.length;
  const offset = valid ? source.matchOffset : 0;
  const length = valid ? source.matchLength : 0;
  const shown = windowOf(sentence, offset, length);
  const paragraph = api.el("p", "sc-sentence gsm-hoshidicts-glossary-content");
  paragraph.setAttribute("lang", "ja");
  if (shown.leading) paragraph.appendChild(api.el("span", "sc-ellipsis", "…"));
  appendRuns(paragraph, shown.text.slice(0, shown.offset), api);
  if (length > 0) {
    const mark = api.el("mark", "sc-match");
    const word = shown.text.slice(shown.offset, shown.offset + length);
    if (character && word.includes(character)) {
      for (const glyph of word) {
        if (glyph === character) mark.appendChild(api.el("b", "sc-kanji", glyph));
        else mark.append(glyph);
      }
    } else {
      mark.textContent = word;
    }
    paragraph.appendChild(mark);
  }
  appendRuns(paragraph, shown.text.slice(shown.offset + length), api);
  if (shown.trailing) paragraph.appendChild(api.el("span", "sc-ellipsis", "…"));
  return paragraph;
}

// ---- deconjugation trail -----------------------------------------------------
// The renderer labels the headword "<expression>, <reading>" (popup.js:3199).
function expressionOf(headword) {
  const label = headword?.querySelector(".gsm-hoshidicts-expression")?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? label.slice(0, comma) : label;
}

// Reads the renderer's "Why this matched" disclosure (popup.js:267-322).
function readTrail(headword) {
  const details = headword?.querySelector(":scope > .gsm-hoshidicts-deinflection");
  if (!details) return null;
  const endpoints = details.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint");
  const steps = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-steps > li")].map(item => ({
    name: item.querySelector(".gsm-hoshidicts-deinflection-step-name")?.textContent ?? item.textContent,
    description: item.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "",
  }));
  return { details, matched: endpoints[0]?.textContent ?? "", lemma: endpoints[1]?.textContent ?? "", steps };
}

function chip(api, className, text) {
  const item = api.el("li", "sc-trail-item");
  item.appendChild(api.el("span", `sc-chip ${className}`, text));
  return item;
}

function stepChip(api, step, note, trail) {
  const item = api.el("li", "sc-trail-item");
  const button = api.el("button", "sc-chip sc-chip-step", step.name);
  button.type = "button";
  button.title = step.description;
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") === "true";
    for (const other of trail.querySelectorAll("[aria-expanded='true']")) other.setAttribute("aria-expanded", "false");
    note.hidden = open;
    if (!open) {
      button.setAttribute("aria-expanded", "true");
      note.textContent = "";
      note.append(api.el("b", "sc-trail-note-name", step.name), " ", step.description);
    }
    api.requestLayout();
  });
  item.appendChild(button);
  return item;
}

// 食べたかった › -た › -たい › 食べる. Steps with a dictionary note are buttons
// that reveal the note under the trail; the note element is returned separately
// so it can sit below the tools row.
function buildTrail(trail, api) {
  const list = api.el("ol", "sc-trail");
  list.setAttribute("aria-label", "Deconjugation trail");
  const note = api.el("p", "sc-trail-note");
  note.hidden = true;
  list.appendChild(chip(api, "sc-chip-form", trail.matched));
  for (const step of trail.steps) {
    list.appendChild(step.description ? stepChip(api, step, note, list) : chip(api, "sc-chip-step", step.name));
  }
  list.appendChild(chip(api, "sc-chip-lemma", trail.lemma));
  return { list, note };
}

// Kanji view: sentence › word › lemma › kanji, from what the term render left.
function buildCrumbs(remembered, character, api) {
  const list = api.el("ol", "sc-trail sc-trail-kanji");
  list.setAttribute("aria-label", "Where this kanji came from");
  if (remembered?.matched) list.appendChild(chip(api, "sc-chip-form", remembered.matched));
  if (remembered?.lemma && remembered.lemma !== remembered.matched) list.appendChild(chip(api, "sc-chip-lemma", remembered.lemma));
  list.appendChild(chip(api, "sc-chip-kanji", character));
  return list;
}

// ---- sentence tools ----------------------------------------------------------
function textButton(api, className, text) {
  const button = api.el("button", `sc-button ${className}`);
  button.type = "button";
  button.appendChild(api.el("span", "sc-button-label", text));
  return button;
}

// Copy uses api.copyText (an API the proposal asks for). Feedback is a label
// change that resets when the pointer or focus leaves — no timers needed.
function copyButton(sentence, api) {
  const button = textButton(api, "sc-copy", "Copy sentence");
  button.title = "Copy the whole sentence to the clipboard";
  const label = button.firstChild;
  const reset = () => {
    if (!button.dataset.state) return;
    delete button.dataset.state;
    label.textContent = "Copy sentence";
  };
  button.addEventListener("click", () => {
    api.copyText(sentence).then(
      () => { button.dataset.state = "copied"; label.textContent = "Copied"; },
      () => { button.dataset.state = "failed"; label.textContent = "Copy failed"; },
    );
  });
  button.addEventListener("pointerleave", reset);
  button.addEventListener("blur", reset);
  return button;
}

function markButton(paragraph, api) {
  const button = textButton(api, "sc-mark", "Mark words");
  button.title = "Underline the other likely words in the sentence; hover one to look it up";
  const apply = () => {
    button.setAttribute("aria-pressed", String(state.markWords));
    paragraph.classList.toggle("sc-marked", state.markWords);
  };
  apply();
  button.addEventListener("click", () => {
    state.markWords = !state.markWords;
    apply();
  });
  return button;
}

// The renderer's action group (Back/Close, Anki, audio, Note, custom buttons)
// moves here WHOLE: the Anki binding is keyed on that element and Alt+E/Alt+V
// look inside it, so it must stay one group. The theme's own buttons sit beside it.
function buildTools(actions, source, paragraph, api) {
  const tools = api.el("div", "sc-tools");
  const own = api.el("div", "sc-tools-own");
  own.setAttribute("role", "group");
  own.setAttribute("aria-label", "Sentence tools");
  if (source && typeof api.copyText === "function") own.appendChild(copyButton(source.sentence, api));
  if (paragraph) own.appendChild(markButton(paragraph, api));
  if (own.childElementCount > 0) tools.appendChild(own);
  if (actions) api.move(actions, tools);
  return tools;
}

// ---- views -------------------------------------------------------------------
function renderTerm(view, api) {
  const { chrome } = view;
  if (!chrome) return;
  const header = chrome.querySelector(":scope > .gsm-hoshidicts-primary-header");
  const headword = header?.querySelector(":scope > .gsm-hoshidicts-headword");
  // A tab switch or Show more re-renders the entries but not the top bar; the
  // frequency / grammar capsule comes back into the first entry and moves up again.
  const capsuleRow = view.entries[0]?.querySelector(":scope > .gsm-hoshidicts-primary-metadata-row");
  if (capsuleRow && header) api.move(capsuleRow, header);
  if (chrome.querySelector(":scope > .sc-masthead")) return;

  const trail = readTrail(headword);
  if (trail) api.hide(trail.details);
  state.trails.set(view.depth, trail
    ? { matched: trail.matched, lemma: trail.lemma }
    : { matched: expressionOf(headword), lemma: "" });

  const masthead = api.el("header", "sc-masthead");
  const paragraph = view.source ? buildSentence(view.source, api, null) : null;
  if (paragraph) masthead.appendChild(paragraph);
  const row = api.el("div", "sc-row");
  const built = trail ? buildTrail(trail, api) : null;
  if (built) row.appendChild(built.list);
  row.appendChild(buildTools(header?.querySelector(":scope > .gsm-hoshidicts-entry-actions"), view.source, paragraph, api));
  masthead.appendChild(row);
  if (built) masthead.appendChild(built.note);
  api.move(masthead, chrome, chrome.firstChild);
}

function renderKanji(view, api) {
  const { chrome } = view;
  if (!chrome || chrome.querySelector(":scope > .sc-masthead")) return;
  const header = chrome.querySelector(":scope > .gsm-hoshidicts-primary-header");
  const character = view.source?.character || header?.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent || "";
  const masthead = api.el("header", "sc-masthead");
  const paragraph = view.source ? buildSentence(view.source, api, character) : null;
  if (paragraph) masthead.appendChild(paragraph);
  const row = api.el("div", "sc-row");
  row.appendChild(buildCrumbs(state.trails.get(view.depth), character, api));
  row.appendChild(buildTools(header?.querySelector(":scope > .gsm-hoshidicts-entry-actions"), view.source, paragraph, api));
  masthead.appendChild(row);
  api.move(masthead, chrome, chrome.firstChild);
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    api.requestLayout();
  },
};
