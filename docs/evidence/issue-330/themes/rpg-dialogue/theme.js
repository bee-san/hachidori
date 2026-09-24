// themes/rpg-dialogue/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (enforced by hachidori-themes CI lint and by the reader's host):
//  - one default export; hooks are synchronous and return nothing;
//  - no import/export other than this default, no fetch/XHR/WebSocket, no
//    chrome.*/browser.*, no window/document/globalThis, no timers, no observers —
//    only `view` and `api`;
//  - a hook that throws switches this module off for the page; CSS keeps working.
//
// The popup becomes a 16-bit RPG message window. The reader still renders its
// ordinary DOM and this module never deletes it. It
//   * pages through the senses: every <li> of every dictionary card of every
//     entry is one "page"; only the current page's entry/card/li is shown
//     (data-rpg-current attributes the CSS switches on);
//   * types the current sense out: each text node of the visible glossary is
//     wrapped in per-character spans whose CSS animation-delay grows with the
//     character index — the browser is the typewriter, no timers needed;
//   * builds a speaker plate above the window (headword whose kanji forward to
//     the reader's real kanji buttons) and a status strip inside it (reading,
//     pitch accent as a segmented HP bar, frequency, lookup count);
//   * builds a command window with a ▶ cursor whose items forward to the
//     reader's own buttons (Anki, audio, Note, custom buttons, Back, Close);
//   * turns the kanji view into an item-description window with an RPG stat
//     block (strokes / grade / freq / JLPT as pip bars).
// Everything it creates carries an rpg-* class; theme.css draws all of it
// (window frames, pixel-art cursors, bird portrait, pixel font) with gradients
// and box-shadow pixels — no images, no fonts, no network.

const SLUG = "rpg-dialogue";
const TYPED_CAP = 120;        // characters typed one by one …
const CHUNK_AFTER_CAP = 16;   // … then at least this many per tick …
const TAIL_TICKS = 80;        // … and the rest of any sense within this many ticks (≈ 1.8 s)
const STATES = new WeakMap(); // popup element → per-popup state
const ACTIVE = new Set();     // popups with live RPG DOM (for onDeactivate)
const BOUND = new WeakSet();  // content scrollers that already listen for taps
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const HAN = /\p{Script=Han}/u;

// ---------------------------------------------------------------------------
// DOM helpers. api.el is the only element factory; append() is only ever
// called on elements this module created, api.move reparents into the popup.

// Pixel-font text: one <i data-ch> per character, drawn by theme.css
// box-shadows. The run is aria-hidden; callers label the container.
function pixelText(api, text, className = "rpg-pxt") {
  const run = api.el("span", className);
  run.setAttribute("aria-hidden", "true");
  for (const ch of String(text).toUpperCase()) {
    const glyph = api.el("i", "rpg-px");
    glyph.dataset.ch = ch === " " ? "_" : ch;
    run.append(glyph);
  }
  return run;
}

function pipBar(api, filled, total) {
  const bar = api.el("span", "rpg-pips");
  bar.setAttribute("aria-hidden", "true");
  for (let index = 0; index < total; index += 1) {
    const pip = api.el("i", "rpg-pip");
    if (index < filled) pip.dataset.on = "";
    bar.append(pip);
  }
  return bar;
}

// The renderer labels the headword "<expression>, <reading>" (popup.js); that
// is the one place the reading exists as plain text.
function splitLabel(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { text: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { text: label, reading: "" };
}

// Characters of the headword in order, each with the reader's kanji button
// when it has one; ruby annotations are skipped.
function expressionRuns(expression) {
  const runs = [];
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        for (const ch of child.data) runs.push({ ch, link: null });
      } else if (child.nodeType === ELEMENT_NODE && child.localName !== "rt") {
        if (child.classList.contains("gsm-hoshidicts-kanji-link")) runs.push({ ch: child.textContent, link: child });
        else walk(child);
      }
    }
  };
  if (expression) walk(expression);
  return runs;
}

// ---------------------------------------------------------------------------
// Typewriter. The text nodes under `root` become per-character spans; each
// span's --i is its tick, and theme.css turns that into animation-delay. Text
// past the cap is grouped so a long sense finishes in a bounded time and DOM.

