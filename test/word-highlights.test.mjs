// SPDX-License-Identifier: GPL-3.0-or-later
// Word highlighting (#520): the content-script highlighter against a fake
// engine and Anki index. Chrome's text reading, layout and painting are
// covered by chrome-e2e.mjs and chrome-theme-contrast.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/reader-options.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const SOURCE = readFileSync(new URL("../extension/word-highlights.js", import.meta.url), "utf8");
const isJapanese = text => /[ぁ-ヿ一-鿿]/u.test(text);
const settle = async () => {
  for (let turn = 0; turn < 30; turn += 1) await new Promise(resolveTurn => setImmediate(resolveTurn));
};

// The longest lexicon word at each position, as the engine's spans.
function segmentText(text, lexicon) {
  const spans = [];
  for (let index = 0; index < text.length;) {
    const surface = Object.keys(lexicon).filter(word => text.startsWith(word, index))
      .sort((left, right) => right.length - left.length)[0];
    if (!surface) {
      index += 1;
      continue;
    }
    const { candidates = [{ expression: surface, reading: "" }], functionWord = false, alternative = [] } = lexicon[surface];
    spans.push({ start: index, length: surface.length, functionWord, candidates,
      alternative: alternative.map(word => ({ ...word, start: index + word.start })) });
    index += surface.length;
  }
  return spans;
}

function parseColor(value) {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/iu.exec(value);
  if (hex) return [1, 2, 3].map(index => Number.parseInt(hex[index], 16)).concat(hex[4] ? Number.parseInt(hex[4], 16) : 255);
  if (value === "#0000") return [0, 0, 0, 0];
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 255 : Math.round(Number(rgb[4]) * 255)] : null;
}

