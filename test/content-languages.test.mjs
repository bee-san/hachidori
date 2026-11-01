// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reading pages in a language (docs/languages.md 8.2-8.5, 18): the content
// script's scan primitives with the English, Arabic and a Ukrainian-style
// pack's text rules — the gate, the start at the hovered word, the scan to the
// end of its last word, hovers on the second part of separated words
// (five-minute → minute, mother’s → mother, l’homme → homme) and м’ясо kept
// whole —, sentences cut at a pack's terminators and quote pairs, and word
// highlighting that segments each block with its profile and cuts chunks at
// the pack's breaks. Japanese keeps today's tables, which the existing suites
// pin.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registryEntries } from "../scripts/sync-languages.mjs";
import "../extension/reader-options.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const { ClassSet } = await import(pathToFileURL(resolve(new URL("../third_party/hoshidicts/tools/lib/classes.mjs",
  import.meta.url).pathname)).href);

// The reader's copy of a fixture pack, class references expanded as
// registry-reader.js holds them.
function readerPack(code) {
  const pack = JSON.parse(readFileSync(new URL(`./data/languages/${code}/language.json`, import.meta.url), "utf8"));
  return registryEntries(pack, ClassSet).reader;
}
const ENGLISH = readerPack("en");
const ARABIC = readerPack("ar");