function tickFor(index, chunk) {
  return index < TYPED_CAP ? index : TYPED_CAP + Math.floor((index - TYPED_CAP) / chunk);
}

function textNodesUnder(root) {
  const texts = [];
  const collect = parent => {
    for (const child of parent.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        if (child.data.trim()) texts.push(child);
      } else if (child.nodeType === ELEMENT_NODE && !child.hidden && !child.classList.contains("rpg-tw")) {
        collect(child);
      }
    }
  };
  collect(root);
  return texts;
}

// Up to the cap every character is its own span; past it each text node (a
// word or phrase in structured content) is one span, and `cursor.chunk` is
// chosen per page so the whole tail lands within TAIL_TICKS ticks. That keeps
// the DOM this adds proportional to the cap, not to the length of the sense.
function prepareTyping(texts, api, cursor) {
  for (const text of texts) {
    const wrapper = api.el("span", "rpg-tw");
    const characters = Array.from(text.data);
    let start = 0;
    while (start < characters.length) {
      const size = cursor.index < TYPED_CAP ? 1 : characters.length - start;
      const span = api.el("span", "rpg-ch", characters.slice(start, start + size).join(""));
      span.style.setProperty("--i", String(tickFor(cursor.index, cursor.chunk)));
      wrapper.append(span);
      cursor.last = span;
      if (!cursor.first) cursor.first = span;
      cursor.index += size;
      start += size;
    }
    api.move(wrapper, text.parentNode, text);
    text.remove();
  }
}

function unwrapTyping(root) {
  for (const wrapper of root.querySelectorAll(".rpg-tw")) wrapper.replaceWith(wrapper.textContent);
}

// ---------------------------------------------------------------------------
// Pages: term view → every definition <li>; kanji view → every kanji entry.

function collectPages(state) {
  if (state.kind === "kanji") return [...state.popup.querySelectorAll(".gsm-hoshidicts-kanji-entry")];
  const pages = [];
  for (const entry of state.popup.querySelectorAll(".gsm-hoshidicts-entry")) {
    pages.push(...entry.querySelectorAll(
      ":scope > .gsm-hoshidicts-glossary-grid > .gsm-hoshidicts-glossary-card > .gsm-hoshidicts-definitions > li"));
  }
  return pages;
}

