// themes/tamagotchi-lcd/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Tango Pet LCD": the popup is a translucent plastic egg around a monochrome
// dot-matrix LCD. Three physical keys under the screen drive the reader
// (A = audio, B = feed the word to Anki, C = next page / back), a pixel
// creature called Tango walks along the bottom of the screen and eats every
// word you mine, and long entries page like a pager instead of scrolling.
//
// Contract (hachidori-themes CI lint + the reader's host):
//  - one default export, synchronous hooks, nothing but `view` and `api`;
//  - no window/document/timers/observers: every clock in this file is a CSS
//    animation whose `animationstart`/`animationend` event reaches the popup;
//  - a hook that throws switches the module off; nothing here relies on it.
//
// Every sprite below is original pixel art, stored as text and turned into a
// `box-shadow` list (one shadow per lit dot, colour = currentColor). CSS owns
// the frame timing; this file only publishes the frames as --theme-* variables.

const UNIT = 3; // one LCD dot in CSS pixels (the sprite is 12 × 12 dots)

// ---------------------------------------------------------------------------
// Sprites. `#` is a lit dot; rows are top to bottom. 12 columns × 12 rows.
// ---------------------------------------------------------------------------
const SPRITES = {
  // Tango standing, eyes open.
  idleA: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#..#..#..#.",
    ".#........#.",
    "#..........#",
    "#....##....#",
    ".#........#.",
    "..##....##..",
    "...##..##...",
  ],
  // Blink.
  idleB: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#........#.",
    ".#........#.",
    "#..........#",
    "#....##....#",
    ".#........#.",
    "..##....##..",
    "...##..##...",
  ],
  // Waddle: feet alternate.
  walkA: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#..#..#..#.",
    ".#........#.",
    "#..........#",
    "#....##....#",
    ".#........#.",
    "..##....##..",
    "..##.....##.",
  ],
  walkB: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#..#..#..#.",
    ".#........#.",
    "#..........#",
    "#....##....#",
    ".#........#.",
    "..##....##..",
    ".##.....##..",
  ],
  // Chomp: mouth wide open …
  eatA: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#..#..#..#.",
    ".#........#.",
    "#...####...#",
    "#...#..#...#",
    ".#..####..#.",
    "..##....##..",
    "...##..##...",
  ],
  // … and shut, cheeks full.
  eatB: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#.##..##.#.",
    "##........##",
    "#..........#",
    "##..####..##",
    ".#........#.",
    "..##....##..",
    "...##..##...",
  ],
  // Fed and happy: ^ ^ eyes and a big smile.
  happy: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#.##..##.#.",
    ".#........#.",
    "#..........#",
    "#..#....#..#",
    ".#..####..#.",
    "..##....##..",
    "...##..##...",
  ],
  // Seen this word too often: eyes shut, drooping.
  sleepy: [
    "......#.....",
    "......##....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#........#.",
    ".#.##..##.#.",
    "#..........#",
    "#.....#....#",
    ".#........#.",
    "..##....##..",
    "...##..##...",
  ],
  // Singing along with the audio button.
  sing: [
    "......#.....",
    ".....##.....",
    "......#.....",
    "....####....",
    "..##....##..",
    ".#..#..#..#.",
    ".#........#.",
    "#....##....#",
    "#....##....#",
    ".#........#.",
    "..##....##..",
    "...##..##...",
  ],
  // Small things that float above Tango's head.
  heart: [
    ".#.#.",
    "#####",
    "#####",
    ".###.",
    "..#..",
  ],
  note: [
    "...##",
    "...#.",
    "...#.",
    ".###.",
    "###..",
  ],
  zzz: [
    "###",
    "..#",
    ".#.",
    "#..",
    "###",
  ],
  bang: [
    "#",
    "#",
    "#",
    ".",
    "#",
  ],
  // The word being eaten.
  morsel: [
    ".##.",
    "####",
    ".##.",
  ],
  // Stage 2 (fed 3+ words): a second leaf.
  leafBig: [
    "....#.#.....",
    ".....##.....",
    "......#.....",
  ],
  // Stage 3 (fed 6+ words): a little crown.
  crown: [
    "...#.#.#....",
    "...#####....",
    "....###.....",
  ],
};

