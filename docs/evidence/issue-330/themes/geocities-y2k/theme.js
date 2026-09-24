// themes/geocities-y2k/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (hachidori-themes CI lint + the reader's host): one default export,
// synchronous hooks, only `view` and `api`, no globals, no HTML strings. A hook
// that throws switches this module off for the page; the CSS layer keeps working.
//
// Every looked-up word gets its own 1999 personal homepage: a welcome marquee,
// a bevelled プロフィール table, a 訪問者数 odometer fed by the lookup count, a
// リンク集 of 88×31 dictionary buttons, a ゲストブック holding the real Anki /
// audio / note buttons, a WebRing between entries and a sparkle cursor trail.
// The definitions themselves stay a plain readable block.

const SLUG = "geocities-y2k";

// One block of selectors, so a renamed class in reader.css is one edit here.
const HEADER = ".gsm-hoshidicts-primary-header";
const EXPRESSION = ".gsm-hoshidicts-expression";
const DEINFLECTION = ".gsm-hoshidicts-deinflection";
const ACTIONS = ".gsm-hoshidicts-entry-actions";
const TAB_LIST = ".gsm-hoshidicts-tab-list";
const PANEL = ".gsm-hoshidicts-tab-panel";
const ENTRY = ".gsm-hoshidicts-entry";
const LOOKUP_STATS = ".gsm-hoshidicts-lookup-stats";
const FREQUENCIES = ".gsm-hoshidicts-primary-frequencies";
const GRAMMAR = ".gsm-hoshidicts-primary-grammar";
const PITCH_ROW = ".gsm-hoshidicts-pitch-metadata";
const IPA_ROW = ".gsm-hoshidicts-ipa-metadata";
const CARD = ".gsm-hoshidicts-glossary-card";
const CARD_TITLE = ".gsm-hoshidicts-glossary-card-title";
const GLOSS = ".gsm-hoshidicts-glossary-content";
// Part-of-speech tags only: deinflection steps ("past", "negative") are not moods.
const POS_TAGS = ".gsm-hoshidicts-primary-grammar-tag-term, .gsm-hoshidicts-tag-term, .gsm-hoshidicts-tag-definition";
const KANJI_ENTRY = ".gsm-hoshidicts-kanji-entry";
const KANJI_GLYPH = ".gsm-hoshidicts-kanji-glyph";
const KANJI_DICTIONARY = ".gsm-hoshidicts-kanji-dictionary";
const KANJI_READING_GROUP = ".gsm-hoshidicts-kanji-reading-group";
const KANJI_STATS = ".gsm-hoshidicts-kanji-stats";

const ODOMETER_DIGITS = 6;
const COUNTER_TICKS = 10;     // × the 200 ms CSS tick = 2 s of waiting for the count
const SPARKLE_LIMIT = 14;
const SPARKLE_STEP = 18;      // CSS px of pointer travel between sparkles
const SPARKLES = ["✦", "✧", "★", "☆", "･", "ﾟ", "✦", "＋"];

// Kaomoji "webmasters" by part of speech, matched against Yomitan/JMdict tag
// names (v1, vt, adj-i, n, int, exp, prt …). The word picks a stable face for
// itself (pick()), so 食べる always greets you with the same one.
const MOODS = [
  { test: /^(v[1-5][a-z-]*|vs(-[a-z]+)?|vk|vz|vi|vt|v-unspec|ichidan|godan|verb)$/u,
    faces: ["( ｀ー´)ﾉ", "＼(^o^)／", "(๑•̀ㅂ•́)و✧"], line: "動詞です。動きを表すことば！" },
  { test: /^(adj-[a-z]+|adjective)$/u, faces: ["(*´∇｀*)", "(・∀・)b", "(＞ω＜)"], line: "形容詞です。ようすを表すことば。" },
  { test: /^(adv(-to)?|adverb)$/u, faces: ["(・ω・)ノ", "( ・ㅂ・)و"], line: "副詞です。動詞にそっと寄り添います。" },
  { test: /^(int|interjection)$/u, faces: ["ヽ(´▽`)/", "(≧▽≦)", "(ﾟ▽ﾟ)/"], line: "感動詞です！叫びます！" },
  { test: /^(exp|expression|id|proverb)$/u, faces: ["(￣ー￣)", "( ˘ω˘ )", "(´ｰ`)"], line: "決まり文句・表現です。丸ごと覚えてね。" },
  { test: /^(prt|aux|aux-adj|conj|cop|copula|particle|auxiliary)$/u, faces: ["(´・ω・｀)", "(・_・)", "( ´_ゝ`)"], line: "助詞・助動詞です。文をつなぎます。" },
  { test: /^(n(-[a-z]+)?|pn|num|ctr|noun|pronoun|suf|pref)$/u, faces: ["(・∀・)", "( ^ω^ )", "(°▽°)"], line: "名詞です。モノやコトの名前。" },
];
const DEFAULT_MOOD = { faces: ["(´・ω・｀)", "(・ω・)"], line: "ことばのホームページへようこそ。" };
const CONSTRUCTION_MOOD = { faces: ["(・_・;)", "(；´Д｀)"], line: "このページはまだ工事中です…" };
const KANJI_MOOD = { faces: ["(ﾟ∀ﾟ)", "(・∀・)つ", "( ・`ω・´)"], line: "今日の漢字はこれ！じっくり眺めてね。" };