function pageParts(page) {
  return {
    page,
    card: page.closest(".gsm-hoshidicts-glossary-card"),
    entry: page.closest(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry"),
  };
}

function setCurrent(parts, on) {
  for (const node of [parts.page, parts.card, parts.entry]) {
    if (!node) continue;
    if (on) node.dataset.rpgCurrent = "";
    else delete node.dataset.rpgCurrent;
  }
}

function markTyped(state, page) {
  page.dataset.rpgTyped = "";
  if (state.current === page) updateFooter(state);
}

// Only asked on interaction (advance): getAnimations() forces a style recalc,
// which is fine on a key press but not inside onRender.
function isTyping(state, page) {
  if (page.dataset.rpgTyped !== undefined) return false;
  const last = state.lastSpan.get(page);
  if (!last?.isConnected) return false;
  return last.getAnimations().some(animation => animation.playState === "running" || animation.playState === "pending");
}

// Wrap the glossary (term) or the meanings (kanji) once, when the page is
// first shown; the animation starts the moment the page becomes visible.
function preparePage(state, page, api) {
  if (page.dataset.rpgPrepared !== undefined) return;
  page.dataset.rpgPrepared = "";
  const roots = state.kind === "kanji"
    ? [...page.querySelectorAll(".gsm-hoshidicts-kanji-meanings > li")]
    : [...page.querySelectorAll(":scope > .gsm-hoshidicts-glossary-content")];
  const texts = roots.flatMap(textNodesUnder);
  const total = texts.reduce((sum, text) => sum + text.data.length, 0);
  const cursor = { index: 0, first: null, last: null,
    chunk: Math.max(CHUNK_AFTER_CAP, Math.ceil(Math.max(0, total - TYPED_CAP) / TAIL_TICKS)) };
  prepareTyping(texts, api, cursor);
  if (cursor.last) {
    state.lastSpan.set(page, cursor.last);
    // The first span's animation starting proves animations run at all (they do
    // not under prefers-reduced-motion); the last one ending completes the page.
    cursor.first.addEventListener("animationstart", () => { state.motion = true; }, { once: true });
    cursor.last.addEventListener("animationend", () => markTyped(state, page), { once: true });
  } else {
    page.dataset.rpgTyped = "";
  }
}

function showPage(state, index, api) {
  const pages = state.pages;
  if (pages.length === 0) return;
  const next = Math.max(0, Math.min(pages.length - 1, index));
  const page = pages[next];
  if (state.current && state.current !== page) setCurrent(pageParts(state.current), false);
  state.index = next;
  state.current = page;
  const parts = pageParts(page);
  setCurrent(parts, true);
  preparePage(state, page, api);
  if (parts.entry !== state.entry) {
    state.entry = parts.entry;
    updatePlate(state, api);
    updateStatus(state, api);
  }
  updateLocation(state, parts, api);
  updateFooter(state, api);
  updateMenu(state);
  // Reading or writing scrollTop forces a layout; only reset after a real scroll.
  if (state.scrolled) {
    state.scrolled = false;
    state.content.scrollTop = 0;
  }
  api.requestLayout();
}

function advance(state, api) {
  const page = state.current;
  if (page && page.dataset.rpgTyped === undefined) {
    // Still typing: this press completes the page. With animations off (reduced
    // motion) the text was complete all along, so the press turns the page.
    const typing = isTyping(state, page);
    markTyped(state, page);
    if (typing) return;
  }
  if (state.index + 1 < state.pages.length) {
    showPage(state, state.index + 1, api);
    return;
  }
  // Entries beyond the first arrive progressively; a Show more button means
  // more pages are on their way. Ask for them the way the keybinds do.
  state.popup.querySelector(".gsm-hoshidicts-show-more")?.click();
}

function retreat(state, api) {
  if (state.index > 0) showPage(state, state.index - 1, api);
}

// つぎ: the first page of the next dictionary card (or the next kanji entry).
function nextCard(state, api) {
  const parts = pageParts(state.current);
  const groupOf = candidate => (state.kind === "kanji" ? candidate.entry : candidate.card);
  const group = groupOf(parts);
  const count = state.pages.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (state.index + step) % count;
    if (groupOf(pageParts(state.pages[index])) !== group) {
      showPage(state, index, api);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Where the reader keeps an entry's header and action buttons.

function headerFor(state, entry) {
  return entry?.querySelector(":scope > .gsm-hoshidicts-entry-header")
    || (entry === state.firstEntry ? state.chrome?.querySelector(".gsm-hoshidicts-primary-header") : null);
}

function actionsFor(state, entry) {
  return headerFor(state, entry)?.querySelector(".gsm-hoshidicts-entry-actions") || null;
}

// ---------------------------------------------------------------------------
// Speaker plate (above the window): portrait + name box.

function buildPlate(state, api) {
  const plate = api.el("div", "rpg-plate");
  const portrait = api.el("span", "rpg-bird");
  portrait.setAttribute("role", "img");
  portrait.setAttribute("aria-label", "Hachidori, the narrator");
  const name = api.el("div", "rpg-name");
  plate.append(portrait, name);
  state.plate = plate;
  state.name = name;
  return plate;
}

function updatePlate(state, api) {
  const { name } = state;
  name.replaceChildren();
  if (state.kind === "kanji") {
    const glyph = state.chrome?.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent || "";
    name.dataset.kind = "kanji";
    name.append(api.el("span", "rpg-name-text", glyph));
    name.setAttribute("aria-label", `Kanji ${glyph}`);
    return;
  }
  const header = headerFor(state, state.entry);
  const expression = header?.querySelector(".gsm-hoshidicts-expression");
  const { text, reading } = splitLabel(expression);
  name.dataset.kind = "term";
  const nameText = api.el("span", "rpg-name-text");
  const runs = expressionRuns(expression);
  if (runs.length === 0) nameText.textContent = text;
  for (const run of runs) {
    if (run.link || HAN.test(run.ch)) {
      // Forward to the reader's own kanji button so the kanji view, Back and
      // focus return keep working; the plate is only a proxy for the headword.
      const button = api.el("button", "rpg-kanji", run.ch);
      button.type = "button";
      button.setAttribute("aria-label", `Look up kanji ${run.ch}`);
      const target = run.link;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (target?.isConnected) target.click();
      });
      if (!target) button.disabled = true;
      nameText.append(button);
    } else {
      nameText.append(api.el("span", null, run.ch));
    }
  }
  name.append(nameText);
  name.setAttribute("aria-label", reading && reading !== text ? `${text}, ${reading}` : text);
}

// ---------------------------------------------------------------------------
// Status strip (first row inside the window): reading, pitch HP bar, stats.

function buildStatus(state, api) {
  const status = api.el("div", "rpg-status");
  state.status = status;
  return status;
}

// The header ruby draws one contour per furigana segment; together they hold
// every mora of the reading. Without header furigana the pitch badge has them.
function pitchFor(entry, header) {
  const expression = header?.querySelector(".gsm-hoshidicts-expression");
  let morae = expression ? [...expression.querySelectorAll(".gsm-hoshidicts-pitch-mora")] : [];
  let position = expression?.querySelector(".gsm-hoshidicts-pitch-reading")?.dataset.pitchPosition ?? "";
  if (morae.length === 0) {
    const badge = entry?.querySelector(".gsm-hoshidicts-tag-pitch");
    if (!badge) return null;
    morae = [...badge.querySelectorAll(".gsm-hoshidicts-pitch-mora")];
    position = (badge.querySelector(".gsm-hoshidicts-pitch-position")?.textContent || "").replace(/\D/gu, "");
  }
  return morae.length > 0 ? { morae, position } : null;
}

function buildPitchBar(api, morae, position) {
  const bar = api.el("span", "rpg-pitch");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `Pitch accent [${position}]: ${morae.map(mora =>
    `${mora.textContent} ${mora.dataset.pitchLevel}`).join(", ")}`);
  bar.append(pixelText(api, "PITCH", "rpg-pxt rpg-pitch-label"));
  const track = api.el("span", "rpg-hp");
  for (const mora of morae) {
    const segment = api.el("span", "rpg-hp-seg");
    segment.dataset.level = mora.dataset.pitchLevel || "low";
    if (mora.dataset.pitchTransition) segment.dataset.transition = mora.dataset.pitchTransition;
    segment.append(api.el("i", "rpg-hp-bar"), api.el("span", "rpg-hp-mora", mora.textContent));
    track.append(segment);
  }
  bar.append(track);
  if (position !== "") bar.append(pixelText(api, `[${position}]`, "rpg-pxt rpg-pitch-num"));
  return bar;
}