// The rules content.js derives from a pack's `text` (its textRules).
function wordRules(text) {
  return { word: new RegExp(text.wordCharacters, "u"),
    internal: text.wordInternal ? new RegExp(text.wordInternal, "u") : null, limit: 256 };
}
// A Ukrainian-style pack: the apostrophe is word-internal (engine contract 4.3).
const UKRAINIAN = { word: /[\p{L}\p{M}]/u, internal: /[’']/u, limit: 256 };

function page(t, html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(extension("sentence.js"));
  dom.window.eval(extension("content-scan.js"));
  const scanner = dom.window.HDContent.createPageScanner({ isOurNode: () => false });
  return { window: dom.window, document: dom.window.document, scanner };
}

// The text a scan from `offset` in the first text node of `selector` reads.
function scanFrom(t, html, selector, offset, words, length = 16) {
  const { document, scanner } = page(t, html);
  const node = document.querySelector(selector).firstChild;
  const styleCache = new Map();
  const start = words === null ? { node, offset } : scanner.wordStart(node, offset, document.body, words, styleCache);
  const entries = scanner.collectScanEntries(start.node, start.offset, document.body, length, styleCache, words);
  return entries.map(entry => entry.text).join("");
}

test("the fixture packs' text rules expand to patterns the reader can use", () => {
  for (const pack of [ENGLISH, ARABIC]) {
    for (const field of ["pattern", "wordCharacters"]) {
      assert.doesNotThrow(() => new RegExp(pack.text[field], "u"), `${pack.code} ${field}`);
    }
    assert.equal(pack.text.scanStart, "word");
  }
});

test("a scan in an English profile starts at the hovered word and reaches the end of its last word", t => {
  const html = "<p>She was running late.</p>";
  const words = wordRules(ENGLISH.text);
  // Hovering the second n of "running".
  assert.equal(scanFrom(t, html, "p", 10, words, 3), "running");
  assert.equal(scanFrom(t, html, "p", 8, words, 16), "running late.");
  // Without word rules the scan starts at the cursor, as for Japanese.
  assert.equal(scanFrom(t, html, "p", 10, null, 4), "nnin");
  // A hover on a space keeps its own start; the scan still ends at a word's end.
  assert.equal(scanFrom(t, html, "p", 7, words, 4), " running");
});

test("a hover on the second part of a separated word looks that part up", t => {
  const words = wordRules(ENGLISH.text);
  assert.equal(scanFrom(t, "<p>a five-minute walk</p>", "p", 9, words, 6), "minute");
  assert.equal(scanFrom(t, "<p>my mother’s book</p>", "p", 5, words, 6), "mother");
  assert.equal(scanFrom(t, "<p>my mother’s book</p>", "p", 10, words, 2), "s ");
  assert.equal(scanFrom(t, "<p>c’est l’homme</p>", "p", 11, words, 5), "homme");
  // Ukrainian keeps м’ясо whole: the apostrophe is part of the word.
  assert.equal(scanFrom(t, "<p>смачне м’ясо тут</p>", "p", 10, UKRAINIAN, 5), "м’ясо");
  assert.equal(scanFrom(t, "<p>смачне м’ясо тут</p>", "p", 8, UKRAINIAN, 1), "м’ясо");
});

test("the word start crosses inline elements a scan reads, and stops at a block", t => {
  const words = wordRules(ENGLISH.text);
  assert.equal(scanFrom(t, "<p>wa<b>lk</b>ing home</p>", "b", 1, words, 4), "walking");
  assert.equal(scanFrom(t, "<div><p>run</p><p>ning</p></div>", "p:last-child", 1, words, 4), "ning");
});

test("an Arabic scan starts at the hovered word in logical order and gates on the pack's pattern", t => {
  const { scanner } = page(t, "");
  const pattern = new RegExp(ARABIC.text.pattern, "u");
  const words = wordRules(ARABIC.text);
  const html = `<p lang="ar" dir="rtl">\u0627\u0644\u0643\u062A\u0627\u0628 \u062C\u062F\u064A\u062F.</p>`;
  // Hovering the fourth letter of الكتاب.
  assert.equal(scanFrom(t, html, "p", 3, words, 3), "\u0627\u0644\u0643\u062A\u0627\u0628");
  assert.equal(scanner.isLanguageToken("\u0643\u062A\u0627\u0628 book", pattern), true);
  assert.equal(scanner.isLanguageToken("book \u0643\u062A\u0627\u0628", pattern), false, "the first token decides");
  assert.equal(scanner.isLanguageToken("running", new RegExp(ENGLISH.text.pattern, "u")), true);
  assert.equal(scanner.isJapaneseToken("running"), false, "Japanese keeps today's gate");
});

test("sentences end at a pack's terminators and keep its quote pairs whole", t => {
  const { window } = page(t, "");
  const { extractSentence, sentenceRules } = window.HDSentence;
  const arabic = sentenceRules(ARABIC.text.sentence);
  const text = "\u0645\u0627 \u0647\u0630\u0627\u061F \u0647\u0630\u0627 \u0643\u062A\u0627\u0628. \u0648\u062F\u0627\u0639\u0627";
  const at = text.indexOf("\u0643\u062A\u0627\u0628");
  assert.deepEqual({ ...extractSentence(text, at, 4, undefined, arabic) },
    { sentence: "\u0647\u0630\u0627 \u0643\u062A\u0627\u0628.", matchOffset: 4 });
  const english = sentenceRules(ENGLISH.text.sentence);
  const quoted = "He said “Stop. Now.” and left. Then he ran.";
  assert.equal(extractSentence(quoted, quoted.indexOf("left"), 4, undefined, english).sentence,
    "He said “Stop. Now.” and left.");
  // Without rules, today's Japanese tables: “ ” pairs and 。 end sentences.
  assert.equal(extractSentence("見た。食べた。", 3, 2).sentence, "食べた。");
});

// ---------------------------------------------------------------- highlights

function highlighter(t, html, { profiles, lexicon }) {
  const dom = new JSDOM(`<!doctype html><html><body style="background-color:#ffffff">${html}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.CSS.highlights = new Map();
  window.Highlight = class extends Set { priority = 0; };
  document.adoptedStyleSheets = [];
  let intersect = null;
  window.IntersectionObserver = class {
    constructor(callback) { intersect = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.OffscreenCanvas = class { getContext() { return { clearRect() {}, fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 255] }), set fillStyle(value) {} }; } };
  window.eval(extension("word-highlights.js"));
  const sent = [];
  async function send(type, fields) {
    sent.push({ type, fields: JSON.parse(JSON.stringify(fields)) });
    await null;
    if (type === "hd_segment") {
      return { generation: 1, segments: fields.chunks.map(({ id, text }) => ({ id,
        spans: lexicon.filter(word => text.includes(word)).map(word => ({ start: text.indexOf(word), length: word.length,
          functionWord: false, candidates: [{ expression: word, reading: "" }], alternative: [] })) })) };
    }
    return { revision: 1, statuses: fields.request.headwords.map(() => "unknown") };
  }
  const blockOf = node => (node.nodeType === 1 ? node : node.parentElement).closest("p");
  const textRuns = block => [[{ node: block.firstChild, start: 0, end: block.firstChild.data.length }]];
  const runEntries = parts => [...parts[0].node.data.slice(parts[0].start, parts[0].end)].map((text, index) => ({
    node: parts[0].node, offset: parts[0].start + index, sourceLength: text.length, text, collapsed: false }));
  const profileOf = element => profiles[element.closest("[lang]")?.getAttribute("lang")] ?? null;
  const textBlocks = root => new Set([...root.querySelectorAll("p")].filter(block => profileOf(block)?.isText(block.textContent)));
  const marker = window.HDWordHighlights.createWordHighlighter({ window, send, textBlocks, blockOf, textRuns, runEntries,
    isJapanese: () => false, prepare: async () => {}, readPalette: () => null, profileOf });
  marker.start({ ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, wordHighlightEnabled: true, wordHighlightUnknown: true });
  const show = () => intersect([...document.querySelectorAll("p")].map(target => ({ target, isIntersecting: true })));
  return { marker, sent, show, window };
}

const settle = async () => {
  for (let turn = 0; turn < 30; turn += 1) await new Promise(resolveTurn => setImmediate(resolveTurn));
};

test("word highlighting segments each block with its profile and cuts chunks at the pack's breaks", async t => {
  const english = { key: "en", fields: { profileId: "en" }, isText: text => /[A-Za-z]/u.test(text),
    breaks: { sentenceEnd: new Set([".", "!", "?"]), clauseEnd: new Set() },
    options: { scanLength: 12, frequencyDictionary: "", frequencyOrder: "auto", personalDictionaryEnabled: true } };
  const arabic = { key: "ar", fields: { profileId: "ar" }, isText: text => /[\u0620-\u064A]/u.test(text),
    breaks: { sentenceEnd: new Set([".", "\u061F"]), clauseEnd: new Set() },
    options: { scanLength: 20, frequencyDictionary: "", frequencyOrder: "auto", personalDictionaryEnabled: true } };
  const { sent, show } = highlighter(t, `<p lang="en">I run. You walk!</p><p lang="ar">\u0647\u0630\u0627 \u0643\u062A\u0627\u0628\u061F \u0646\u0639\u0645</p><p lang="fr">bonjour</p>`,
    { profiles: { en: english, ar: arabic }, lexicon: ["run", "walk", "\u0643\u062A\u0627\u0628"] });
  show();
  await settle();
  const statusRequests = sent.filter(request => request.type === "hd_anki_word_status");
  assert.deepEqual([...new Set(statusRequests.map(request => request.fields.profileId))].sort(), ["ar", "en"],
    "each profile's statuses are read for its own Templates");
  const segments = sent.filter(request => request.type === "hd_segment");
  const byProfile = Object.fromEntries(segments.map(request => [request.fields.profileId,
    request.fields.chunks.map(chunk => chunk.text)]));
  assert.deepEqual(byProfile.en, ["I run.", " You walk!"], "English chunks end at its terminators");
  assert.deepEqual(byProfile.ar, ["\u0647\u0630\u0627 \u0643\u062A\u0627\u0628\u061F", " \u0646\u0639\u0645"],
    "Arabic chunks end at its question mark");
  assert.deepEqual(segments.map(request => request.fields.scanLength).sort(), [12, 20], "each with its own scan length");
  assert.equal(segments.some(request => request.fields.chunks.some(chunk => chunk.text.includes("bonjour"))), false,
    "a block whose profile marks no words is left alone");
});

// ------------------------------------------------------------------ Netflix

// netflix-page.js's main world, as test/netflix-page.test.mjs builds it.
async function netflixPage() {
  const vm = await import("node:vm");
  const source = extension("netflix-page.js");
  const document = new EventTarget();
  document.querySelector = () => null;
  const posted = [];
  document.addEventListener("hachidori-netflix-page", event => posted.push(JSON.parse(event.detail)));
  const bodies = { "https://cdn.example/ja.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\n食べる\n",
    "https://cdn.example/en.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nShe was\nrunning late\n" };
  const context = vm.createContext({ document, CustomEvent, EventTarget, ArrayBuffer, Promise, Reflect, performance,
    setTimeout, clearTimeout, setInterval, clearInterval, location: { pathname: "/watch/81000001" },
    fetch: async url => ({ ok: true, status: 200, text: async () => bodies[url] }) });
  context.window = context;
  vm.runInContext(source, context);
  const command = message => document.dispatchEvent(new CustomEvent("hachidori-netflix-command", { detail: JSON.stringify(message) }));
  const read = tracks => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify({ result: { movieId: 81000001, textTracks: tracks } }))})`, context);
  return { posted, command, read };
}

const vttTrack = (id, language, url) => ({ id, language, rawTrackType: "subtitles",
  downloadables: { "webvtt-lssdh-ios8": { urls: [{ url }] } } });
const tick = () => new Promise(resolveTick => { setTimeout(resolveTick, 0); });

test("Netflix posts the reading language's subtitle tracks: Japanese until the reader names another", async () => {
  const { posted, command, read } = await netflixPage();
  read([vttTrack("t-ja", "ja", "https://cdn.example/ja.vtt"), vttTrack("t-en", "en-US", "https://cdn.example/en.vtt")]);
  await tick();
  assert.deepEqual(posted.filter(message => message.kind === "subtitle").map(message => message.trackId), ["t-ja"]);
  posted.length = 0;
  command({ type: "language", language: "en" });
  await tick();
  assert.deepEqual(posted.filter(message => message.kind === "subtitle").map(message => message.trackId), ["t-en"],
    "the kept manifest's English track is posted");
  posted.length = 0;
  command({ type: "resend", movieId: "81000001" });
  assert.deepEqual(posted.map(message => message.trackId), ["t-en"], "a resend posts what this language posted");
  posted.length = 0;
  command({ type: "language", language: "../x" });
  await tick();
  assert.deepEqual(posted, [], "a malformed language changes nothing");
});

test("a Netflix cue's lines are joined with the language's joiner", t => {
  const { window } = page(t, "");
  window.eval(extension("netflix-subtitles.js"));
  const { cueSentence } = window.HDNetflixSubtitles;
  assert.deepEqual({ ...cueSentence("She was\nrunning late", "running late", 0, " ") },
    { sentence: "She was running late", matchOffset: 8 });
  // Without a joiner, today's Japanese join.
  assert.deepEqual({ ...cueSentence("食べ\nたかった", "食べたかった", 0) }, { sentence: "食べたかった", matchOffset: 0 });
});