function fixture(t, html, { lexicon, statuses = {}, available = true, options = {}, palette = {} }) {
  const dom = new JSDOM(`<!doctype html><html><body style="background-color: #ffffff">${html}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  // The Chrome surface the highlighter uses: the highlight registry, a viewport
  // the test opens block by block, and a canvas that paints colours.
  window.CSS.highlights = new Map();
  window.Highlight = class extends Set { priority = 0; };
  document.adoptedStyleSheets = [];
  let intersect = null;
  const observed = new Set();
  window.IntersectionObserver = class {
    constructor(callback) { intersect = callback; }
    observe(target) { observed.add(target); }
    unobserve(target) { observed.delete(target); }
    disconnect() { observed.clear(); }
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.OffscreenCanvas = class {
    getContext() {
      let color = [0, 0, 0, 0];
      return { clearRect() {}, fillRect() {}, getImageData: () => ({ data: color }),
        set fillStyle(value) { color = parseColor(value) ?? color; } };
    }
  };
  window.eval(SOURCE);
  const state = { statuses, available, revision: 1, generation: 1 };
  const sent = [];
  let hold = null;
  async function send(type, fields, target) {
    sent.push({ type, target, fields: JSON.parse(JSON.stringify(fields)) });
    if (hold?.type === type) await new Promise(release => { hold.release = release; });
    await null;
    if (type === "hd_segment") {
      return { generation: state.generation,
        segments: fields.chunks.map(({ id, text }) => ({ id, spans: segmentText(text, lexicon) })) };
    }
    return { revision: state.revision, statuses: state.available
      ? fields.request.headwords.map(headword => state.statuses[headword] ?? "unknown") : null };
  }
  // Page text as content.js reads it, reduced to what these pages hold: each
  // paragraph is a block, <br> ends a run and ruby annotations are left out.
  const textNodes = root => {
    const nodes = [];
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT);
    for (let node = root.nodeType === 3 ? root : walker.nextNode(); node; node = root.nodeType === 3 ? null : walker.nextNode()) {
      nodes.push(node);
    }
    return nodes;
  };
  const textBlocks = root => new Set(textNodes(root)
    .filter(node => node.nodeType === 3 && isJapanese(node.data) && !node.parentElement.closest("rt"))
    .map(node => node.parentElement.closest("p")));
  const textRuns = block => {
    const runs = [[]];
    for (const node of textNodes(block)) {
      if (node.nodeType === 1 && node.localName === "br") runs.push([]);
      if (node.nodeType !== 3 || node.parentElement.closest("rt")) continue;
      for (let offset = 0; offset < node.data.length; offset += 1) {
        runs.at(-1).push({ node, offset, sourceLength: 1, text: node.data[offset], collapsed: false });
      }
    }
    return runs.filter(run => run.length > 0);
  };
  const highlighter = window.HDWordHighlights.createWordHighlighter({ window, send, textBlocks, textRuns, isJapanese,
    prepare: async () => {}, readPalette: () => ({ getPropertyValue: name => palette[name] ?? "" }) });
  const current = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, wordHighlightEnabled: true, ...options };
  return {
    window, document, state, sent, highlighter, observed,
    options: current,
    start: () => highlighter.start(current),
    show: (...elements) => intersect(elements.map(target => ({ target, isIntersecting: true }))),
    hold(type) { hold = { type }; return () => { const { release } = hold; hold = null; release?.(); }; },
    segmented: () => sent.filter(request => request.type === "hd_segment").flatMap(request => request.fields.chunks.map(chunk => chunk.text)),
    statusRequests: () => sent.filter(request => request.type === "hd_anki_word_status").map(request => request.fields.request.headwords),
    // Each registered status that paints something, with the text of each of its ranges.
    marks: () => Object.fromEntries([...window.CSS.highlights].filter(([, highlight]) => highlight.size > 0)
      .map(([name, highlight]) =>
        [name, [...highlight].map(range => range.startContainer.data.slice(range.startOffset, range.endOffset))])),
  };
}

const VERBS = {
  食べたかった: { candidates: [{ expression: "食べる", reading: "たべる" }] },
  漢字: {}, 読む: {}, 猫: {}, いる: {},
  を: { functionWord: true }, が: { functionWord: true },
};

test("visible words take their first result's status, leaving function words and off-screen text unmarked", async t => {
  const page = fixture(t, `<p id="near"><ruby>食<rt>た</rt></ruby>べたかった。<span>漢字</span>を読む</p><p id="far">猫がいる</p>`,
    { lexicon: VERBS, statuses: { 食べる: "unknown", 漢字: "learning", 読む: "known" } });
  page.start();
  await settle();
  // Nothing is segmented before the index says it can answer, nor off screen.
  assert.deepEqual(page.statusRequests(), [[]]);
  assert.deepEqual(page.segmented(), []);
  assert.equal(page.observed.size, 2);
  page.show(page.document.getElementById("near"));
  await settle();
  assert.deepEqual(page.segmented(), ["食べたかった。", "漢字を読む"]);
  assert.deepEqual(page.sent.find(request => request.type === "hd_segment").fields.scanLength, page.options.scanLength);
  // The conjugated verb is marked by its dictionary form's card, around the
  // ruby's reading; を is a function word and known words are off by default.
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["食", "べたかった"], "hd-word-learning": ["漢字"] });
  page.highlighter.update({ ...page.options, wordHighlightKnown: true, wordHighlightLearning: false });
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["食", "べたかった"], "hd-word-known": ["読む"] });
  assert.equal(page.window.CSS.highlights.get("hd-word-unknown").priority, -1, "the hover's source highlight paints above");
});

test("a kana word takes a reading candidate's card and a phrase around a function word takes its words' cards", async t => {
  const page = fixture(t, `<p id="line">かわいい。今日は学生</p>`, {
    options: { wordHighlightKnown: true },
    lexicon: {
      かわいい: { candidates: [{ expression: "かわいい", reading: "" }, { expression: "可愛い", reading: "かわいい" }] },
      今日は: { candidates: [{ expression: "今日は", reading: "こんにちは" }], alternative: [
        { start: 0, length: 2, functionWord: false, candidates: [{ expression: "今日", reading: "きょう" }] },
        { start: 2, length: 1, functionWord: true, candidates: [{ expression: "は", reading: "" }] }] },
      // A compound of content words keeps its own status.
      学生: { alternative: [
        { start: 0, length: 1, functionWord: false, candidates: [{ expression: "学", reading: "がく" }] },
        { start: 1, length: 1, functionWord: false, candidates: [{ expression: "生", reading: "せい" }] }] },
    },
    statuses: { 可愛い: "learning", 今日: "known", 学: "known", 生: "known" },
  });
  page.start();
  page.show(page.document.getElementById("line"));
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["学生"], "hd-word-learning": ["かわいい"], "hd-word-known": ["今日"] });
  assert.deepEqual(page.statusRequests().at(-1).sort(), ["かわいい", "今日は", "今日", "可愛い", "学生"].sort(),
    "a compound's words are never asked for");
});

test("arriving lines reuse cached segmentation and a status change moves marks without segmenting again", async t => {
  const page = fixture(t, `<p id="first">猫がいる</p>`, { lexicon: VERBS, statuses: { 猫: "unknown" } });
  page.start();
  page.show(page.document.getElementById("first"));
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["猫", "いる"] });
  // A texthooker line arrives with text the page already showed.
  const line = page.document.createElement("p");
  line.textContent = "猫がいる";
  page.document.body.append(line);
  await settle();
  assert.ok(page.observed.has(line));
  page.show(line);
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["猫", "いる", "猫", "いる"] });
  assert.deepEqual(page.segmented(), ["猫がいる"], "the repeated line is not segmented again");
  // Adding 猫 to Anki: the worker signals a new row revision.
  page.state.statuses = { 猫: "learning" };
  page.state.revision = 2;
  page.highlighter.statusChanged(2);
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["いる", "いる"], "hd-word-learning": ["猫", "猫"] });
  assert.deepEqual(page.segmented(), ["猫がいる"]);
  assert.deepEqual(page.statusRequests().at(-1).sort(), ["いる", "猫"]);
  const requests = page.sent.length;
  page.highlighter.statusChanged(2);
  await settle();
  assert.equal(page.sent.length, requests, "a revision already read asks nothing");
  // A removed line takes its marks with it.
  line.remove();
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["いる"], "hd-word-learning": ["猫"] });
  assert.equal(page.observed.has(line), false);
});

test("an unavailable index marks nothing until the worker signals, and stale or stopped replies are dropped", async t => {
  const page = fixture(t, `<p id="line">猫がいる</p>`, { lexicon: VERBS, available: false });
  page.start();
  page.show(page.document.getElementById("line"));
  await settle();
  assert.deepEqual(page.segmented(), [], "no index rows: the page is not segmented");
  assert.deepEqual(page.marks(), {});
  page.state.available = true;
  page.highlighter.statusChanged(null);
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["猫", "いる"] });
  // A dictionary commit lands before the next batch: its reply carries
  // another generation, so nothing in it is kept, the marks stay, and the
  // text shown is asked again under the new generation.
  page.state.generation = 2;
  const line = page.document.createElement("p");
  line.textContent = "いる猫";
  page.document.body.append(line);
  await settle();
  page.show(line);
  await settle();
  assert.deepEqual(page.segmented(), ["猫がいる", "いる猫", "猫がいる", "いる猫"]);
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["猫", "いる", "いる", "猫"] });
  // Changed dictionaries segment the shown text again, keeping its marks meanwhile.
  const release = page.hold("hd_segment");
  page.highlighter.invalidate();
  await settle();
  assert.deepEqual(page.marks(), { "hd-word-unknown": ["猫", "いる", "いる", "猫"] });
  page.highlighter.stop();
  release();
  await settle();
  assert.equal(page.segmented().length, 6);
  assert.equal(page.window.CSS.highlights.size, 0, "turning highlighting off removes every mark at once");
  assert.equal(page.document.adoptedStyleSheets.length, 0);
  assert.equal(page.observed.size, 0);
});

test("status colours follow the palette, made legible against the page, and stand aside in forced colours", async t => {
  const page = fixture(t, `<p id="line">猫がいる</p>`, { lexicon: VERBS,
    palette: { "--hoshidicts-palette-error": "#ffd0d0", "--hoshidicts-palette-warning": "#ffe6b0" } });
  const luminance = rgb => rgb.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrastWithWhite = rgb => 1.05 / (luminance(rgb) + 0.05);
  const rules = () => {
    const [sheet] = page.document.adoptedStyleSheets;
    const media = sheet.cssRules[0];
    assert.equal(media.media.mediaText, "not (forced-colors: active)");
    return Object.fromEntries([...media.cssRules].map(rule => [rule.selectorText, rule.style]));
  };
  const channels = value => /rgb\((\d+),? (\d+),? (\d+)/u.exec(value).slice(1, 4).map(Number);
  page.start();
  await settle();
  const underline = rules();
  for (const status of ["unknown", "learning", "known"]) {
    assert.ok(contrastWithWhite(channels(underline[`::highlight(hd-word-${status})`].textDecorationColor)) >= 3, status);
  }
  page.highlighter.update({ ...page.options, wordHighlightStyle: "color" });
  const colored = rules()["::highlight(hd-word-unknown)"];
  assert.equal(colored.textDecorationLine, "none");
  assert.ok(contrastWithWhite(channels(colored.color)) >= 4.5);
  page.highlighter.update({ ...page.options, wordHighlightStyle: "background" });
  assert.match(rules()["::highlight(hd-word-learning)"].backgroundColor, /^rgb(a?)\(255,? 230,? 176(,| \/) 0?\.34\)$|34%/u);
});