// Visitor-count captions, in the voice of a 1999 access counter.
function visitCaption(count) {
  if (count <= 1) return "はじめまして！ようこそ！";
  if (count <= 4) return "またお会いしましたね♪";
  if (count <= 9) return "常連さんですね！(´∀｀)";
  return "そろそろ覚えましょう♪ (￣ω￣;)";
}

// KANJIDIC statistics → stickers on the 今日の漢字 plaque.
const STICKERS = {
  strokes: value => `${value}画`,
  grade: value => (/^[1-6]$/u.test(value) ? `小学${value}年` : value === "8" ? "中学" : /^(9|10)$/u.test(value) ? "人名用" : null),
  freq: value => `頻度 ${value}位`,
  jlpt: value => `旧JLPT ${value}級`,
};

// Stable "random" choice: the word hashes itself.
function pick(list, seed) {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)) % 100003;
  return list[hash % list.length];
}

function text(node) {
  return (node?.textContent || "").replace(/\s+/gu, " ").trim();
}

// The renderer labels the headword "<expression>, <reading>" (popup.js createEntryHeader);
// that aria-label is the one place the reading exists as plain text.
function splitLabel(expression) {
  const label = expression?.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0
    ? { word: label.slice(0, comma), reading: label.slice(comma + 2) }
    : { word: label, reading: "" };
}

function heading(api, label, level = "h2") {
  const node = api.el(level, "y2k-heading");
  node.append(api.el("span", "y2k-heading-star", "★"), api.el("span", "y2k-heading-text", label),
    api.el("span", "y2k-heading-star", "★"));
  return node;
}

function frame(api, className, label) {
  const section = api.el("section", `y2k-frame ${className}`);
  if (label) section.appendChild(heading(api, label));
  return section;
}

function row(api, table, label, className = "") {
  table.appendChild(api.el("div", "y2k-th", label));
  return table.appendChild(api.el("div", `y2k-td ${className}`));
}

function button(api, className, label, title) {
  const node = api.el("button", className, label);
  node.type = "button";
  if (title) node.title = title;
  return node;
}

// ---------------------------------------------------------------------------
// Shell: marquee + two-column table + footer. Built once per lookup (the
// renderer empties the scroll area for each new lookup) and reused across the
// re-renders of that lookup (tab switch, Show more), because the tab list and a
// focused button must never be detached.
function ensureShell(view, api, kind) {
  const { content } = view;
  let page = content.querySelector(":scope > .y2k-page");
  if (page && page.dataset.kind !== kind) { page.remove(); page = null; }
  if (page) return page;

  page = api.el("div", "y2k-page");
  page.dataset.kind = kind;
  page.dataset.visit = "unknown";
  const marquee = api.el("div", "y2k-marquee");
  marquee.setAttribute("aria-hidden", "true");   // decorative: it repeats the headword
  marquee.appendChild(api.el("span", "y2k-marquee-track"));
  const body = api.el("div", "y2k-body");
  body.append(api.el("div", "y2k-main"), api.el("aside", "y2k-side"));
  const footer = api.el("footer", "y2k-footer");
  footer.append(api.el("span", "y2k-footer-item", "Since 1999"), api.el("span", "y2k-footer-item", "800×600 推奨"),
    api.el("span", "y2k-footer-item", "リンクフリー"), api.el("span", "y2k-footer-item y2k-footer-made", "Made with Hachidori"));
  page.append(marquee, body, footer);
  api.move(page, content, content.firstChild);
  installSparkles(page, api);
  return page;
}