// A sprite as a box-shadow list. The sprite element is one transparent dot at
// (−1, −1) so a shadow at column x, row y lands on dot (x, y).
function shadows(rows, unit = UNIT) {
  const parts = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === "#") parts.push(`${(x + 1) * unit}px ${(y + 1) * unit}px 0 0`);
    }
  });
  return parts.join(", ");
}

// Replace the sprout (rows 0–2) with a stage decoration.
function withHat(rows, hat) {
  return [...hat, ...rows.slice(hat.length)];
}

const FRAME_NAMES = ["idleA", "idleB", "walkA", "walkB", "eatA", "eatB", "happy", "sleepy", "sing"];
const FRAMES = {
  1: Object.fromEntries(FRAME_NAMES.map(name => [name, shadows(SPRITES[name])])),
  2: Object.fromEntries(FRAME_NAMES.map(name => [name, shadows(withHat(SPRITES[name], SPRITES.leafBig))])),
  3: Object.fromEntries(FRAME_NAMES.map(name => [name, shadows(withHat(SPRITES[name], SPRITES.crown))])),
};
const BUBBLES = Object.fromEntries(["heart", "note", "zzz", "bang", "morsel"].map(name => [name, shadows(SPRITES[name])]));

// ---------------------------------------------------------------------------
// Session state. The module loads once per page, so this is "for this tab":
// the API has no storage on purpose, and a reload hatches a new Tango.
// ---------------------------------------------------------------------------
const session = {
  fed: 0,                 // words eaten this session
  fedWords: new Set(),    // one meal per expression, however often it re-renders
};
const boundPopups = new WeakSet();    // popups that already have the event listeners
const publishedStage = new WeakMap(); // popup → stage whose frames it carries

function stage() {
  return session.fed >= 6 ? 3 : session.fed >= 3 ? 2 : 1;
}

function pad2(value) {
  return String(Math.min(99, value)).padStart(2, "0");
}

// The reading lives in the headword's aria-label, "<expression>, <reading>".
function headwordParts(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? { text: label.slice(0, comma), reading: label.slice(comma + 2) } : { text: label, reading: "" };
}

// "Looked up 4 times" → 4; the slot is empty or hidden until the count arrives.
function lookupCount(stats) {
  if (!stats || stats.hidden) return 0;
  const match = /(\d+)/u.exec(stats.textContent || "");
  return match ? Number(match[1]) : 0;
}

// Tango is bright for a new word, drowsy after five lookups, asleep after ten.
function setMood(popup, stats) {
  const pet = popup.querySelector(".tama-pet");
  if (!pet) return;
  const count = lookupCount(stats);
  pet.dataset.mood = count >= 10 ? "asleep" : count >= 5 ? "sleepy" : "awake";
}