function updateStatus(state, api) {
  const { status } = state;
  status.replaceChildren();
  const entry = state.entry;
  if (state.kind === "kanji") {
    status.hidden = true;
    return;
  }
  const header = headerFor(state, entry);
  const expression = header?.querySelector(".gsm-hoshidicts-expression");
  const { text, reading } = splitLabel(expression);
  if (reading && reading !== text) status.append(api.el("span", "rpg-reading", reading));
  const pitch = pitchFor(entry, header);
  if (pitch) status.append(buildPitchBar(api, pitch.morae, pitch.position));
  const stats = api.el("span", "rpg-stats");
  const frequency = entry?.querySelector(".gsm-hoshidicts-frequency-value");
  if (frequency) {
    const chip = api.el("span", "rpg-chip rpg-chip-freq");
    chip.setAttribute("aria-label", `Frequency ${frequency.textContent}`);
    chip.append(pixelText(api, "FREQ"), api.el("span", "rpg-chip-value", frequency.textContent));
    stats.append(chip);
  }
  // The lookup count is painted later by the reader: keep its element, move it.
  const lookups = entry?.querySelector(".gsm-hoshidicts-lookup-stats");
  if (lookups) api.move(lookups, stats);
  if (stats.childNodes.length > 0) status.append(stats);
  status.hidden = status.childNodes.length === 0;
}

// Dictionary name, shown like a location banner in the window's footer.
function updateLocation(state, parts, api) {
  const title = state.kind === "kanji"
    ? parts.entry?.querySelector(":scope > .gsm-hoshidicts-kanji-dictionary")
    : parts.card?.querySelector(":scope > .gsm-hoshidicts-glossary-card-title");
  state.location.replaceChildren();
  if (title) state.location.append(api.el("span", null, title.textContent));
}

