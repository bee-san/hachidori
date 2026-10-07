/*
 * The ported renderer against the engine's own replies.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine-lookup.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { createContext, runInContext } from "node:vm";
import { buildAnkiResourceFields } from "../../extension/anki-resources.js";
import {
  gaijiSizingFixture,
  imageSizingFixture,
  structuredContentDeepFixture,
} from "../make-fixture.mjs";
import { kanji, lookup, media } from "./engine-lookup.mjs";
import { request } from "./engine.mjs";
import {
  DEFAULT_JSDOM_TREE,
  EXTENSION,
  jsdomFailure,
  jsdomSearchPaths,
  loadJsdom,
} from "./fakes.mjs";
import { check, equal, fail, pass, section, step } from "./harness.mjs";

// A rendered glossary's text without Yomitan's hidden gloss separators.
function glossaryText(parent) {
  return [...parent.querySelectorAll(".gloss-content")].map((content) => content.textContent).join("");
}

// The renderer is the one consumer that reads contract B field by field, so it
// is driven with the engine's own bytes rather than a hand-written payload.
async function renderStage({ imageLookup, kanji, lookup, media }) {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;

  const dom = new JSDOM("<!doctype html><html><body><p>...</p></body></html>", {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const { window } = dom;
  const { document } = window;

  const sandbox = createContext({ window, document, console, URL: window.URL, globalThis: undefined });
  sandbox.globalThis = sandbox;
  sandbox.window = window;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    runInContext(readFileSync(resolve(EXTENSION, file), "utf8"), sandbox, { filename: file });
  }
  const HDGlossary = sandbox.HDGlossary ?? window.HDGlossary;
  const HDPopup = sandbox.HDPopup ?? window.HDPopup;
  check("Automatic toolbar placement follows above/below while explicit edges win and side panes stay stable",
    [
      ["auto", "above", "top", "bottom"], ["auto", "below", "bottom", "top"],
      ["auto", "beside", "bottom", "bottom"], ["auto", null, undefined, "top"],
      ["top", "above", "bottom", "top"], ["bottom", "below", "top", "bottom"],
    ].every(([preference, placement, current, expected]) => HDPopup.resolveToolbarPosition(preference, placement, current) === expected));
  {
    const viewport = { width: 1000, height: 600 };
    const place = (anchor, preferBelow, height = 200) =>
      [anchor, HDPopup.calculatePopupPosition(anchor, { width: 300, height }, viewport, { preferBelow })];
    const roomy = { left: 100, top: 250, right: 140, bottom: 270 };
    const low = { left: 100, top: 500, right: 140, bottom: 520 };
    const high = { left: 100, top: 40, right: 140, bottom: 60 };
    const upper = { left: 100, top: 190, right: 140, bottom: 210 };
    const lower = { left: 100, top: 400, right: 140, bottom: 420 };
    // Issue #360: a 400px pane fits on neither side of the last three words.
    // Like Yomitan, it takes the roomier side and is shortened to that side's
    // room, keeping the 4px gap and 6px padding, instead of being clamped over
    // the word; a root does the same. Panes that fit keep their full size.
    const boxes = [place(roomy), place(roomy, true), place(low, true), place(high),
      place(upper, true, 400), place(lower, true, 400), place(upper, false, 400)];
    const summary = ([anchor, box]) => `${box.placement} ${box.left},${box.top} ${box.width}x${box.height}`
      + (box.top >= anchor.bottom || box.top + box.height <= anchor.top ? "" : " covering its word");
    equal("calculatePopupPosition prefers above for roots and below for nested panes, shortening a pane on the roomier side rather than covering its word",
      boxes.map(summary), [
        "above 100,46 300x200", "below 100,274 300x200", "above 100,296 300x200", "below 100,64 300x200",
        "below 100,214 300x380", "above 100,6 300x390", "below 100,214 300x380",
      ]);
  }
  check("render/glossary.js publishes HDGlossary", Boolean(HDGlossary), "HDGlossary was undefined");
  check("render/popup.js publishes HDPopup", Boolean(HDPopup), "HDPopup was undefined");
  if (!HDGlossary || !HDPopup) {
    return false;
  }

  const summaryRaw = JSON.stringify([{ type: "structured-content", content: [
    { tag: "span", data: { content: "part-of-speech" }, content: "noun" },
    { tag: "img", path: "media/kanji.png", width: 16, height: 16, collapsed: true },
    { tag: "ul", data: { content: "glossary" }, content: [
      { tag: "li", content: "first • • second" }, { tag: "li", content: "third" },
    ] },
    { tag: "div", data: { content: "example" }, content: "not a definition" },
  ] }]);
  const summaryGlossaries = [
    { dictionary: "Plain", glossary: JSON.stringify(["plain first", "plain second"]) },
    { dictionary: "Illustrated", glossary: summaryRaw },
  ];
  const summaryBefore = JSON.stringify(summaryGlossaries);
  const compact = HDPopup.extractCompactDefinitionSummary(summaryGlossaries, "Illustrated", 2);
  const fallback = HDPopup.extractCompactDefinitionSummary(summaryGlossaries, "Absent", 1);
  const lateImage = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Late", glossary: JSON.stringify([
    "text before image", { type: "image", path: "media/kanji.png" },
  ]) }]);
  const nonImageLeads = [0, false, { type: "text", content: "prefix" },
    { type: "text", tag: "img", text: "prefix", path: "wrong.png" },
    { type: "structured-content", tag: "img", content: "prefix", path: "wrong.png" },
  ].map(lead => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Leading text", glossary: JSON.stringify([
    lead, { type: "image", path: "late.png" }, "definition",
  ]) }]));
  const bulletText = ("first • first • second • " + "unused • ".repeat(50000)).trim();
  const longText = "長😀".repeat(50000);
  const duplicateText = "a".repeat(200) + " • " + "a".repeat(200) + " • tail";
  sandbox.__summaryWork = { bulletText, longText, splitFragments: 0, codePoints: 0, emptyNormalizations: 0,
    largeNormalizations: 0, largeTrims: 0, matchedCodeUnits: 0, duplicateText, duplicateMatches: 0,
    countDuplicateBoundaries: false, duplicateBoundaries: 0, duplicatePointArrays: 0, spanNormalizations: 0 };
  runInContext(`
    (() => {
      const split = String.prototype.split;
      const at = Array.prototype.at;
      const from = Array.from;
      const replace = String.prototype.replace;
      const trim = String.prototype.trim;
      const toLowerCase = String.prototype.toLowerCase;
      const codePointAt = String.prototype.codePointAt;
      const exec = RegExp.prototype.exec;
      const iterator = String.prototype[Symbol.iterator];
      Array.prototype.at = function (...args) {
        if (__summaryWork.countDuplicateBoundaries) __summaryWork.duplicateBoundaries += 1;
        return at.apply(this, args);
      };
      Array.from = function (value, ...args) {
        if (__summaryWork.countDuplicateBoundaries && typeof value === "string") __summaryWork.duplicatePointArrays += 1;
        return from.call(this, value, ...args);
      };
      String.prototype.toLowerCase = function () {
        if (String(this) === "span") __summaryWork.spanNormalizations += 1;
        return toLowerCase.call(this);
      };
      String.prototype.split = function (...args) {
        const result = split.apply(this, args);
        if (String(this) === __summaryWork.bulletText) __summaryWork.splitFragments += result.length;
        return result;
      };
      String.prototype.replace = function (...args) {
        if (String(this).trim() === "") __summaryWork.emptyNormalizations += 1;
        if (String(this).length > 482) __summaryWork.largeNormalizations += 1;
        return replace.apply(this, args);
      };
      String.prototype.trim = function () {
        if (String(this).length > 482) __summaryWork.largeTrims += 1;
        return trim.call(this);
      };
      String.prototype.codePointAt = function (...args) {
        if (String(this) === __summaryWork.longText) __summaryWork.codePoints += 1;
        return codePointAt.apply(this, args);
      };
      RegExp.prototype.exec = function (...args) {
        const result = exec.apply(this, args);
        __summaryWork.matchedCodeUnits = Math.max(__summaryWork.matchedCodeUnits, result?.[0].length || 0);
        if (args[0] === __summaryWork.duplicateText) __summaryWork.duplicateMatches += 1;
        return result;
      };
      String.prototype[Symbol.iterator] = function* () {
        const observed = String(this) === __summaryWork.longText;
        for (const character of { [Symbol.iterator]: () => iterator.call(this) }) {
          if (observed) __summaryWork.codePoints += 1;
          yield character;
        }
      };
      globalThis.__restoreSummaryWork = () => {
        Array.prototype.at = at;
        Array.from = from;
        String.prototype.split = split;
        String.prototype.replace = replace;
        String.prototype.trim = trim;
        String.prototype.toLowerCase = toLowerCase;
        String.prototype.codePointAt = codePointAt;
        RegExp.prototype.exec = exec;
        String.prototype[Symbol.iterator] = iterator;
      };
    })();
  `, sandbox);
  let boundedSummaryWork, bulletSummary;
  try {
    bulletSummary = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Bullets",
      glossary: JSON.stringify([" • ".repeat(150000) + "first • second"]) }]);
    const bullets = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Bullets", glossary: JSON.stringify([bulletText]) }], null, 2);
    const long = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Long", glossary: JSON.stringify([longText]) }], null, 1);
    sandbox.__summaryWork.countDuplicateBoundaries = true;
    const repeated = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Repeated", glossary: JSON.stringify([duplicateText]) }]);
    sandbox.__summaryWork.countDuplicateBoundaries = false;
    sandbox.__summaryWork.spanNormalizations = 0;
    const afterEmptySenses = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Empty senses", glossary: JSON.stringify([
      ...Array.from({ length: 16 }, () => ({ tag: "span", content: Array.from({ length: 128 }, () => ({ tag: "span", content: "" })) })),
      "useful final sense",
    ]) }], null, 1);
    boundedSummaryWork = JSON.stringify(bullets?.items) === JSON.stringify(["first", "second"])
      && long?.items[0] === "長😀".repeat(119) + "長…"
      && sandbox.__summaryWork.splitFragments === 0 && sandbox.__summaryWork.codePoints <= 241
      && sandbox.__summaryWork.emptyNormalizations === 0 && sandbox.__summaryWork.largeNormalizations === 0
      && sandbox.__summaryWork.largeTrims === 0 && sandbox.__summaryWork.matchedCodeUnits <= 482
      && JSON.stringify(repeated?.items) === JSON.stringify(["a".repeat(200), "tail"])
      && sandbox.__summaryWork.duplicateMatches <= 6 && sandbox.__summaryWork.duplicateBoundaries <= 3
      && sandbox.__summaryWork.duplicatePointArrays === 0
      && JSON.stringify(afterEmptySenses?.items) === JSON.stringify(["useful final sense"])
      // Original tag work plus 256 records classified by the marked-section
      // visibility pass; neither number is a product input cap.
      && sandbox.__summaryWork.spanNormalizations <= 2832 + 256;
  } finally { sandbox.__restoreSummaryWork(); }
  const summaryWork = { splitFragments: sandbox.__summaryWork.splitFragments, codePoints: sandbox.__summaryWork.codePoints,
    emptyNormalizations: sandbox.__summaryWork.emptyNormalizations, largeNormalizations: sandbox.__summaryWork.largeNormalizations,
    largeTrims: sandbox.__summaryWork.largeTrims, matchedCodeUnits: sandbox.__summaryWork.matchedCodeUnits,
    duplicateMatches: sandbox.__summaryWork.duplicateMatches, duplicateBoundaries: sandbox.__summaryWork.duplicateBoundaries,
    duplicatePointArrays: sandbox.__summaryWork.duplicatePointArrays, spanNormalizations: sandbox.__summaryWork.spanNormalizations };
  delete sandbox.__summaryWork;
  delete sandbox.__restoreSummaryWork;
  const duplicate = "a".repeat(200);
  const streamedText = [
    { content: ["pre", { tag: "div", content: "" }, "fix"], items: ["prefix"] },
    { content: ["pre", { tag: "div", content: " \r\n" }, "fix"], items: ["pre fix"] },
    { content: ["a".repeat(238), "\ud83d", "\ude00", "z"], items: ["a".repeat(238) + "😀z"] },
    { content: ["a".repeat(238), "\ud83d", "\ude00", "zq"], items: ["a".repeat(238) + "😀…"] },
    { content: ["a".repeat(239) + "\ud83d", "\ude00z"], items: ["a".repeat(239) + "…"] },
    { content: ["a".repeat(240), " \r\n"], items: ["a".repeat(240)] },
    { content: [duplicate, " • ", duplicate, " • tail"], items: [duplicate, "tail"] },
  ].every(({ content, items }) => JSON.stringify(HDPopup.extractCompactDefinitionSummary([{ dictionary: "Stream",
    glossary: JSON.stringify({ tag: "ul", content: { tag: "li", content } }) }])?.items) === JSON.stringify(items));
  const mixedSenses = [
    ["first sense", { tag: "p", content: "second sense" }],
    [{ tag: "p", content: "first sense" }, "second sense"],
    [{ type: "text", text: "first sense" }, { tag: "p", content: "second sense" }],
    [{ type: "structured-content", content: { tag: "div", content: [
      { tag: "p", content: "first sense" }, { tag: "p", content: "second sense" },
    ] } }],
  ].map(senses => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Mixed", glossary: JSON.stringify(senses) }])?.items);
  const brokenLines = [
    { tag: "p", content: ["first", { tag: "br" }, "second"] },
    { tag: "p", content: ["first", { tag: "br", content: "not rendered" }, "second"] },
    { tag: "p", data: { content: "glossary" }, content: ["first", { tag: "br" }, "second"] },
    { tag: "ul", content: { tag: "li", content: ["first", { tag: "br" }, "second"] } },
  ].map(content => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Line breaks",
    glossary: JSON.stringify([{ type: "structured-content", content }]) }])?.items);
  const ruby = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Ruby", glossary: JSON.stringify([
    { tag: "p", content: [
      { tag: "ruby", content: ["食", { tag: "rp", content: "(" },
        { tag: "rt", content: "た" }, { tag: "rp", content: ")" }] }, "べる (literal)",
    ] },
  ]) }]);
  const phantomList = { tag: "ul", content: { tag: "li", content: "not rendered" } };
  const renderedDispatch = [
    ...["br", "img", "script", "button", "input", "source"].map(tag => [{ tag, content: phantomList }, "visible"]),
    [{ type: "text", tag: "img", text: "visible", content: phantomList }],
    [{ type: "text", tag: "br", text: "visible", content: phantomList }],
    [{ type: "text", tag: "rp", text: "visible", content: phantomList }],
    [{ type: "structured-content", tag: "img", content: "visible" }],
  ].map(content => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Dispatch", glossary: JSON.stringify(content) }])?.items);
  const imageAfterBreak = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Break image", glossary: JSON.stringify([
    { tag: "br", content: "not rendered" }, { tag: "img", path: "leading.png" }, "visible",
  ]) }]);
  check("compact summaries preserve ordered text, split nonempty bullets and select only a leading image without changing full glossaries",
    JSON.stringify(compact?.items) === JSON.stringify(["first", "second"])
      && compact?.dictionary === "Illustrated" && compact?.image?.path === "media/kanji.png"
      && JSON.stringify(fallback?.items) === JSON.stringify(["plain first"])
      && !lateImage?.image && JSON.stringify(bulletSummary?.items) === JSON.stringify(["first", "second"])
      && nonImageLeads.every(summary => !summary?.image)
      && JSON.stringify(summaryGlossaries) === summaryBefore && boundedSummaryWork && streamedText
      && mixedSenses.every(items => JSON.stringify(items) === JSON.stringify(["first sense", "second sense"]))
      && brokenLines.every(items => JSON.stringify(items) === JSON.stringify(["first second"]))
      && JSON.stringify(ruby?.items) === JSON.stringify(["食べる (literal)"])
      && renderedDispatch.every(items => JSON.stringify(items) === JSON.stringify(["visible"]))
      && imageAfterBreak?.image?.path === "leading.png",
    JSON.stringify({ compact, fallback, lateImage, bulletSummary, nonImageLeads, summaryWork, streamedText, mixedSenses, brokenLines, ruby, renderedDispatch, imageAfterBreak }));
  // Jitendex redirect entries are just "⟶ <link>"; the summary skips to the next glossary.
  const redirect = HDPopup.extractCompactDefinitionSummary([
    { dictionary: "Jitendex", glossary: JSON.stringify([{ type: "structured-content", content: { tag: "div",
      data: { content: "redirect-glossary" }, content: ["⟶", { tag: "a", href: "?query=悪どい", content: "悪どい" }] } }]) },
    { dictionary: "Jitendex", glossary: JSON.stringify(["vicious"]) },
  ]);
  check("compact summaries skip Jitendex ⟶ redirects", JSON.stringify(redirect?.items) === JSON.stringify(["vicious"]),
    JSON.stringify(redirect));
  // Sanseido-style senses (sankoku, 新明解) keep only each 語釈's English half:
  // no sense numbers, labels, examples, furigana, ⇨ references or link lists.
  const named = (name, content, tag = "span") => ({ tag, data: { name }, content });
  const sanseido = (...senses) => JSON.stringify([{ type: "structured-content", content: [
    named("見出部", named("見出仮名", "あ")), named("解説部", named("大語義", senses, "div"), "div"),
  ] }]);
  const usage = named("用例G", ["「", named("用例", ["━", "、久しぶり"]), "」"], "div");
  const furigana = named("ルビG", named("ルビ", "(かんとく)"));
  const spacer = named("分書");
  const sanseidoItems = (glossary) => HDPopup.extractCompactDefinitionSummary([{ dictionary: "sankoku", glossary }], null, 6)?.items;
  const sanseidoSummaries = {
    numbered: sanseidoItems(sanseido(
      named("語義", [named("語義番号", "①"), named("専門G", ["〘", named("専門", "映画"), "〙"]),
        named("語釈", ["An art director", furigana, ".", " ", "美術監督", furigana, "。"]), usage], "div"),
      named("語義", [named("語義番号", "②"), named("参照G", [named("参照矢印", "⇨"),
        named("参照", { tag: "a", href: "?query=監督", content: "監督" })]), usage], "div"),
      named("語義", [named("語義番号", "③"), named("語釈", ["A passageway with a rounded roof.", " ", "まるい屋根のある通路。"])], "div"),
    )),
    unnumbered: sanseidoItems(sanseido(named("語義", [named("使用域G", ["〔", named("使用域", "俗"), "〕"]),
      named("語釈", ["…you know. …yeah.", " ", "…よ。…ぜ。"]), usage], "div"))),
    subSenses: sanseidoItems(sanseido(named("語義", [named("語義番号", "①"),
      named("語釈", ["The act of going up. In particular,", " ", "上がること。特に、"]),
      named("副義", [named("語義番号", "ⓐ"), named("語釈", ["The act of being completed.", " ", "完成すること。"]), usage], "div"),
      named("副義", [named("語義番号", "ⓑ"), named("語釈", ["The act of becoming higher.", " ", "高くなること。"])], "div"),
    ], "div"))),
    groupGloss: sanseidoItems(sanseido(named("語釈", ["The symbol “＠.”", " ", "「＠」の記号。"]))),
    spacing: sanseidoItems(sanseido(named("語義", named("語釈", [
      "An", spacer, " inter", spacer, "change  of 「“　”」 marks.", " ", "インター", spacer, "チェンジ。",
    ]), "div"))),
    englishOnly: sanseidoItems(sanseido(named("語義", named("語釈", ["The ",
      named("言換G", ["〈", named("言換", "act of succeeding"), "／", named("言換", "successor"), "〉"]), " ",
      named("言換G", ["〈", named("言換", "title"), "／", named("言換", "estate"), "〉"]), "."]), "div"))),
    fullWidthJapanese: sanseidoItems(sanseido(named("語義", named("語釈", ["Stitches crossed in the shape of ",
      named("横", "Ｘ"), ".", " ", named("横", "Ｘ"), "の形に交差させたステッチ。"]), "div"))),
    japaneseOnly: sanseidoItems(sanseido(named("語義", named("語釈", "あせび。"), "div"),
      named("語義", named("語釈", ["かなしみの", furigana, "感じ。"]), "div"))),
  };
  const sanseidoSkipped = HDPopup.extractCompactDefinitionSummary([
    { dictionary: "sankoku", glossary: JSON.stringify([{ type: "structured-content",
      content: { tag: "a", href: "?query=ああ言えばこう言う", content: "ああ言えばこう言う" } }]) },
    { dictionary: "sankoku", glossary: sanseido(named("語義", [named("参照G", [named("参照矢印", "⇨"),
      named("参照", { tag: "a", href: "?query=指示語", content: "指示語" })]), usage], "div")) },
    { dictionary: "Jitendex", glossary: JSON.stringify(["like that"]) },
  ]);
  check("compact summaries keep only the English gloss of Sanseido-style senses",
    JSON.stringify(sanseidoSummaries) === JSON.stringify({
      numbered: ["An art director.", "A passageway with a rounded roof."],
      unnumbered: ["…you know. …yeah."],
      subSenses: ["The act of going up. In particular,", "The act of being completed.", "The act of becoming higher."],
      groupGloss: ["The symbol “＠.”"],
      spacing: ["An interchange of 「“ ”」 marks."],
      englishOnly: ["The 〈act of succeeding／successor〉 〈title／estate〉."],
      fullWidthJapanese: ["Stitches crossed in the shape of Ｘ."],
      japaneseOnly: ["あせび。", "かなしみの感じ。"],
    })
      && sanseidoSkipped?.dictionary === "Jitendex" && JSON.stringify(sanseidoSkipped?.items) === JSON.stringify(["like that"]),
    JSON.stringify({ sanseidoSummaries, sanseidoSkipped }));

  const aggregateResult = { term: { frequencies: [
    { dictionary: "Rank A", frequencies: [{ value: 1234, displayValue: "1,234" }, { value: 1 }] },
    { dictionary: "Occurrences", frequencies: [{ value: 1000 }] },
    { dictionary: "Rank B", frequencies: [{ value: 0, displayValue: "999" }, { value: 2468, displayValue: "999 label" }] },
    { dictionary: "Unspecified", frequencies: [{ value: 7 }] },
    { dictionary: "Empty", frequencies: [{ value: 0, displayValue: "100" }] },
  ] } };
  const aggregateInput = JSON.stringify(aggregateResult);
  const aggregateTags = HDPopup.createFrequencyTags(document, aggregateResult, [
    { title: "Rank A", frequencyMode: "rank-based" },
    { title: "Rank B", frequencyMode: "rank-based" },
    { title: "Occurrences", frequencyMode: "occurrence-based" },
  ], 12, true, false).filter(tag => !tag.hidden);
  check("frequency aggregates use native values once per dictionary and keep rank occurrence and unknown units separate",
    JSON.stringify(aggregateTags.map(tag => Number(tag.querySelector("[data-frequency]")?.dataset.frequency)))
      === JSON.stringify([1645, 1000, 7])
      && JSON.stringify(aggregateTags.map(tag => tag.querySelector(".gsm-hoshidicts-frequency-source")?.textContent))
        === JSON.stringify(["Avg rank", "Avg count", "Avg frequency"])
      && JSON.stringify(aggregateTags.map(tag => tag.title))
        === JSON.stringify(["Rank average", "Occurrence average", "Frequency average (unspecified)"])
      && JSON.stringify(aggregateResult) === aggregateInput,
    aggregateTags.map(tag => tag.outerHTML).join("\n"));

  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.appendChild(popup);

  let positioned = 0;
  const noteEntries = [];
  const noteEditingStates = [];
  let addNoteEntry = async () => {};
  const view = HDPopup.createPopupView({
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    document,
    getPopupColumns: () => 1,
    idPrefix: "hoshidicts",
    onKanjiClick() {},
    onAddCustomEntry(entry) {
      noteEntries.push(structuredClone(entry));
      return addNoteEntry(entry);
    },
    onNoteEditingChange(editing) {
      noteEditingStates.push(editing);
    },
    parseTagList: HDGlossary.parseTagList,
    popup,
    positionPopup() {
      positioned += 1;
    },
    window,
  });

  const source = document.querySelector("p");
  source.textContent = lookup.results[0].matched;
  const candidate = {
    anchor: source,
    matchOffset: 0,
    query: lookup.results[0].matched,
    sentence: source.textContent,
    sourceElements: [source],
  };

  const mediaRequests = [];
  let stats;
  try {
    stats = view.renderResults(lookup.results, candidate, {
      generation: lookup.generation,
      hidePopupGrammarTags: false,
      resolveMedia(query) {
        mediaRequests.push(query);
        return Promise.resolve(media.dataUrl);
      },
      showFrequencyDictionaryNames: true,
      showPitchAccentBadge: true,
      showPitchAccentFurigana: true,
    });
  } catch (error) {
    fail("renderResults accepts the engine's LookupResult verbatim", error.stack ?? error);
    return false;
  }
  pass("renderResults accepts the engine's LookupResult verbatim");
  check("renderResults asked the caller to position the popup", positioned > 0, `positioned ${positioned}`);
  check("renderResults returned its lookupStats slot", stats !== undefined && "lookupStats" in stats, JSON.stringify(stats));
  check("pronunciation buttons render as named icons without visible text",
    stats.audioButtons.length > 0 && stats.audioButtons.every(({ button }) => button.textContent === ""
      && button.getAttribute("aria-label")?.startsWith("Play pronunciation for ")
      && button.title.includes("Down for choices")));

  const headword = popup.querySelector(".gsm-hoshidicts-headword");
  check(
    "the headword renders the deinflected expression",
    (headword?.textContent ?? "").includes(lookup.results[0].term.expression),
    JSON.stringify(headword?.textContent),
  );
  const explanation = headword?.querySelector(".gsm-hoshidicts-deinflection");
  check("the real deinflection endpoints and ordered native trace render in a collapsed disclosure",
    explanation?.open === false
      && explanation.querySelector("summary").textContent === `${lookup.results[0].matched} → ${lookup.results[0].deinflected}`
      && JSON.stringify([...explanation.querySelectorAll("ol > li")].map((item) => [
        item.querySelector(".gsm-hoshidicts-deinflection-step-name").textContent,
        item.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "",
      ])) === JSON.stringify(lookup.results[0].trace.map(({ name, description }) => [name, description])),
    explanation?.outerHTML ?? "missing disclosure");
  const glossaryContent = popup.querySelector(".gsm-hoshidicts-glossary-content");
  check(
    "the raw structured-content glossary was parsed and rendered",
    Boolean(glossaryContent) && (glossaryContent.textContent ?? "").length > 0,
    JSON.stringify(glossaryContent?.textContent?.slice(0, 80)),
  );
  // The engine hands over the raw glossary *array* of one term-bank row, and
  // every element of it is a separate sense. Appending them into one parent runs
  // them together with no separator ("to eatto live on (e.g. a salary)").
  const senses = JSON.parse(lookup.results[0].term.glossaries[0].glossary);
  check("the fixture's first glossary carries more than one sense", senses.length > 1, JSON.stringify(senses));
  // Yomitan's gloss item leads with a hidden separator, so read its content.
  equal(
    "every element of the glossary array renders as its own item",
    [...(glossaryContent?.querySelectorAll(".gloss-item > .gloss-content") ?? [])].map((item) => item.textContent),
    senses,
  );
  check(
    "the gloss list counts its items as Yomitan's data-count does",
    glossaryContent?.querySelector(":scope > ul.gloss-list")?.dataset.count === String(senses.length),
    glossaryContent?.innerHTML.slice(0, 200),
  );
  check(
    "the glossary card is tagged with its dictionary for @scope",
    glossaryContent?.dataset.hoshidictsDictionary === lookup.results[0].term.glossaries[0].dictionary,
    JSON.stringify(glossaryContent?.dataset?.hoshidictsDictionary),
  );
  check(
    "frequency metadata rendered",
    popup.textContent.includes(lookup.results[0].term.frequencies[0].frequencies[0].displayValue),
    JSON.stringify(popup.textContent.slice(0, 200)),
  );

  await metadataRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  lookupCountsRenderStage({ HDGlossary, HDPopup, document, window, candidate, results: lookup.results });
  keybindEntryRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await dynamicHeadwordRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });

  const glossary = lookup.results[0].term.glossaries[0];
  const noteResults = [
    {
      ...lookup.results[0],
      term: {
        ...lookup.results[0].term,
        expression: "All-tab primary",
        reading: "おーる",
        glossaries: [{ ...glossary, dictionary: "Dictionary A" }],
      },
    },
    {
      ...lookup.results[0],
      term: {
        ...lookup.results[0].term,
        expression: "Projected primary",
        reading: "ぷろじぇくてっど",
        glossaries: [{ ...glossary, dictionary: "Dictionary B" }],
      },
    },
  ];
  const tabResults = structuredClone(noteResults);
  tabResults[0].term.glossaries.push({ ...glossary, dictionary: "Dictionary C" });
  const originalTabResults = JSON.stringify(tabResults);
  const tabSelections = [];
  const tabContext = {
    dictionaryPresentation: [
      { title: "Dictionary A", displayName: "All", favorite: true },
      { title: "Dictionary B", displayName: "Favourite B", favorite: true },
      { title: "Missing", favorite: true },
    ],
    dictionaryTabGroups: [
      { id: "c", name: "Favourite B", dictionaries: ["Dictionary C"] },
      { id: "a", name: "All", dictionaries: ["Dictionary A"] },
      { id: "empty", name: "Empty", dictionaries: ["Missing"] },
    ],
    onDictionaryTabSelected(selection) { tabSelections.push(selection); },
  };
  view.renderResults(tabResults, candidate, tabContext);
  // As in Yomitan, a dictionary card is never a disclosure: a fresh lookup and
  // every tab projection show its definitions under a plain title.
  const cardDisclosures = () => [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")]
    .map((card) => ({ tag: card.tagName, title: card.firstElementChild.className,
      label: card.firstElementChild.textContent, dictionary: card.firstElementChild.title,
      collapsible: card.closest("details") !== null
        || card.querySelector(".gsm-hoshidicts-definitions").closest("details") !== null }));
  const freshCards = cardDisclosures();
  const allTabs = [...popup.querySelectorAll('[role="tab"]')];
  check("dictionary tabs include ordered nonempty groups and only ungrouped favourites",
    JSON.stringify(allTabs.map((tab) => [tab.textContent, { ...tab.dataset }])) === JSON.stringify([
      ["All", {}],
      ["Favourite B", { groupId: "c" }],
      ["All (group)", { groupId: "a" }],
      ["Favourite B (dictionary)", { dictionary: "Dictionary B" }],
    ]), JSON.stringify(allTabs.map((tab) => [tab.textContent, { ...tab.dataset }])));
  const tabProjections = [];
  const projectedCards = [];
  for (const selector of [
    '[data-dictionary="Dictionary B"]', '[data-group-id="c"]', '[data-group-id="a"]',
  ]) {
    const tab = popup.querySelector(`[role="tab"]${selector}`);
    tab?.click();
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    tabProjections.push([...popup.querySelectorAll(".gsm-hoshidicts-glossary-card-title")]
      .map((title) => title.title));
    projectedCards.push(cardDisclosures());
  }
  check("a new lookup and every tab projection show each dictionary card open under a plain title",
    JSON.stringify(freshCards) === JSON.stringify([
      { tag: "DIV", title: "gsm-hoshidicts-glossary-card-title", label: "All", dictionary: "Dictionary A", collapsible: false },
      { tag: "DIV", title: "gsm-hoshidicts-glossary-card-title", label: "Dictionary C", dictionary: "Dictionary C", collapsible: false },
    ])
      && JSON.stringify(projectedCards) === JSON.stringify([
        [{ tag: "DIV", title: "gsm-hoshidicts-glossary-card-title", label: "Favourite B", dictionary: "Dictionary B", collapsible: false }],
        [{ tag: "DIV", title: "gsm-hoshidicts-glossary-card-title", label: "Dictionary C", dictionary: "Dictionary C", collapsible: false }],
        [{ tag: "DIV", title: "gsm-hoshidicts-glossary-card-title", label: "All", dictionary: "Dictionary A", collapsible: false }],
      ]),
    JSON.stringify({ freshCards, projectedCards }));
  const sameTabPanel = popup.querySelector(".gsm-hoshidicts-tab-panel").firstElementChild;
  const beforeSameTab = positioned;
  popup.querySelector('[role="tab"][data-group-id="a"]')?.click();
  check("favourite and group tabs project locally in native order without mutating results",
    JSON.stringify(tabProjections) === JSON.stringify([
      ["Dictionary B"], ["Dictionary C"], ["Dictionary A"],
    ])
      && JSON.stringify(tabSelections) === JSON.stringify([
        null, { dictionary: "Dictionary B" }, { groupId: "c" }, { groupId: "a" },
      ])
      && JSON.stringify(tabResults) === originalTabResults
      && sameTabPanel === popup.querySelector(".gsm-hoshidicts-tab-panel").firstElementChild
      && positioned === beforeSameTab,
    JSON.stringify({ tabProjections, tabSelections, positioned, beforeSameTab }));
  const inheritedProjections = [];
  for (const selection of [
    { dictionary: "Dictionary B" }, { groupId: "c" }, { dictionary: "Dictionary C" },
    { favourites: true }, { groupId: "empty" },
  ]) {
    let selected;
    const context = { ...tabContext, selectedDictionaryTab: selection, expandAll: true,
      onDictionaryTabSelected(value) { selected = value; } };
    view.renderResults(tabResults, candidate, context);
    inheritedProjections.push([selected,
      [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card-title")].map((item) => item.title)]);
    selected = undefined;
    view.renderKanji({ ...kanji, entries: ["Dictionary A", "Dictionary C", "Dictionary B"]
      .map((dictionary) => ({ ...kanji.entries[0], dictionary })) }, candidate, context);
    inheritedProjections.push([selected,
      [...popup.querySelectorAll(".gsm-hoshidicts-kanji-entry")].map((item) => item.dataset.dictionary)]);
  }
  check("term and native-kanji destinations adopt favourite or group context and otherwise fall back to All",
    JSON.stringify(inheritedProjections) === JSON.stringify([
      [{ dictionary: "Dictionary B" }, ["Dictionary B"]], [{ dictionary: "Dictionary B" }, ["Dictionary B"]],
      [{ groupId: "c" }, ["Dictionary C"]], [{ groupId: "c" }, ["Dictionary C"]],
      [null, ["Dictionary A", "Dictionary C", "Dictionary B"]], [null, ["Dictionary A", "Dictionary C", "Dictionary B"]],
      [null, ["Dictionary A", "Dictionary C", "Dictionary B"]], [null, ["Dictionary A", "Dictionary C", "Dictionary B"]],
      [null, ["Dictionary A", "Dictionary C", "Dictionary B"]], [null, ["Dictionary A", "Dictionary C", "Dictionary B"]],
    ]), JSON.stringify(inheritedProjections));
  // A clicked-kanji group compares its members side by side: every member with
  // an entry is its own tab in group order, replacing the group and favourite
  // tabs, and a native kanji entry renders as one structured card.
  const nativeEntry = kanji.entries[0];
  const scopeSelections = [];
  view.renderResults([{ ...noteResults[0], term: { ...noteResults[0].term, expression: kanji.character, reading: "",
    glossaries: [
      { dictionary: "Dictionary B", glossary: JSON.stringify(["a term member's single-kanji entry"]) },
      { dictionary: nativeEntry.dictionary, glossary: HDPopup.kanjiEntryGlossary(nativeEntry) },
    ] } }], candidate, { ...tabContext, expandAll: true,
    dictionaryTabScope: ["Missing", nativeEntry.dictionary, "Dictionary B"],
    onDictionaryTabSelected(selection) { scopeSelections.push(selection); } });
  const scopeTabs = () => [...popup.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, { ...tab.dataset }]);
  const allScopeTabs = scopeTabs();
  popup.querySelector(`[role="tab"][data-dictionary="${nativeEntry.dictionary}"]`)?.click();
  const nativeCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
  const nativeContent = nativeCard?.querySelector(".gsm-hoshidicts-glossary-content");
  const nativeCardState = {
    cards: [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card-title")].map((title) => title.title),
    structured: nativeContent?.querySelector(".gloss-content")?.classList.contains("structured-content"),
    readings: [...nativeContent?.querySelectorAll("[data-sc-content=reading]") ?? []].map((node) => node.textContent),
    tags: nativeContent?.querySelector("[data-sc-content=tags]")?.textContent,
    meanings: [...nativeContent?.querySelectorAll("ol > li") ?? []].map((item) => item.textContent),
    details: [...nativeContent?.querySelectorAll("details table tr") ?? []]
      .map((row) => [...row.cells].map((cell) => cell.textContent)),
    summary: nativeContent?.querySelector("details > summary")?.textContent,
  };
  // The live presentation update keeps the scope: a renamed group cannot bring
  // the ordinary group tabs back or drop the selected member.
  view.updateDictionaryPresentation({ ...tabContext, dictionaryTabGroups: [
    { id: "scoped", name: "Renamed", dictionaries: [nativeEntry.dictionary, "Dictionary B"] }] });
  check("a clicked-kanji group renders each contributing member as an ordered tab and native entries as structured cards",
    JSON.stringify(allScopeTabs) === JSON.stringify([
      ["All", {}], [nativeEntry.dictionary, { dictionary: nativeEntry.dictionary }], ["Favourite B", { dictionary: "Dictionary B" }],
    ])
      && JSON.stringify(scopeTabs()) === JSON.stringify(allScopeTabs)
      && JSON.stringify(scopeSelections) === JSON.stringify([null, { dictionary: nativeEntry.dictionary }])
      && JSON.stringify(nativeCardState) === JSON.stringify({
        cards: [nativeEntry.dictionary], structured: true,
        readings: ["On ショク · ジキ", "Kun く.う · た.べる"], tags: "jouyou grade2", meanings: ["food", "eat", "meal"],
        details: nativeEntry.stats.map(({ name, value }) => [name, value]), summary: "Details",
      }),
    JSON.stringify({ allScopeTabs, afterUpdate: scopeTabs(), scopeSelections, nativeCardState }));
  const selectedTabs = [];
  view.renderResults(noteResults, candidate, {
    dictionaryPresentation: [{ title: "Dictionary B", displayName: "Favourite B", favorite: true }],
    onDictionaryTabSelected(tab) {
      selectedTabs.push(tab);
    },
  });
  popup.querySelector('[role="tab"][data-dictionary="Dictionary B"]')?.click();
  const termNoteButton = popup.querySelector(".gsm-hoshidicts-note-button");
  const termFormWasLazy = popup.querySelector(".gsm-hoshidicts-note-form") === null
    && view.closeNoteForm() === false;
  const resultToolbar = popup.querySelector(".gsm-hoshidicts-result-chrome");
  view.setToolbarPosition("bottom");
  view.scrollElement.scrollTop = 120;
  let scrollAtNoteFocus;
  popup.addEventListener("focus", () => { scrollAtNoteFocus = view.scrollElement.scrollTop; }, { capture: true, once: true });
  termNoteButton?.click();
  const bottomNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  const miningFeedback = popup.querySelector(".gsm-hoshidicts-mining-feedback");
  const bottomChildren = [...popup.children];
  const openedAtBottom = view.scrollElement.scrollTop;
  view.setToolbarPosition("top");
  check(
    "the bottom Note form stays outside scrolling definitions and opens without moving their viewport",
    termFormWasLazy
      && bottomChildren.at(-3) === bottomNoteForm
      && bottomChildren.at(-2) === miningFeedback
      && bottomChildren.at(-1) === resultToolbar
      && openedAtBottom === 120
      && scrollAtNoteFocus === 120
      && bottomNoteForm.scrollTop === 0
      && view.scrollElement.parentNode === popup
      && view.scrollElement.contains(popup.querySelector(".gsm-hoshidicts-tab-panel"))
      && !view.scrollElement.contains(bottomNoteForm) && !view.scrollElement.contains(miningFeedback)
      && !view.scrollElement.contains(resultToolbar)
      && popup.children[0] === resultToolbar
      && popup.children[1] === miningFeedback
      && popup.children[2] === bottomNoteForm,
    JSON.stringify({
      bottomOrder: bottomChildren.map(({ className }) => className),
      openedAtBottom,
      scrollAtNoteFocus,
      formScrollTop: bottomNoteForm.scrollTop,
      topOrder: [...popup.children].map(({ className }) => className),
    }),
  );
  const termNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  const focusedDefinition = termNoteForm.elements.definition;
  focusedDefinition.value = "Keep this draft";
  focusedDefinition.focus();
  focusedDefinition.setSelectionRange(2, 6);
  const focusRemovals = [];
  let edgeBlurs = 0;
  focusedDefinition.addEventListener("blur", () => { edgeBlurs += 1; });
  const edgeObserver = new window.MutationObserver(() => {});
  edgeObserver.observe(popup, { childList: true });
  view.setToolbarPosition("bottom");
  focusRemovals.push(...edgeObserver.takeRecords().flatMap(record => [...record.removedNodes])
    .filter(node => node.contains(focusedDefinition)));
  const retainedNoteFocus = shadow.activeElement === focusedDefinition
    && focusedDefinition.selectionStart === 2 && focusedDefinition.selectionEnd === 6;
  const focusedTab = popup.querySelector('[role="tab"][aria-selected="true"]');
  focusedTab.focus();
  edgeBlurs = 0;
  focusedTab.addEventListener("blur", () => { edgeBlurs += 1; });
  view.setToolbarPosition("top");
  focusRemovals.push(...edgeObserver.takeRecords().flatMap(record => [...record.removedNodes])
    .filter(node => node.contains(focusedTab)));
  view.setToolbarPosition("top");
  const sameEdgeUntouched = edgeObserver.takeRecords().length === 0;
  edgeObserver.disconnect();
  check("toolbar edge changes preserve deliberate tab and Note focus with draft selection",
    retainedNoteFocus && shadow.activeElement === focusedTab && focusedDefinition.value === "Keep this draft"
      && focusRemovals.length === 0 && edgeBlurs === 0 && sameEdgeUntouched,
    JSON.stringify({ removals: focusRemovals.length, edgeBlurs, sameEdgeUntouched }));
  focusedDefinition.value = "";
  const termInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-term");
  const readingInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-reading");
  const definitionInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-definition");
  check(
    "the shared Note form uses the currently projected primary term",
    selectedTabs.length === 2
      && selectedTabs[0] === null
      && selectedTabs[1]?.dictionary === "Dictionary B"
      && termNoteButton?.getAttribute("aria-expanded") === "true"
      && termNoteButton?.getAttribute("aria-controls") === termNoteForm?.id
      && termNoteForm?.id === "hoshidicts-note-form"
      && termInput?.value === "Projected primary"
      && readingInput?.value === "ぷろじぇくてっど"
      && definitionInput?.value === ""
      && !termInput?.hasAttribute("maxlength")
      && !readingInput?.hasAttribute("maxlength")
      && !definitionInput?.hasAttribute("maxlength"),
    JSON.stringify({
      selectedTabs,
      expanded: termNoteButton?.getAttribute("aria-expanded"),
      term: termInput?.value,
      reading: readingInput?.value,
      definition: definitionInput?.value,
    }),
  );
  if (definitionInput) definitionInput.value = "A retained draft";
  addNoteEntry = () => {
    throw new Error("simulated append failure");
  };
  termNoteForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((done) => window.setTimeout(done, 0));
  const rejectedDraft = {
    hidden: termNoteForm?.hidden,
    definition: definitionInput?.value,
    error: termNoteForm?.querySelector(".gsm-hoshidicts-note-error")?.textContent,
  };
  addNoteEntry = () => {};
  termNoteForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((done) => window.setTimeout(done, 0));
  check(
    "a rejected Note append retains its draft and an accepted retry closes immediately",
    rejectedDraft.hidden === false
      && rejectedDraft.definition === "A retained draft"
      && rejectedDraft.error?.includes("simulated append failure")
      && noteEntries.length === 2
      && noteEntries.every((entry) => JSON.stringify(entry) === JSON.stringify({
        term: "Projected primary",
        reading: "ぷろじぇくてっど",
        definition: "A retained draft",
      }))
      && termNoteForm?.hidden === true
      && shadow.activeElement === termNoteButton
      && noteEditingStates.join(",") === "true,false",
    JSON.stringify({
      activeClass: shadow.activeElement?.className,
      hidden: termNoteForm?.hidden,
      noteEditingStates,
      noteEntries,
      rejectedDraft,
    }),
  );
  termNoteButton?.click();
  const firstEscapeClosed = typeof view.closeNoteForm === "function" && view.closeNoteForm();
  const secondEscapeClosed = typeof view.closeNoteForm === "function" && view.closeNoteForm();
  check(
    "the Note controller consumes Escape only while its form is open",
    firstEscapeClosed === true
      && secondEscapeClosed === false
      && noteEditingStates.join(",") === "true,false,true,false",
    JSON.stringify({ firstEscapeClosed, secondEscapeClosed, noteEditingStates }),
  );

  view.renderResults(imageLookup.results, candidate, {
    generation: imageLookup.generation,
    hidePopupGrammarTags: false,
    resolveMedia(query) {
      mediaRequests.push(query);
      return Promise.resolve(media.dataUrl);
    },
  });
  await new Promise((done) => setTimeout(done, 20));
  check(
    "the structured-content image asked for media with a dictionary and a path",
    mediaRequests.length > 0 &&
      typeof mediaRequests[0].dictionary === "string" &&
      mediaRequests[0].path === "media/kanji.png",
    JSON.stringify(mediaRequests),
  );
  const image = popup.querySelector(".gsm-hoshidicts-glossary-content img");
  check(
    "the resolved data: URL reached the <img>",
    image?.getAttribute("src") === media.dataUrl,
    JSON.stringify(image?.getAttribute("src")?.slice(0, 48)),
  );
  // The class a dictionary's own CSS can target, on the gloss content as in
  // Yomitan. It only fires if the array element, not the array, is inspected.
  const structuredContainer = popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-content");
  check(
    "a structured-content glossary tags its container",
    structuredContainer?.classList.contains("structured-content") === true,
    JSON.stringify(structuredContainer?.className),
  );

  try {
    view.renderKanji(kanji, candidate, { dictionaryPresentation: [], highlightText: kanji.character });
  } catch (error) {
    fail("renderKanji accepts contract-B string onyomi/kunyomi/tags", error.stack ?? error);
    return false;
  }
  pass("renderKanji accepts contract-B string onyomi/kunyomi/tags");
  check(
    "the kanji view renders the readings without splitting them per character",
    popup.textContent.includes(kanji.entries[0].onyomi.split(/[\s,;]/u)[0]),
    JSON.stringify(popup.textContent.slice(0, 200)),
  );
  const kanjiNoteButton = popup.querySelector(".gsm-hoshidicts-note-button");
  const kanjiFormWasLazy = popup.querySelector(".gsm-hoshidicts-note-form") === null;
  kanjiNoteButton?.click();
  const kanjiNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  check(
    "the kanji view uses the same Note form with a glyph-only prefill",
    kanjiFormWasLazy
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-term")?.value === kanji.character
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-reading")?.value === ""
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-definition")?.value === "",
    JSON.stringify({
      term: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-term")?.value,
      reading: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-reading")?.value,
      definition: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-definition")?.value,
    }),
  );

  view.renderResults(lookup.results, candidate);
  popup.querySelector(".gsm-hoshidicts-note-button")?.click();
  const retainedDefinitions = popup.querySelector(".gsm-hoshidicts-definitions");
  const retainedForm = popup.querySelector(".gsm-hoshidicts-note-form");
  const retainedDraft = retainedForm?.querySelector(".gsm-hoshidicts-note-definition");
  if (retainedDraft) retainedDraft.value = "keep this draft";
  let failureRetries = 0;
  view.renderLookupFailure({
    kind: "updating",
    title: "Dictionary update in progress.",
    detail: "Try the lookup again when the update finishes.",
    actionLabel: "Try again",
    onAction() { failureRetries += 1; },
  }, { preserveView: true });
  const failure = popup.querySelector(".gsm-hoshidicts-lookup-failure");
  failure?.querySelector(".gsm-hoshidicts-lookup-failure-action")?.click();
  check(
    "a compact lookup failure retains the rendered definition and Note draft while offering retry",
    failure?.getAttribute("role") === "alert"
      && failure.querySelector(".gsm-hoshidicts-lookup-failure-title")?.textContent === "Dictionary update in progress."
      && popup.querySelector(".gsm-hoshidicts-definitions") === retainedDefinitions
      && popup.querySelector(".gsm-hoshidicts-note-form") === retainedForm
      && retainedDraft?.value === "keep this draft"
      && failureRetries === 1,
    JSON.stringify({
      text: failure?.textContent,
      definitionRetained: popup.querySelector(".gsm-hoshidicts-definitions") === retainedDefinitions,
      formRetained: popup.querySelector(".gsm-hoshidicts-note-form") === retainedForm,
      draft: retainedDraft?.value,
      failureRetries,
    }),
  );
  view.renderLookupFailure({
    kind: "engine",
    title: "Dictionary engine could not start.",
    detail: "Open Settings to check the engine status, then try again.",
  });
  check(
    "a first-lookup failure replaces stale definitions with one actionable state",
    popup.querySelector(".gsm-hoshidicts-definitions") === null
      && popup.querySelector(".gsm-hoshidicts-note-form") === null
      && popup.querySelectorAll(".gsm-hoshidicts-lookup-failure").length === 1,
    JSON.stringify(popup.textContent),
  );

  view.renderNotice("nothing found", candidate);
  check("renderNotice replaces the view", popup.textContent.includes("nothing found"), JSON.stringify(popup.textContent));
  const scrollProperty = Object.getOwnPropertyDescriptor(window.Element.prototype, "scrollTop");
  let scrollWrites = 0;
  Object.defineProperty(view.scrollElement, "scrollTop", {
    configurable: true,
    get() { return scrollProperty.get.call(this); },
    set(value) { scrollWrites += 1; scrollProperty.set.call(this, value); },
  });
  popup.hidden = true;
  view.clear();
  const hiddenCleared = popup.childElementCount === 1 && popup.firstElementChild === view.scrollElement
    && view.scrollElement.childElementCount === 0 && scrollWrites === 0;
  popup.hidden = false;
  const visibleResets = [
    () => view.renderNotice("nothing found", candidate),
    () => view.renderKanji(kanji, candidate),
    () => view.renderResults(lookup.results, candidate),
  ].map((render) => {
    view.scrollElement.scrollTop = 120;
    scrollWrites = 0;
    render();
    return scrollWrites > 0 && view.scrollElement.scrollTop === 0
      && view.scrollElement.parentNode === popup
      && popup.querySelector(".gsm-hoshidicts-result-chrome")?.parentNode === popup;
  });
  check("clear empties hidden popups without scrolling and every visible view resets scroll",
    hiddenCleared && visibleResets.every(Boolean), JSON.stringify({ hiddenCleared, visibleResets }));
  delete view.scrollElement.scrollTop;
  view.clear();
  await imagePreviewStage({ view, popup, shadow, document, window, candidate,
    calculatePopupPosition: HDPopup.calculatePopupPosition,
    result: imageLookup.results[0], mediaUrl: media.dataUrl });
  await imageHoverPreviewModeStage({ HDGlossary, HDPopup, document, window, candidate,
    result: imageLookup.results[0], mediaUrl: media.dataUrl });
  structuredRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await deepStructuredContentStage({ HDGlossary, HDPopup, document });
  externalLinksRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  internalLinksRenderStage({ HDGlossary, document, window });
  await retainedNavigationRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await backViewportRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await deinflectionRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await mediaRenderStage({ HDGlossary, document, window });
  await compactSummaryRenderStage({ HDGlossary, HDPopup, document, window, candidate,
    result: lookup.results[0], mediaUrl: media.dataUrl, summaryGlossaries });
  await imageSourceRenderStage({ HDGlossary, HDPopup, document, window, candidate,
    result: lookup.results[0], mediaUrl: media.dataUrl, summaryGlossaries });
  dom.window.close();
  return true;
}

async function backViewportRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.append(popup);
  const layouts = new Set();
  const layout = () => { for (const callback of layouts) callback(); layouts.clear(); };
  const settle = () => new Promise(resolve => window.setTimeout(resolve, 0));
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    queueMasonry: callback => layouts.add(callback),
    positionPopup() {},
  });
  const results = [result, result];
  const dictionaryPresentation = [{
    title: result.term.glossaries[0].dictionary,
    favorite: true,
  }];
  const render = (values, options = {}) => view.renderResults(values, candidate, {
    dictionaryPresentation,
    ...options,
  });
  const tab = () => popup.querySelectorAll('[role="tab"]')[1].click();
  try {
    render(results, { expandAll: true });
    tab();
    const collapsed = view.captureTermView().expandAll === false;
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    view.scrollElement.scrollTop = 80;
    const snapshot = view.captureTermView();
    check("Back captures the current projected tab's expansion and scroll, not the initial panel",
      collapsed && snapshot.expandAll && snapshot.restoreScrollTop === 80);
    render(results, snapshot);
    layout();
    const beforeFill = view.scrollElement.scrollTop === 0;
    await settle();
    layout();
    const restored = view.scrollElement.scrollTop === 80 && !popup.querySelector(".gsm-hoshidicts-show-more");
    tab();
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    await settle();
    layout();
    check("Back restores scroll after deferred bodies and masonry only once",
      beforeFill && restored && view.scrollElement.scrollTop === 0);
    render(results, snapshot);
    tab();
    await settle();
    layout();
    const newerTab = view.scrollElement.scrollTop === 0;
    render(results, snapshot);
    await settle();
    view.scrollElement.scrollTop = 23;
    layout();
    check("a newer tab or deliberate scroll cancels deferred Back viewport restoration",
      newerTab && view.scrollElement.scrollTop === 23);
    const disclosureResult = { ...result, term: { ...result.term,
      pitches: Array.from({ length: 13 }, (_, index) => ({ ...result.term.pitches[0], dictionary: `IPA ${index}` })),
      glossaries: [{ ...result.term.glossaries[0], glossary: JSON.stringify([{ type: "structured-content", content: {
        tag: "details", content: [{ tag: "summary", content: "Example" }, { tag: "div", content: "Nested definition" }],
      } }]) }],
    } };
    const disclosureResults = [disclosureResult, disclosureResult];
    render(disclosureResults, { expandAll: true });
    await settle();
    // Dictionary cards are not disclosures, and an authored details without
    // `open` starts closed, as in Yomitan.
    const cardsOpen = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")]
      .every(card => card.tagName === "DIV" && card.closest("details") === null);
    const authoredClosed = [...popup.querySelectorAll(".gloss-sc-details")].every(details => !details.open);
    for (const details of popup.querySelectorAll("details")) details.open = true;
    popup.querySelector(".gloss-sc-details").open = false;
    await settle();
    const states = () => [...popup.querySelectorAll("details")].map(details => [details.className, details.open]);
    const beforeDetails = states();
    const prior = view.captureTermView();
    render(disclosureResults, prior);
    await settle();
    layout();
    check("Back restores open and closed structured details and complete lazy IPA before layout",
      cardsOpen && authoredClosed
        && beforeDetails.some(([, open]) => !open) && beforeDetails.some(([, open]) => open)
        && JSON.stringify(states()) === JSON.stringify(beforeDetails)
        && popup.querySelectorAll(".gsm-hoshidicts-tag-ipa").length === 26,
      JSON.stringify({ cardsOpen, authoredClosed, beforeDetails, states: states(),
        ipa: popup.querySelectorAll(".gsm-hoshidicts-tag-ipa").length }));
    const changed = disclosureResults.map(value => ({ ...value, term: { ...value.term,
      glossaries: [{ ...value.term.glossaries[0], glossary: '["Changed definition"]' }],
    } }));
    render(changed, prior);
    await settle();
    layout();
    check("Back does not apply saved disclosures to changed dictionary content",
      !popup.querySelector(".gloss-sc-details")
        && !popup.querySelector(".gsm-hoshidicts-ipa-overflow").open);
    let scrollReads = 0;
    let retainedScroll = 85;
    Object.defineProperty(view.scrollElement, "scrollTop", { configurable: true,
      get() { scrollReads++; return retainedScroll; },
      set(value) { retainedScroll = value; },
    });
    render(results, snapshot);
    const backAvoidsEarlyLayout = scrollReads === 0 && retainedScroll === 0;
    retainedScroll = 85;
    scrollReads = 0;
    render(results, { preserveViewControls: true });
    check("Back and ordinary retained renders do not force scroll layout while their replacement panel is empty",
      backAvoidsEarlyLayout && scrollReads === 0 && retainedScroll === 85);
    delete view.scrollElement.scrollTop;
  } finally { view.destroy(); popup.remove(); }
}

async function compactSummaryRenderStage({ HDGlossary, HDPopup, document, window, candidate, result, mediaUrl, summaryGlossaries }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const projected = { ...result, term: { ...result.term, glossaries: summaryGlossaries } };
  const original = JSON.stringify(projected);
  const mediaRequests = [];
  let finishMedia;
  const pendingMedia = new Promise(resolve => { finishMedia = resolve; });
  let positions = 0;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList, positionPopup() { positions += 1; },
  });
  const context = { generation: 23, dictionaryPresentation: [], dictionaryTabGroups: [],
    resolveMedia(query) { mediaRequests.push(query); return pendingMedia; },
    showCompactDefinitionSummary: false, compactDefinitionSummaryCount: 2,
    compactDefinitionSummaryDictionary: "Illustrated" };
  try {
    view.renderResults([projected], candidate, context);
    const absent = popup.querySelector(".gsm-hoshidicts-compact-definition-summary") === null && mediaRequests.length === 1;
    const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const bodies = cards.map(card => card.textContent);
    const expression = popup.querySelector(".gsm-hoshidicts-expression");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const note = popup.querySelector(".gsm-hoshidicts-note-form");
    const input = note.querySelector(".gsm-hoshidicts-note-definition");
    input.value = "retained draft";
    input.focus();
    input.setSelectionRange(2, 6);
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true });
    const summary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const image = summary?.querySelector("img");
    const live = summary?.dataset.hoshidictsDictionary === "Illustrated"
      && JSON.stringify([...summary.querySelectorAll("li")].map(node => node.textContent)) === JSON.stringify(["first", "second"])
      && image && mediaRequests.length === 2 && mediaRequests[1].generation === 23
      && mediaRequests[1].dictionary === "Illustrated" && mediaRequests[1].isCurrent()
      && image.closest(".gloss-image-link").dataset.collapsed === "false"
      && popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link").dataset.collapsed === "true";
    const retained = popup.querySelector(".gsm-hoshidicts-expression") === expression
      && popup.querySelector(".gsm-hoshidicts-note-form") === note && document.activeElement === input
      && input.value === "retained draft" && input.selectionStart === 2 && input.selectionEnd === 6
      && cards.every((card, index) => card.isConnected && card.textContent === bodies[index]);
    view.updateDictionaryPresentation({ dictionaryPresentation: [], dictionaryTabGroups: [] });
    const unchangedSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary") === summary
      && mediaRequests.length === 2;
    view.updateDictionaryPresentation(context);
    const obsolete = image && !image.isConnected && mediaRequests[1].isCurrent() === false;
    await new Promise(done => window.setTimeout(done, 40));
    const beforeReply = positions;
    finishMedia(mediaUrl);
    await new Promise(done => window.setTimeout(done, 0));
    const oldImageUntouched = !image?.getAttribute("src");
    // The full-card consumer remains current; only its actual load can position.
    const noLatePosition = positions === beforeReply;
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "Absent", compactDefinitionSummaryCount: 1 });
    const fallback = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const fallbackText = fallback?.textContent;
    const fullImageLink = popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link");
    fullImageLink.dispatchEvent(new window.Event("mouseenter"));
    const fullPreview = popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "Absent", compactDefinitionSummaryCount: 2 });
    const previewKept = fullPreview?.isConnected === true;
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true });
    await new Promise(done => window.setTimeout(done, 0));
    const focusedThumbnail = popup.querySelector(".gsm-hoshidicts-compact-definition-summary .gloss-image-link");
    focusedThumbnail.focus();
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3 });
    const summaryFocusKept = document.activeElement === focusedThumbnail && focusedThumbnail.isConnected
      && popup.querySelectorAll(".gsm-hoshidicts-compact-definition-summary li").length === 2;
    focusedThumbnail.blur();
    await new Promise(done => window.setTimeout(done, 0));
    const summaryFlushed = popup.querySelectorAll(".gsm-hoshidicts-compact-definition-summary li").length === 3;
    const failedThumbnails = [];
    for (const failure of ["missing", "rejected", "decode"]) {
      view.renderResults([projected], candidate, { ...context, showCompactDefinitionSummary: true,
        resolveMedia() {
          if (failure === "rejected") return Promise.reject(new Error("missing dictionary image"));
          return failure === "missing" ? null : mediaUrl;
        },
      });
      await new Promise(done => window.setTimeout(done, 0));
      if (failure === "decode") {
        for (const failedImage of popup.querySelectorAll("img")) {
          failedImage.dispatchEvent(new window.Event("error"));
        }
      }
      const textSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      const fullCardError = popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link");
      failedThumbnails.push(textSummary?.querySelector(".gsm-hoshidicts-compact-definition-image") === null
        && JSON.stringify([...textSummary.querySelectorAll("li")].map(node => node.textContent)) === JSON.stringify(["first", "second"])
        && fullCardError?.dataset.imageLoadState === "load-error"
        && fullCardError.textContent.includes("Image failed to load"));
    }
    check("live compact summaries preserve Note and cards while retiring only their own media and falling back within projected results",
      absent && live && retained && unchangedSummary && obsolete && oldImageUntouched && noLatePosition
        && fallbackText === "plain first" && fallback.dataset.hoshidictsDictionary === "Plain" && previewKept
        && summaryFocusKept && summaryFlushed && failedThumbnails.every(Boolean)
        && JSON.stringify(projected) === original,
      JSON.stringify({ absent, live: Boolean(live), retained, unchangedSummary, obsolete, oldImageUntouched, noLatePosition,
        fallback: fallback?.outerHTML, previewKept, summaryFocusKept, summaryFlushed, failedThumbnails,
        mediaRequests: mediaRequests.map(({ isCurrent, ...query }) => query) }));
  } finally {
    finishMedia(mediaUrl);
    view.destroy();
    popup.remove();
  }
}

async function imageSourceRenderStage({ HDGlossary, HDPopup, document, window, candidate, result, mediaUrl, summaryGlossaries }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const projected = { ...result, term: { ...result.term, glossaries: summaryGlossaries } };
  const requests = [];
  let sources = null;
  let current = true;
  let canUpdate = true;
  let admissions = 0;
  let fills = 0;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary(...args) { fills += 1; return HDGlossary.appendTextOnlyGlossary(...args); },
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
    canUpdateCompactSummary() { admissions += 1; return canUpdate; },
  });
  const context = { generation: 23, dictionaryPresentation: [{ title: "Pictures", displayName: "Picture book" }],
    dictionaryTabGroups: [], isCurrentRequest: () => current, isCurrentView: () => true,
    showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2,
    compactDefinitionSummaryDictionary: "Illustrated", popupImageSources: sources,
    resolveMedia(query) {
      const supplier = sources?.[0] || query.dictionary;
      return new Promise((resolve, reject) => requests.push({ query, supplier, resolve, reject }));
    },
  };
  const tick = () => new Promise(done => window.setTimeout(done, 0));
  const route = (next, extra = {}) => {
    sources = next;
    Object.assign(context, { popupImageSources: sources }, extra);
    view.updateDictionaryPresentation({ ...context });
  };
  const settle = (pending, url = mediaUrl) => {
    for (const request of pending) {
      request.query.onResolvedSource?.(request.supplier);
      request.resolve(url);
    }
  };
  try {
    view.renderResults([projected], candidate, context);
    const automatic = requests.slice();
    const summary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const items = summary.querySelector("ul");
    const images = [...popup.querySelectorAll("img")];
    const links = images.map(image => image.closest(".gloss-image-link"));
    const listeners = [];
    const addImageListener = images[1].addEventListener;
    images[1].addEventListener = function (type, listener, options) {
      listeners.push({ type, listener });
      return addImageListener.call(this, type, listener, options);
    };
    const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const originalFills = fills;
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    form.elements.definition.value = "keep image-source draft";
    form.elements.definition.focus();
    form.elements.definition.setSelectionRange(2, 7);
    route(["Pictures"]);
    const replacement = requests.slice(automatic.length);
    const beforeAlias = requests.length;
    route(sources, { dictionaryPresentation: [{ title: "Pictures", displayName: "Renamed pictures" }] });
    settle(replacement);
    await tick();
    const suppliers = [...popup.querySelectorAll(".gloss-image-source")];
    const currentLoaded = replacement.length === 2 && replacement.every(({ query }) => query.isCurrent())
      && images.every(image => image.src === mediaUrl && !image.hidden)
      && suppliers.length === 2 && suppliers.every(label => label.textContent === "Image: Renamed pictures"
        && label.dataset.dictionary === "Pictures" && label.title === "Pictures")
      && !summary.querySelector(".gsm-hoshidicts-compact-definition-image .gloss-image-source");
    settle(automatic, "data:image/png;base64,b2xk");
    await tick();
    check("live image-source changes retain mounted cards and Note selection while rejecting old Automatic replies and relabelling the actual supplier",
      currentLoaded && requests.length === beforeAlias && automatic.every(({ query }) => !query.isCurrent())
        && images.every((image, index) => image.isConnected && image.src === mediaUrl && image.closest("a") === links[index])
        && cards.every(card => card.isConnected) && fills === originalFills && summary.querySelector("ul") === items
        && popup.querySelector("form") === form && document.activeElement === form.elements.definition
        && form.elements.definition.value === "keep image-source draft"
        && form.elements.definition.selectionStart === 2 && form.elements.definition.selectionEnd === 7,
      JSON.stringify({ currentLoaded, requests: requests.length, beforeAlias, fills, originalFills,
        suppliers: suppliers.map(label => label.outerHTML), replacement: replacement.length }));

    const oldListeners = listeners.slice();
    links[1].focus();
    const previewOpened = Boolean(popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview"));
    const beforeFocusRoute = requests.length;
    route(["Focused supplier"]);
    for (const { listener } of oldListeners) listener();
    const pendingFocused = document.activeElement === links[1] && links[1].getAttribute("tabindex") === "0"
      && !links[1].hasAttribute("href") && links[1].dataset.imageLoadState === "not-loaded"
      && !popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    view.hideImagePreview();
    settle(requests.slice(beforeFocusRoute));
    await tick();
    images[1].dispatchEvent(new window.Event("load"));
    const dismissedKept = !popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    for (const { listener } of oldListeners) listener();
    check("image route refresh retains keyboard focus and ignores retired load/error callbacks without reviving a dismissed preview",
      previewOpened && pendingFocused && dismissedKept && document.activeElement === links[1]
        && !images[1].hidden && images[1].src === mediaUrl && links[1].dataset.imageLoadState === "loaded",
      JSON.stringify({ previewOpened, pendingFocused, dismissedKept }));
    delete images[1].addEventListener;
    const beforeFocusedFailure = requests.length;
    route(["Missing focused source"]);
    settle(requests.slice(beforeFocusedFailure), null);
    await tick();
    const failedStillFocused = document.activeElement === links[1] && links[1].dataset.imageLoadState === "load-error";
    links[1].blur();
    check("a failed refreshed image drops its temporary tab stop when keyboard focus leaves",
      failedStillFocused && !links[1].hasAttribute("href") && !links[1].hasAttribute("tabindex"));
    form.elements.definition.focus();

    const beforeAutomatic = requests.length;
    route(null);
    settle(requests.slice(beforeAutomatic), null);
    await tick();
    const failed = summary.querySelector(".gsm-hoshidicts-compact-definition-image") === null
      && !popup.querySelector(".gloss-image-source") && links[1].dataset.imageLoadState === "load-error";
    const beforeRecovery = requests.length;
    route(["Pictures"]);
    settle(requests.slice(beforeRecovery));
    await tick();
    check("a failed compact thumbnail recovers under a new image source without reparsing or replacing its summary, full image or Note draft",
      failed && requests.length === beforeRecovery + 2 && images.every(image => image.isConnected && !image.hidden && image.src === mediaUrl)
        && summary.querySelectorAll(".gsm-hoshidicts-compact-definition-image").length === 1
        && summary.querySelector("ul") === items && fills === originalFills
        && popup.querySelector("form") === form && !form.hidden && document.activeElement === form.elements.definition,
      JSON.stringify({ failed, beforeRecovery, requests: requests.length, summary: summary.outerHTML }));

    // A retained parent can accept aliases, but cannot restart asynchronous work.
    current = false;
    const beforeStale = requests.length;
    route(sources, { dictionaryPresentation: [{ title: "Pictures", displayName: "Retained alias" }] });
    const staleLabels = [...popup.querySelectorAll(".gloss-image-source")].every(label => label.textContent === "Image: Retained alias");
    route(["Other"]);
    check("retained image labels may refresh without admitting media for an obsolete request",
      staleLabels && requests.length === beforeStale && images.every(image => image.src === mediaUrl));
    current = true;
    const beforeRetry = requests.length;
    route(["Retry"]);
    const retired = requests.slice(beforeRetry);
    view.clear();
    settle(retired);
    await tick();
    check("clearing the projection retires all image refresh handles and their pending completions",
      retired.length === 2 && retired.every(({ query }) => !query.isCurrent())
        && !view.scrollElement.hasChildNodes() && popup.childElementCount === 1
        && images.every(image => !image.isConnected));

    sources = null;
    const group = { id: "reading", name: "Reading", dictionaries: ["Illustrated", "Plain"] };
    Object.assign(context, { popupImageSources: null, dictionaryTabGroups: [group] });
    view.renderResults([projected], candidate, { ...context, selectedDictionaryTab: { groupId: group.id } });
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const protectedCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const beforeProtected = requests.length;
    route(["Pictures"], { dictionaryTabGroups: [{ ...group, dictionaries: ["Plain"] }] });
    const protectedRequests = requests.slice(beforeProtected);
    settle(protectedRequests);
    await tick();
    const beforeOrphan = { requests: requests.length, admissions };
    canUpdate = false;
    route(null);
    check("image-source admission compares the applied route while protected tab membership still awaits projection",
      protectedRequests.length === 2 && protectedCards.every(card => card.isConnected)
        && admissions === beforeOrphan.admissions + 1 && requests.length === beforeOrphan.requests,
      JSON.stringify({ protectedRequests: protectedRequests.length, beforeOrphan, requests: requests.length, admissions }));
    canUpdate = true;
    route(["Pictures"], { dictionaryPresentation: [{ title: "Pictures", displayName: "Latest pictures" }],
      showPitchAccentBadge: false, showPitchAccentFurigana: false, hidePopupGrammarTags: true,
      showFrequencyDictionaryNames: false });
    const beforeTab = requests.length;
    popup.querySelector('[role="tab"]').click();
    settle(requests.slice(beforeTab));
    await tick();
    const projectedLabels = [...popup.querySelectorAll(".gloss-image-source")];
    const latestLabels = projectedLabels.length === 2
      && projectedLabels.every(label => label.textContent === "Image: Latest pictures");
    const beforeFlush = requests.length;
    view.flushDictionaryPresentation();
    check("local tab projection retains the latest image route and aliases without reloading again on deferred presentation flush",
      latestLabels && beforeFlush === beforeTab + 2 && requests.length === beforeFlush
        && !popup.querySelector(".gsm-hoshidicts-frequency-source, .gsm-hoshidicts-tag-pitch, .gsm-hoshidicts-pitch-ruby, .gsm-hoshidicts-primary-grammar")
        && Boolean(popup.querySelector(".gsm-hoshidicts-tag-ipa")),
      JSON.stringify({ latestLabels, beforeTab, beforeFlush, requests: requests.length }));

    const replacementProjections = [];
    for (const title of ["Illustrated", "Plain"]) {
      sources = null;
      Object.assign(context, { popupImageSources: sources, dictionaryTabGroups: [group] });
      const beforeInitial = requests.length;
      view.renderResults([projected], candidate, { ...context, expandAll: true,
        selectedDictionaryTab: { groupId: group.id } });
      settle(requests.slice(beforeInitial));
      await tick();
      const oldCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
      const beforeReplacement = requests.length;
      route(["Pictures"], { dictionaryTabGroups: [{ ...group, dictionaries: [title] }] });
      const pending = requests.slice(beforeReplacement);
      const expectedImages = title === "Illustrated" ? 2 : 0;
      replacementProjections.push(pending.length === expectedImages
        && pending.every(({ query, supplier }) => query.isCurrent() && supplier === "Pictures")
        && oldCards.every(card => !card.isConnected));
      settle(pending);
      await tick();
      replacementProjections.push(popup.querySelectorAll("img").length === expectedImages);
    }
    check("group membership and image-route changes load only the replacement projection's images",
      replacementProjections.every(Boolean), JSON.stringify(replacementProjections));

    const replacementSummaries = [];
    for (const enabled of [true, false]) {
      sources = null;
      Object.assign(context, { popupImageSources: sources, dictionaryTabGroups: [],
        showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2 });
      const beforeInitial = requests.length;
      view.renderResults([projected], candidate, context);
      settle(requests.slice(beforeInitial));
      await tick();
      const oldSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      const oldCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
      const beforeReplacement = requests.length;
      route(["Pictures"], { showCompactDefinitionSummary: enabled, compactDefinitionSummaryCount: 3 });
      const pending = requests.slice(beforeReplacement);
      const expectedImages = enabled ? 2 : 1;
      replacementSummaries.push(pending.length === expectedImages
        && pending.every(({ query, supplier }) => query.isCurrent() && supplier === "Pictures")
        && !oldSummary.isConnected && oldCards.every(card => card.isConnected));
      settle(pending);
      await tick();
      replacementSummaries.push(popup.querySelectorAll("img").length === expectedImages);
    }
    check("combined summary and image-route changes load only retained or replacement images",
      replacementSummaries.every(Boolean), JSON.stringify(replacementSummaries));
  } finally {
    settle(requests);
    view.destroy();
    popup.remove();
  }
}

function lookupCountsRenderStage({ HDGlossary, HDPopup, document, window, candidate, results }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let renders = 0;
  let showCounts = false;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {}, onKanjiClick() {}, onAddCustomEntry() {},
    // The owner decides visibility; the renderer only provides the slot.
    onResultsRendered({ lookupStats }) {
      renders += 1;
      if (lookupStats) view.setLookupStats(lookupStats, showCounts ? { lookupCount: 3 } : null);
    },
  });
  const line = () => popup.querySelector(".gsm-hoshidicts-lookup-stats");
  try {
    const dictionary = results[0].term.glossaries[0].dictionary;
    view.renderResults(results, candidate, {
      dictionaryPresentation: [{ title: dictionary, favorite: true }],
    });
    const slotHidden = line() !== null && line().hidden;
    showCounts = true;
    if (line()) view.setLookupStats(line(), { lookupCount: 3 });
    const painted = line()?.textContent === "Looked up 3 times" && !line().hidden && renders === 1;
    popup.querySelector('.gsm-hoshidicts-tab[data-dictionary]').click();
    const projected = !line();
    popup.querySelector('.gsm-hoshidicts-tab').click();
    const restored = line()?.textContent === "Looked up 3 times" && !line().hidden;
    check("the lookup count slot renders hidden on All only and its owner paints it without rerendering",
      slotHidden && painted && projected && restored,
      JSON.stringify({ slotHidden, painted, projected, restored, renders }));
  } finally { view.destroy(); popup.remove(); }
}

// jsdom has no layout: entries and cards sit at fixed content offsets and move
// with the stubbed scroller, which starts 100px down the page and is 200px tall.
// A later entry's own 20px header opens it; navigation lands just below it.
function keybindEntryRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const expanded = [];
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {}, onKanjiClick() {}, onAddCustomEntry() {},
    onResultsExpanded: ({ audioButtons }) => {
      expanded.push(audioButtons.length);
      layout();
    },
  });
  const scroller = view.scrollElement;
  let scrollTop = 0;
  const scrolls = [];
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } });
  scroller.scrollTo = ({ top, behavior }) => { scrolls.push({ top, behavior }); scrollTop = top; };
  const place = (node, offset, height) => Object.defineProperty(node, "getBoundingClientRect", { configurable: true,
    value: () => ({ top: 100 + offset - scrollTop, bottom: 100 + offset + height - scrollTop, height }) });
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300 });
  const glossary = result.term.glossaries[0];
  const entry = (expression, dictionaries) => ({ ...result, matched: expression,
    term: { ...result.term, expression, glossaries: dictionaries.map(dictionary => ({ ...glossary, dictionary })) } });
  const layout = () => [...scroller.querySelectorAll(".gsm-hoshidicts-entry")].forEach((node, index) => {
    place(node, index * 300, 280);
    const header = node.querySelector(":scope > .gsm-hoshidicts-entry-header");
    if (header) place(header, index * 300, 20);
    [...node.querySelectorAll(".gsm-hoshidicts-glossary-card")].forEach((card, cardIndex) => place(card, index * 300 + 20 + cardIndex * 90, 80));
  });
  try {
    view.renderResults([entry("一", ["Alpha", "Beta"]), entry("二", ["Beta"]), entry("三", ["Alpha"])], candidate, {});
    layout();
    const initial = view.currentEntryIndex() === 0 && scroller.querySelectorAll(".gsm-hoshidicts-entry").length === 1;
    const moved = view.focusEntry({ offset: 1 });
    layout();
    const expandedToNext = moved && expanded.length === 1 && view.currentEntryIndex() === 1 && scrolls.at(-1).top === 320
      && scrolls.at(-1).behavior === "instant";
    const clamped = view.focusEntry({ offset: 5 }) && view.currentEntryIndex() === 2 && scrolls.at(-1).top === 620;
    const first = view.focusEntry("first") && view.currentEntryIndex() === 0 && scrolls.at(-1).top === 0;
    scrollTop = 30; // Beta is now the most visible card of the first entry.
    const nextDictionary = view.focusEntry({ dictionary: 1 }) && view.currentEntryIndex() === 2 && scrolls.at(-1).top === 620;
    const previousDictionary = view.focusEntry({ dictionary: -1 }) && view.currentEntryIndex() === 1 && scrolls.at(-1).top === 320;
    scroller.querySelector(".gsm-hoshidicts-entry .gsm-hoshidicts-glossary-card").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const clicked = view.currentEntryIndex() === 0;
    const last = view.focusEntry("last") && view.currentEntryIndex() === 2;
    view.renderResults([entry("四", ["Alpha"])], candidate, {});
    const reset = view.currentEntryIndex() === 0 && view.focusEntry({ dictionary: 1 }) === false;
    view.renderNotice("No results", candidate);
    const empty = view.focusEntry("last") === false;
    check("keybind entry navigation expands Show more, clamps, follows clicks and moves instantly between dictionary cards",
      initial && expandedToNext && clamped && first && nextDictionary && previousDictionary && clicked && last && reset && empty
        && scrolls.every(scroll => scroll.behavior === "instant"),
      JSON.stringify({ initial, expandedToNext, clamped, first, nextDictionary, previousDictionary, clicked, last, reset, empty,
        expanded, scrolls, current: view.currentEntryIndex() }));
  } finally { view.destroy(); popup.remove(); }
}

// Issue #488: the pinned header shows the result being read. Three 明日 results
// sit 300px apart in the same stubbed layout; later results' own 20px headers
// open their articles, and the reader starts 100px down a 200px scroller.
async function dynamicHeadwordRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const bound = [];
  const layouts = new Set();
  let editing = false;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {}, onKanjiClick() {}, onAddCustomEntry() {},
    onNoteEditingChange: value => { editing = value; },
    // As content.js: a Note draft holds the view.
    canProjectDictionaryPresentation: () => !editing,
    onResultsRendered: rendered => bound.push(rendered),
    onResultsExpanded: rendered => bound.push(rendered),
    queueMasonry: callback => layouts.add(callback),
    customButtons: [{ id: "sentence", type: "anki", label: "Sentence card", templateId: "sentence" }],
  });
  const scroller = view.scrollElement;
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } });
  scroller.scrollTo = ({ top }) => { scrollTop = top; };
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 });
  const place = (node, offset, height) => Object.defineProperty(node, "getBoundingClientRect", { configurable: true,
    value: () => ({ top: 100 + offset - scrollTop, bottom: 100 + offset + height - scrollTop, height }) });
  const articles = () => [...scroller.querySelectorAll(".gsm-hoshidicts-entry")];
  const layout = () => articles().forEach((node, index) => {
    place(node, index * 300, 280);
    const header = node.querySelector(":scope > .gsm-hoshidicts-entry-header");
    if (header) place(header, index * 300, 20);
  });
  const scrollTo = top => { scrollTop = top; scroller.dispatchEvent(new window.Event("scroll")); };
  const reading = (expression, value, definition) => ({ ...result, matched: "明日", deinflected: "明日", trace: [],
    term: { ...result.term, expression, reading: value, rules: "", furigana: null,
      glossaries: [{ ...result.term.glossaries[0], glossary: JSON.stringify([definition]) }] } });
  const results = [reading("明日", "あした", "tomorrow"), reading("明日", "あす", "tomorrow (formal)"),
    reading("明日", "みょうにち", "tomorrow (business)")];
  // あす alone carries a trace, so its headword holds the only later disclosure.
  results[1] = { ...results[1], matched: "明日は", deinflected: "明日", trace: [{ name: "particle", description: "" }] };
  const header = () => popup.querySelector(".gsm-hoshidicts-primary-header");
  const visibleReading = () => [...header().querySelectorAll(":scope > .gsm-hoshidicts-headword")]
    .filter(node => !node.hidden).map(node => node.querySelector("rt")?.textContent ?? "").join("|");
  try {
    view.renderResults(results, candidate, { expandAll: true, definitionBlurState: "blurred", lookupStatsSlot: true });
    layout();
    const [rendered] = bound;
    const toolbar = header().querySelector(":scope > .gsm-hoshidicts-entry-actions");
    const asuHeader = articles()[1].querySelector(":scope > .gsm-hoshidicts-entry-header");
    const asuHeadword = asuHeader.querySelector(".gsm-hoshidicts-headword");
    const asuRow = rendered.miningActions[1].actions;
    const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const stats = popup.querySelector(".gsm-hoshidicts-lookup-stats");
    const firstAudio = rendered.audioButtons[0].button;
    const initial = visibleReading() === "あした" && view.currentEntryIndex() === 0
      && rendered.miningActions[0].customActions === toolbar && rendered.miningActions[1].customActions === null;

    // あした's header button has focus when あす's own header scrolls away.
    firstAudio.focus();
    scrollTo(330);
    const shown = visibleReading() === "あす" && header().contains(asuHeadword) && toolbar.contains(asuRow)
      && toolbar.contains(rendered.audioButtons[1].button) && asuHeader.style.height === "20px"
      && asuHeader.childElementCount === 0 && header().dataset.shownResult === "1";
    const followed = view.currentEntryIndex() === 1 && rendered.miningActions[1].customActions === toolbar
      && rendered.miningActions[0].customActions === null && bound.length === 2 && bound[1].miningActions === rendered.miningActions;
    const focusMoved = popup.ownerDocument.activeElement === rendered.audioButtons[1].button;
    const retained = cards.every((card, index) => popup.querySelectorAll(".gsm-hoshidicts-glossary-card")[index] === card)
      && popup.querySelector(".gsm-hoshidicts-lookup-stats") === stats && popup.dataset.definitionBlurState === "blurred";

    // The Note form opens with the shown result and holds the header.
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector(".gsm-hoshidicts-note-form");
    const prefilled = form.querySelector(".gsm-hoshidicts-note-reading").value === "あす";
    form.querySelector(".gsm-hoshidicts-note-definition").value = "draft";
    scrollTo(640);
    const held = visibleReading() === "あす" && form.querySelector(".gsm-hoshidicts-note-definition").value === "draft";
    form.querySelector(".gsm-hoshidicts-note-cancel").click();
    view.flushDictionaryPresentation();
    const caughtUp = visibleReading() === "みょうにち" && asuHeader.contains(asuHeadword) && asuHeader.style.height === ""
      && view.currentEntryIndex() === 2;

    // Back keeps disclosures in fresh order while みょうにち is shown, then the
    // restored scroll shows it again.
    asuHeadword.querySelector(".gsm-hoshidicts-deinflection").open = true;
    const prior = view.captureTermView();
    view.renderResults(results, candidate, { ...prior, expandAll: true });
    const restarted = visibleReading() === "あした" && !header().dataset.shownResult;
    await new Promise(done => window.setTimeout(done, 0));
    const restoredOpen = articles()[1].querySelector(".gsm-hoshidicts-deinflection")?.open === true;
    layout();
    for (const callback of layouts) callback();
    layouts.clear();
    const restoredShown = scrollTop === 640 && visibleReading() === "みょうにち";

    // Navigation shows its target; one that cannot reach the top stays current.
    scrollTo(0);
    const next = bound.at(-1);
    view.focusEntry({ offset: 1 });
    const navigated = scrollTop === 320 && visibleReading() === "あす" && view.currentEntryIndex() === 1
      && next.miningActions[1].customActions === header().querySelector(":scope > .gsm-hoshidicts-entry-actions");
    scroller.scrollTo = ({ top }) => { scrollTop = Math.min(top, 400); };
    view.focusEntry("last");
    const unreachable = scrollTop === 400 && visibleReading() === "あす" && view.currentEntryIndex() === 2;
    scrollTo(0);
    const back = visibleReading() === "あした" && view.currentEntryIndex() === 0 && !header().dataset.shownResult
      && articles()[1].querySelector(":scope > .gsm-hoshidicts-entry-header").style.height === "";
    check("the pinned header moves the shown result's own headword and actions in, holds for a Note draft and restores them",
      initial && shown && followed && focusMoved && retained && prefilled && held && caughtUp && restarted
        && restoredOpen && restoredShown && navigated && unreachable && back,
      JSON.stringify({ initial, shown, followed, focusMoved, retained, prefilled, held, caughtUp, restarted,
        restoredOpen, restoredShown, navigated, unreachable, back, reading: visibleReading(), current: view.currentEntryIndex() }));
  } finally { view.destroy(); popup.remove(); }
}

async function metadataRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let fills = 0;
  let rubyFills = 0;
  let layouts = 0;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby(...args) { rubyFills += 1; return HDGlossary.appendExpressionRuby(...args); },
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary(...args) { fills += 1; return HDGlossary.appendTextOnlyGlossary(...args); },
    parseTagList: HDGlossary.parseTagList, positionPopup() {}, onKanjiClick() {}, onAddCustomEntry() {},
    queueMasonry() { layouts += 1; },
  });
  const results = [{ ...result, term: { ...result.term, pitches: [
    ...result.term.pitches, { dictionary: "IPA only", pitches: [], transcriptions: ["ipa-only", "second transcription"] },
  ] } }];
  const original = JSON.stringify(results);
  const context = { hidePopupGrammarTags: false, showPitchAccentBadge: true,
    showPitchAccentFurigana: true, showFrequencyDictionaryNames: true, averageFrequency: false,
    pitchAccentFuriganaDictionary: "", dictionaryPresentation: [{ title: "IPA only", displayName: "Phonetics" }],
  };
  try {
    view.renderResults(results, candidate, context);
    const initialIpa = [...popup.querySelectorAll(".gsm-hoshidicts-tag-ipa")];
    const card = popup.querySelector(".gsm-hoshidicts-glossary-card");
    const body = popup.querySelector(".gsm-hoshidicts-glossary-content");
    const definitionTag = popup.querySelector(".gsm-hoshidicts-definition-tags");
    const disclosure = popup.querySelector(".gsm-hoshidicts-deinflection");
    disclosure.open = true;
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    form.elements.definition.value = "keep this draft";
    form.elements.definition.focus();
    form.elements.definition.setSelectionRange(2, 5);
    const initialFills = fills;
    const hidden = { ...context, showPitchAccentFurigana: false, showPitchAccentBadge: false,
      hidePopupGrammarTags: true, showFrequencyDictionaryNames: false };
    view.updateDictionaryPresentation(hidden);
    const independent = !popup.querySelector(".gsm-hoshidicts-tag-pitch")
      && !popup.querySelector(".gsm-hoshidicts-primary-grammar")
      && !popup.querySelector(".gsm-hoshidicts-frequency-source")
      && popup.querySelector('.gsm-hoshidicts-tag-ipa[data-dictionary="IPA only"]')?.title.includes("Phonetics (IPA only)")
      && !popup.querySelector(".gsm-hoshidicts-ipa-source, .gsm-hoshidicts-pitch-source")
      && popup.textContent.includes("ipa-only · second transcription")
      && definitionTag.isConnected;
    const preserved = popup.querySelector("form") === form && document.activeElement === form.elements.definition
      && form.elements.definition.selectionStart === 2 && form.elements.definition.selectionEnd === 5
      && form.elements.definition.value === "keep this draft" && card.isConnected
      && body.isConnected && disclosure.isConnected && disclosure.open && fills === initialFills;
    const frequency = popup.querySelector(".gsm-hoshidicts-frequency-value");
    const ipa = popup.querySelector(".gsm-hoshidicts-tag-ipa");
    const appliedRuby = rubyFills;
    view.updateDictionaryPresentation(hidden);
    const noop = rubyFills === appliedRuby && popup.querySelector(".gsm-hoshidicts-frequency-value") === frequency
      && popup.querySelector(".gsm-hoshidicts-tag-ipa") === ipa;
    view.closeNoteForm();
    const kanji = popup.querySelector(".gsm-hoshidicts-expression .gsm-hoshidicts-kanji-link");
    kanji.focus();
    view.updateDictionaryPresentation(context);
    const deferred = kanji.isConnected && document.activeElement === kanji && rubyFills === appliedRuby
      && Boolean(popup.querySelector(".gsm-hoshidicts-tag-pitch"));
    kanji.blur();
    await new Promise(resolve => setTimeout(resolve, 0));
    const applied = rubyFills === appliedRuby + 1 && !kanji.isConnected;
    view.flushDictionaryPresentation();
    check("live metadata keeps IPA independent and preserves Note cards and focused ruby without redundant work",
      initialIpa.some(tag => tag.textContent.includes("ipa-only · second transcription"))
        && independent && preserved && noop && deferred && applied && rubyFills === appliedRuby + 1
        && JSON.stringify(results) === original,
      JSON.stringify({ initialIpa: initialIpa.map(tag => tag.textContent), independent, preserved, noop,
        deferred, applied, fills, initialFills, rubyFills, appliedRuby }));
    const many = { ...result, term: { ...result.term, pitches: Array.from({ length: 13 }, (_, index) => ({
      dictionary: `Phonetic ${index}`, pitches: [], transcriptions: [`transcription ${index}`, `second ${index}`],
    })) } };
    view.renderResults([many], candidate, context);
    const overflow = popup.querySelector(".gsm-hoshidicts-ipa-overflow");
    const lazy = overflow && !overflow.open && !popup.querySelector(".gsm-hoshidicts-tag-ipa");
    view.updateDictionaryPresentation({ ...context, dictionaryPresentation: [{ title: "Phonetic 12", displayName: "Latest alias" }] });
    overflow.open = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    const tags = [...popup.querySelectorAll(".gsm-hoshidicts-tag-ipa")];
    const beforeClose = layouts;
    overflow.open = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterClose = layouts;
    overflow.open = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    check("IPA overflow is lazy and reveals every ordered transcription with current aliases only once",
      lazy && tags.length === 13 && tags.every((tag, index) => tag.textContent.includes(`transcription ${index} · second ${index}`))
        && tags[12].textContent === "transcription 12 · second 12"
        && tags[12].title === "Latest alias (Phonetic 12): transcription 12 · second 12"
        && tags[12].getAttribute("aria-label") === tags[12].title
        && afterClose > beforeClose && layouts > afterClose
        && tags.every((tag, index) => popup.querySelectorAll(".gsm-hoshidicts-tag-ipa")[index] === tag));
  } finally { view.destroy(); popup.remove(); }
}

async function retainedNavigationRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let current = true;
  let displayed = true;
  let links = 0;
  let fills = 0;
  let replays = 0;
  let selected = null;
  let replayIntent = null;
  let appends = 0;
  const linkPredicates = [];
  const originalResizeObserver = window.ResizeObserver;
  const observedTargets = new Set();
  const observations = [];
  let observerDisconnects = 0;
  // Track the renderer's observation ownership, not native layout or heap size.
  window.ResizeObserver = class {
    observe(target) { observedTargets.add(target); }
    unobserve(target) { observedTargets.delete(target); }
    disconnect() { observerDisconnects += 1; observedTargets.clear(); }
  };
  function observeProjection(stage, expectedCount) {
    const currentTargets = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-grid, .gsm-hoshidicts-glossary-card")];
    const detached = [...observedTargets].filter(target => !target.isConnected).length;
    observations.push({ stage, observed: observedTargets.size, current: currentTargets.length, detached,
      valid: observedTargets.size === expectedCount && currentTargets.length === expectedCount
        && currentTargets.every(target => target.isConnected && observedTargets.has(target)) });
  }
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary(...args) {
      fills += 1;
      linkPredicates.push(args[3].isCurrentLink);
      return HDGlossary.appendTextOnlyGlossary(...args);
    },
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
    onBeforeResultsRendered(intent) { if (!current) { replays += 1; replayIntent = intent; return false; } },
    onAddCustomEntry() { appends += 1; },
  });
  const results = ["First", "Second"].map((dictionary) => ({ ...result, term: { ...result.term,
    glossaries: [{ dictionary, glossary: JSON.stringify([{ type: "structured-content", content: {
      tag: "a", href: "?query=食", content: "linked word",
    } }]) }],
  } }));
  const context = { isCurrentRequest: () => current, isCurrentView: () => displayed,
    onInternalLink() { links += 1; }, onDictionaryTabSelected(value) { selected = value; },
    dictionaryPresentation: [{ title: "First", favorite: true }, { title: "Second", favorite: true }],
  };
  try {
    view.renderResults(results, candidate, { ...context, expandAll: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const initialPredicates = linkPredicates.slice();
    const sharedPredicate = initialPredicates.length === 2
      && initialPredicates[0] === initialPredicates[1];
    const first = popup.querySelector("a[data-hoshidicts-query]");
    const initialFills = fills;
    current = false;
    first.click();
    popup.querySelector('[role="tab"][data-dictionary="Second"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const retained = links === 1 && replays === 1 && selected?.dictionary === "Second"
      && first.isConnected && fills === initialFills && initialPredicates.every(owns => owns());
    displayed = false;
    first.click();
    popup.querySelector('[role="tab"][data-dictionary="First"]').click();
    const obsoleteIgnored = links === 1 && replays === 1 && initialPredicates.every(owns => !owns());
    current = true;
    displayed = true;
    view.renderResults(results, candidate, context);
    popup.querySelector('[role="tab"][data-dictionary="Second"]').click();
    observeProjection("dictionary tab", 2);
    check("retained displayed links and stale-tab handoff never reenable obsolete glossary work",
      sharedPredicate && retained && obsoleteIgnored && replays === 1 && fills > initialFills
        && initialPredicates.every(owns => !owns()),
      JSON.stringify({ sharedPredicate, retained, obsoleteIgnored, links, replays, fills, initialFills }));

    const preserved = [];
    for (const toolbarPosition of ["top", "bottom"]) {
      view.setToolbarPosition(toolbarPosition);
      view.renderResults(results, candidate, context);
      current = false;
      popup.querySelector('[data-dictionary="Second"][role="tab"]').click();
      // Open after replay started: retain the live form, not request-start state.
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      const form = popup.querySelector("form");
      const definition = form.elements.definition;
      definition.value = "keep this draft";
      definition.focus();
      definition.setSelectionRange(2, 7);
      const observer = new window.MutationObserver(() => {});
      observer.observe(popup, { childList: true });
      current = true;
      view.renderResults(results, candidate, { ...context, preserveViewControls: true,
        selectedDictionaryTab: { dictionary: "Second" } });
      preserved.push(popup.querySelector("form") === form && !form.hidden
        && definition.value === "keep this draft" && document.activeElement === definition
        && definition.selectionStart === 2 && definition.selectionEnd === 7
        && !observer.takeRecords().some(record => [...record.removedNodes].includes(form)));
      observer.disconnect();
      form.elements.term.value = "saved";
      form.elements.reading.value = "reading";
      const beforeAppend = appends;
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      view.renderResults(results, candidate, { ...context, preserveViewControls: true });
      preserved.push(form.hidden && appends === beforeAppend + 1);
      const refreshed = [{ ...results[0], term: { ...results[0].term, expression: "new prefill", reading: "new reading" } }];
      view.renderResults(refreshed, candidate, { ...context, preserveViewControls: true });
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      preserved.push(form.elements.term.value === "new prefill" && form.elements.reading.value === "new reading");
      view.closeNoteForm();

      view.renderResults(results, candidate, context);
      const oldTab = popup.querySelector('[data-dictionary="Second"][role="tab"]');
      oldTab.focus();
      view.renderResults(results, candidate, { ...context, preserveViewControls: true,
        selectedDictionaryTab: { dictionary: "Second" } });
      preserved.push(document.activeElement === popup.querySelector('[data-dictionary="Second"][role="tab"]'));
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      view.renderResults(results, candidate, { ...context, preserveViewControls: true });
      preserved.push(document.activeElement === outside);
      outside.remove();
    }
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const kanjiForm = popup.querySelector("form");
    kanjiForm.elements.definition.value = "draft during generic fallback";
    kanjiForm.elements.definition.focus();
    view.renderKanji({ character: "食", entries: [{ dictionary: "Kanji", tags: "", onyomi: "ショク",
      kunyomi: "", definitions: ["eat"], stats: [] }] }, candidate, { preserveViewControls: true, onBack() {} });
    preserved.push(popup.querySelector("form") === kanjiForm && !kanjiForm.hidden
      && document.activeElement === kanjiForm.elements.definition && kanjiForm.elements.definition.value === "draft during generic fallback");
    view.closeNoteForm();
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    preserved.push(kanjiForm.elements.term.value === "食" && kanjiForm.elements.reading.value === "");
    view.renderResults(results, candidate, context);
    preserved.push(!kanjiForm.isConnected && !popup.querySelector("form"));
    check("same-view refresh preserves mounted Note drafts and response-time focus",
      preserved.every(Boolean), JSON.stringify(preserved));

    view.renderResults(results, candidate, context);
    current = false;
    const beforeReplay = replays;
    const beforeFills = fills;
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    const expansionDelegated = replays === beforeReplay + 1 && replayIntent?.expandAll === true
      && fills === beforeFills && popup.querySelectorAll("article").length === 1;
    current = true;
    view.renderResults(results, candidate, { ...context, preserveViewControls: true, expandAll: true });
    const expanded = popup.querySelectorAll("article").length === 2 && !popup.querySelector(".gsm-hoshidicts-show-more");
    view.renderResults(results, candidate, context);
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    observeProjection("Show more retains all current targets", 4);
    check("stale Show more replays fresh results while current expansion remains lookup-free",
      expansionDelegated && expanded && replays === beforeReplay + 1 && popup.querySelectorAll("article").length === 2);

    const live = [];
    const presentation = {
      dictionaryPresentation: [{ title: "First", displayName: "First alias", favorite: true }, { title: "Second", favorite: true }],
      dictionaryTabGroups: [{ id: "first", name: "First group", dictionaries: ["First"] },
        { id: "second", name: "Second group", dictionaries: ["Second"] }],
    };
    const firstGroup = '[role="tab"][data-group-id="first"]';
    const secondGroup = '[role="tab"][data-group-id="second"]';
    current = true;
    const writes = { selected: [], tabIndex: [], panelLabel: [] };
    const setAttribute = window.Element.prototype.setAttribute;
    const tabIndex = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "tabIndex");
    window.Element.prototype.setAttribute = function (name, value) {
      if (name === "aria-selected" && this.getAttribute("role") === "tab") writes.selected.push(this);
      if (name === "aria-labelledby" && this.classList.contains("gsm-hoshidicts-tab-panel")) writes.panelLabel.push(this);
      return setAttribute.call(this, name, value);
    };
    Object.defineProperty(window.HTMLElement.prototype, "tabIndex", { ...tabIndex,
      set(value) {
        if (this.getAttribute("role") === "tab") writes.tabIndex.push(this);
        tabIndex.set.call(this, value);
      },
    });
    const beforeInitialDisconnects = observerDisconnects;
    try {
      view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    } finally {
      window.Element.prototype.setAttribute = setAttribute;
      Object.defineProperty(window.HTMLElement.prototype, "tabIndex", tabIndex);
    }
    const initialTabs = [...popup.querySelectorAll('[role="tab"]')];
    const initialPanel = popup.querySelector('[role="tabpanel"]');
    const tabStateCounts = {
      tabs: initialTabs.map(button => ({ label: button.textContent,
        selected: writes.selected.filter(target => target === button).length,
        tabIndex: writes.tabIndex.filter(target => target === button).length,
      })),
      panelLabel: writes.panelLabel.length,
      observerDisconnects: observerDisconnects - beforeInitialDisconnects,
    };
    live.push(initialTabs.length === 3 && tabStateCounts.tabs.every(row => row.selected === 1 && row.tabIndex === 1)
      && tabStateCounts.observerDisconnects === 1
      && tabStateCounts.panelLabel === 1 && writes.panelLabel[0] === initialPanel
      && initialTabs.every(button => button.getAttribute("aria-controls") === initialPanel.id
        && button.getAttribute("aria-selected") === String(button.matches(firstGroup))
        && button.tabIndex === (button.matches(firstGroup) ? 0 : -1))
      && initialPanel.getAttribute("aria-labelledby") === popup.querySelector(firstGroup).id);
    const groupButton = popup.querySelector(firstGroup);
    groupButton.focus();
    const anchor = popup.querySelector("a[data-hoshidicts-query]");
    const card = popup.querySelector(".gsm-hoshidicts-glossary-card");
    const beforePresentation = { fills, replays };
    const reordered = { ...presentation,
      dictionaryPresentation: [{ title: "First", displayName: "Renamed", favorite: true }, { title: "Second", favorite: true }],
      dictionaryTabGroups: [presentation.dictionaryTabGroups[1], { ...presentation.dictionaryTabGroups[0], name: "Renamed group" }],
    };
    view.updateDictionaryPresentation?.(reordered);
    live.push(popup.querySelector(firstGroup) === groupButton && document.activeElement === groupButton
      && groupButton.textContent === "Renamed group" && groupButton.previousElementSibling === popup.querySelector(secondGroup)
      && popup.querySelector("a[data-hoshidicts-query]") === anchor && popup.querySelector(".gsm-hoshidicts-glossary-card") === card
      && card.querySelector(".gsm-hoshidicts-glossary-card-title").textContent === "Renamed" && fills === beforePresentation.fills && replays === beforePresentation.replays
      && popup.querySelector('[role="tabpanel"]').getAttribute("aria-labelledby") === groupButton.id);
    groupButton.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    observeProjection("group tab", 2);
    live.push(selected?.groupId === "second" && document.activeElement === popup.querySelector(secondGroup)
      && popup.querySelector(".gsm-hoshidicts-glossary-card-title").title === "Second");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const draft = popup.querySelector("form");
    draft.elements.definition.value = "presentation draft";
    const changedMembers = { ...reordered, dictionaryTabGroups: [
      { id: "second", name: "Changed group", dictionaries: ["First"] }, reordered.dictionaryTabGroups[1],
    ] };
    view.updateDictionaryPresentation({ ...changedMembers, dictionaryTabGroups: [
      { id: "second", name: "Intermediate group", dictionaries: ["First", "Second"] }, reordered.dictionaryTabGroups[1],
    ] });
    view.updateDictionaryPresentation?.(changedMembers);
    live.push(popup.querySelector(secondGroup).textContent === "Second group"
      && popup.querySelector(".gsm-hoshidicts-glossary-card-title").title === "Second"
      && popup.querySelector("form") === draft && !draft.hidden && draft.elements.definition.value === "presentation draft");
    view.closeNoteForm();
    observeProjection("live membership flush", 2);
    live.push(popup.querySelector(secondGroup).textContent === "Changed group"
      && popup.querySelector(".gsm-hoshidicts-glossary-card-title").title === "First"
      && popup.querySelector("form") === draft && draft.hidden && selected?.groupId === "second"
      && document.activeElement === popup.querySelector(".gsm-hoshidicts-note-button"));
    const protectedLink = popup.querySelector("a[data-hoshidicts-query]");
    protectedLink.focus();
    view.updateDictionaryPresentation?.(reordered);
    live.push(popup.querySelector("a[data-hoshidicts-query]") === protectedLink && protectedLink.isConnected);
    protectedLink.blur();
    await new Promise(resolve => setTimeout(resolve, 0));
    live.push(popup.querySelector(".gsm-hoshidicts-glossary-card-title").title === "Second");
    current = false;
    const staleAnchor = popup.querySelector("a[data-hoshidicts-query]");
    const staleFills = fills;
    view.updateDictionaryPresentation?.(changedMembers);
    view.flushDictionaryPresentation?.();
    live.push(popup.querySelector("a[data-hoshidicts-query]") === staleAnchor && fills === staleFills);
    current = true;
    view.renderResults(results, candidate, context);
    view.flushDictionaryPresentation?.();
    live.push(!popup.querySelector(secondGroup) && selected === null);

    view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    popup.querySelector(firstGroup).focus();
    view.updateDictionaryPresentation({ ...presentation, dictionaryTabGroups: [] });
    live.push(selected === null && document.activeElement === popup.querySelector('[role="tab"][aria-selected="true"]'));
    const outside = document.createElement("button");
    document.body.append(outside);
    view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    outside.focus();
    view.updateDictionaryPresentation({ ...presentation, dictionaryTabGroups: [] });
    live.push(selected === null && document.activeElement === outside);
    outside.remove();

    const metadataResults = results.map(entry => ({ ...entry, term: { ...entry.term,
      expression: entry.term.glossaries[0].dictionary,
      frequencies: [{ dictionary: "Rank", frequencies: [{ value: 42, displayValue: null }] }],
      pitches: [{ dictionary: "Pitch", transcriptions: [], pitches: [{ position: 0, pattern: "HLL", nasal: [], devoice: [] }] }],
    } }));
    const metadataBefore = JSON.stringify(metadataResults);
    view.renderResults(metadataResults, candidate, { ...context, showFrequencyDictionaryNames: true, showPitchAccentBadge: true });
    const frequencyValue = popup.querySelector(".gsm-hoshidicts-frequency-value");
    const pronunciation = popup.querySelector(".gsm-hoshidicts-tag-pitch");
    const pitchSource = popup.querySelector(".gsm-hoshidicts-pitch-source");
    view.updateDictionaryPresentation({ dictionaryPresentation: [
      { title: "Rank", displayName: "Rank alias" }, { title: "Pitch", displayName: "Pitch alias" },
      { title: "Second", displayName: "Second alias" },
    ], dictionaryTabGroups: [] });
    live.push(popup.querySelector(".gsm-hoshidicts-frequency-value") === frequencyValue && frequencyValue.textContent === "42"
      && popup.querySelector(".gsm-hoshidicts-tag-pitch") === pronunciation
      && popup.querySelector(".gsm-hoshidicts-pitch-source") === pitchSource && pitchSource.textContent === "Pitch alias"
      && popup.querySelector(".gsm-hoshidicts-frequency-source").textContent === "Rank alias"
      && pronunciation.title === "Pitch alias (Pitch): たべる [1]");
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    const secondary = popup.querySelectorAll("article")[1];
    live.push(secondary.querySelector(".gsm-hoshidicts-glossary-card-title").textContent === "Second alias"
      && secondary.querySelector(".gsm-hoshidicts-frequency-source").textContent === "Rank alias"
      && secondary.querySelector(".gsm-hoshidicts-pitch-source").textContent === "Pitch alias"
      && secondary.querySelector(".gsm-hoshidicts-tag-pitch").title === "Pitch alias (Pitch): たべる [1]"
      && JSON.stringify(metadataResults) === metadataBefore);
    const expandedGroup = { ...presentation, dictionaryTabGroups: [{ id: "expanded", name: "Expanded", dictionaries: ["First", "Second"] }] };
    view.renderResults(metadataResults, candidate, { ...context, ...expandedGroup, expandAll: true, selectedDictionaryTab: { groupId: "expanded" } });
    view.updateDictionaryPresentation({ ...expandedGroup, dictionaryTabGroups: [{ id: "expanded", name: "Narrow", dictionaries: ["First"] }] });
    view.updateDictionaryPresentation(expandedGroup);
    live.push(popup.querySelectorAll("article").length === 2 && !popup.querySelector(".gsm-hoshidicts-show-more"));
    view.updateDictionaryPresentation({ ...expandedGroup, dictionaryTabGroups: [{ id: "expanded", name: "Only second", dictionaries: ["Second"] }] });
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    live.push(popup.querySelector("form").elements.term.value === "Second");
    view.closeNoteForm();
    view.clear();
    observeProjection("clear", 0);
    check("live presentation keeps keyed tabs and protected views coherent until local projection is safe",
      live.every(Boolean) && observations.every(value => value.valid), JSON.stringify({ live, observations, tabStateCounts }));

    const kanji = { character: "食", entries: ["First", "Second"].map(dictionary => ({
      dictionary, tags: "", onyomi: "ショク", kunyomi: "", definitions: [dictionary], stats: [],
    })) };
    view.renderKanji(kanji, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    const kanjiEntry = popup.querySelector("article");
    view.updateDictionaryPresentation?.(reordered);
    const aliasOnly = popup.querySelector("article") === kanjiEntry
      && kanjiEntry.querySelector("h3").textContent === "Renamed";
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const kanjiDraft = popup.querySelector("form");
    kanjiDraft.elements.definition.value = "kanji draft";
    view.updateDictionaryPresentation?.({ ...reordered, dictionaryTabGroups: [] });
    const kanjiProtected = popup.querySelectorAll("article").length === 1 && selected?.groupId === "first";
    view.closeNoteForm();
    check("native kanji presentation refreshes its original entries without replacing Note controls or term history",
      aliasOnly && kanjiProtected && selected === null && popup.querySelectorAll("article").length === 2
        && popup.querySelector("form") === kanjiDraft && kanjiDraft.elements.definition.value === "kanji draft"
        && kanji.entries.length === 2,
      JSON.stringify({ aliasOnly, kanjiProtected, selected, entries: popup.querySelectorAll("article").length }));
  } finally {
    view.destroy();
    window.ResizeObserver = originalResizeObserver;
    popup.remove();
  }
}

function internalLinksRenderStage({ HDGlossary, document, window }) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const calls = [];
  let current = true;
  HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([{ type: "structured-content", content: [
    { tag: "a", href: "?query=食&primary_reading=しょく", content: "linked term" },
    { tag: "a", href: "?query=outer", content: { tag: "a", href: "?query=inner", content: "inner term" } },
  ] }]), { isCurrent: () => current, onInternalLink(value) { calls.push(value); } });
  const first = parent.querySelector("a");
  const activate = (anchor, detail = 0) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const active = activate(first) && calls.length === 1 && calls[0].anchor === first
      && calls[0].query === "食" && calls[0].primaryReading === "しょく" && calls[0].focusChild === true;
    current = false;
    const stale = activate(first) && calls.length === 1;
    current = true;
    const nested = activate(parent.querySelector('[data-hoshidicts-query="inner"]'), 1)
      && calls.length === 2 && calls[1].query === "inner" && calls[1].focusChild === false;
    first.remove();
    const detached = activate(first) && calls.length === 2;
    check("internal links retain exact query and reading while rejecting stale, detached and enclosing actions",
      active && stale && nested && detached, JSON.stringify({ active, stale, nested, detached, queries: calls.map(value => value.query) }));
  } finally { parent.remove(); }
}

function externalLinksRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const calls = [];
  let current = true;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
  });
  const href = "  HTTPS://EXAMPLE.test:443/参照?q=食#meaning  ";
  const entry = (dictionary, content) => ({ ...result,
    term: { ...result.term, glossaries: [{ dictionary, glossary: JSON.stringify([
      { type: "structured-content", content },
    ]) }] },
  });
  const link = (url, content = "reference <literal>") => ({ tag: "a", href: url, content });
  const first = entry("Links", link(href));
  const context = {
    isCurrentRequest: () => current,
    onExternalLink(value) { calls.push(value); },
    dictionaryPresentation: [{ title: "Links", favorite: true }, { title: "Other", favorite: true }],
  };
  const dispatch = (anchor, type = "click", options = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const invalid = ["javascript:alert(1)", "file:///tmp/reference", "/relative", "https://[bad/",
      "https://user:secret@example.test/", "https://example.test/line\nbreak"];
    view.renderResults([entry("Links", [link(href), link("http://localhost/reference"), ...invalid.map((url) => link(url))])], candidate, context);
    const anchors = [...popup.querySelectorAll(".gloss-link")];
    const normalised = new URL(href.trim()).href;
    const preserved = anchors[0].href === normalised && anchors[0].target === "_blank"
      && anchors[0].rel === "noopener noreferrer"
      && anchors[0].querySelector(".gloss-link-text").textContent === "reference <literal>"
      && anchors[1].href === "http://localhost/reference"
      && anchors.slice(2).every((anchor) => !anchor.hasAttribute("href"));
    anchors[0].href = "https://mutated.test/";
    const events = [
      ["click", { detail: 1 }, true], ["click", { detail: 0 }, true],
      ["click", { ctrlKey: true }, false], ["click", { metaKey: true }, false],
      ["auxclick", { button: 1 }, false], ["auxclick", { button: 1, shiftKey: true }, true],
    ];
    const prevented = events.map(([type, options]) => dispatch(anchors[0], type, options));
    const nativeContext = !dispatch(anchors[0], "auxclick", { button: 2 })
      && !dispatch(anchors[0], "contextmenu", { button: 2 });
    check("external anchors keep safe native links and route primary, keyboard and middle activation exactly once",
      preserved && prevented.every(Boolean) && nativeContext && calls.length === events.length
        && calls.every((value, index) => value.url === normalised && value.active === events[index][2]),
      JSON.stringify({ preserved, prevented, nativeContext, calls }));

    const stale = [
      () => view.renderResults([first], candidate, context),
      () => popup.querySelector('[data-dictionary="Other"][role="tab"]').click(),
      () => { current = false; },
      (anchor) => anchor.remove(),
      () => view.clear(),
      () => view.destroy(),
    ].map((replace) => {
      current = true;
      view.renderResults([first, entry("Other", "other")], candidate, context);
      const anchor = popup.querySelector(".gloss-link");
      replace(anchor);
      const count = calls.length;
      return dispatch(anchor) && dispatch(anchor, "auxclick", { button: 1 }) && calls.length === count;
    });
    check("obsolete external anchors cancel native navigation without dispatching a new tab",
      stale.every(Boolean), JSON.stringify(stale));

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let internal = 0;
    const before = calls.length;
    HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([{ type: "structured-content",
      content: [link("https://outer.test/", link("https://inner.test/")),
        link("https://outer.test/", link("?query=食&primary_reading=しょく")),
        link("?query=outer", link("https://inner.test/second"))],
    }]), { onExternalLink: context.onExternalLink, onInternalLink() { internal += 1; } });
    dispatch(parent.querySelector('a[href="https://inner.test/"]'));
    dispatch(parent.querySelector('[data-hoshidicts-query]'));
    dispatch(parent.querySelector('a[href="https://inner.test/second"]'));
    check("nested structured links dispatch only the handled inner action",
      calls.length === before + 2 && calls[before]?.url === "https://inner.test/"
        && calls.at(-1)?.url === "https://inner.test/second" && internal === 1,
      JSON.stringify({ calls: calls.slice(before), internal }));
    parent.remove();
  } finally { view.destroy(); popup.remove(); }
}

async function deinflectionRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let layouts = 0;
  let requestCurrent = true;
  const view = HDPopup.createPopupView({
    document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    positionPopup() { layouts += 1; },
  });
  const disclosure = () => popup.querySelector(".gsm-hoshidicts-deinflection");
  const language = Object.getOwnPropertyDescriptor(window.navigator, "language");
  const settle = async () => {
    await new Promise((done) => window.setTimeout(done, 0));
    await new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done)));
  };
  const entry = (dictionary, matched = "Selected form") => ({
    ...result, matched, deinflected: "Dictionary form",
    term: { ...result.term, glossaries: [{ dictionary, glossary: '["definition"]' }] },
  });
  try {
    const raw = { ...entry("Raw"), matched: " <em>{deinflected} $&</em> ", deinflected: " base $' ", trace: [
      { name: "duplicate", description: "first" },
      { name: "duplicate", description: "second" },
      { name: "  ", description: " <img src=x>\n literal $& " },
      { name: " padded ", description: " padded description " },
      { name: "長".repeat(1100), description: "" },
    ] };
    const before = JSON.stringify(raw);
    const locales = [
      ["en-GB", "Deinflection steps", `Why this matched: ${raw.matched} became ${raw.deinflected}`],
      ["ja-JP", "活用解除の手順", `一致した理由: ${raw.matched} から ${raw.deinflected} に戻しました`],
      ["uk-UA", "Кроки відновлення словникової форми", `Чому це збіглося: ${raw.matched} перетворено на ${raw.deinflected}`],
      ["fr-FR", "Deinflection steps", `Why this matched: ${raw.matched} became ${raw.deinflected}`],
    ];
    const failures = [];
    for (const [locale, label, aria] of locales) {
      Object.defineProperty(window.navigator, "language", { configurable: true, value: locale });
      view.renderResults([raw], candidate, { hidePopupGrammarTags: false });
      const details = disclosure();
      const names = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map((node) => node.textContent);
      const descriptions = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection-steps > li")]
        .map((node) => node.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "");
      const valid = details?.open === false
        && details.querySelector("summary").textContent === `${raw.matched} → ${raw.deinflected}`
        && details.querySelector("summary").getAttribute("aria-label") === aria
        && details.querySelector("ol").getAttribute("aria-label") === label
        && JSON.stringify(names) === JSON.stringify(raw.trace.map(({ name }) => name))
        && JSON.stringify(descriptions) === JSON.stringify(raw.trace.map(({ description }) => description))
        && !details.querySelector("em, img");
      if (details) details.open = true;
      await settle();
      if (!valid || JSON.stringify(raw) !== before) failures.push(locale);
    }
    for (const [index, replacement] of [
      { matched: "" }, { matched: null }, { deinflected: "" },
      { deinflected: raw.matched }, { trace: null }, { trace: "not an array" },
      { trace: [] }, { trace: [null, {}, { name: "" }, { name: 2 }] },
    ].entries()) {
      try {
        view.renderResults([{ ...raw, ...replacement }], candidate, { hidePopupGrammarTags: false });
        if (disclosure()) failures.push(`ineligible ${index}`);
      } catch (error) { failures.push(`ineligible ${index}: ${error.message}`); }
    }
    check("deinflection disclosure preserves raw duplicate steps and localized literal text without empty explanations",
      failures.length === 0, JSON.stringify(failures));

    const oversized = { ...raw,
      matched: "前".repeat(5000),
      deinflected: "後".repeat(5000),
      trace: Array.from({ length: 40 }, (_, index) => ({
        name: index === 0 ? "名".repeat(5000) : `step ${index}`,
        description: index === 0 ? "説".repeat(5000) : `description ${index}`,
      })),
    };
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "fr-FR" });
    view.renderResults([oversized], candidate, { hidePopupGrammarTags: false });
    const bounded = disclosure();
    const boundedItems = [...bounded.querySelectorAll("ol > li")];
    const boundedEncoder = new TextEncoder();
    check("oversized deinflection traces keep bounded nodes and UTF-8 text with a locale-neutral fallback",
      boundedItems.length === 32
        && boundedItems.at(-1).textContent === "…"
        && bounded.querySelector("ol").getAttribute("aria-label") === "Deinflection steps"
        && bounded.querySelector("summary").getAttribute("aria-label").startsWith("Why this matched:")
        && [...bounded.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint, .gsm-hoshidicts-deinflection-step-name, .gsm-hoshidicts-deinflection-step-description")]
          .every((node) => boundedEncoder.encode(node.textContent).byteLength <= 4096)
        && bounded.querySelectorAll(".gsm-hoshidicts-deinflection-step-name").length === 31,
      bounded?.outerHTML ?? "missing disclosure");

    const first = entry("First", "First match");
    const second = entry("Second", "Second match");
    const results = [first, second];
    const originalResults = JSON.stringify(results);
    const context = {
      dictionaryPresentation: [{ title: "Second", favorite: true }],
      isCurrentRequest: () => requestCurrent,
      onBack() {},
    };
    view.renderResults(results, candidate, context);
    const primary = disclosure();
    const primaryOutsidePanel = primary !== null
      && popup.querySelector(".gsm-hoshidicts-primary-header").contains(primary)
      && !popup.querySelector(".gsm-hoshidicts-tab-panel").contains(primary);
    const lazy = popup.querySelectorAll(".gsm-hoshidicts-deinflection").length === 1;
    await settle();
    const beforeOpening = layouts;
    if (primary) primary.open = true;
    await settle();
    let currentPositioned = layouts > beforeOpening;
    const beforeClosing = layouts;
    if (primary) primary.open = false;
    await settle();
    currentPositioned &&= layouts > beforeClosing;
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    const expanded = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection")];
    const secondary = expanded.length === 2 && expanded[0] === primary && !expanded[1].open
      && expanded[1].closest("article") !== null
      && expanded[1].querySelector("summary").textContent === "Second match → Dictionary form";
    popup.querySelector('[role="tab"][data-dictionary="Second"]')?.click();
    const projected = disclosure()?.open === false
      && disclosure().querySelector("summary").textContent === "Second match → Dictionary form";
    const staleCases = [];
    for (const replace of [
      () => view.renderResults(results, candidate, context),
      () => popup.querySelector('[role="tab"][data-dictionary="Second"]')?.click(),
      () => view.clear(),
      () => { requestCurrent = false; },
      () => view.destroy(),
    ]) {
      requestCurrent = true;
      view.renderResults(results, candidate, context);
      await settle();
      const old = disclosure();
      replace();
      await settle();
      const beforeStaleToggle = layouts;
      old?.dispatchEvent(new window.Event("toggle"));
      await settle();
      staleCases.push(old !== null && layouts === beforeStaleToggle);
    }
    check("deinflection headers stay lazy and only current projected disclosures can request positioning",
      primaryOutsidePanel && lazy && currentPositioned && secondary && projected
        && staleCases.every(Boolean) && JSON.stringify(results) === originalResults,
      JSON.stringify({ primaryOutsidePanel, lazy, currentPositioned, secondary, projected, staleCases }));
  } finally {
    if (language) Object.defineProperty(window.navigator, "language", language);
    else delete window.navigator.language;
    view.destroy();
    popup.remove();
  }
}

// Issue #397: "large" (the default) skips inline glyphs, "off" opens nothing
// on hover or focus and "all" keeps the preview for every image.
async function imageHoverPreviewModeStage({ HDGlossary, HDPopup, document, window, candidate, result, mediaUrl }) {
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const popup = document.createElement("div");
  shadow.append(popup);
  let mode = "large";
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    getImageHoverPreview: () => mode,
    positionPopup() {},
  });
  const images = [
    { name: "em", path: "media/em.png", width: 1, height: 1, sizeUnits: "em" },
    { name: "small", path: "media/small.png", width: 16, height: 16 },
    { name: "large", path: "media/large.png", width: 64, height: 64 },
    { name: "collapsed", path: "media/collapsed.png", width: 64, height: 64, collapsed: true },
  ];
  try {
    view.renderResults([{ ...result, term: { ...result.term, glossaries: [{
      dictionary: "A",
      glossary: JSON.stringify([{ type: "structured-content", content: images.map(({ name, ...image }) => ({
        tag: "img", alt: name, ...image,
      })) }]),
    }] } }], candidate, {
      generation: 1,
      dictionaryPresentation: [{ title: "A", favorite: true }],
      resolveMedia: () => Promise.resolve(mediaUrl),
    });
    await new Promise((done) => setTimeout(done, 0));
    const links = [...popup.querySelectorAll(".gloss-image-link")];
    const opens = (link, type) => {
      view.hideImagePreview();
      link.dispatchEvent(new window.Event(type));
      const open = shadow.querySelector(".gsm-hoshidicts-image-hover-preview") !== null;
      link.dispatchEvent(new window.Event(type === "focus" ? "blur" : "mouseleave"));
      return open;
    };
    const observed = {};
    for (const next of ["large", "off", "all"]) {
      mode = next;
      observed[next] = Object.fromEntries(links.map((link, index) => [images[index].name,
        [opens(link, "mouseenter"), opens(link, "focus")]]));
    }
    const expected = {
      large: { em: [false, false], small: [false, false], large: [true, true], collapsed: [true, true] },
      off: { em: [false, false], small: [false, false], large: [false, false], collapsed: [false, false] },
      all: { em: [true, true], small: [true, true], large: [true, true], collapsed: [true, true] },
    };
    check("image hover preview skips inline glyphs by default, opens nothing when off and previews every image with all",
      links.length === 4 && links.every(link => link.querySelector("img").src === mediaUrl)
        && JSON.stringify(observed) === JSON.stringify(expected)
        && links[3].dataset.collapsed === "true",
      JSON.stringify({ links: links.length, observed }));
  } finally {
    view.destroy();
    host.remove();
  }
}

async function imagePreviewStage({ view, popup, shadow, window, candidate, result, mediaUrl, calculatePopupPosition }) {
  let requests = 0;
  let ownsRequest = true;
  let holdFirstMedia = false;
  let resolveHeldMedia;
  const preview = () => shadow.querySelector(".gsm-hoshidicts-image-hover-preview");
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this === popup || this === view.scrollElement) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight };
    return this.classList.contains("gsm-hoshidicts-image-hover-preview")
      ? { left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240 }
      : originalRect.call(this);
  };
  const render = async () => {
    ownsRequest = true;
    view.renderResults([{ ...result, term: { ...result.term, glossaries: ["A", "B"].map((dictionary) => ({
      dictionary,
      glossary: JSON.stringify([{ type: "structured-content", content: {
        tag: "img", path: `media/${dictionary}.png`, width: 16, height: 16,
        alt: `${dictionary} image`, appearance: "monochrome", pixelated: true,
      } }]),
    })) } }], candidate, {
      generation: 2,
      dictionaryPresentation: ["A", "B"].map((title) => ({ title, favorite: true })),
      isCurrentRequest: () => ownsRequest,
      resolveMedia({ path }) {
        requests += 1;
        return holdFirstMedia && path === "media/A.png"
          ? new Promise((resolveMedia) => { resolveHeldMedia = resolveMedia; })
          : Promise.resolve(mediaUrl);
      },
    });
    await new Promise((done) => setTimeout(done, 0));
    const links = [...popup.querySelectorAll(".gloss-image-link")];
    links.forEach((link, index) => {
      const image = link.querySelector("img");
      const left = index === 0 ? 0 : window.innerWidth - 16;
      const top = index === 0 ? 0 : window.innerHeight - 16;
      image.getBoundingClientRect = () => ({ left, top, right: left + 16, bottom: top + 16, width: 16, height: 16 });
      Object.defineProperties(image, {
        naturalWidth: { value: 16 }, naturalHeight: { value: 16 }, complete: { value: true },
      });
    });
    return links;
  };
  const event = (target, type) => target.dispatchEvent(new window.Event(type));
  try {
    let links = await render();
    const lazy = !preview();
    const beforeRequests = requests;
    links[0].focus();
    const first = preview();
    event(links[0], "mouseenter");
    const stable = preview() === first;
    const firstFits = first && Number.parseFloat(first.style.left) >= 8 && Number.parseFloat(first.style.top) >= 8;
    const firstSource = first?.querySelector("img");
    check("image preview is lazy, shadow-owned and reuses the exact source without another media request",
      lazy && first?.parentNode === shadow && first.getAttribute("aria-hidden") === "true"
        && firstSource?.src === mediaUrl && firstSource.alt === "A image"
        && first.dataset.appearance === "monochrome" && first.dataset.imageRendering === "pixelated"
        // The monochrome mask layer paints the preview's own copy of the source.
        && first.style.getPropertyValue("--image") === `url("${mediaUrl}")`
        && shadow.activeElement === links[0] && stable && requests === beforeRequests
        && links[0].querySelector(".gloss-image-container").style.width === "16px",
      JSON.stringify({ lazy, stable, requests, beforeRequests, source: firstSource?.src,
        previewImage: first?.style.getPropertyValue("--image") }));

    event(links[0], "mouseleave");
    const focusSurvivedLeave = preview() === first;
    event(links[0], "mouseenter");
    links[0].blur();
    const hoverSurvivedBlur = preview() === first;
    event(links[0], "mouseleave");
    const bothLeftClosed = !preview();
    links[0].focus();
    links[1].focus();
    const second = preview();
    event(links[0], "mouseleave");
    event(links[0], "blur");
    const staleLeaveIgnored = preview() === second;
    const secondFits = second && Number.parseFloat(second.style.left) + 320 <= window.innerWidth - 8
      && Number.parseFloat(second.style.top) + 240 <= window.innerHeight - 8;
    // 92vw/vh produce fractional CSS pixels in a 320x240 Chrome viewport.
    // Rounding after clamping would cross the right/bottom padding boundary.
    const fractionalSize = { width: 294.390625, height: 220.796875 };
    const fractionalCornersFit = [0, 304].every(left => [0, 224].every(top => {
      const position = calculatePopupPosition({ left, top, right: left + 16, bottom: top + 16 },
        fractionalSize, { width: 320, height: 240 }, { gap: 8, padding: 8, vertical: true });
      return position.left >= 8 && position.top >= 8
        && position.left + fractionalSize.width <= 312 && position.top + fractionalSize.height <= 232;
    }));
    event(view.scrollElement, "scroll");
    const focusedScrollKept = Boolean(second) && preview() === second;
    links[1].blur();
    const blurred = !preview();
    event(links[1], "mouseenter");
    event(links[1], "mouseleave");
    const left = !preview();
    event(links[0], "mouseenter");
    event(window, "resize");
    const resized = !preview();
    event(links[0], "mouseenter");
    event(view.scrollElement, "scroll");
    const scrolled = !preview();
    event(links[0], "mouseenter");
    event(links[0].querySelector("img"), "error");
    const failed = !preview();
    check("image previews clamp both viewport corners and close only their current hover or focus owner",
      firstFits && secondFits && fractionalCornersFit && focusSurvivedLeave && hoverSurvivedBlur && bothLeftClosed
        && focusedScrollKept && staleLeaveIgnored && blurred && left && resized && scrolled && failed,
      JSON.stringify({ firstFits, secondFits, fractionalCornersFit, focusSurvivedLeave, hoverSurvivedBlur, bothLeftClosed,
        focusedScrollKept, staleLeaveIgnored, blurred, left, resized, scrolled, failed }));

    links = await render();
    event(links[0], "mouseenter");
    const beforeTab = Boolean(preview());
    popup.querySelector('[role="tab"][data-dictionary="A"]').click();
    const tabClosed = !preview();
    const current = popup.querySelector(".gloss-image-link");
    await new Promise((done) => setTimeout(done, 0));
    current.focus();
    ownsRequest = false;
    view.hideImagePreview?.();
    event(current, "mouseenter");
    check("a tab change or pending newer request prevents obsolete connected images from reopening a preview",
      beforeTab && tabClosed && current.isConnected && !preview(),
      JSON.stringify({ beforeTab, tabClosed, connected: current.isConnected, open: Boolean(preview()) }));

    holdFirstMedia = true;
    links = await render();
    event(links[0], "mouseenter");
    links[1].focus();
    const newerPreview = preview();
    resolveHeldMedia(mediaUrl);
    await new Promise((done) => setTimeout(done, 0));
    event(links[0].querySelector("img"), "load");
    const newerIntentPreserved = Boolean(newerPreview) && preview() === newerPreview;
    links = await render();
    event(links[0], "mouseenter");
    event(window, "resize");
    resolveHeldMedia(mediaUrl);
    await new Promise((done) => setTimeout(done, 0));
    event(links[0].querySelector("img"), "load");
    check("late image loads cannot steal newer preview intent or revive a dismissed preview",
      newerIntentPreserved && !preview(),
      JSON.stringify({ newerIntentPreserved, dismissedRevived: Boolean(preview()) }));
    holdFirstMedia = false;

    links = await render();
    event(links[0], "mouseenter");
    const beforeClear = Boolean(preview());
    view.clear();
    const cleared = !preview();
    links = await render();
    event(links[0], "mouseenter");
    const beforeDestroy = Boolean(preview());
    view.destroy();
    event(links[0], "mouseenter");
    check("clearing or destroying the popup removes its preview and invalidates its image listeners",
      beforeClear && cleared && beforeDestroy && !preview(),
      JSON.stringify({ beforeClear, cleared, beforeDestroy, open: Boolean(preview()) }));
  } finally {
    window.Element.prototype.getBoundingClientRect = originalRect;
    view.destroy();
  }
}

async function mediaRenderStage({ HDGlossary, document, window }) {
  const gaiji = gaijiSizingFixture();
  const gaijiParent = document.createElement("div");
  document.body.appendChild(gaijiParent);
  let gaijiLayouts = 0;
  let gaijiPreviewRefreshes = 0;
  const gaijiRendered = [];
  for (const fixtureCase of gaiji.cases) {
    HDGlossary.appendStructuredImage(document, gaijiParent, {
      path: gaiji.path,
      data: gaiji.data,
      ...fixtureCase.dimensions,
    }, {
      onLayoutChange() { gaijiLayouts += 1; },
      refreshImagePreview() { gaijiPreviewRefreshes += 1; },
      resolveMedia: async () => `data:image/png;base64,${gaiji.bytes.toString("base64")}`,
    });
    await Promise.resolve();
    const link = gaijiParent.lastElementChild;
    const image = link.querySelector("img");
    const [naturalWidth, naturalHeight] = fixtureCase.natural ?? [16, 16];
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: naturalWidth },
      naturalHeight: { configurable: true, value: naturalHeight },
    });
    image.dispatchEvent(new window.Event("load"));
    const container = link.querySelector(".gloss-image-container");
    gaijiRendered.push({
      name: fixtureCase.name,
      inlineWidth: container.style.width,
      padding: Number.parseFloat(container.querySelector(".gloss-image-sizer").style.paddingTop),
      linkHook: link.classList.contains("gloss-sc-a"),
      imageHook: image.classList.contains("gloss-sc-img"),
      classData: link.getAttribute("data-sc-class"),
      glyphData: link.getAttribute("data-sc-glyph"),
      unsafeData: link.hasAttribute("data-sc-unsafe key"),
    });
  }
  check("structured gaiji hooks preserve dictionary selectors while decoded natural sizing leaves explicit geometry unchanged",
    gaijiRendered.every((rendered, index) =>
      rendered.linkHook && rendered.imageHook
      && rendered.classData === "gaiji" && rendered.glyphData === "bs-arrow"
      && !rendered.unsafeData
      // Images decode as 16x16 unless a case names its size, so a natural
      // case writes 16px and a lone side takes the stubbed ratio.
      && rendered.inlineWidth === (gaiji.cases[index].inlineWidth ?? "16px")
      && Math.abs(rendered.padding - gaiji.cases[index].height / gaiji.cases[index].width * 100) < 0.001)
      && gaijiLayouts === gaiji.cases.length
      && gaijiPreviewRefreshes === gaiji.cases.length,
    JSON.stringify({ gaijiRendered, gaijiLayouts, gaijiPreviewRefreshes }));

  // Converted Monokakido dictionaries key their data by Japanese words (付録,
  // 外字) and select on the names Yomitan's dataset setter produces, so the
  // renderer must derive the same names: `data-sc付録`, `data-sc-head`.
  const dataParent = document.createElement("div");
  HDGlossary.appendStructuredValue(document, dataParent, { tag: "span", content: "x",
    data: { "付録": "", head: "", someKey: "camel", a_b: "underscore", ABC: "caps", "sc-x": "rejected", "unsafe key": "rejected", "1st": "digit" } },
    { nodes: 0 }, 0);
  const dataAttributes = Object.fromEntries([...dataParent.firstElementChild.attributes]
    .filter(attribute => attribute.name.startsWith("data-sc")).map(attribute => [attribute.name, attribute.value]));
  check("structured data keys become the attribute names Yomitan's dataset setter produces, including Japanese keys",
    JSON.stringify(dataAttributes) === JSON.stringify({
      "data-sc付録": "", "data-sc-head": "", "data-sc-some-key": "camel", "data-sc-a_b": "underscore",
      "data-sc-a-b-c": "caps", "data-sc1st": "digit",
    }), JSON.stringify(dataAttributes));
  gaijiParent.remove();

  const sizing = imageSizingFixture();
  const sizingParent = document.createElement("div");
  document.body.appendChild(sizingParent);
  const sized = sizing.cases.map(({ name, dimensions, width, padding }) => {
    HDGlossary.appendStructuredImage(document, sizingParent, { path: sizing.path, ...dimensions }, {
      resolveMedia: async () => `data:image/png;base64,${sizing.bytes.toString("base64")}`,
    });
    const container = sizingParent.lastElementChild.querySelector(".gloss-image-container");
    const actualWidth = Number.parseFloat(container.style.width);
    const actualPadding = Number.parseFloat(container.querySelector(".gloss-image-sizer").style.paddingTop);
    return { name, width: actualWidth, padding: actualPadding,
      dimensionsMatch: Math.abs(actualWidth - width) < 1e-12 && Math.abs(actualPadding - padding) < 0.001,
      bounded: container.style.aspectRatio === "" && Number.isFinite(actualPadding) && actualPadding <= 10_000 };
  });
  check("image aspect sizing uses the existing bounded sizer without a competing raw ratio",
    sized.every(({ bounded }) => bounded), JSON.stringify(sized));
  check("image width arithmetic recovers intermediate overflow and underflow without changing valid sizes",
    sized.every(({ dimensionsMatch }) => dimensionsMatch), JSON.stringify(sized));
  sizingParent.remove();
  const outcomes = [];
  let supplierLayout = null;
  for (const replyKind of ["missing", "failure", "valid"]) {
    for (const current of [false, true]) {
      const parent = document.createElement("div");
      let ownsView = true;
      let settleMedia;
      let layouts = 0;
      let ownerPassed = false;
      let imageHandle;
      const imageContext = { popupImageSources: ["Pictures"] };
      const pending = new Promise((resolveMedia, rejectMedia) => {
        settleMedia = () => replyKind === "failure"
          ? rejectMedia(new Error("transient media failure"))
          : resolveMedia(replyKind === "valid" ? "data:image/png;base64,YQ==" : null);
      });
      HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([
        "surrounding definition", { type: "structured-content", content: {
          tag: "img", path: "media/owned.png", alt: "descriptive image",
        } },
      ]), {
        dictionary: "Definitions",
        imageContext,
        onImageCreated(handle) { imageHandle = handle; },
        isCurrent: () => ownsView,
        onLayoutChange() { layouts += 1; },
        resolveMedia({ isCurrent, onResolvedSource }) {
          ownerPassed = typeof isCurrent === "function" && isCurrent();
          onResolvedSource("Pictures");
          return pending;
        },
      });
      document.body.appendChild(parent);
      ownsView = current;
      settleMedia();
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
      const image = parent.querySelector("img");
      const link = parent.querySelector(".gloss-image-link");
      if (!current) {
        image.dispatchEvent(new window.Event("load"));
        image.dispatchEvent(new window.Event("error"));
      }
      outcomes.push(current
        ? replyKind === "valid"
          ? image.getAttribute("src") === "data:image/png;base64,YQ==" && link.dataset.imageLoadState === "loaded"
          : link.dataset.imageLoadState === "load-error" && layouts > 0
          && parent.textContent.includes("surrounding definition")
          && link.getAttribute("aria-label")?.includes("descriptive image")
          && link.querySelector(".gloss-image-link-text").textContent.includes("Image failed to load")
        : ownerPassed && link.dataset.imageLoadState === "not-loaded" && layouts === 0
          && !image.hasAttribute("src") && !link.hasAttribute("href") && !image.hidden);
      if (current && replyKind === "valid") {
        const labelBeforeLoad = parent.querySelector(".gloss-image-source")?.textContent === "Image: Pictures";
        const beforeLoad = layouts;
        image.dispatchEvent(new window.Event("load"));
        const afterLoad = layouts;
        const aliasChanged = imageHandle.updatePresentation({ ...imageContext,
          dictionaryPresentation: [{ title: "Pictures", displayName: "Picture book" }] });
        const aliasNeedsLayout = aliasChanged && layouts === afterLoad
          && parent.querySelector(".gloss-image-source")?.textContent === "Image: Picture book";
        image.dispatchEvent(new window.Event("error"));
        supplierLayout = { labelBeforeLoad, beforeLoad, afterLoad, aliasNeedsLayout,
          failedLayout: layouts === afterLoad + 1 && !parent.querySelector(".gloss-image-source")
            && link.dataset.imageLoadState === "load-error" };
      }
      parent.remove();
    }
  }
  check("obsolete connected image callbacks cannot mutate or reposition their old panel",
    outcomes[0] && outcomes[2] && outcomes[4] && outcomes[5], JSON.stringify(outcomes));
  check("missing and failed images expose an accessible failure state without losing glossary text",
    outcomes[1] && outcomes[3], JSON.stringify(outcomes));
  check("supplier labels share the image completion layout while alias changes and failures retain their layout path",
    supplierLayout?.labelBeforeLoad && supplierLayout.beforeLoad === 0 && supplierLayout.afterLoad === 1
      && supplierLayout.aliasNeedsLayout && supplierLayout.failedLayout, JSON.stringify(supplierLayout));
}

function structuredRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const rejected = (operation) => {
    try { operation(); return null; }
    catch (error) {
      if (error.name !== "RangeError" || !/structured.*limit/iu.test(error.message)) throw error;
      return error;
    }
  };
  const nested = (depth, leaf = "leaf") => {
    let value = leaf;
    for (let index = 0; index < depth; index += 1) value = { type: "text", text: value };
    return JSON.stringify([value]);
  };
  const parent = document.createElement("div");
  HDGlossary.appendTextOnlyGlossary(document, parent, nested(24));
  const exactDepth = glossaryText(parent) === "leaf";
  parent.replaceChildren();
  HDGlossary.appendTextOnlyGlossary(document, parent, nested(1000));
  const deepContent = glossaryText(parent) === "leaf";
  parent.replaceChildren();
  HDGlossary.appendTextOnlyGlossary(document, parent, '[{"tag":"unknown","content":"kept"}]');
  HDGlossary.appendTextOnlyGlossary(document, parent, "<literal>");
  check("structured content renders beyond the former depth limit and preserves ordinary fallback text",
    exactDepth && deepContent && glossaryText(parent) === "kept<literal>", parent.innerHTML);

  const limit = 1_048_576;
  const values = [
    { value: null, count: 1 },
    { value: "text", count: 1 },
    { value: { tag: "script", content: "ignored" }, count: 1 },
    { value: [null], count: 2 },
    { value: { type: "text", text: "leaf" }, count: 2 },
    { value: { tag: "unknown", content: null }, count: 2 },
  ];
  const nodeCases = values.map(({ value, count }) => {
    const state = { nodes: limit - count };
    const accepted = rejected(() => HDGlossary.appendStructuredValue(document, parent, value, state, 0)) === null;
    const full = rejected(() => HDGlossary.appendStructuredValue(document, parent, null, state, 0));
    const overflow = rejected(() =>
      HDGlossary.appendStructuredValue(document, parent, value, { nodes: limit - count + 1 }, 0));
    return accepted && state.nodes === limit
      && [full, overflow].every(error =>
        error?.structuredContentLimitKind === "node count"
        && error.structuredContentActual === limit + 1
        && error.structuredContentLimit === limit
        && error.structuredContentLocation.startsWith("structuredContent"));
  });
  check("structured node accounting reports the exact limit across containers wrappers and ignored values",
    nodeCases.every(Boolean), JSON.stringify(nodeCases));
  const deepValue = JSON.parse(nested(1000))[0];
  const deepOverflow = rejected(() =>
    HDGlossary.appendStructuredValue(document, parent, deepValue, { nodes: limit - 100 }, 0));
  check("deep node-limit diagnostics keep a bounded structural path without exposing content",
    deepOverflow?.structuredContentLimitKind === "node count"
      && deepOverflow.structuredContentActual === limit + 1
      && deepOverflow.structuredContentLimit === limit
      && deepOverflow.structuredContentLocation.includes("path segments omitted")
      && deepOverflow.structuredContentLocation.length < 1024
      && !deepOverflow.message.includes("leaf"),
    JSON.stringify({ message: deepOverflow?.message, location: deepOverflow?.structuredContentLocation }));

  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const queued = [];
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = (callback) => { queued.push(callback); return queued.length; };
  let fills = 0;
  let layouts = 0;
  let media = 0;
  const errors = [];
  let requestCurrent = true;
  const view = HDPopup.createPopupView({
    document, window, popup, initialResultCount: 2,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    parseTagList: HDGlossary.parseTagList,
    appendTextOnlyGlossary(...args) {
      fills += 1;
      if (args[2] === "structured-limit") {
        const error = new RangeError("Structured content node count 1048577 exceeds limit 1048576 at glossary[0]");
        error.code = "structured-content-limit";
        error.structuredContentActual = 1_048_577;
        error.structuredContentLimit = 1_048_576;
        error.structuredContentLimitKind = "node count";
        error.structuredContentLocation = "glossary[0]";
        throw error;
      }
      if (args[2] === "unexpected-renderer-failure") throw new Error("unexpected renderer failure");
      return HDGlossary.appendTextOnlyGlossary(...args);
    },
    positionPopup() { layouts += 1; },
  });
  const entry = (dictionary, glossary) => ({
    ...result,
    term: { ...result.term, glossaries: [{ dictionary, glossary }] },
  });
  const healthy = entry("Healthy", '["healthy"]');
  const invalid = entry("Invalid", "structured-limit");
  const unexpected = entry("Unexpected", "unexpected-renderer-failure");
  const imageEntry = entry("Image", '[{"type":"image","path":"media/image.png","width":16,"height":16}]');
  const context = {
    isCurrentRequest: () => requestCurrent,
    dictionaryPresentation: [
      { id: "healthy-id", title: "Healthy", favorite: true },
      { id: "invalid-id", title: "Invalid", favorite: true },
    ],
    onRenderError(error) { errors.push(error); view.clear(); },
    resolveMedia() { media += 1; return Promise.resolve(null); },
  };
  const drain = () => {
    let escaped = 0;
    for (const callback of queued.splice(0)) {
      try { callback(); } catch { escaped += 1; }
    }
    return escaped;
  };
  try {
    view.renderResults([healthy, invalid], candidate, context);
    const escaped = drain();
    const deferredHandled = errors.length === 0 && escaped === 0
      && view.scrollElement.childElementCount === 1
      && popup.textContent.includes("healthy");
    view.renderResults([healthy, invalid], candidate, context);
    popup.querySelector('[data-dictionary="Invalid"][role="tab"]')?.click();
    const tabHandled = errors.length === 0 && view.scrollElement.childElementCount > 0
      && popup.textContent.includes("Invalid");
    drain();
    view.renderResults([healthy, healthy, invalid], candidate, context);
    drain();
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    const moreEscaped = drain();
    check("deferred, tab and expanded structured-limit failures omit only their glossary body",
      deferredHandled && tabHandled && errors.length === 0 && moreEscaped === 0
        && view.scrollElement.childElementCount > 0 && popup.textContent.includes("Invalid"),
      JSON.stringify({ deferredHandled, tabHandled, errors: errors.map(error => error.message), escaped, moreEscaped }));

    const projectionContext = { ...context, selectedDictionaryTab: { groupId: "live" },
      dictionaryTabGroups: [{ id: "live", name: "Live", dictionaries: ["Healthy"] }],
    };
    view.renderResults([healthy, invalid], candidate, projectionContext);
    let presentationEscaped = false;
    const beforePresentationError = errors.length;
    try {
      view.updateDictionaryPresentation({ ...projectionContext,
        dictionaryTabGroups: [{ id: "live", name: "Live", dictionaries: ["Invalid"] }],
      });
    } catch { presentationEscaped = true; }
    check("storage-driven projection failures omit only the affected glossary body",
      !presentationEscaped && errors.length === beforePresentationError
        && view.scrollElement.childElementCount > 0 && popup.textContent.includes("Invalid"),
      JSON.stringify({ presentationEscaped, errors: errors.length, beforePresentationError }));

    const manyDictionaries = Array.from({ length: 100 }, (_, index) => ({
      dictionary: `Dictionary ${index}`,
      glossary: index === 50 ? "structured-limit" : JSON.stringify([`definition ${index}`]),
    }));
    const manyDictionaryResult = {
      ...result,
      term: { ...result.term, glossaries: manyDictionaries },
    };
    view.renderResults([manyDictionaryResult], candidate, {
      ...context,
      dictionaryPresentation: manyDictionaries.map(({ dictionary }) => ({
        id: `dictionary-${dictionary}`,
        title: dictionary,
        favorite: true,
      })),
    });
    const manyEscaped = drain();
    const manyCards = popup.querySelectorAll(".gsm-hoshidicts-glossary-card").length;
    check("one failed glossary does not cap a large dictionary result set",
      manyEscaped === 0 && errors.length === 0 && manyCards === 100
        && popup.textContent.includes("definition 0")
        && popup.textContent.includes("definition 99"),
      JSON.stringify({ manyEscaped, errors: errors.length, manyCards }));

    view.renderResults([healthy, unexpected], candidate, context);
    const unexpectedEscaped = drain();
    check("unexpected glossary renderer failures still use the current view error boundary",
      unexpectedEscaped === 0 && errors.length === 1
        && errors[0].message === "unexpected renderer failure"
        && view.scrollElement.childElementCount === 0 && popup.childElementCount === 1,
      JSON.stringify({ unexpectedEscaped, errors: errors.map(error => error.message) }));

    const replacements = [
      () => view.renderResults([healthy], candidate, context),
      () => popup.querySelector('[data-dictionary="Healthy"][role="tab"]')?.click(),
      () => view.clear(),
      () => { requestCurrent = false; },
      () => view.destroy(),
    ];
    const staleCases = replacements.map((replace) => {
      requestCurrent = true;
      view.renderResults([healthy, imageEntry], candidate, context);
      replace();
      const before = { fills, layouts, media, errors: errors.length };
      const staleEscaped = drain();
      return staleEscaped === 0
        && JSON.stringify(before) === JSON.stringify({ fills, layouts, media, errors: errors.length });
    });
    check("superseded glossary tasks do no rendering, media or layout work",
      staleCases.every(Boolean), JSON.stringify(staleCases));
  } finally {
    window.setTimeout = originalSetTimeout;
    view.destroy();
    popup.remove();
  }
}

// Depth is not a failure condition anywhere in the render path (#287): the
// glossary, the compact summary and Anki fields owe deep content its leaf text.
async function deepStructuredContentStage({ HDGlossary, HDPopup, document }) {
  const fixture = structuredContentDeepFixture();
  const depth = (value, level = 0) => Array.isArray(value)
    ? Math.max(level, ...value.map(child => depth(child, level + 1)))
    : value !== null && typeof value === "object"
      ? depth(value.type === "text" && Object.hasOwn(value, "text") ? value.text : value.content, level + 1)
      : level;
  const render = glossary => {
    const parent = document.createElement("div");
    HDGlossary.appendTextOnlyGlossary(document, parent, glossary);
    return glossaryText(parent);
  };
  const summary = glossary => HDPopup.extractCompactDefinitionSummary([{ dictionary: fixture.title, glossary }], null, 6)?.items;
  const ankiFields = async glossary => (await buildAnkiResourceFields({
    term: { expression: fixture.query, reading: fixture.query, rules: "", frequencies: [], pitches: [],
      glossaries: [{ dictionary: fixture.title, glossary, definitionTags: "", termTags: "" }] },
    trace: [], dictionaryAliases: {}, frequencyDictionaries: [], generation: 1,
  }, { Rich: { value: "{glossary}", overwriteMode: "coalesce" }, Plain: { value: "{glossary-plain-no-dictionary}", overwriteMode: "coalesce" } },
  { document, dictionaryPaths: { [fixture.title]: "/dicts/deep" }, styles: async () => [] })).fields;
  const fixtureDepth = depth(JSON.parse(fixture.glossary)[0]);
  const rendered = render(fixture.glossary);
  check("a 大辞泉-shaped glossary nested beyond the former depth limit renders its deepest gloss",
    fixtureDepth >= 25 && rendered.includes(fixture.leaf), JSON.stringify({ fixtureDepth, rendered }));
  const items = summary(fixture.glossary);
  check("the compact summary of that glossary is every gloss in order without labels or examples",
    JSON.stringify(items) === JSON.stringify(fixture.summary) && items.every(item => !item.includes("用例")),
    JSON.stringify({ items, expected: fixture.summary }));
  const fields = await ankiFields(fixture.glossary);
  check("Anki glossary and glossary-plain fields contain that glossary's deepest gloss",
    fields.Rich.includes(fixture.leaf) && fields.Plain.includes(fixture.leaf),
    JSON.stringify(fields));

  const nested = wrappers => {
    let value = "leaf";
    for (let index = 0; index < wrappers; index += 1) {
      value = index % 2 === 0 ? { type: "text", text: value } : { tag: "span", content: [value] };
    }
    return JSON.stringify([value]);
  };
  const depths = [1, 10, 24, 25, 64, 500];
  const outcomes = await Promise.all(depths.map(async wrappers => {
    const glossary = nested(wrappers);
    const fields = await ankiFields(glossary);
    return {
      wrappers, depth: depth(JSON.parse(glossary)[0]), rendered: render(glossary), items: summary(glossary),
      plain: fields.Plain, richLeaf: fields.Rich.includes("leaf"),
    };
  }));
  // The preview keeps its 512-node budget (COMPACT_DEFINITION_MAX_NODES): 500
  // wrappers are 750 values, so only that budget, never depth, ends its summary.
  check("rendering, compact summaries and Anki fields never fail on depth alone",
    outcomes.every(outcome => outcome.depth >= outcome.wrappers && outcome.rendered === "leaf"
      && (outcome.depth < 512 ? JSON.stringify(outcome.items) === '["leaf"]' : outcome.items === undefined)
      && outcome.plain === "leaf" && outcome.richLeaf),
    JSON.stringify(outcomes.map(({ wrappers, depth, rendered, items, plain, richLeaf }) =>
      ({ wrappers, depth, rendered, items, plain, richLeaf }))));
}

describe("renderer", () => {
  step("renderer against real engine output", async () => {
    section("renderer against real engine output");
    // 漢字 is the fixture's structured-content entry, the only one carrying an <img>.
    const imageLookup = await request("hd_lookup", {
      text: "漢字",
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    check("hd_lookup finds the structured-content entry", imageLookup.results.length > 0, JSON.stringify(imageLookup.error));
    // A skip here is a failure. The renderer is the only consumer that reads
    // contract B field by field, and a printed SKIP under "44 passed, 0 failed"
    // hid the fact that nothing exercised it at all.
    const rendered = await renderStage({ imageLookup, kanji: kanji.kanji, lookup, media });
    if (rendered === null) {
      fail(
        "jsdom is loadable, so the renderer stage can run",
        `${jsdomFailure}\nSearched: ${jsdomSearchPaths().join(", ")}\n` +
          "Install it outside the repo and point HACHIDORI_JSDOM or NODE_PATH at that tree:\n" +
          `  (cd ${DEFAULT_JSDOM_TREE} && npm install jsdom)\n` +
          `  NODE_PATH=${DEFAULT_JSDOM_TREE}/node_modules node test/extension-smoke.mjs`,
      );
    }
  });
});