// The entry whose top is nearest the top of the screen: the one being read.
function currentEntry(content) {
  const entries = [...content.querySelectorAll(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry")];
  if (entries.length === 0) return null;
  const top = content.getBoundingClientRect().top;
  return entries.find(entry => entry.getBoundingClientRect().bottom > top + 24) || entries.at(-1);
}

function control(entry, selector, popup) {
  // The first entry's controls live in the top bar (moved to the status line).
  return entry?.querySelector(selector) || popup.querySelector(`.gsm-hoshidicts-result-chrome ${selector}`);
}

function atEnd(scroller) {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
}

function scrollable(scroller) {
  return scroller.scrollHeight > scroller.clientHeight + 2;
}

// What C does once the screen is scrolled to its end. Pure DOM, no layout:
// the "page" case is decided by CSS from the scroll timeline (see .tama-key-page).
function endAction(popup) {
  if (popup.querySelector(".gsm-hoshidicts-kanji-back")) return "back";
  if (popup.querySelector(".gsm-hoshidicts-popup-close")) return "close";
  return "top";
}

// What the C key does right now; measured only when it is pressed.
function nextAction(view) {
  const { content, popup } = view;
  if (scrollable(content) && !atEnd(content)) return "page";
  return endAction(popup);
}

// ---------------------------------------------------------------------------
// Key actions. They only ever press the reader's own buttons.
// ---------------------------------------------------------------------------
function pressA(view, api) {
  const entry = currentEntry(view.content);
  const button = control(entry, ".gsm-hoshidicts-audio-button", view.popup);
  if (button && !button.disabled) button.click();
  else toast(view, api, "NO AUDIO");
}

function pressB(view, api) {
  const entry = currentEntry(view.content);
  const button = control(entry, ".gsm-hoshidicts-mine-button", view.popup);
  if (!button) { toast(view, api, "NO ANKI"); react(view, "bang"); return; }
  if (button.disabled || button.dataset.state === "checking" || button.dataset.state === "mining") return;
  button.click();
}

function pressC(view) {
  const { content, popup } = view;
  switch (nextAction(view)) {
    case "page":
      content.scrollBy({ top: Math.max(40, content.clientHeight - 24) });
      return;
    case "back":
      popup.querySelector(".gsm-hoshidicts-kanji-back").click();
      return;
    case "close":
      popup.querySelector(".gsm-hoshidicts-popup-close").click();
      return;
    default:
      content.scrollTo({ top: 0 });
  }
}

// A short LCD caption. CSS animates it out and `animationend` removes it, so
// no timer is needed; under reduced motion the same animation is static.
function toast(view, api, text) {
  const status = view.chrome?.querySelector(".tama-status");
  if (!status) return;
  for (const previous of status.querySelectorAll(".tama-toast")) previous.remove();
  const caption = api.el("span", "tama-toast", text);
  caption.setAttribute("role", "status");
  api.move(caption, status);
}

// A transient pet reaction; CSS ends it and `animationend` clears the attribute.
function react(view, name) {
  const pet = view.popup.querySelector(".tama-pet");
  if (pet) pet.dataset.react = name;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
// The frames are --theme-* variables on the popup; CSS keyframes read them.
// Written once per popup and again only when Tango grows a stage.
function publishSprites(popup, api) {
  const current = stage();
  if (publishedStage.get(popup) === current) return;
  publishedStage.set(popup, current);
  const frames = FRAMES[current];
  for (const name of FRAME_NAMES) api.setVariable(`--theme-pet-${name.toLowerCase()}`, frames[name]);
  for (const [name, value] of Object.entries(BUBBLES)) api.setVariable(`--theme-bubble-${name}`, value);
  api.setVariable("--theme-pet-unit", `${UNIT}px`);
}

function buildStatus(view, api) {
  const { chrome } = view;
  let status = chrome.querySelector(":scope > .tama-status");
  if (!status) {
    status = api.el("div", "tama-status");
    status.setAttribute("role", "group");
    status.setAttribute("aria-label", "Pet status");
    api.move(status, chrome, chrome.firstChild);
  }
  // Hearts: one lit heart per two words fed, five hearts in total.
  let hearts = status.querySelector(".tama-hearts");
  if (!hearts) { hearts = api.el("span", "tama-hearts"); api.move(hearts, status); }
  hearts.setAttribute("aria-label", `${session.fed} ${session.fed === 1 ? "word" : "words"} fed this session`);
  hearts.setAttribute("role", "img");
  const lit = Math.min(5, Math.ceil(session.fed / 2));
  hearts.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const heart = api.el("span", "tama-heart");
    heart.setAttribute("aria-hidden", "true");
    if (index < lit) heart.dataset.lit = "true";
    api.move(heart, hearts);
  }
  let fed = status.querySelector(".tama-fed");
  if (!fed) { fed = api.el("span", "tama-fed"); fed.setAttribute("aria-hidden", "true"); api.move(fed, status); }
  fed.textContent = `FED ${pad2(session.fed)}`;
  // Scroll gauge: a CSS scroll-driven animation fills it, no JS on scroll.
  if (!status.querySelector(".tama-gauge")) {
    const gauge = api.el("span", "tama-gauge");
    gauge.setAttribute("aria-hidden", "true");
    const fill = api.el("span", "tama-gauge-fill");
    api.move(fill, gauge);
    api.move(gauge, status);
  }
  // The reader's own action group (Note, custom buttons) becomes LCD chips at
  // the end of the status row. Audio and Anki move to the deck keys.
  const actions = chrome.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-entry-actions");
  if (actions) api.move(actions, status);
  return status;
}

function buildFloor(view, api) {
  const { popup } = view;
  let floor = popup.querySelector(":scope > .tama-floor");
  if (!floor) {
    floor = api.el("div", "tama-floor");
    floor.setAttribute("aria-hidden", "true");
    const pet = api.el("div", "tama-pet");
    const body = api.el("span", "tama-body");
    const sprite = api.el("span", "tama-sprite");
    const bubble = api.el("span", "tama-bubble");
    const detector = api.el("span", "tama-fed-detector");
    api.move(sprite, body);
    api.move(bubble, body);
    api.move(body, pet);
    api.move(detector, pet);
    api.move(pet, floor);
    const more = api.el("span", "tama-more", "▼");
    api.move(more, floor);
    api.move(floor, popup);
    // Power-on wipe: a fresh element per lookup, so a tab switch does not replay it.
    const boot = api.el("div", "tama-boot");
    boot.setAttribute("aria-hidden", "true");
    api.move(boot, popup);
  }
  const pet = floor.querySelector(".tama-pet");
  pet.dataset.stage = String(stage());
  return floor;
}

const END_FACES = {
  back: ["◀", "back", "back to the previous entry"],
  close: ["✕", "close", "close this popup"],
  top: ["▲", "top", "back to the top"],
};

// letter + glyph + hint printed under a cap. C has two faces: "next" while the
// screen can still scroll (CSS shows it from the scroll timeline) and the end action.
function face(api, className, letter, glyph, hint) {
  const node = api.el("span", `tama-key-face ${className}`);
  node.setAttribute("aria-hidden", "true");
  api.move(api.el("span", "tama-key-letter", letter), node);
  api.move(api.el("span", "tama-key-glyph", glyph), node);
  api.move(api.el("span", "tama-key-hint", hint), node);
  return node;
}

function buildDeck(view, api) {
  const { popup } = view;
  let deck = popup.querySelector(":scope > .tama-deck");
  if (!deck) {
    deck = api.el("div", "tama-deck");
    deck.setAttribute("role", "group");
    deck.setAttribute("aria-label", "Pet keys");
    for (const key of ["a", "b", "c"]) {
      const button = api.el("button", `tama-key tama-key-${key}`);
      button.type = "button";
      button.dataset.key = key;
      button.setAttribute("aria-keyshortcuts", key.toUpperCase());
      const cap = api.el("span", "tama-cap");
      cap.setAttribute("aria-hidden", "true");
      api.move(cap, button);
      if (key === "a") api.move(face(api, "", "A", "♪", "audio"), button);
      if (key === "b") api.move(face(api, "", "B", "✚", "feed"), button);
      if (key === "c") {
        api.move(face(api, "tama-key-page", "C", "▼", "next"), button);
        api.move(face(api, "tama-key-else", "C", "▲", "top"), button);
      }
      api.move(button, deck);
    }
    api.move(deck, popup);
  }
  return deck;
}

// Labels follow the DOM only (which buttons exist); nothing here forces layout.
function syncDeck(view) {
  const deck = view.popup.querySelector(":scope > .tama-deck");
  if (!deck) return;
  const keyA = deck.querySelector(".tama-key-a");
  keyA.setAttribute("aria-label", "A: play the pronunciation");
  const [glyph, hint, description] = END_FACES[endAction(view.popup)];
  const keyC = deck.querySelector(".tama-key-c");
  const end = keyC.querySelector(".tama-key-else");
  end.querySelector(".tama-key-glyph").textContent = glyph;
  end.querySelector(".tama-key-hint").textContent = hint;
  keyC.setAttribute("aria-label", `C: next page, then ${description}`);
  const keyB = deck.querySelector(".tama-key-b");
  const hasAnki = Boolean(view.popup.querySelector(".gsm-hoshidicts-mine-button"));
  keyB.setAttribute("aria-disabled", String(!hasAnki));
  keyB.querySelector(".tama-key-hint").textContent = hasAnki ? "feed" : view.kind === "kanji" ? "terms only" : "no anki";
  keyB.setAttribute("aria-label", hasAnki ? "B: feed this word to Anki"
    : view.kind === "kanji" ? "B: only terms can be fed to Anki" : "B: Anki is not set up (Settings → Anki)");
  keyB.title = hasAnki ? "" : keyB.getAttribute("aria-label").slice(3);
}

// One listener set per popup element; the popup outlives every render.
function bindPopup(view, api) {
  const { popup } = view;
  if (boundPopups.has(popup)) return;
  boundPopups.add(popup);
  popup.addEventListener("click", event => {
    const key = event.target?.closest?.(".tama-key");
    if (!key || !popup.contains(key)) return;
    event.preventDefault();
    run(view, api, key.dataset.key);
  });
  // Physical keys while the popup has focus. Hachidori's own keybinds keep
  // working page-wide; these are the printed shortcuts on the shell.
  popup.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    const target = event.target;
    if (target?.matches?.("input, textarea, select, [contenteditable]")) return;
    const key = String(event.key || "").toLowerCase();
    if (!["a", "b", "c"].includes(key)) return;
    event.preventDefault();
    run(view, api, key);
    popup.querySelector(`.tama-key-${key}`)?.focus?.();
  });
  // CSS raises `tama-fed` on the detector the moment the mine button reports
  // success: that is how the pet learns it has been fed, without observers.
  popup.addEventListener("animationstart", event => {
    const { animationName, target } = event;
    if (animationName === "tama-fed") {
      const entry = currentEntry(popup.querySelector(".gsm-hoshidicts-content-scroll") || popup);
      const word = entry?.dataset.expression || popup.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent || "";
      feed(popup, api, word);
    } else if (animationName === "tama-raster" && target?.dataset?.character) {
      // The kanji bitmap, drawn after the popup has painted.
      api.setVariable("--theme-kanji-bitmap", rasterise(target.dataset.character, api) || "none");
    } else if (animationName === "tama-counted") {
      // The reader painted "Looked up N times": Tango's mood follows.
      setMood(popup, target);
    }
  });
  popup.addEventListener("animationend", event => {
    if (event.animationName === "tama-toast-out" || event.animationName === "tama-toast-hold") event.target.remove();
    if (event.animationName === "tama-react") {
      const pet = event.target.closest?.(".tama-pet");
      if (pet) delete pet.dataset.react;
    }
  });
}