// 1999 DHTML cursor trail, confined to the popup: at most SPARKLE_LIMIT glyphs,
// each removed when its CSS fade ends. Under prefers-reduced-motion the sheet
// hides .y2k-sparkle, so nothing is ever seen and the ring buffer stays bounded.
function installSparkles(page, api) {
  let last = null;
  let serial = 0;
  page.addEventListener("pointermove", event => {
    const rect = page.getBoundingClientRect();
    if (!rect.width || !page.offsetWidth) return;
    const zoom = rect.width / page.offsetWidth;          // popup scale × page zoom
    const x = (event.clientX - rect.left) / zoom;
    const y = (event.clientY - rect.top) / zoom;
    if (last && Math.hypot(x - last.x, y - last.y) < SPARKLE_STEP) return;
    last = { x, y };
    const sparkle = api.el("span", `y2k-sparkle y2k-sparkle-${serial % 4}`, SPARKLES[serial % SPARKLES.length]);
    serial += 1;
    sparkle.setAttribute("aria-hidden", "true");
    sparkle.style.setProperty("--y2k-x", `${Math.round(x)}px`);
    sparkle.style.setProperty("--y2k-y", `${Math.round(y)}px`);
    sparkle.addEventListener("animationend", () => sparkle.remove());
    const existing = page.querySelectorAll(":scope > .y2k-sparkle");
    if (existing.length >= SPARKLE_LIMIT) existing[0].remove();
    api.move(sparkle, page);
  });
}

function setMarquee(page, api, parts) {
  const track = page.querySelector(".y2k-marquee-track");
  track.replaceChildren();
  for (const part of parts) {
    track.append(api.el("span", "y2k-marquee-star", "☆"), api.el("span", part.className || "", part.text));
  }
  track.append(api.el("span", "y2k-marquee-star", "☆"));
}

// ---------------------------------------------------------------------------
// 訪問者数: six odometer reels showing the lookup count. The reader paints the
// count asynchronously, a few ms after onRender, and there is no hook for that
// moment; so the counter listens for the end of a 200 ms CSS animation on
// itself (a timer without setTimeout) and re-reads the count up to ten times.
// Back, Show more and tab switches already have the count when they render.
function readCount(page) {
  const stats = page.querySelector(LOOKUP_STATS);
  if (!stats || stats.hidden) return null;
  const digits = /\d+/u.exec(text(stats));
  return digits ? Number(digits[0]) : null;
}

function buildCounter(api) {
  const counter = frame(api, "y2k-counter", "訪問者数");
  const line = api.el("p", "y2k-counter-line");
  const display = api.el("span", "y2k-odometer");
  display.setAttribute("role", "img");
  display.setAttribute("aria-label", "訪問者数 準備中");
  line.append(api.el("span", "y2k-counter-lead", "あなたは"), display, api.el("span", "y2k-counter-tail", "人目のお客様です"));
  counter.append(line, api.el("p", "y2k-counter-mood", "カウンター準備中…"));
  return counter;
}

function fillCounter(counter, count, page, api) {
  const display = counter.querySelector(".y2k-odometer");
  display.replaceChildren();
  const padded = String(count).padStart(ODOMETER_DIGITS, "0").slice(-ODOMETER_DIGITS);
  display.setAttribute("aria-label", `訪問者数 ${count}`);
  for (const digit of padded) {
    const reel = api.el("span", `y2k-reel y2k-d${digit}`);
    const strip = api.el("span", "y2k-reel-strip");
    for (let value = 0; value <= 9; value += 1) strip.appendChild(api.el("span", "", String(value)));
    reel.appendChild(strip);
    display.appendChild(reel);
  }
  counter.querySelector(".y2k-counter-mood").textContent = visitCaption(count);
  counter.dataset.state = "counted";
  page.dataset.visit = count <= 1 ? "first" : "repeat";
}

function armCounter(counter, page, api) {
  counter.dataset.state = "waiting";
  let ticks = 0;
  const tick = event => {
    if (event.animationName !== "y2k-tick") return;
    if (counter.dataset.state !== "waiting") { counter.removeEventListener("animationend", tick); return; }
    const count = readCount(page);
    if (count !== null) { fillCounter(counter, count, page, api); counter.removeEventListener("animationend", tick); return; }
    ticks += 1;
    if (ticks >= COUNTER_TICKS || !counter.isConnected) {
      // Counts are off (or unavailable): say so instead of spinning forever.
      counter.querySelector(".y2k-counter-mood").textContent = "カウンターはお休み中";
      counter.querySelector(".y2k-odometer").setAttribute("aria-label", "訪問者数 非表示");
      counter.dataset.state = "off";
      counter.removeEventListener("animationend", tick);
      return;
    }
    counter.classList.remove("y2k-ticking");
    void counter.offsetWidth;                  // restart the CSS tick animation
    counter.classList.add("y2k-ticking");
  };
  counter.addEventListener("animationend", tick);
  counter.classList.add("y2k-ticking");
}

