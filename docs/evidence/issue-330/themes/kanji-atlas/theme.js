// themes/kanji-atlas/theme.js — Hachidori theme module, schema 1.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract (hachidori-themes CI lint and the reader's host): one default export;
// hooks are synchronous and return nothing; no import/export other than this
// default, no fetch/XHR/WebSocket, no chrome.*/browser.*, no window/document/
// globalThis — only `view` and `api`. A hook that throws switches this module
// off for the page; the CSS layer keeps working.
//
// Kanji Atlas turns the popup into a page from a kanji reference book:
//  · term view  — the headword's kanji become a rail of tiles: the glyph inside
//                 a stroke ring, the reading THIS word uses (音 in vermilion,
//                 訓 in indigo), JLPT · grade · strokes and the top meanings;
//                 the glosses follow, flat and compact;
//  · kanji view — one atlas card: big glyph, stroke ring (or the dictionary's
//                 own stroke diagram when it ships one), 音/訓 readings with the
//                 reading you arrived from highlighted, badges, meanings, and
//                 the words this page has already met with the kanji;
//  · memory     — module state, nothing stored: facts harvested from a kanji
//                 dictionary's cards and from kanji views fill the tiles in as
//                 you read; onDeactivate forgets everything.

const SLUG = "kanji-atlas";
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
const BEE = role => `[data-sc-bee-role="${role}"]`;   // Bee's Ultimate Kanji Dictionary marks its parts
const MET_LIMIT = 8;

// ---- memory: per page, per module instance --------------------------------
const facts = new Map();     // kanji → { on: [], kun: [], meanings: [], keyword, strokes, grade, jlpt, rank, heisig, jouyou, source }
const met = new Map();       // kanji → Map(expression → { reading, gloss, seq })
const arrivedBy = new Map(); // kanji → hiragana reading it had in the last word that showed it
let seq = 0;

// ---- small helpers ----------------------------------------------------------
function text(node) {
  return node ? node.textContent.replace(/\s+/gu, " ").trim() : "";
}

function isOneKanji(value) {
  return [...value].length === 1 && HAN.test(value);
}

function toHiragana(value) {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

// "た.べる" → stem た + okurigana べる; "-がき" → がき.
function splitReading(reading) {
  const clean = reading.replace(/^-|-$/gu, "");
  const dot = clean.indexOf(".");
  return dot >= 0 ? { stem: clean.slice(0, dot), okurigana: clean.slice(dot + 1) } : { stem: clean, okurigana: "" };
}

// The renderer labels the headword "<expression>, <reading>" (popup.js createEntryHeader).
function splitLabel(expression) {
  const label = expression.getAttribute("aria-label") || "";
  const comma = label.indexOf(", ");
  return comma >= 0 ? { word: label.slice(0, comma), reading: label.slice(comma + 2) } : { word: label, reading: "" };
}

function learn(char, patch) {
  const known = facts.get(char) || { on: [], kun: [], meanings: [] };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "") known[key] = value;
  }
  facts.set(char, known);
  return known;
}