// ---------------------------------------------------------------------------
// Footer (sticky, bottom of the window): location, page counter, ▼ button.

function buildFooter(state, api) {
  const footer = api.el("div", "rpg-footer");
  const location = api.el("span", "rpg-location");
  const counter = api.el("span", "rpg-counter");
  counter.setAttribute("role", "status");
  const next = api.el("button", "rpg-next");
  next.type = "button";
  next.title = "Next (Space / Enter). ← → turn pages, ↓ opens the commands.";
  next.setAttribute("aria-label", "Next");
  next.append(api.el("i", "rpg-px-down"), api.el("i", "rpg-px-end"));
  next.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    advance(state, api);
  });
  // A mouse press on ▼ must not focus it either (see the tap handler); keyboard
  // users reach it with Tab, which focuses as usual.
  next.addEventListener("pointerdown", event => { if (event.pointerType !== "") event.preventDefault(); });
  next.addEventListener("keydown", event => {
    if (event.key === "ArrowRight") advance(state, api);
    else if (event.key === "ArrowLeft") retreat(state, api);
    else if (event.key === "ArrowDown") state.menu.querySelector(".rpg-cmd:not([hidden])")?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  footer.append(location, counter, next);
  state.footer = footer;
  state.location = location;
  state.counter = counter;
  state.next = next;
  return footer;
}

function updateFooter(state, api = state.api) {
  const total = state.pages.length;
  const number = state.index + 1;
  state.counter.replaceChildren(pixelText(api, `${number}/${total}`));
  state.counter.setAttribute("aria-label", `Page ${number} of ${total}`);
  const typed = state.current ? state.current.dataset.rpgTyped !== undefined : true;
  const more = state.index + 1 < total || Boolean(state.popup.querySelector(".gsm-hoshidicts-show-more"));
  state.footer.dataset.rpgState = !typed ? "typing" : more ? "ready" : "end";
  state.next.setAttribute("aria-label", !typed ? "Show the whole text" : more ? "Next page" : "Last page");
}

// ---------------------------------------------------------------------------
// Command window. Items forward to the reader's buttons; targets are resolved
// at click time so buttons the reader re-binds keep working.

const COMMANDS = [
  { id: "back", label: "もどる", title: "Back", find: state => state.popup.querySelector(".gsm-hoshidicts-kanji-back") },
  { id: "anki", label: "おぼえる", title: "Add to Anki", always: true,
    find: state => actionsFor(state, state.entry)?.querySelector(".gsm-hoshidicts-mine-button") },
  { id: "audio", label: "きく", title: "Play pronunciation",
    find: state => (state.api.options.showPopupAudioButton === false ? null
      : actionsFor(state, state.entry)?.querySelector(".gsm-hoshidicts-audio-button")) },
  { id: "note", label: "メモ", title: "Personal dictionary note",
    find: state => state.popup.querySelector(".gsm-hoshidicts-note-button") },
  { id: "next", label: "つぎ", title: "Next dictionary", find: state => (state.pages.length > 1 ? state.next : null) },
  { id: "close", label: "とじる", title: "Close", find: state => state.popup.querySelector(".gsm-hoshidicts-popup-close") },
];

function buildMenu(state, api) {
  const menu = api.el("nav", "rpg-menu");
  menu.setAttribute("aria-label", "Commands");
  const list = api.el("ul", "rpg-cmds");
  list.setAttribute("role", "menu");
  const addItem = (id, label, title, run) => {
    const item = api.el("li", null);
    item.setAttribute("role", "none");
    const button = api.el("button", "rpg-cmd", label);
    button.type = "button";
    button.dataset.cmd = id;
    button.title = title;
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.getAttribute("aria-disabled") !== "true") run();
    });
    item.append(button);
    list.append(item);
    return button;
  };
  for (const command of COMMANDS) {
    addItem(command.id, command.label, command.title, () => {
      if (command.id === "next") {
        nextCard(state, api);
        return;
      }
      const target = command.find(state);
      if (target && !target.disabled) target.click();
    });
  }
  // The user's own text buttons (Anki templates, links) join the menu by label.
  for (const custom of state.popup.querySelectorAll(".gsm-hoshidicts-entry-actions .gsm-hoshidicts-text-action-button")) {
    const label = custom.querySelector(".gsm-hoshidicts-text-action-label")?.textContent || custom.title || "…";
    addItem("custom", label, custom.title || label, () => { if (custom.isConnected) custom.click(); }).dataset.custom = "";
  }
  list.addEventListener("keydown", event => {
    const items = [...list.querySelectorAll(".rpg-cmd:not([hidden])")];
    const index = items.indexOf(event.target);
    if (index < 0) return;
    if (event.key === "ArrowDown") items[(index + 1) % items.length].focus();
    else if (event.key === "ArrowUp") (index === 0 ? state.next : items[index - 1]).focus();
    else if (event.key === "ArrowLeft") state.next.focus();
    else if (event.key === "ArrowRight") advance(state, api);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // Roving tab stop: the focused item is the one Tab reaches next time.
  list.addEventListener("focusin", event => {
    for (const item of list.querySelectorAll(".rpg-cmd")) item.tabIndex = item === event.target ? 0 : -1;
  });
  const hint = api.el("div", "rpg-hint");
  menu.append(list, hint);
  state.menu = menu;
  state.hint = hint;
  return menu;
}

function updateMenu(state) {
  let first = null;
  let hasClose = false;
  let hasStop = false;
  for (const button of state.menu.querySelectorAll(".rpg-cmd")) {
    if (button.dataset.custom !== undefined) {
      first ||= button;
      continue;
    }
    const command = COMMANDS.find(entry => entry.id === button.dataset.cmd);
    const target = command.find(state);
    button.hidden = !target && !command.always;
    if (button.hidden) continue;
    // A command the reader cannot serve right now (no Anki, no audio) stays
    // listed but greyed out, like an RPG command you cannot use here.
    button.setAttribute("aria-disabled", String(!target || target.disabled === true));
    first ||= button;
    hasClose ||= command.id === "close";
    hasStop ||= button.tabIndex === 0;
  }
  if (!hasStop && first) first.tabIndex = 0;
  state.hint.textContent = hasClose ? "Space ▼ · ←→ ページ" : "Esc とじる · Space ▼ · ←→ ページ";
}

// ---------------------------------------------------------------------------
// Kanji stat block: strokes / grade / freq / JLPT as pip bars, the rest as text.

const STAT_BARS = {
  strokes: { label: "STROKES", total: 12, fill: value => Math.min(12, Math.ceil(value / 2)) },
  grade: { label: "GRADE", total: 10, fill: value => Math.min(10, value) },
  jlpt: { label: "JLPT", total: 5, fill: value => Math.max(0, Math.min(5, 6 - value)), prefix: "N" },
  freq: { label: "FREQ", total: 10, fill: value => Math.max(1, Math.min(10, 11 - Math.ceil(value / 250))) },
};

function buildStatBlock(entry, api) {
  if (entry.querySelector(":scope > .rpg-statblock")) return;
  const names = [...entry.querySelectorAll(":scope > .gsm-hoshidicts-kanji-stats dl > dt")];
  if (names.length === 0) return;
  const block = api.el("dl", "rpg-statblock");
  const misc = [];
  for (const dt of names) {
    const key = dt.textContent.trim().toLowerCase();
    const value = dt.nextElementSibling?.textContent.trim() ?? "";
    const spec = STAT_BARS[key];
    if (!spec || !/^\d+$/u.test(value)) {
      misc.push(`${key} ${value}`);
      continue;
    }
    const row = api.el("div", "rpg-stat");
    row.dataset.stat = key;
    row.setAttribute("aria-label", `${key} ${value}`);
    const label = api.el("dt", "rpg-stat-label");
    label.append(pixelText(api, spec.label));
    const data = api.el("dd", "rpg-stat-data");
    data.append(pipBar(api, spec.fill(Number(value)), spec.total),
      pixelText(api, `${spec.prefix || ""}${value}`, "rpg-pxt rpg-stat-value"));
    row.append(label, data);
    block.append(row);
  }
  if (misc.length > 0) {
    const row = api.el("div", "rpg-stat rpg-stat-misc");
    row.append(api.el("dt", "rpg-stat-label", "…"), api.el("dd", "rpg-stat-data", misc.join(" · ")));
    block.append(row);
  }
  api.move(block, entry);
}

// ---------------------------------------------------------------------------
// Build / refresh / teardown.

function build(view, api) {
  const state = {
    api, kind: view.kind, popup: view.popup, chrome: view.chrome, content: view.content,
    pages: [], index: 0, current: null, entry: null, firstEntry: view.entries[0] || null,
    lastSpan: new WeakMap(), motion: null, scrolled: false,
  };
  const plate = buildPlate(state, api);
  const status = buildStatus(state, api);
  const footer = buildFooter(state, api);
  const menu = buildMenu(state, api);
  api.move(plate, view.popup, view.content);
  api.move(status, view.content, view.content.firstChild);
  api.move(footer, view.content);
  api.move(menu, view.popup, view.content.nextSibling);
  if (view.chrome) api.hide(view.chrome);
  api.hide(view.popup.querySelector(":scope > .gsm-hoshidicts-resize-handle"));
  STATES.set(view.popup, state);
  ACTIVE.add(view.popup);
  if (!BOUND.has(view.content)) {
    BOUND.add(view.content);
    let pressed = null;
    view.content.addEventListener("scroll", () => { const live = STATES.get(view.popup); if (live) live.scrolled = true; }, { passive: true });
    view.content.addEventListener("pointerdown", event => { pressed = { x: event.clientX, y: event.clientY }; });
    view.content.addEventListener("click", event => {
      const live = STATES.get(view.popup);
      if (!live || event.button !== 0 || event.defaultPrevented) return;
      if (event.target.closest("a, button, summary, input, textarea, select, .rpg-footer")) return;
      // A drag that ended here was a text selection, not a tap.
      if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 6) return;
      // Advance without taking focus: the reader pauses hover lookups inside a
      // focused popup, and a mouse reader still wants to hover words in the text.
      advance(live, live.api);
    });
  }
  return state;
}