function renderCounter(page, side, api) {
  let counter = side.querySelector(":scope > .y2k-counter");
  if (!counter) { counter = buildCounter(api); api.move(counter, side, side.firstChild); }
  const known = readCount(page);
  if (known !== null) { fillCounter(counter, known, page, api); return; }
  if (counter.dataset.state === "counted") return;      // a dictionary tab keeps the All tab's count
  if (!page.querySelector(LOOKUP_STATS)) {
    // The reader only renders the count slot on the All tab (popup.js lookupStatsSlot).
    counter.dataset.state = "off";
    counter.querySelector(".y2k-counter-mood").textContent = "カウンターは All タブにあります";
    return;
  }
  if (!counter.dataset.state) armCounter(counter, page, api);
}

// ---------------------------------------------------------------------------
// Scrolls the popup body (not the page) so `target` sits under the marquee.
function scrollContentTo(content, target) {
  const marquee = content.querySelector(".y2k-marquee");
  const offset = (marquee?.offsetHeight || 0) + 6;
  content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - offset;
}

// リンク集: the real dictionary tabs when there are several dictionaries (they
// keep their role=tab arrow-key behaviour), otherwise one 88×31 button per
// dictionary that scrolls the definitions to its card or entry.
function renderLinks(view, api, side, targets) {
  let links = side.querySelector(":scope > .y2k-links");
  if (!links) { links = frame(api, "y2k-links", "リンク集"); api.move(links, side); }
  const tabList = view.popup.querySelector(TAB_LIST);
  if (tabList) {
    if (tabList.parentNode !== links) api.move(tabList, links);
    return;
  }
  for (const stale of links.querySelectorAll(":scope > .y2k-banner-row")) stale.remove();
  const rowNode = api.el("div", "y2k-banner-row");
  const seen = new Set();
  for (const { node, title, name } of targets) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const banner = button(api, "y2k-banner", title || name, `${name} へ`);
    banner.addEventListener("click", () => scrollContentTo(view.content, node));
    rowNode.appendChild(banner);
  }
  if (rowNode.childNodes.length) api.move(rowNode, links);
}

// ゲストブック: the reader's own action row (Anki 書き込む, audio BGM, Note 日記,
// custom buttons). The renderer re-appends it to its header on every render, so
// every render moves it back.
function renderGuestbook(api, side, actions) {
  let guestbook = side.querySelector(":scope > .y2k-guestbook");
  if (!guestbook) { guestbook = frame(api, "y2k-guestbook", "ゲストブック"); api.move(guestbook, side); }
  if (actions && actions.parentNode !== guestbook) api.move(actions, guestbook);
}

// WebRing: ← 前 | 次 → between the entries of this lookup (Show more grows it).
function renderWebring(view, api, main) {
  let ring = main.querySelector(":scope > .y2k-webring");
  const count = view.entries.length;
  if (count < 2) { ring?.remove(); return; }
  if (ring) { ring.querySelector(".y2k-ring-label").textContent = `WebRing ${count}件`; return; }
  ring = api.el("nav", "y2k-webring");
  ring.setAttribute("aria-label", "WebRing: entries of this lookup");
  const step = direction => {
    const content = view.content;
    const top = content.getBoundingClientRect().top + (content.querySelector(".y2k-marquee")?.offsetHeight || 0) + 6;
    const entries = [...content.querySelectorAll(`${ENTRY}, ${KANJI_ENTRY}`)];
    const positions = entries.map(entry => entry.getBoundingClientRect().top - top);
    const target = direction > 0
      ? entries[positions.findIndex(position => position > 4)]
      : entries[positions.reduce((found, position, index) => (position < -4 ? index : found), -1)];
    if (target) scrollContentTo(content, target);
  };
  const previous = button(api, "y2k-ring-button", "← 前の言葉", "前の項目へ");
  const next = button(api, "y2k-ring-button", "次の言葉 →", "次の項目へ");
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  ring.append(previous, api.el("span", "y2k-ring-label", `WebRing ${count}件`), next);
  api.move(ring, main);
}