function parseBadge(label, target) {
  let m;
  if ((m = /(\d+)\s*strokes?/iu.exec(label))) target.strokes = Number(m[1]);
  else if ((m = /grade\s*(\d+)/iu.exec(label))) target.grade = m[1];
  else if ((m = /jlpt\s*(N?\d)/iu.exec(label))) target.jlpt = m[1].toUpperCase();
  else if ((m = /rank\s*#?(\d+)/iu.exec(label))) target.rank = Number(m[1]);
}

// ---- harvesting: the popup already contains kanji facts, read them ---------
// A single-kanji card from Bee's Ultimate Kanji Dictionary rendered as a term
// entry (it is a term dictionary, so it answers 食 inside 食べたかった).
function harvestBee(entry) {
  const glyph = text(entry.querySelector(BEE("hero-glyph")));
  if (!isOneKanji(glyph)) return null;
  const found = { source: dictionaryLabel(entry), keyword: text(entry.querySelector(BEE("hero-keyword"))) };
  const meaning = text(entry.querySelector(BEE("meaning")));
  if (meaning) found.meanings = meaning.split(/;\s*/u).filter(Boolean);
  for (const group of entry.querySelectorAll(BEE("reading-group"))) {
    const label = text(group.querySelector(BEE("reading-label"))).toLowerCase();
    const chips = [...group.querySelectorAll(BEE("reading-chip"))].map(text).filter(Boolean);
    if (label.startsWith("on")) found.on = chips;
    else if (label.startsWith("kun")) found.kun = chips;
  }
  for (const badge of entry.querySelectorAll(BEE("badge"))) parseBadge(text(badge), found);
  learn(glyph, found);
  return glyph;
}

// A native kanji-bank entry (KANJIDIC and friends) in the kanji view.
function harvestNative(entry, char) {
  const found = { source: text(entry.querySelector(".gsm-hoshidicts-kanji-dictionary")) };
  for (const group of entry.querySelectorAll(".gsm-hoshidicts-kanji-reading-group")) {
    const label = text(group.querySelector("strong")).toLowerCase();
    const values = text(group.querySelector("span")).split(/\s*·\s*/u).filter(Boolean);
    if (label.startsWith("on")) found.on = values;
    else if (label.startsWith("kun")) found.kun = values;
  }
  found.meanings = [...entry.querySelectorAll(".gsm-hoshidicts-kanji-meanings > li")].map(text).filter(Boolean);
  found.keyword = found.meanings[0] || "";
  for (const dt of entry.querySelectorAll(".gsm-hoshidicts-kanji-stats dt")) {
    const name = text(dt).toLowerCase();
    const value = text(dt.nextElementSibling);
    if (name.startsWith("stroke")) found.strokes = Number(value);
    else if (name.startsWith("grade")) found.grade = value;
    else if (name.startsWith("jlpt")) found.jlptOld = value;   // KANJIDIC keeps the pre-2010 four-level scale
    else if (name.startsWith("freq")) found.rank = Number(value);
    else if (name === "heisig") found.heisig = value;
  }
  const tags = [...entry.querySelectorAll(".gsm-hoshidicts-tags .gsm-hoshidicts-tag")].map(text);
  if (tags.includes("jouyou")) found.jouyou = "常用";
  else if (tags.includes("jinmeiyou")) found.jouyou = "人名用";
  return learn(char, found);
}

function dictionaryLabel(entry) {
  return text(entry.querySelector(".gsm-hoshidicts-glossary-card-title"));
}

// A native kanji entry laid out as a structured card inside a clicked-kanji
// group (popup.js kanjiEntryGlossary): reading rows, a meanings list and a
// Details table.
function harvestNativeCard(entry) {
  const rows = [...entry.querySelectorAll('[data-sc-content="reading"]')];
  if (rows.length === 0 || !isOneKanji(entry.dataset.expression || "")) return null;
  const found = { source: dictionaryLabel(entry) };
  for (const row of rows) {
    const label = text(row.querySelector("strong")).toLowerCase();
    const values = text(row).replace(/^\S+\s*/u, "").split(/\s*·\s*/u).filter(Boolean);
    if (label.startsWith("on")) found.on = values;
    else if (label.startsWith("kun")) found.kun = values;
  }
  found.meanings = [...entry.querySelectorAll(".gsm-hoshidicts-glossary-content ol > li")].map(text).filter(Boolean);
  found.keyword = found.meanings[0] || "";
  for (const th of entry.querySelectorAll(".gsm-hoshidicts-glossary-content th")) {
    const name = text(th).toLowerCase();
    const value = text(th.nextElementSibling);
    if (name.startsWith("stroke")) found.strokes = Number(value);
    else if (name.startsWith("grade")) found.grade = value;
    else if (name.startsWith("jlpt")) found.jlptOld = value;
    else if (name.startsWith("freq")) found.rank = Number(value);
    else if (name === "heisig") found.heisig = value;
  }
  learn(entry.dataset.expression, found);
  return entry.dataset.expression;
}

function glossOf(entry) {
  const content = entry.querySelector(".gsm-hoshidicts-glossary-content");
  if (!content) return "";
  const items = [...content.querySelectorAll("li")].map(text).filter(Boolean);
  const value = items.length > 0 ? items.join("; ") : text(content);
  return value.length > 60 ? `${value.slice(0, 59)}…` : value;
}

// Every word rendered on this page is remembered under each of its kanji, so
// the kanji view can list "食べる · 朝食 · 食事 — you met these today". The
// first entry for a word (the engine's best-ranked reading) is the one kept.
function remember(entry, expression) {
  const word = entry.dataset.expression || "";
  if (!HAN.test(word) || entry.querySelector(`${BEE("hero-glyph")}, [data-sc-content="reading"]`)) return;
  const gloss = glossOf(entry);
  if (entry.dataset.atlasMet === "full" || (entry.dataset.atlasMet && !gloss)) return;
  entry.dataset.atlasMet = gloss ? "full" : "partial";
  const reading = expression ? splitLabel(expression).reading : "";
  for (const ch of new Set([...word].filter(c => HAN.test(c)))) {
    if (!met.has(ch)) met.set(ch, new Map());
    const records = met.get(ch);
    const existing = records.get(word);
    if (existing && existing.gloss) { existing.seq = ++seq; continue; }
    records.set(word, { reading, gloss, seq: ++seq });
  }
}

// ---- which reading does this word use? --------------------------------------
const RENDAKU = { か: "が", き: "ぎ", く: "ぐ", け: "げ", こ: "ご", さ: "ざ", し: "じ", す: "ず", せ: "ぜ", そ: "ぞ",
  た: "だ", ち: "ぢ", つ: "づ", て: "で", と: "ど", は: "ばぱ", ひ: "びぴ", ふ: "ぶぷ", へ: "べぺ", ほ: "ぼぽ" };

// Sound changes inside a compound: rendaku on the first kana (か→が, は→ば/ぱ)
// and sokuon on the last (く/つ/ち/き→っ). ん-assimilation is not modelled.
function variants(stem) {
  const set = new Set([stem]);
  for (const voiced of RENDAKU[stem[0]] || "") set.add(voiced + stem.slice(1));
  for (const v of [...set]) if (/[くつちき]$/u.test(v) && v.length > 1) set.add(`${v.slice(0, -1)}っ`);
  return [...set];
}

// Candidate stems of a kanji in hiragana: on readings first, then kun stems.
function candidates(found) {
  const out = [];
  for (const [kind, list] of [["on", found.on], ["kun", found.kun]]) {
    for (const reading of list) {
      const stem = toHiragana(splitReading(reading).stem);
      if (stem) out.push({ kind, reading, stem });
    }
  }
  return out;
}

// No reading starts with a small kana, a long-vowel mark or ん, so no segment
// boundary may fall before one.
const NO_START = /^[ゃゅょぁぃぅぇぉゎっーん]/u;

// Assign a ruby run's reading to its kanji: a known kanji offers its reading
// stems (with variants); an unknown one accepts 1–4 kana, or the rest when
// last. Strict first (known kanji must match), then loose (marked inferred).
function splitRun(chars, reading) {
  const target = toHiragana(reading);
  const options = chars.map(ch => {
    const found = facts.get(ch);
    return found ? candidates(found).flatMap(c => variants(c.stem).map(stem => ({ ...c, stem }))) : [];
  });
  const solve = loose => {
    const parts = [];
    const walk = (index, rest) => {
      if (index === chars.length) return rest.length === 0;
      const last = index === chars.length - 1;
      const known = options[index].filter(o => rest.startsWith(o.stem) && !NO_START.test(rest.slice(o.stem.length)))
        .sort((a, b) => b.stem.length - a.stem.length);
      for (const option of known) {
        parts[index] = { ...option, inferred: false };
        if (walk(index + 1, rest.slice(option.stem.length))) return true;
      }
      if (options[index].length > 0 && !loose) return false;
      const lengths = last ? [rest.length] : [1, 2, 3, 4].filter(n => n < rest.length && !NO_START.test(rest.slice(n)));
      for (const n of lengths) {
        if (n === 0 || NO_START.test(rest)) continue;
        parts[index] = { kind: "", reading: "", stem: rest.slice(0, n), inferred: true };
        if (walk(index + 1, rest.slice(n))) return true;
      }
      return false;
    };
    return walk(0, target) ? parts : null;
  };
  return solve(false) || solve(true);
}

// ---- term view: the kanji rail -----------------------------------------------
function baseText(ruby) {
  return [...ruby.childNodes].filter(node => node.nodeName !== "RT" && node.nodeName !== "RP")
    .map(node => node.textContent).join("");
}

function appendKana(rail, value, api) {
  const kana = value.replace(/\s+/gu, "");
  if (kana) api.move(api.el("span", "atlas-kana", kana), rail);
}

function buildRail(expression, api) {
  const rail = api.el("div", "atlas-rail");
  rail.setAttribute("lang", "ja");
  let tiles = 0;
  let kana = "";                       // the renderer emits one text node per character
  const flush = () => { appendKana(rail, kana, api); kana = ""; };
  for (const node of [...expression.childNodes]) {
    if (node.nodeType === 3) { kana += node.textContent; continue; }
    if (node.nodeName === "RUBY") {
      const buttons = [...node.querySelectorAll(".gsm-hoshidicts-kanji-link")];
      if (buttons.length === 0) { kana += baseText(node); continue; }
      flush();
      const rt = node.querySelector("rt");
      const morae = rt ? [...rt.querySelectorAll(".gsm-hoshidicts-pitch-mora")].map(text).join("") : "";
      tiles += appendGroup(rail, buttons, morae || text(rt), api);
      continue;
    }
    if (node.classList && node.classList.contains("gsm-hoshidicts-kanji-link")) {
      flush();
      tiles += appendGroup(rail, [node], "", api);
      continue;
    }
    kana += text(node);
  }
  flush();
  return tiles > 0 ? { rail, tiles } : null;
}

function appendGroup(rail, buttons, reading, api) {
  const group = api.el("span", "atlas-group");
  group.dataset.atlasReading = reading;
  for (const button of buttons) api.move(buildTile(button, api), group);
  refreshGroup(group, api);
  api.move(group, rail);
  return buttons.length;
}

// A run's reading is split again on every render: a kanji that has just
// become known (a Bee's card among the later results, a kanji view + Back)
// turns an inferred guess into a matched reading, and may move the boundary.
function refreshGroup(group, api) {
  const tiles = [...group.querySelectorAll(".atlas-tile")];
  const reading = group.dataset.atlasReading || "";
  const parts = reading ? splitRun(tiles.map(tile => tile.dataset.atlasChar), reading) : null;
  tiles.forEach((tile, index) => {
    const part = parts ? parts[index] : null;
    tile.dataset.atlasReading = part ? part.stem : "";
    tile.dataset.atlasInferred = part ? String(part.inferred) : "";
    if (part) arrivedBy.set(tile.dataset.atlasChar, part.stem);
  });
  const label = group.querySelector(":scope > .atlas-group-reading");
  if (reading && !parts && !label) api.move(api.el("span", "atlas-group-reading", reading), group);
  else if (label && parts) label.remove();
}

// One tile: the renderer's own kanji button (it keeps its click handler and its
// place in the keyboard order) inside a stroke ring, then what this word does
// with the kanji and what the atlas knows about it. A plain-text ghost of the
// kanji stays in the hidden headword so its textContent still reads the word.
function buildTile(button, api) {
  const tile = api.el("span", "atlas-tile");
  tile.dataset.atlasChar = button.textContent;
  api.move(api.el("span", "atlas-ghost", button.textContent), button.parentNode, button);
  const ring = api.el("span", "atlas-ring");
  api.move(button, ring);
  api.move(ring, tile);
  api.move(api.el("span", "atlas-used"), tile);
  api.move(api.el("span", "atlas-meta"), tile);
  api.move(api.el("span", "atlas-gloss"), tile);
  return tile;
}

// The top meanings, as many as fit a tile.
function shortMeanings(found) {
  const out = [];
  for (const meaning of found.meanings) {
    if (out.length > 0 && out.join(" · ").length + meaning.length > 16) break;
    out.push(meaning);
    if (out.length === 2) break;
  }
  return out.join(" · ") || found.keyword || "";
}

function jlptLabel(found, tile) {
  if (found.jlpt) return `JLPT ${found.jlpt}`;
  if (found.jlptOld) return tile ? `JLPT ${found.jlptOld}` : `JLPT ${found.jlptOld} (old scale)`;
  return "";
}

// Idempotent: called on every render so a tile fills in once its kanji becomes
// known (a Bee's card arriving with the later results, or a kanji view + Back).
function fillTile(tile, api) {
  const char = tile.dataset.atlasChar;
  const found = facts.get(char);
  const used = tile.querySelector(".atlas-used");
  const reading = tile.dataset.atlasReading || "";
  let match = null;
  if (found && reading) {
    match = candidates(found).find(c => variants(c.stem).includes(reading)) || null;
  }
  used.replaceChildren();
  if (reading) {
    if (match) {   // 音/訓 in text as well as colour, for readers who do not see the hue
      const kind = api.el("span", "atlas-used-kind", match.kind === "on" ? "音" : "訓");
      kind.setAttribute("lang", "ja");
      kind.setAttribute("title", match.kind === "on" ? "on-yomi" : "kun-yomi");
      api.move(kind, used);
    }
    api.move(api.el("span", "atlas-used-stem", reading), used);
    const okurigana = match ? splitReading(match.reading).okurigana : "";
    if (okurigana) api.move(api.el("span", "atlas-used-okurigana", okurigana), used);
  }
  tile.dataset.atlasKind = match ? match.kind : "";
  tile.dataset.atlasKnown = String(Boolean(found));
  const ring = tile.querySelector(".atlas-ring");
  if (found && found.strokes) {
    ring.dataset.strokes = String(found.strokes);
    ring.setAttribute("title", `${found.strokes} strokes`);
  }
  const meta = tile.querySelector(".atlas-meta");
  meta.textContent = found ? [jlptLabel(found, true), found.grade && `G${found.grade}`, found.strokes && `${found.strokes}画`]
    .filter(Boolean).join(" · ") : "";
  if (found && found.jlptOld && !found.jlpt) meta.setAttribute("title", "JLPT level on KANJIDIC's pre-2010 scale");
  tile.querySelector(".atlas-gloss").textContent = found ? shortMeanings(found) : "";
}

function buildTitle(word, reading, headword, api) {
  const title = api.el("div", "atlas-title");
  const wordNode = api.el("span", "atlas-word", word);
  wordNode.setAttribute("lang", "ja");
  api.move(wordNode, title);
  if (reading && reading !== word) {
    const kana = api.el("span", "atlas-word-reading", reading);
    kana.setAttribute("lang", "ja");
    api.move(kana, title);
  }
  const deinflection = headword.querySelector(".gsm-hoshidicts-deinflection");
  if (deinflection) api.move(deinflection, title);
  return title;
}

// The primary header lives in the top bar. Its headword is rebuilt as a plain
// title (word · reading · "why this matched") and its kanji buttons move into
// the rail below; the bar itself, with the note/audio/Anki actions and the
// dictionary tabs, stays where the reader put it.
function renderTermHead(view, api) {
  const header = view.chrome ? view.chrome.querySelector(".gsm-hoshidicts-primary-header") : null;
  const headword = header ? header.querySelector(".gsm-hoshidicts-headword") : null;
  const expression = headword ? headword.querySelector(".gsm-hoshidicts-expression") : null;
  if (!header || !expression) return null;
  if (header.querySelector(":scope > .atlas-title")) return splitLabel(expression).word;
  const { word, reading } = splitLabel(expression);
  api.move(buildTitle(word, reading, headword, api), header, headword);
  api.hide(headword);
  if (isOneKanji(word)) {
    header.dataset.atlas = "kanji-card";
    return word;
  }
  const built = buildRail(expression, api);
  if (built) {
    api.move(built.rail, header);
    api.setVariable("--theme-atlas-tiles", String(built.tiles));
  }
  header.dataset.atlas = "rail";
  return word;
}

// A kanji dictionary's full card stays one click away under the tile it fed.
function drawer(entry, char, api) {
  const parent = entry.parentNode;
  if (!parent || parent.classList.contains("atlas-drawer")) return;
  const details = api.el("details", "atlas-drawer");
  const summary = api.el("summary", "atlas-drawer-summary");
  const glyph = api.el("span", "atlas-drawer-char", char);
  glyph.setAttribute("lang", "ja");
  api.move(glyph, summary);
  api.move(api.el("span", "atlas-drawer-label", `${dictionaryLabel(entry)} — full card`), summary);
  api.move(summary, details);
  api.move(details, parent, entry);
  api.move(entry, details);
}

// ---- kanji view: the atlas card ----------------------------------------------
function chipRow(kind, readings, char, api) {
  const row = api.el("div", "atlas-yomi");
  row.dataset.kind = kind;
  const label = api.el("span", "atlas-yomi-label", kind === "on" ? "音" : "訓");
  label.setAttribute("lang", "ja");
  label.setAttribute("title", kind === "on" ? "on-yomi (Sino-Japanese reading)" : "kun-yomi (native reading)");
  api.move(label, row);
  const here = arrivedBy.get(char);
  for (const reading of readings) {
    const { stem, okurigana } = splitReading(reading);
    const chip = api.el("span", "atlas-chip");
    chip.setAttribute("lang", "ja");
    api.move(api.el("span", "atlas-chip-stem", stem), chip);
    if (okurigana) api.move(api.el("span", "atlas-chip-okurigana", okurigana), chip);
    if (here && variants(toHiragana(stem)).includes(here)) {
      chip.dataset.atlasHere = "true";
      chip.setAttribute("title", "the reading in the word you came from");
    }
    api.move(chip, row);
  }
  return row;
}

function badgeRow(found, api) {
  const row = api.el("div", "atlas-badges");
  const badges = [
    jlptLabel(found, false) && [jlptLabel(found, false), "jlpt"], found.grade && [`Grade ${found.grade}`, "grade"],
    found.jouyou && [found.jouyou, "jouyou"], found.strokes && [`${found.strokes} strokes`, "strokes"],
    found.rank && [`#${found.rank} in use`, "rank"], found.heisig && [`RTK ${found.heisig}`, "heisig"],
  ].filter(Boolean);
  for (const [label, kind] of badges) {
    const badge = api.el("span", "atlas-badge", label);
    badge.dataset.kind = kind;
    api.move(badge, row);
  }
  return badges.length > 0 ? row : null;
}

// The words this page has shown with the kanji, newest first — the reader's own
// example sentences, harvested from the popups they already opened.
function metSection(char, api) {
  const words = met.get(char);
  if (!words || words.size === 0) return null;
  const section = api.el("section", "atlas-met");
  api.move(api.el("h4", "atlas-heading", "Met on this page"), section);
  const list = api.el("ul", "atlas-met-list");
  const recent = [...words.entries()].sort((a, b) => b[1].seq - a[1].seq).slice(0, MET_LIMIT);
  for (const [word, record] of recent) {
    const item = api.el("li", "atlas-met-item");
    const wordNode = api.el("span", "atlas-met-word", word);
    wordNode.setAttribute("lang", "ja");
    api.move(wordNode, item);
    if (record.reading && record.reading !== word) {
      const reading = api.el("span", "atlas-met-reading", record.reading);
      reading.setAttribute("lang", "ja");
      api.move(reading, item);
    }
    if (record.gloss) api.move(api.el("span", "atlas-met-gloss", record.gloss), item);
    api.move(item, list);
  }
  api.move(list, section);
  return section;
}

// The card's figure holds nodes borrowed from the renderer (the glyph, a stroke
// diagram) and is built once; the body is rebuilt on every render so facts that
// arrive later (a deferred glossary, a second dictionary) still land on it.
function buildCard(char, api, { glyph = null, diagram = null } = {}) {
  const card = api.el("section", "atlas-card");
  card.setAttribute("aria-label", `Kanji ${char}`);
  card.dataset.atlasChar = char;
  const figure = api.el("div", "atlas-figure");
  const ring = api.el("span", "atlas-ring atlas-ring-large");
  if (glyph) api.move(glyph, ring);
  else {
    const drawn = api.el("span", "gsm-hoshidicts-kanji-glyph", char);
    drawn.setAttribute("lang", "ja");
    api.move(drawn, ring);
  }
  api.move(ring, figure);
  if (diagram) {
    const plate = api.el("div", "atlas-diagram");
    api.move(diagram, plate);
    api.move(plate, figure);
  }
  api.move(figure, card);
  return card;
}

function fillCard(card, api) {
  const char = card.dataset.atlasChar;
  const found = facts.get(char) || learn(char, {});
  const ring = card.querySelector(".atlas-ring");
  if (found.strokes) {
    ring.dataset.strokes = String(found.strokes);
    ring.setAttribute("title", `${found.strokes} strokes`);
  }
  for (const stale of card.querySelectorAll(":scope > .atlas-card-body, :scope > .atlas-met")) stale.remove();
  const body = api.el("div", "atlas-card-body");
  if (found.keyword) api.move(api.el("div", "atlas-keyword", found.keyword), body);
  const rest = found.meanings.filter(meaning => meaning !== found.keyword);
  if (rest.length > 0) api.move(api.el("div", "atlas-meanings", rest.join(" · ")), body);
  if (found.on.length > 0) api.move(chipRow("on", found.on, char, api), body);
  if (found.kun.length > 0) api.move(chipRow("kun", found.kun, char, api), body);
  const badges = badgeRow(found, api);
  if (badges) api.move(badges, body);
  if (found.source) api.move(api.el("div", "atlas-source", found.source), body);
  api.move(body, card);
  const metList = metSection(char, api);
  if (metList) api.move(metList, card);
}

// Native kanji view: the first entry becomes the card; its readings, meanings
// and heading are hidden in place (the Details index list stays as it is).
function renderKanji(view, api) {
  const entries = view.entries;
  const header = view.chrome ? view.chrome.querySelector(".gsm-hoshidicts-primary-header") : null;
  const glyph = header ? header.querySelector(".gsm-hoshidicts-kanji-glyph") : null;
  const char = text(glyph) || text(view.content.querySelector(".atlas-card .gsm-hoshidicts-kanji-glyph"));
  if (entries.length === 0 || !isOneKanji(char)) return;
  for (const entry of entries) harvestNative(entry, char);
  let card = view.content.querySelector(":scope > .atlas-card");
  if (!card) {
    card = buildCard(char, api, { glyph });
    api.move(card, view.content, view.content.firstChild);
    const primary = entries[0];
    for (const selector of [".gsm-hoshidicts-kanji-dictionary", ".gsm-hoshidicts-tags", ".gsm-hoshidicts-kanji-readings", "h4", ".gsm-hoshidicts-kanji-meanings"]) {
      api.hide(primary.querySelector(selector));
    }
    if (header) header.dataset.atlas = "kanji";
  }
  fillCard(card, api);
}

// A single-kanji headword (a kanji dictionary chosen as the clicked-kanji
// dictionary, or 食 looked up by itself): the card is built from what the
// popup's own cards say, and Bee's stroke diagram moves up beside the glyph.
function renderKanjiAsTerm(view, api, char) {
  let card = view.content.querySelector(":scope > .atlas-card");
  if (!card) {
    let diagram = null;
    for (const entry of view.entries) {
      const image = entry.querySelector(`.gloss-image-link${BEE("stroke-image")}`);
      if (image && !diagram) diagram = image;
    }
    card = buildCard(char, api, { diagram });
    api.move(card, view.content, view.content.firstChild);
  }
  for (const entry of view.entries) api.hide(entry.querySelector(BEE("hero")));
  fillCard(card, api);
}

function renderTerm(view, api) {
  const header = view.chrome ? view.chrome.querySelector(".gsm-hoshidicts-primary-header") : null;
  const primaryExpression = header ? header.querySelector(".gsm-hoshidicts-expression") : null;
  // Harvest first: a kanji card among the results feeds the tile for its kanji.
  const kanjiCards = new Map();
  view.entries.forEach((entry, index) => {
    const glyph = harvestBee(entry) || harvestNativeCard(entry);
    if (glyph) kanjiCards.set(entry, glyph);
    remember(entry, index === 0 ? primaryExpression : entry.querySelector(".gsm-hoshidicts-expression"));
  });
  const word = renderTermHead(view, api);
  if (word && isOneKanji(word)) {
    renderKanjiAsTerm(view, api, word);
  } else {
    for (const [entry, glyph] of kanjiCards) drawer(entry, glyph, api);
  }
  for (const group of view.popup.querySelectorAll(".atlas-group")) refreshGroup(group, api);
  for (const tile of view.popup.querySelectorAll(".atlas-tile")) fillTile(tile, api);
}

export default {
  schema: 1,
  slug: SLUG,
  onRender(view, api) {
    if (view.kind === "term") renderTerm(view, api);
    else if (view.kind === "kanji") renderKanji(view, api);
    else return;
    api.requestLayout();
  },
  onDeactivate() {
    facts.clear();
    met.clear();
    arrivedBy.clear();
  },
};
