// themes/denshi-jisho/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 電子辞書: the popup is a handheld electronic dictionary. theme.css draws the
// plastic bezel, the monochrome LCD and the key caps; this module gives the
// device its behaviour:
//
//   • candidate list + preview pane — every entry's header becomes one LCD line
//     and the highlighted entry shows its definitions underneath. The reader's
//     nodes are re-ordered with CSS (`display: contents` + `order`), never cloned,
//     so tabs, Show more, Note, Anki and definition blur keep working;
//   • six keys (訳 決定 戻る 音声 ジャンプ メニュー) and a cursor pad that click
//     the reader's own buttons (audio, Back, kanji links, Anki, Note);
//   • a keyboard model: ↑↓ move the cursor, Enter = 決定, Backspace = 戻る,
//     ←→ = dictionary tab (list) or kanji cursor (ジャンプ), PgUp/PgDn scroll.
//     Escape stays the reader's: it closes the popup before any theme sees it;
//   • a 漢字辞典 screen: readings, meanings and stats in a labelled table;
//   • a メニュー screen with the Anki / Note / custom actions, the 訳 and
//     backlight switches, and the last five lookups of this page.
//
// Contract (hachidori-themes lint + the reader's host): one default export,
// synchronous hooks, only `view` and `api`. A throwing hook switches the module
// off for the page; theme.css gates every JS-dependent rule on
// `.gsm-hoshidicts-popup:has(> .dj-keys)`, which only the hook creates, so the
// CSS layer alone still renders a readable popup.

const HISTORY_MAX = 5;
const LIST_WINDOW = 7; // candidate lines shown around the cursor
const MEMORY_MAX = 8;  // remembered cursor positions (Back restores yours)

// One device per popup level. The reader keeps the popup element and re-renders
// into it, so keying on that element survives tab switches, Show more and Back.
// Switches (訳, backlight) and the history are shared by every level on the page.
const devices = new WeakMap();
const bound = [];
const session = { gloss: true, backlight: true, history: [] };

const KEYS = [
  { id: "yaku", jp: "訳", en: "DEF", label: "訳 — show or hide the definitions" },
  { id: "enter", jp: "決定", en: "ENTER", label: "決定 — open the highlighted entry" },
  { id: "back", jp: "戻る", en: "BACK", label: "戻る — back to the list, the previous results or the kanji's word" },
  { id: "audio", jp: "音声", en: "AUDIO", label: "音声 — play the pronunciation of the highlighted entry" },
  { id: "jump", jp: "ジャンプ", en: "JUMP", label: "ジャンプ — look up a kanji of the highlighted headword" },
  { id: "menu", jp: "メニュー", en: "MENU", label: "メニュー — Anki, Note, switches and the lookup history" },
];
const PAD = [
  ["up", "▲", "↑ previous entry"],
  ["left", "◀", "← previous dictionary, or previous kanji in ジャンプ"],
  ["right", "▶", "→ next dictionary, or next kanji in ジャンプ"],
  ["down", "▼", "↓ next entry"],
];
const MODE_LABEL = { list: "一覧", detail: "詳細", jump: "ジャンプ", menu: "メニュー" };
// Soft-key guide at the bottom of the LCD, as the real devices print it.
const HINTS = {
  list: [["↑↓", "候補"], ["←→", "辞書"], ["決定", "詳細"], ["ジャンプ", "漢字"], ["訳", "表示切替"]],
  detail: [["↑↓", "前後の語"], ["PgUp/Dn", "スクロール"], ["戻る", "一覧へ"], ["音声", "発音"]],
  jump: [["←→", "漢字を選ぶ"], ["決定", "その漢字を調べる"], ["戻る", "中止"]],
  menu: [["↑↓", "項目"], ["決定", "実行"], ["戻る", "閉じる"]],
  kanji: [["↑↓", "辞書"], ["決定", "全索引"], ["戻る", "前の画面"], ["メニュー", "登録・履歴"]],
};
const READING_LABELS = { On: "音", Kun: "訓" };
const STAT_LABELS = { strokes: "画数", "stroke count": "画数", grade: "学年", freq: "頻度", frequency: "頻度",
  jlpt: "JLPT", heisig: "Heisig", kanken: "漢検", radical: "部首" };
const MINE_STATE = { checking: "確認中", "view-existing": "登録済み・開く", success: "登録済み", error: "エラー",
  mining: "登録中", ready: "登録する", "add-duplicate": "重複あり・登録", overwrite: "上書き登録" };

// ---------------------------------------------------------------------------
// State