function refresh(state, view, api) {
  state.api = api;
  state.chrome = view.chrome;
  state.firstEntry = view.entries[0] || state.firstEntry;
  if (state.kind === "kanji") for (const entry of view.entries) buildStatBlock(entry, api);
  const pages = collectPages(state);
  const keep = state.current && pages.includes(state.current);
  state.pages = pages;
  if (!keep) {
    state.current = null;
    state.entry = null;
    showPage(state, 0, api);
  } else {
    state.index = pages.indexOf(state.current);
    updateFooter(state, api);
    updateMenu(state);
  }
}

function teardown(popup) {
  const state = STATES.get(popup);
  if (!state) return;
  for (const node of [state.plate, state.status, state.footer, state.menu]) node?.remove();
  for (const node of popup.querySelectorAll("[data-rpg-current], [data-rpg-typed], [data-rpg-prepared]")) {
    delete node.dataset.rpgCurrent;
    delete node.dataset.rpgTyped;
    delete node.dataset.rpgPrepared;
  }
  for (const block of popup.querySelectorAll(".rpg-statblock")) block.remove();
  unwrapTyping(popup);
  STATES.delete(popup);
  ACTIVE.delete(popup);
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind !== "term" && view.kind !== "kanji") return;
    let state = STATES.get(view.popup);
    // A new render (lookup, tab, Back, kanji) discards this module's nodes with
    // the reader's clear(); progressive Show more expansions keep them.
    if (!state || state.kind !== view.kind || !state.plate.isConnected || !state.footer.isConnected) {
      if (state) teardown(view.popup);
      state = build(view, api);
    }
    const height = Number(api.options.popupHeightPx);
    api.setVariable("--theme-rpg-window-max",
      `${Number.isFinite(height) && height > 0 ? Math.max(180, height - 160) : 260}px`);
    refresh(state, view, api);
    // The reader focuses Back after a kanji click; that button now sits behind
    // the command window, so the ▶ cursor lands on もどる instead.
    if (view.kind === "kanji" && !view.popup.matches(":focus-within")) {
      state.menu.querySelector('.rpg-cmd[data-cmd="back"]:not([hidden])')?.focus({ preventScroll: true });
    }
    api.requestLayout();
  },
  onDeactivate() {
    for (const popup of [...ACTIVE]) teardown(popup);
  },
};