// `view` is frozen per render; the live one is what the listeners must use.
const liveViews = new WeakMap();
function run(view, api, key) {
  const current = liveViews.get(view.popup) || view;
  if (key === "a") pressA(current, api);
  else if (key === "b") pressB(current, api);
  else if (key === "c") pressC(current);
}

function feed(popup, api, word) {
  if (!word || session.fedWords.has(word)) return;
  session.fedWords.add(word);
  session.fed += 1;
  publishSprites(popup, api);
  const view = liveViews.get(popup);
  if (view) { buildStatus(view, api); buildFloor(view, api); }
  const pet = popup.querySelector(".tama-pet");
  if (pet) pet.dataset.react = "fed";
}

// ---------------------------------------------------------------------------
// Term view.
// ---------------------------------------------------------------------------
function renderTerm(view, api) {
  const { chrome, entries, popup } = view;
  if (chrome) {
    buildStatus(view, api);
    // Reading beside the headword, LCD style, in addition to the furigana.
    const expression = chrome.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-expression");
    if (expression && !expression.parentNode.querySelector(":scope > .tama-reading")) {
      const { text, reading } = headwordParts(expression);
      if (reading && reading !== text) expression.after(api.el("span", "tama-reading", reading));
    }
  }
  // Later entries carry their own audio/Anki buttons; the keys act on the entry
  // at the top of the screen, so those rows go. (The first entry's live in the bar.)
  for (const entry of entries) {
    for (const node of entry.querySelectorAll(".gsm-hoshidicts-entry-actions")) api.hide(node);
  }
  // Tango's mood follows the lookup count; the count slot re-arms it when it paints.
  setMood(popup, entries[0]?.querySelector(".gsm-hoshidicts-lookup-stats"));
}