function device(popup) {
  let state = devices.get(popup);
  if (!state) {
    state = { popup, view: null, api: null, key: null, historyKey: null, mode: "list", cursor: 0, jump: 0,
      menuIndex: 0, primaryHeader: null, glyph: "", dictName: "", memory: new Map(), screenFocused: false,
      onKey: null };
    devices.set(popup, state);
  }
  return state;
}

// "食べる, たべる" — the renderer labels the headword this way (popup.js
// createEntryHeader); it is the one place the reading exists as plain text.
function splitLabel(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? { text: label.slice(0, comma), reading: label.slice(comma + 2) } : { text: label, reading: "" };
}

function renderKey(state, view) {
  if (view.kind === "kanji") {
    return `kanji:${view.chrome?.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent ?? state.glyph}`;
  }
  return `${view.kind}:${view.entries[0]?.dataset.expression ?? ""}`;
}

function entryNodes(state) {
  return [...state.popup.querySelectorAll(state.view?.kind === "kanji" ? ".gsm-hoshidicts-kanji-entry" : ".gsm-hoshidicts-entry")];
}

function lineOf(state, entry) {
  return entry?.querySelector(state.view?.kind === "kanji"
    ? ":scope > .gsm-hoshidicts-kanji-dictionary" : ":scope > .gsm-hoshidicts-entry-header") ?? null;
}

function currentEntry(state) {
  return entryNodes(state)[state.cursor] ?? null;
}

function headwordText(state, entry) {
  if (state.view?.kind === "kanji") return entry?.querySelector(":scope > .gsm-hoshidicts-kanji-dictionary")?.textContent ?? "";
  const { text, reading } = splitLabel(entry?.querySelector(".gsm-hoshidicts-expression"));
  return reading && reading !== text ? `${text}【${reading}】` : text;
}

function jumpLinks(state) {
  return [...(lineOf(state, currentEntry(state))?.querySelectorAll(".gsm-hoshidicts-kanji-link") ?? [])];
}

function menuItems(state) {
  return [...state.popup.querySelectorAll(".dj-menu-item:not([disabled])")];
}

function screenOf(state) {
  return state.popup.querySelector(":scope > .dj-title");
}

function contentOf(state) {
  return state.popup.querySelector(":scope > .gsm-hoshidicts-content-scroll");
}