// ---------------------------------------------------------------------------
// Term view.
function moodFor(entry, underConstruction) {
  if (underConstruction) return CONSTRUCTION_MOOD;
  for (const tag of entry.querySelectorAll(POS_TAGS)) {
    const name = text(tag).toLowerCase();
    const mood = MOODS.find(candidate => candidate.test.test(name));
    if (mood) return mood;
  }
  return DEFAULT_MOOD;
}

// プロフィール: the renderer's header (headword, furigana, kanji buttons) in the
// 名前 cell, the reading and the webmaster's one-liner. Three rows, so the 意味
// block starts above the fold of a 420 px popup. Frequency, pitch, IPA and the
// deinflection trail go to the データ frame under the definitions (renderData).
function renderProfile(api, main, header, entry) {
  // The hook can run again for the same render (the reader adopts dictionary
  // presentation a moment after the first paint). Fresh nodes live in the entry;
  // nodes the previous run already moved live in the old frames. Prefer fresh.
  const previous = [...main.querySelectorAll(":scope > .y2k-profile, :scope > .y2k-data")];
  const find = (root, selector) => root.querySelector(selector)
    || previous.map(frameNode => frameNode.querySelector(selector)).find(Boolean) || null;
  const profile = frame(api, "y2k-profile", "プロフィール");
  const table = api.el("div", "y2k-table");
  profile.appendChild(table);

  const { word, reading } = splitLabel(header.querySelector(EXPRESSION));
  const name = row(api, table, "名前", "y2k-name");
  api.move(header, name);                  // whole header: the renderer still finds its headword inside
  name.appendChild(api.el("span", "y2k-new", "NEW!"));
  if (reading && reading !== word) row(api, table, "よみ", "y2k-reading").textContent = reading;

  const underConstruction = [...entry.querySelectorAll(`${CARD} ${GLOSS}`)].some(gloss => !gloss.hasChildNodes());
  const mood = moodFor(entry, underConstruction);
  const hitokoto = row(api, table, "ひとこと", "y2k-hitokoto");
  hitokoto.append(api.el("span", "y2k-kaomoji", pick(mood.faces, word)), api.el("span", "y2k-hitokoto-text", mood.line));

  const data = frame(api, "y2k-data", "データ");
  const dataTable = api.el("div", "y2k-table");
  data.appendChild(dataTable);
  const grammar = find(entry, GRAMMAR);
  if (grammar?.childNodes.length) api.move(grammar, row(api, dataTable, "品詞"));
  const frequencies = find(entry, FREQUENCIES);
  if (frequencies?.childNodes.length) api.move(frequencies, row(api, dataTable, "頻度"));
  const pitch = find(entry, PITCH_ROW);
  if (pitch?.childNodes.length) api.move(pitch, row(api, dataTable, "アクセント"));
  const ipa = find(entry, IPA_ROW);
  if (ipa?.childNodes.length) api.move(ipa, row(api, dataTable, "発音"));
  const deinflection = find(header, DEINFLECTION);
  if (deinflection) api.move(deinflection, row(api, dataTable, "更新履歴"));

  for (const stale of previous) stale.remove();
  api.move(profile, main, main.firstChild);
  const meanings = main.querySelector(":scope > .y2k-meanings");
  if (dataTable.childNodes.length) api.move(data, main, meanings?.nextSibling ?? null);
  return { word, reading };
}

function decorateEntries(view) {
  for (const [index, entry] of view.entries.entries()) {
    if (entry.dataset.y2k) continue;
    entry.dataset.y2k = index === 0 ? "primary" : "secondary";
    // The dictionary name above each card becomes an 88×31 style banner (CSS);
    // the definition list itself stays exactly what the renderer produced.
    for (const title of entry.querySelectorAll(CARD_TITLE)) title.dataset.y2kBanner = "true";
  }
}

function renderTerm(view, api) {
  const header = view.popup.querySelector(HEADER);
  const entry = view.entries[0];
  if (!header || !entry) return;
  const page = ensureShell(view, api, "term");
  const main = page.querySelector(".y2k-main");
  const side = page.querySelector(".y2k-side");
  const actions = header.querySelector(`:scope > ${ACTIONS}`);

  let meanings = main.querySelector(":scope > .y2k-meanings");
  if (!meanings) { meanings = frame(api, "y2k-meanings", "意味"); api.move(meanings, main); }
  const panel = view.popup.querySelector(PANEL);
  if (panel && panel.parentNode !== meanings) api.move(panel, meanings);

  const { word, reading } = renderProfile(api, main, header, entry);
  setMarquee(page, api, [
    { text: "ようこそ！" },
    { text: `「${word}」${reading && reading !== word ? `（${reading}）` : ""}のホームページへ`, className: "y2k-marquee-word" },
    { text: "Welcome to my homepage" }, { text: "訪問ありがとうございます" }, { text: "リンクフリーです" },
  ]);
  decorateEntries(view);
  renderWebring(view, api, main);
  renderCounter(page, side, api);
  renderLinks(view, api, side, [...entry.querySelectorAll(CARD)].map(card => {
    const title = card.querySelector(CARD_TITLE);
    return { node: card, title: text(title), name: title?.getAttribute("title") || text(title) };
  }));
  renderGuestbook(api, side, actions);
  if (view.chrome) api.hide(view.chrome);
}