// ---------------------------------------------------------------------------
// Kanji view: the glyph as a real 24-dot bitmap beside the selectable glyph,
// and the stats folded into one LCD line.
// ---------------------------------------------------------------------------
const BITMAP_DOTS = 24;

function rasterise(character, api) {
  const canvas = api.el("canvas");
  canvas.width = BITMAP_DOTS;
  canvas.height = BITMAP_DOTS;
  const context = canvas.getContext?.("2d");
  if (!context) return "";
  context.fillStyle = "#000";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${BITMAP_DOTS - 2}px "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif`;
  context.fillText(character, BITMAP_DOTS / 2, BITMAP_DOTS / 2 + 1);
  const { data } = context.getImageData(0, 0, BITMAP_DOTS, BITMAP_DOTS);
  const rows = [];
  for (let y = 0; y < BITMAP_DOTS; y += 1) {
    let row = "";
    for (let x = 0; x < BITMAP_DOTS; x += 1) row += data[(y * BITMAP_DOTS + x) * 4 + 3] > 96 ? "#" : ".";
    rows.push(row);
  }
  return shadows(rows);
}

function renderKanji(view, api) {
  const { chrome, entries, popup } = view;
  const glyph = chrome?.querySelector(".gsm-hoshidicts-kanji-glyph");
  if (chrome) buildStatus(view, api);
  if (glyph && !glyph.parentNode.querySelector(":scope > .tama-bitmap")) {
    const character = glyph.textContent || "";
    const bitmap = api.el("span", "tama-bitmap");
    bitmap.setAttribute("role", "img");
    bitmap.setAttribute("aria-label", `${character} as a ${BITMAP_DOTS}-dot bitmap`);
    bitmap.dataset.character = character;
    const dots = api.el("span", "tama-bitmap-dots");
    api.move(dots, bitmap);
    api.move(bitmap, glyph.parentNode, glyph);
    // Rasterised on the element's own 1 ms animationstart, off the render path.
  }
  for (const entry of entries) {
    const stats = entry.querySelector(".gsm-hoshidicts-kanji-stats");
    if (stats && !entry.querySelector(":scope > .tama-kstats")) {
      const line = api.el("dl", "tama-kstats");
      for (const term of stats.querySelectorAll("dt")) {
        const value = term.nextElementSibling;
        const name = (term.textContent || "").trim();
        if (!name || !value) continue;
        const dt = api.el("dt", "", name);
        const dd = api.el("dd", "", (value.textContent || "").trim());
        api.move(dt, line);
        api.move(dd, line);
      }
      api.move(line, entry, stats);
      api.hide(stats);
    }
  }
  const pet = popup.querySelector(".tama-pet");
  if (pet) pet.dataset.mood = "awake";
}

export default {
  schema: 1,
  slug: "tamagotchi-lcd",
  onRender(view, api) {
    liveViews.set(view.popup, view);
    publishSprites(view.popup, api);
    bindPopup(view, api);
    buildFloor(view, api);
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    buildDeck(view, api);
    syncDeck(view);
  },
};