function setText(root, selector, text) {
  const node = root.querySelector(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

function clock() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The device frame: title bar (the screen's focus target), soft-key guide, keys.
// clear() removes them on every fresh render, so they are rebuilt when missing.

function buildFrame(state, view, api) {
  const { popup } = view;
  if (popup.querySelector(":scope > .dj-keys")) return;

  const title = api.el("div", "dj-title");
  title.tabIndex = 0;
  title.setAttribute("role", "group");
  title.setAttribute("aria-label", "電子辞書 screen. Arrow keys move the cursor, Enter is 決定, Backspace is 戻る.");
  title.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight Enter Backspace PageUp PageDown Home End");
  title.addEventListener("focus", () => { state.screenFocused = true; });
  // Chrome fires blur while the reader's clear() removes the screen, before the
  // hook rebuilds it. Decide after the current task instead: if the focus is
  // back on the (new) screen by then, the reader was using the device; if not,
  // the reader clicked elsewhere and the device must not steal focus later.
  title.addEventListener("blur", () => {
    Promise.resolve().then(() => { state.screenFocused = state.popup.getRootNode().activeElement === screenOf(state); });
  });
  const battery = api.el("span", "dj-battery");
  battery.setAttribute("aria-hidden", "true");
  title.append(api.el("span", "dj-title-dict"), api.el("span", "dj-title-mode"), api.el("span", "dj-title-count"),
    api.el("span", "dj-title-clock", clock()), battery);
  api.move(title, popup);

  const softkeys = api.el("div", "dj-softkeys");
  for (const [mode, pairs] of Object.entries(HINTS)) {
    const hint = api.el("span", "dj-hint");
    hint.dataset.mode = mode;
    for (const [key, meaning] of pairs) {
      const pair = api.el("span", "dj-hint-pair");
      pair.append(api.el("b", "dj-hint-key", key), api.el("span", "dj-hint-text", meaning));
      hint.append(pair);
    }
    softkeys.append(hint);
  }
  const status = api.el("span", "dj-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  softkeys.append(status);
  api.move(softkeys, popup);

  const keys = api.el("div", "dj-keys");
  keys.setAttribute("role", "toolbar");
  keys.setAttribute("aria-label", "電子辞書 keys");
  for (const spec of KEYS) {
    const key = api.el("button", "dj-key");
    key.type = "button";
    key.dataset.key = spec.id;
    key.title = spec.label;
    key.setAttribute("aria-label", spec.label);
    key.append(api.el("span", "dj-key-jp", spec.jp), api.el("span", "dj-key-en", spec.en));
    key.addEventListener("click", () => { press(state, spec.id); if (state.mode !== "menu") focusScreen(state); });
    keys.append(key);
  }
  const pad = api.el("div", "dj-pad");
  pad.setAttribute("role", "group");
  pad.setAttribute("aria-label", "cursor pad");
  for (const [direction, glyph, label] of PAD) {
    const key = api.el("button", "dj-pad-key", glyph);
    key.type = "button";
    key.dataset.dir = direction;
    key.title = label;
    key.setAttribute("aria-label", label);
    key.addEventListener("click", () => { arrow(state, direction); if (state.mode !== "menu") focusScreen(state); });
    pad.append(key);
  }
  keys.append(pad);
  api.move(keys, popup);
}

function focusScreen(state) {
  const screen = screenOf(state);
  if (screen && state.popup.getRootNode().activeElement !== screen) screen.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Term view: candidate list + preview pane.

function findPrimaryHeader(state, view) {
  // A tab switch re-renders the panel without clear(): the reader keeps the very
  // same primary header element, which then sits inside the entry we moved it
  // to — an entry that is no longer in the document. It is still the live header.
  return view.chrome?.querySelector(":scope > .gsm-hoshidicts-primary-header")
    ?? view.entries[0]?.querySelector(":scope > .gsm-hoshidicts-primary-header")
    ?? state.primaryHeader;
}

function renderTerm(state, view, api) {
  const first = view.entries[0];
  const header = findPrimaryHeader(state, view);
  if (header && first) {
    state.primaryHeader = header;
    if (header.parentNode !== first) api.move(header, first, first.firstChild);
  }
  if (view.chrome) {
    const tabs = view.chrome.querySelector(".gsm-hoshidicts-tab-list");
    const title = screenOf(state);
    if (tabs && title) api.move(tabs, title, title.querySelector(".dj-title-mode"));
    api.hide(view.chrome);
  }
  view.entries.forEach((entry, index) => decorateEntry(entry, index, api));
  state.dictName = dictionaryName(view);
}

function dictionaryName(view) {
  const selected = view.popup.querySelector('.gsm-hoshidicts-tab[aria-selected="true"]');
  if (selected && selected.textContent !== "All") return selected.textContent;
  const titles = new Set([...view.popup.querySelectorAll(".gsm-hoshidicts-glossary-card-title")].map(node => node.textContent));
  if (titles.size === 1) return [...titles][0];
  return titles.size > 1 ? `複数辞書 ${titles.size}冊` : "辞書";
}

function labelled(api, label, text) {
  const item = api.el("span", "dj-head-item");
  item.append(api.el("span", "dj-head-label", label), api.el("span", "dj-head-text", text));
  return item;
}

// The pitch badge's mora contour, redrawn in LCD ink for the detail head.
function pitchCopy(tag, api) {
  const pitch = api.el("span", "dj-pitch");
  pitch.title = tag.title;
  const morae = tag.querySelectorAll(".gsm-hoshidicts-pitch-mora");
  if (morae.length === 0) return api.el("span", "dj-pitch", tag.dataset.pronunciation || tag.textContent);
  for (const mora of morae) {
    const copy = api.el("span", "dj-mora", mora.textContent);
    copy.dataset.pitchLevel = mora.dataset.pitchLevel;
    if (mora.dataset.pitchTransition) copy.dataset.pitchTransition = mora.dataset.pitchTransition;
    pitch.append(copy);
  }
  const position = tag.querySelector(".gsm-hoshidicts-pitch-position");
  if (position) pitch.append(api.el("span", "dj-pitch-position", position.textContent));
  return pitch;
}

function conjugationText(details) {
  const endpoints = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint")].map(node => node.textContent);
  const steps = [...details.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map(node => node.textContent);
  return `${endpoints.join(" → ")}${steps.length ? `（${steps.join("・")}）` : ""}`;
}

// One entry: its header becomes a list line (reading + frequency beside the
// headword) and a detail head is inserted after it. The renderer's metadata
// rows, capsule and tags stay in the DOM (theme.css hides them), so its own
// option updates keep working.
function decorateEntry(entry, index, api) {
  entry.dataset.djIndex = String(index);
  if (entry.querySelector(":scope > .dj-detail-head")) return;
  const header = entry.querySelector(":scope > .gsm-hoshidicts-entry-header");
  if (!header) return;
  const headword = header.querySelector(".gsm-hoshidicts-headword");
  const expression = headword?.querySelector(".gsm-hoshidicts-expression");
  const { text, reading } = splitLabel(expression);
  if (headword && expression) {
    if (reading && reading !== text && !headword.querySelector(":scope > .dj-reading")) {
      api.move(api.el("span", "dj-reading", reading), headword, expression.nextSibling);
    }
    const frequency = entry.querySelector(".gsm-hoshidicts-frequency-value");
    if (frequency) api.move(api.el("span", "dj-freq", frequency.textContent), headword);
  }

  const head = api.el("div", "dj-detail-head");
  const title = api.el("span", "dj-head-title");
  title.append(api.el("span", "dj-head-reading", reading || text));
  if (reading && reading !== text) title.append(api.el("span", "dj-head-kanji", text));
  head.append(title);
  for (const tag of [...entry.querySelectorAll(".gsm-hoshidicts-tag-pitch")].slice(0, 3)) head.append(pitchCopy(tag, api));
  // Part of speech only: the deinflection steps are printed on the 活用 line,
  // and a tag's description replaces its code when it is short enough to read.
  const grammar = [...entry.querySelectorAll(".gsm-hoshidicts-primary-grammar-tag-term, :scope > .gsm-hoshidicts-tags > .gsm-hoshidicts-tag-term")]
    .map(tag => (tag.title && tag.title.length <= 28 ? tag.title : tag.textContent))
    .filter(text => /[\p{L}\p{N}]/u.test(text)); // a monochrome LCD prints no ⭐-style symbol tags
  if (grammar.length) head.append(api.el("span", "dj-head-pos", grammar.join("・")));
  const deinflection = header.querySelector(".gsm-hoshidicts-deinflection");
  if (deinflection) head.append(labelled(api, "活用", conjugationText(deinflection)));
  const frequencies = [...entry.querySelectorAll(".gsm-hoshidicts-tag-frequency")];
  if (frequencies.length) {
    head.append(labelled(api, "頻度", frequencies.map(tag => {
      const values = [...tag.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(node => node.textContent).join("·");
      const source = tag.querySelector(".gsm-hoshidicts-frequency-source")?.textContent
        || (frequencies.length > 1 ? tag.dataset.dictionary : "");
      return source ? `${values}（${source}）` : values;
    }).join("　")));
  }
  const ipa = [...entry.querySelectorAll(".gsm-hoshidicts-ipa-body")].map(node => node.textContent).join(" / ");
  if (ipa) head.append(labelled(api, "IPA", ipa));
  api.move(head, entry, header.nextSibling);
}

// ---------------------------------------------------------------------------
// Kanji view: the 漢字辞典 screen — glyph in a box, then a labelled table per
// dictionary (音 / 訓 / 意味 / 画数 / 学年 / 頻度 / 区分).

function renderKanji(state, view, api) {
  const { content, chrome } = view;
  state.glyph = chrome?.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent ?? state.glyph;
  if (chrome) api.hide(chrome);
  if (content && !content.querySelector(":scope > .dj-kanji-head")) {
    const head = api.el("div", "dj-kanji-head");
    const glyph = api.el("div", "dj-glyph", state.glyph);
    glyph.setAttribute("aria-label", `漢字 ${state.glyph}`);
    head.append(glyph);
    api.move(head, content, content.querySelector(":scope > .gsm-hoshidicts-kanji-entry"));
  }
  view.entries.forEach((entry, index) => decorateKanjiEntry(entry, index, api));
  state.dictName = "漢字辞典";
}

function decorateKanjiEntry(entry, index, api) {
  entry.dataset.djIndex = String(index);
  if (entry.dataset.djTable) return;
  entry.dataset.djTable = "true";
  const table = api.el("dl", "dj-table");
  const row = (label, value) => {
    table.append(api.el("dt", "dj-table-label", label));
    const cell = api.el("dd", "dj-table-value");
    if (typeof value === "string") cell.textContent = value;
    else api.move(value, cell);
    table.append(cell);
  };
  for (const group of entry.querySelectorAll(":scope > .gsm-hoshidicts-kanji-readings > .gsm-hoshidicts-kanji-reading-group")) {
    const label = group.querySelector("strong")?.textContent ?? "";
    const value = group.querySelector("span")?.textContent ?? "";
    if (value) row(READING_LABELS[label] || label, value.split(" · ").join("・"));
  }
  const meanings = entry.querySelector(":scope > .gsm-hoshidicts-kanji-meanings");
  if (meanings) row("意味", meanings);
  // The stats a device prints (画数, 学年, 頻度, JLPT …) go in the table; the
  // dozens of dictionary index numbers KANJIDIC carries wait behind 決定.
  const extra = api.el("dl", "dj-table dj-table-extra");
  for (const name of entry.querySelectorAll(":scope > .gsm-hoshidicts-kanji-stats dl > dt")) {
    const value = name.nextElementSibling;
    if (value?.tagName !== "DD") continue;
    const label = STAT_LABELS[name.textContent.trim().toLowerCase()];
    if (label) row(label, value);
    else {
      extra.append(api.el("dt", "dj-table-label", name.textContent));
      const cell = api.el("dd", "dj-table-value");
      api.move(value, cell);
      extra.append(cell);
    }
  }
  const tags = entry.querySelector(":scope > .gsm-hoshidicts-tags");
  if (tags) row("区分", tags);
  const indices = extra.childElementCount / 2;
  if (indices > 0) {
    table.append(api.el("dt", "dj-table-label dj-table-more", "索引"),
      api.el("dd", "dj-table-value dj-table-more", `${indices}項目（決定で表示）`));
  }
  const anchor = entry.querySelector(":scope > .gsm-hoshidicts-kanji-dictionary")?.nextSibling ?? null;
  api.move(table, entry, anchor);
  if (indices > 0) api.move(extra, entry, table.nextSibling);
}

// ---------------------------------------------------------------------------
// Menu screen (hidden until メニュー): the reader's own actions, two switches
// and the history. Built at render time; handlers only toggle attributes.

function buildMenu(state, view, api) {
  const { content } = view;
  if (!content) return;
  let menu = content.querySelector(":scope > .dj-menu");
  if (menu && menu.dataset.key === state.key) return;
  if (!menu) {
    menu = api.el("section", "dj-menu");
    menu.setAttribute("aria-label", "メニュー");
    api.move(menu, content, content.firstChild);
  }
  menu.dataset.key = state.key;
  menu.replaceChildren();

  const items = api.el("div", "dj-menu-items");
  items.setAttribute("role", "menu");
  const item = (label, { target = null, disabled = false, stateText = "", onPress = null } = {}) => {
    const button = api.el("button", "dj-menu-item");
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitem");
    button.append(api.el("span", "dj-menu-label", label));
    if (stateText || onPress) button.append(api.el("span", "dj-menu-state", stateText));
    if (disabled) button.disabled = true;
    button.addEventListener("click", () => {
      if (onPress) { onPress(); refreshMenu(state); return; }
      target?.click();
      closeMenu(state);
    });
    items.append(button);
    return button;
  };
  const { popup } = view;
  const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
  const anki = item("Anki に登録", { target: mine, disabled: !mine, stateText: mine ? "" : "未設定" });
  anki.dataset.menu = "anki";
  const note = popup.querySelector(".gsm-hoshidicts-note-button");
  item("ノート（自分の辞書に追加）", { target: note, disabled: !note });
  for (const custom of popup.querySelectorAll(".gsm-hoshidicts-custom-anki-button, .gsm-hoshidicts-external-link-button")) {
    const label = custom.dataset.customButtonLabel || custom.textContent.trim();
    item(custom.matches(".gsm-hoshidicts-external-link-button") ? `${label} ↗` : `Anki: ${label}`, { target: custom });
  }
  item("訳の表示", { onPress: () => { session.gloss = !session.gloss; applyState(state); } }).dataset.menu = "gloss";
  item("バックライト", { onPress: () => { session.backlight = !session.backlight; applyState(state); } }).dataset.menu = "backlight";

  const history = api.el("ol", "dj-history");
  history.setAttribute("aria-label", "履歴");
  for (const record of session.history) {
    const line = api.el("li", "dj-history-item");
    const word = api.el("span", "dj-h-word", record.word);
    if (record.reading && record.reading !== record.word) word.append(api.el("span", "dj-h-reading", record.reading));
    if (record.kind === "kanji") word.append(api.el("span", "dj-h-kind", "漢"));
    line.append(word, api.el("span", "dj-h-gloss", record.gloss), api.el("span", "dj-h-time", record.time));
    history.append(line);
  }
  if (session.history.length === 0) history.append(api.el("li", "dj-menu-empty", "まだ調べた語はありません"));

  menu.append(api.el("h3", "dj-menu-heading", "メニュー"), items,
    api.el("h3", "dj-menu-heading", `履歴（このページで最近${HISTORY_MAX}件）`), history);
  refreshMenu(state);
}

function refreshMenu(state) {
  const { popup } = state;
  const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
  const anki = popup.querySelector('.dj-menu-item[data-menu="anki"] .dj-menu-state');
  if (anki && mine) anki.textContent = MINE_STATE[mine.dataset.state] ?? (mine.disabled ? "待機中" : "登録する");
  setText(popup, '.dj-menu-item[data-menu="gloss"] .dj-menu-state', session.gloss ? "ON" : "OFF");
  setText(popup, '.dj-menu-item[data-menu="backlight"] .dj-menu-state', session.backlight ? "ON" : "OFF");
}

function openMenu(state) {
  state.mode = "menu";
  state.menuIndex = 0;
  applyState(state);
  refreshMenu(state);
  menuItems(state)[0]?.focus({ preventScroll: true });
}

function closeMenu(state) {
  if (state.mode !== "menu") return;
  state.mode = "list";
  applyState(state);
  focusScreen(state);
}

function moveMenu(state, delta) {
  const items = menuItems(state);
  if (items.length === 0) return;
  const focused = items.indexOf(state.popup.getRootNode().activeElement);
  state.menuIndex = Math.max(0, Math.min(items.length - 1, (focused >= 0 ? focused : state.menuIndex) + delta));
  items[state.menuIndex].focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// History

function pushHistory(state, view) {
  const first = view.entries[0];
  if (!first) return;
  let word, reading = "", gloss;
  if (view.kind === "kanji") {
    word = state.glyph;
    gloss = [...first.querySelectorAll(".gsm-hoshidicts-kanji-meanings li")].map(node => node.textContent).join(", ");
  } else {
    word = first.dataset.expression || "";
    reading = splitLabel(first.querySelector(".gsm-hoshidicts-expression")).reading;
    const content = first.querySelector(".gsm-hoshidicts-glossary-content");
    const items = content ? [...content.querySelectorAll("li")] : [];
    gloss = items.length ? items.map(node => node.textContent.trim()).join("; ") : content?.textContent ?? "";
  }
  if (!word) return;
  gloss = gloss.replace(/\s+/gu, " ").trim().slice(0, 60);
  const previous = session.history.findIndex(record => record.kind === view.kind && record.word === word && record.reading === reading);
  if (previous >= 0) session.history.splice(previous, 1);
  session.history.unshift({ kind: view.kind, word, reading, gloss, time: clock() });
  session.history.length = Math.min(session.history.length, HISTORY_MAX);
}

// ---------------------------------------------------------------------------
// State → DOM. The only place that writes the device's attributes.

function applyState(state) {
  const { popup } = state;
  popup.dataset.djMode = state.mode;
  popup.dataset.djGloss = session.gloss ? "on" : "off";
  popup.dataset.djBacklight = session.backlight ? "on" : "off";
  const entries = entryNodes(state);
  state.cursor = Math.max(0, Math.min(entries.length - 1, state.cursor));
  const total = entries.length;
  const start = total <= LIST_WINDOW ? 0
    : Math.max(0, Math.min(state.cursor - Math.floor(LIST_WINDOW / 2), total - LIST_WINDOW));
  entries.forEach((entry, index) => {
    if (index === state.cursor) entry.dataset.djCursor = "true";
    else delete entry.dataset.djCursor;
    entry.dataset.djWindow = index >= start && index < start + LIST_WINDOW ? "in" : "out";
  });
  for (const link of popup.querySelectorAll(".gsm-hoshidicts-kanji-link[data-dj-jump]")) delete link.dataset.djJump;
  if (state.mode === "jump") {
    const links = jumpLinks(state);
    if (links.length === 0) {
      state.mode = "list";
      popup.dataset.djMode = "list";
    } else {
      state.jump = Math.max(0, Math.min(links.length - 1, state.jump));
      links[state.jump].dataset.djJump = "true";
    }
  }
  const above = start > 0 ? " ▲" : "";
  const below = start + LIST_WINDOW < total ? " ▼" : "";
  setText(popup, ".dj-title-dict", state.dictName);
  setText(popup, ".dj-title-mode", MODE_LABEL[state.mode]);
  setText(popup, ".dj-title-count", total ? `${state.cursor + 1}/${total}${above}${below}` : "");
  const hints = state.view?.kind === "kanji" && state.mode !== "menu" ? "kanji" : state.mode;
  for (const hint of popup.querySelectorAll(".dj-hint")) hint.hidden = hint.dataset.mode !== hints;
  const yaku = popup.querySelector('.dj-key[data-key="yaku"]');
  yaku?.setAttribute("aria-pressed", String(session.gloss));
  const audio = popup.querySelector('.dj-key[data-key="audio"]');
  if (audio) audio.disabled = !currentEntry(state)?.querySelector(".gsm-hoshidicts-audio-button");
  popup.querySelector('.dj-key[data-key="menu"]')?.setAttribute("aria-expanded", String(state.mode === "menu"));
  popup.querySelector('.dj-key[data-key="enter"]')?.setAttribute("aria-pressed", String(state.mode === "detail"));
}

function setStatus(state, text) {
  setText(state.popup, ".dj-status", text);
}

function remember(state) {
  state.memory.set(state.key, state.cursor);
  while (state.memory.size > MEMORY_MAX) state.memory.delete(state.memory.keys().next().value);
}

function setCursor(state, index) {
  const entries = entryNodes(state);
  if (entries.length === 0) return;
  state.cursor = Math.max(0, Math.min(entries.length - 1, index));
  remember(state);
  applyState(state);
  const entry = entries[state.cursor];
  if (state.mode === "detail") {
    const content = contentOf(state);
    if (content) content.scrollTop = 0;
  } else {
    lineOf(state, entry)?.scrollIntoView?.({ block: "nearest" });
  }
  setStatus(state, `${headwordText(state, entry)} ${state.cursor + 1}/${entries.length}`);
}

function moveCursor(state, delta) {
  const entries = entryNodes(state);
  const next = state.cursor + delta;
  if (next < 0) { setStatus(state, "先頭の候補です"); return; }
  if (next >= entries.length) {
    // Later results wait behind Show more: the device loads them on ↓.
    const more = state.popup.querySelector(".gsm-hoshidicts-show-more");
    if (!more) { setStatus(state, "最後の候補です"); return; }
    more.click(); // appends the rest synchronously and re-runs this hook
    if (next < entryNodes(state).length) setCursor(state, next);
    return;
  }
  setCursor(state, next);
}

function moveJump(state, delta) {
  const links = jumpLinks(state);
  if (links.length === 0) return;
  state.jump = (state.jump + delta + links.length) % links.length;
  applyState(state);
  setStatus(state, `漢字 ${links[state.jump].textContent} ${state.jump + 1}/${links.length}`);
}

function switchTab(state, delta) {
  const tabs = [...state.popup.querySelectorAll(".gsm-hoshidicts-tab")];
  if (tabs.length < 2) return;
  const selected = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
  const next = tabs[(Math.max(0, selected) + delta + tabs.length) % tabs.length];
  next.click(); // the reader re-renders the panel and runs the hook again
  focusScreen(state);
  setStatus(state, `辞書: ${next.textContent}`);
}

function scrollScreen(state, direction) {
  const content = contentOf(state);
  if (content) content.scrollBy({ top: direction * content.clientHeight * 0.8 });
}

// ---------------------------------------------------------------------------
// Keys

function press(state, id) {
  switch (id) {
    case "yaku":
      session.gloss = !session.gloss;
      applyState(state);
      refreshMenu(state);
      setStatus(state, session.gloss ? "訳を表示" : "訳を隠しました");
      break;
    case "enter": pressEnter(state); break;
    case "back": pressBack(state); break;
    case "audio": {
      const button = currentEntry(state)?.querySelector(".gsm-hoshidicts-audio-button");
      if (button && !button.disabled) { button.click(); setStatus(state, "♪ 音声"); } else setStatus(state, "音声はありません");
      break;
    }
    case "jump": pressJump(state); break;
    case "menu":
      if (state.mode === "menu") closeMenu(state);
      else openMenu(state);
      break;
    default: break;
  }
}

function pressEnter(state) {
  switch (state.mode) {
    case "menu": menuItems(state)[state.menuIndex]?.click(); break;
    case "jump": jumpLinks(state)[state.jump]?.click(); break; // the reader opens the kanji view
    case "detail":
      if (state.view?.kind === "kanji") { state.mode = "list"; applyState(state); setStatus(state, "索引を閉じました"); }
      else setStatus(state, "詳細を表示中です");
      break;
    default:
      if (state.view?.kind === "kanji") {
        if (!state.popup.querySelector(".dj-table-extra")) { setStatus(state, "索引はありません"); return; }
        state.mode = "detail";
        applyState(state);
        setStatus(state, "全索引を表示");
        return;
      }
      state.mode = "detail";
      applyState(state);
      const content = contentOf(state);
      if (content) content.scrollTop = 0;
      setStatus(state, "詳細");
  }
}

function pressBack(state) {
  switch (state.mode) {
    case "menu": closeMenu(state); break;
    case "jump":
      state.mode = "list";
      applyState(state);
      setStatus(state, "ジャンプを中止");
      break;
    case "detail":
      state.mode = "list";
      applyState(state);
      lineOf(state, currentEntry(state))?.scrollIntoView?.({ block: "nearest" });
      setStatus(state, "一覧");
      break;
    default: {
      // Back (kanji view) or Close (a nested popup) are the reader's buttons.
      const back = state.popup.querySelector(".gsm-hoshidicts-kanji-back, .gsm-hoshidicts-popup-close");
      if (back) back.click();
      else setStatus(state, "戻り先はありません");
    }
  }
}

function pressJump(state) {
  if (state.mode === "menu") return;
  if (state.mode === "jump") { jumpLinks(state)[state.jump]?.click(); return; }
  if (state.view?.kind !== "term") { setStatus(state, "ジャンプできる漢字はありません"); return; }
  state.mode = "list";
  const links = jumpLinks(state);
  if (links.length === 0) { applyState(state); setStatus(state, "見出し語に漢字はありません"); return; }
  state.mode = "jump";
  state.jump = 0;
  applyState(state);
  setStatus(state, `漢字 ${links[0].textContent} 1/${links.length}`);
}

function arrow(state, direction) {
  if (state.mode === "menu") {
    if (direction === "down" || direction === "up") moveMenu(state, direction === "down" ? 1 : -1);
    return;
  }
  if (state.mode === "jump") {
    if (direction === "left" || direction === "right") moveJump(state, direction === "right" ? 1 : -1);
    else { state.mode = "list"; applyState(state); moveCursor(state, direction === "down" ? 1 : -1); }
    return;
  }
  if (direction === "down" || direction === "up") moveCursor(state, direction === "down" ? 1 : -1);
  else switchTab(state, direction === "right" ? 1 : -1);
}

// One listener per popup element; it stays inert once the frame is gone (the
// theme was switched off) because every render that is not ours has no keys.
function onKeyDown(state, event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const { popup } = state;
  if (!popup.querySelector(":scope > .dj-keys")) return;
  const target = event.target;
  if (!target?.closest || target.closest(".gsm-hoshidicts-note-form, .gsm-hoshidicts-audio-menu, input, textarea, select, [contenteditable]")) return;
  if (target.matches('[role="tab"]') && event.key !== "Enter") return; // the tab list has its own arrows
  const onScreen = target === screenOf(state) || target === popup;
  let handled = true;
  switch (event.key) {
    case "ArrowDown": arrow(state, "down"); break;
    case "ArrowUp": arrow(state, "up"); break;
    case "ArrowLeft": arrow(state, "left"); break;
    case "ArrowRight": arrow(state, "right"); break;
    case "Enter":
      if (onScreen) pressEnter(state);
      else handled = false; // a focused button keeps its own Enter
      break;
    case "Backspace": pressBack(state); break;
    case "PageDown": scrollScreen(state, 1); break;
    case "PageUp": scrollScreen(state, -1); break;
    case "Home": if (state.mode !== "menu") setCursor(state, 0); else handled = false; break;
    case "End": if (state.mode !== "menu") setCursor(state, entryNodes(state).length - 1); else handled = false; break;
    default: handled = false;
  }
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function bindPopup(state) {
  if (bound.includes(state.popup)) return;
  bound.push(state.popup);
  state.onKey = event => onKeyDown(state, event);
  state.popup.addEventListener("keydown", state.onKey);
}

// ---------------------------------------------------------------------------

export default {
  schema: 1,
  slug: "denshi-jisho",

  onRender(view, api) {
      const state = device(view.popup);
    state.view = view;
    state.api = api;
    bindPopup(state);
    const key = renderKey(state, view);
    if (key !== state.key) {
      // A new lookup (not a tab switch, Show more or Back of the same word).
      state.key = key;
      state.mode = "list";
      state.jump = 0;
      state.cursor = state.memory.get(key) ?? 0;
    }
    buildFrame(state, view, api);
    if (view.kind === "term") renderTerm(state, view, api);
    else if (view.kind === "kanji") renderKanji(state, view, api);
    if (state.historyKey !== key) {
      state.historyKey = key;
      pushHistory(state, view);
    }
    buildMenu(state, view, api);
    setText(view.popup, ".dj-title-clock", clock());
    applyState(state);
    // Re-focusing forces a layout of the rebuilt DOM (and, the first time, the
    // glyph font's shaping): do it once the reader's own render task is over.
    // `wanted` is read now, before the blur microtask of the removed screen runs.
    const wanted = state.screenFocused;
    if (wanted) Promise.resolve().then(() => focusScreen(state));
    api.requestLayout();
  },

  onDeactivate() {
    for (const popup of bound.splice(0)) {
      const state = devices.get(popup);
      if (state?.onKey) popup.removeEventListener("keydown", state.onKey);
      for (const name of ["djMode", "djGloss", "djBacklight"]) delete popup.dataset[name];
      devices.delete(popup);
    }
  },
};