// ---------------------------------------------------------------------------
// Kanji view: 今日の漢字 on a deep bevelled plaque with stickers computed from
// the KANJIDIC statistics, readings as bullet lists, meanings under a rainbow heading.
function renderKanjiEntry(entry, api) {
  if (entry.dataset.y2k) return;
  entry.dataset.y2k = "kanji";
  for (const group of entry.querySelectorAll(KANJI_READING_GROUP)) {
    const label = group.querySelector("strong");
    const values = group.querySelector("span");
    if (!label || !values) continue;
    const kind = text(label).toLowerCase();
    const list = api.el("ul", "y2k-bullets");
    for (const reading of text(values).split(" · ").filter(Boolean)) list.appendChild(api.el("li", "", reading));
    api.hide(label);
    api.hide(values);
    api.move(api.el("span", `y2k-reading-label y2k-reading-${kind}`,
      kind === "on" ? "音読み" : kind === "kun" ? "訓読み" : text(label)), group);
    api.move(list, group);
  }
  for (const h4 of entry.querySelectorAll(":scope > h4")) {
    api.hide(h4);
    api.move(heading(api, "意味", "h4"), entry, h4.nextSibling);
  }
  const stats = entry.querySelector(KANJI_STATS);
  if (stats) {
    stats.open = true;
    api.move(heading(api, "データ", "h4"), entry, stats);
  }
}

function stickersFor(entry, api) {
  const stickers = api.el("div", "y2k-stickers");
  for (const term of entry?.querySelectorAll(`${KANJI_STATS} dt`) ?? []) {
    const format = STICKERS[text(term).toLowerCase()];
    const value = text(term.nextElementSibling);
    const label = format && value ? format(value) : null;
    if (label) stickers.appendChild(api.el("span", "y2k-sticker", label));
  }
  return stickers;
}

function renderKanji(view, api) {
  const header = view.popup.querySelector(HEADER);
  if (!header) return;
  const page = ensureShell(view, api, "kanji");
  const main = page.querySelector(".y2k-main");
  const side = page.querySelector(".y2k-side");
  const actions = header.querySelector(`:scope > ${ACTIONS}`);
  const character = text(header.querySelector(KANJI_GLYPH));

  main.querySelector(":scope > .y2k-today")?.remove();
  const today = frame(api, "y2k-today", "今日の漢字");
  const plaque = api.el("div", "y2k-plaque");
  api.move(header, plaque);
  plaque.appendChild(stickersFor(view.entries[0], api));
  const hitokoto = api.el("p", "y2k-hitokoto y2k-hitokoto-kanji");
  hitokoto.append(api.el("span", "y2k-kaomoji", pick(KANJI_MOOD.faces, character)), api.el("span", "y2k-hitokoto-text", KANJI_MOOD.line));
  today.append(plaque, hitokoto);
  api.move(today, main, main.firstChild);

  let meanings = main.querySelector(":scope > .y2k-meanings");
  if (!meanings) { meanings = frame(api, "y2k-meanings", "読み・意味"); api.move(meanings, main); }
  for (const entry of view.entries) {
    if (entry.parentNode !== meanings) api.move(entry, meanings);
    renderKanjiEntry(entry, api);
  }
  setMarquee(page, api, [{ text: "今日の漢字" }, { text: `「${character}」`, className: "y2k-marquee-word" },
    { text: "Kanji of the day" }, { text: "じっくり眺めよう" }]);
  renderLinks(view, api, side, view.entries.map(entry => {
    const title = entry.querySelector(KANJI_DICTIONARY);
    return { node: entry, title: text(title), name: entry.dataset.dictionary || text(title) };
  }));
  renderGuestbook(api, side, actions);
  renderWebring(view, api, main);
  if (view.chrome) api.hide(view.chrome);
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
