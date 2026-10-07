/*
 * The reader's source highlighting.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { EXTENSION, loadJsdom } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function sourceHighlightStage() {
  const jsdom = await loadJsdom();
  if (!jsdom) return null;
  const dom = new jsdom.JSDOM('<p id="a">前<span>食べる</span>後</p><p id="b">読む。</p><p id="selection">Keep selection</p>', {
    pretendToBeVisual: true, runScripts: "outside-only",
  });
  const { window } = dom;
  const { document } = window;
  window.CSS = { highlights: new Map() };
  window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
  window.eval(readFileSync(resolve(EXTENSION, "render/popup.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "theme-host.js"), "utf8"));
  window.fetch = async () => ({ ok: true, text: async () => "" });
  const highlighter = window.HDPopup.createSourceHighlighter(window, document, "test-source");
  const candidate = id => {
    const element = document.getElementById(id);
    return { sourceElements: [element], sourceText: element.textContent, sourceOffset: id === "a" ? 1 : 0 };
  };
  const visits = { a: 0, b: 0 };
  const createWalker = document.createTreeWalker.bind(document);
  document.createTreeWalker = (root, ...args) => {
    visits[root.id] += 1;
    return createWalker(root, ...args);
  };
  const ranges = () => [...(window.CSS.highlights.get("test-source") || [])];
  const texts = () => ranges().map(range => range.toString()).join("|");
  const settle = () => new Promise(done => window.setTimeout(done, 0));
  try {
    const a = highlighter.scope("a"), b = highlighter.scope("b");
    const ca = candidate("a"), cb = candidate("b");
    const unrelated = new window.Highlight();
    window.CSS.highlights.set("page-owned", unrelated);
    window.getSelection().selectAllChildren(document.getElementById("selection"));
    a.apply(ca, "食べる");
    const first = ranges()[0];
    b.apply(cb, "読む");
    b.apply(cb, "読む");
    b.clear();
    const ownership = ranges()[0] === first && texts() === "食べる" && visits.a === 1 && visits.b === 1;
    b.apply(cb, "読む");
    document.querySelector("#a span").replaceChildren(document.createTextNode("食べる"));
    await settle();
    const replacement = texts() === "食べる|読む" && ranges()[0] !== first && visits.a === 2 && visits.b === 2;
    document.querySelector("#a span").firstChild.insertData(1, "別");
    await settle();
    const stale = texts() === "読む";
    document.getElementById("b").remove();
    await settle();
    const detached = ranges().length === 0;
    const left = document.createElement("section"), right = document.createElement("section");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    const nested = document.createElement("span");
    nested.textContent = "読む";
    shadow.append(nested);
    left.append(host);
    document.body.append(left, right);
    a.apply({ sourceElements: [nested], sourceText: "読む", sourceOffset: 0 }, "読む");
    right.append(host);
    await settle();
    host.remove();
    await settle();
    const shadowDetached = ranges().length === 0;
    a.apply(candidate("selection"), "Keep");
    const disposableView = window.HDPopup.createPopupView({ document, window, popup: document.createElement("div"),
      sourceHighlighter: a, positionPopup() {} });
    disposableView.destroy();
    const mutations = replacement && stale && detached && shadowDetached && ranges().length === 0
      && window.CSS.highlights.get("page-owned") === unrelated && window.getSelection().toString() === "Keep selection";
    // A screenshot must not contain the highlight: publication stops for as long
    // as it is suspended, including for a match that arrives meanwhile, and the
    // exact ranges come back when it is released.
    highlighter.clearAll();
    const suspendSource = document.createElement("p");
    suspendSource.textContent = "食べる";
    document.body.append(suspendSource);
    const suspendScope = highlighter.scope("suspend");
    const suspendCandidate = { sourceElements: [suspendSource], sourceText: suspendSource.textContent, sourceOffset: 0 };
    suspendScope.apply(suspendCandidate, "食べる");
    const publishedBefore = texts() === "食べる";
    const releaseFirst = highlighter.suspend();
    const releaseSecond = highlighter.suspend();
    const suspendedEmpty = ranges().length === 0;
    suspendScope.clear();
    suspendScope.apply(suspendCandidate, "食べる");
    const suspendedQuiet = ranges().length === 0;
    releaseFirst();
    releaseFirst();
    const heldBySecond = ranges().length === 0;
    releaseSecond();
    const restored = publishedBefore && suspendedEmpty && suspendedQuiet && heldBySecond && texts() === "食べる";
    highlighter.clearAll();
    suspendSource.remove();
    // A pointer scan's sources are text nodes, one per positioned glyph box.
    const boxes = Array.from("食べた", (glyph) => {
      const box = document.createElement("span");
      box.textContent = glyph;
      return box;
    });
    document.body.append(...boxes);
    const boxedScope = highlighter.scope("boxed");
    boxedScope.apply({ sourceElements: boxes.map((box) => box.firstChild), sourceText: "食べた", sourceOffset: 1 }, "べた");
    const boxedRanges = ranges();
    const boxedPainted = texts() === "べ|た" && boxedRanges.length === 2
      && boxedRanges.every((range, index) => range.startContainer === boxes[index + 1].firstChild);
    // Text changing elsewhere in the sources leaves the match in place.
    boxes[0].firstChild.data = "俺";
    await settle();
    const boxedNeighbour = texts() === "べ|た";
    boxes[2].remove();
    await settle();
    const boxedDetached = ranges().length === 0;
    const textSources = boxedPainted && boxedNeighbour && boxedDetached;
    highlighter.clearAll();
    boxes[0].remove();
    boxes[1].remove();
    const fallback = await sourceHighlightFallbackCase(window);
    return { ownership, restored, mutations, fallback, visits, replacement, stale, textSources };
  } finally {
    highlighter.clearAll();
    window.close();
  }
}

async function sourceHighlightFallbackCase(window) {
  const { document } = window;
  window.Highlight = undefined;
  window.Element.prototype.getAnimations = () => [];
  window.Document.prototype.getAnimations = () => [];
  window.ShadowRoot.prototype.getAnimations = () => [];
  let mediaWatches = 0;
  window.matchMedia = () => ({ addEventListener() { mediaWatches += 1; }, removeEventListener() { mediaWatches -= 1; } });
  let geometryReads = 0;
  let siblingOffset = 0;
  window.Range.prototype.getClientRects = function () {
    geometryReads += 1;
    const left = this.toString() === "食べる" ? 100 + siblingOffset : 300;
    return [{ left, top: 200, right: left + 50, bottom: 216, width: 50, height: 16 }];
  };
  const source = document.getElementById("a");
  source.textContent = "前食べる後";
  source.classList.add("gsm-hoshidicts-source-match");
  const before = { text: source.innerHTML, selection: window.getSelection().toString(), className: source.className };
  const host = document.createElement("div");
  const sibling = document.createElement("div");
  sibling.textContent = "spacer";
  const pageStyle = document.createElement("style");
  pageStyle.textContent = ".page-cover { position: static; }";
  document.body.append(host, sibling, pageStyle);
  const shadow = host.attachShadow({ mode: "open" });
  const highlighter = window.HDPopup.createSourceHighlighter(window, document, "test-fallback", shadow);
  const otherSource = document.getElementById("selection");
  const first = highlighter.scope("first"), second = highlighter.scope("second");
  const marks = () => [...shadow.querySelectorAll(".gsm-hoshidicts-source-match")];
  const frame = () => new Promise(done => window.requestAnimationFrame(done));
  const queryDocument = document.querySelectorAll.bind(document);
  let coverScans = 0;
  document.querySelectorAll = (selector, ...args) => {
    if (selector === "*") coverScans += 1;
    return queryDocument(selector, ...args);
  };
  try {
    first.apply({ sourceElements: [source], sourceText: source.textContent, sourceOffset: 1 }, "食べる");
    await frame();
    const mark = marks()[0];
    const exact = marks().length === 1 && mark.style.left === "100px" && mark.style.top === "200px"
      && mark.style.width === "50px" && mark.style.height === "16px";
    second.apply({ sourceElements: [otherSource], sourceText: otherSource.textContent, sourceOffset: 0 }, "Keep");
    await frame();
    const both = marks().length === 2 && marks()[0] === mark;
    const beforeClear = geometryReads;
    second.clear();
    await frame();
    otherSource.dispatchEvent(new window.Event("animationstart", { bubbles: true }));
    await frame();
    const retained = marks().length === 1 && marks()[0] === mark && geometryReads === beforeClear;
    const beforeMotionEnd = coverScans;
    source.dispatchEvent(new window.Event("animationend", { bubbles: true }));
    await frame();
    await frame();
    const settledMotion = coverScans === beforeMotionEnd;
    let animations = [Object.assign(new window.EventTarget(), { playState: "paused", playbackRate: 1, currentTime: 0,
      effect: { target: sibling, getTiming: () => ({ duration: 1000 }),
        getKeyframes: () => [{ position: "static" }, { position: "fixed" }] } })];
    sibling.getAnimations = () => animations;
    document.getAnimations = () => animations;
    sibling.dispatchEvent(new window.Event("animationstart", { bubbles: true }));
    await frame();
    await frame();
    const beforeOtherEffectEnd = coverScans;
    sibling.dispatchEvent(new window.Event("animationend", { bubbles: true }));
    await frame();
    await frame();
    const overlappingMotion = coverScans === beforeOtherEffectEnd;
    animations = [];
    sibling.dispatchEvent(new window.Event("animationend", { bubbles: true }));
    await frame();
    await frame();
    delete document.getAnimations;
    delete sibling.getAnimations;
    second.apply({ sourceElements: [otherSource], sourceText: otherSource.textContent, sourceOffset: 0 }, "Keep");
    await frame();
    source.style.visibility = "hidden";
    second.clear(); // Preserve pending source geometry before reconnecting observers.
    await frame();
    await frame();
    const hidden = marks().length === 0;
    source.style.visibility = "visible";
    await frame();
    await frame();
    const restored = marks().length === 1;
    const beforeSibling = coverScans;
    siblingOffset = 20;
    sibling.firstChild.data = "changed sibling layout";
    await frame();
    await frame();
    const siblingMoved = marks()[0]?.style.left === "120px";
    let discovery = coverScans === beforeSibling;
    sibling.textContent = "replacement sibling text";
    const decoration = document.createElement("div");
    shadow.append(decoration);
    await frame();
    await frame();
    decoration.style.width = "40px";
    await frame();
    await frame();
    discovery &&= coverScans === beforeSibling;
    decoration.remove();
    // Empty-boundary changes can alter :empty/:has membership, unlike a clock
    // changing one non-empty text value to another. New elements can be covers.
    for (const change of [
      () => { sibling.firstChild.data = ""; },
      () => { sibling.firstChild.data = "restored text"; },
      () => { sibling.className = "new-selector-state"; },
      () => { sibling.append(document.createElement("div")); },
      () => { sibling.lastChild.remove(); },
      () => { pageStyle.firstChild.data = ".page-cover { position: fixed; }"; },
      () => { pageStyle.textContent = ".page-cover { position: sticky; }"; },
      () => { sibling.dir = "auto"; },
      () => { sibling.firstChild.data = "العربية"; },
    ]) {
      const beforeChange = coverScans;
      change();
      await frame();
      await frame();
      discovery &&= coverScans === beforeChange + 1;
    }
    const otherHost = document.createElement("div");
    const otherShadow = otherHost.attachShadow({ mode: "open" });
    const shadowSource = document.createElement("div");
    shadowSource.textContent = "Keep";
    otherShadow.append(shadowSource);
    const sharedStyle = document.createElement("style");
    sharedStyle.textContent = ".shared-cover { position: fixed; }";
    document.body.append(otherHost, sharedStyle);
    const adoptedBefore = document.adoptedStyleSheets;
    document.adoptedStyleSheets = [pageStyle.sheet, sharedStyle.sheet];
    otherShadow.adoptedStyleSheets = [pageStyle.sheet];
    second.apply({ sourceElements: [shadowSource], sourceText: "Keep", sourceOffset: 0 }, "Keep");
    await frame();
    await frame();
    const beforeSheetSwitch = coverScans;
    // Both sheets were already visited in the document. Shared references must
    // retain identity when an external source root changes its adopted list.
    otherShadow.adoptedStyleSheets = [sharedStyle.sheet];
    await new Promise(done => window.setTimeout(done, 350));
    await frame();
    discovery &&= coverScans === beforeSheetSwitch + 1;
    second.clear();
    document.adoptedStyleSheets = adoptedBefore;
    otherHost.remove();
    sharedStyle.remove();
    source.style.removeProperty("visibility");
    first.clear();
    const cleaned = shadow.childNodes.length === 0;
    const popup = document.createElement("div");
    document.body.append(popup);
    const view = window.HDPopup.createPopupView({ document, window, popup, sourceHighlightEnabled: true,
      positionPopup() {} });
    let documentRoot;
    try {
      view.renderKanji({ character: "食", entries: [] },
        { sourceElements: [source], sourceText: source.textContent, sourceOffset: 1 });
      await frame();
      documentRoot = document.body.querySelectorAll(":scope > .gsm-hoshidicts-source-highlight-layer").length === 1;
    } finally { view.destroy(); popup.remove(); }
    return exact && both && retained && settledMotion && overlappingMotion && hidden && restored && siblingMoved && discovery && cleaned && documentRoot && mediaWatches === 0
      && !document.querySelector(".gsm-hoshidicts-source-highlight-layer") && source.innerHTML === before.text
      && source.className === before.className && window.getSelection().toString() === before.selection;
  } finally {
    document.querySelectorAll = queryDocument;
    highlighter.clearAll();
    host.remove();
    sibling.remove();
    pageStyle.remove();
  }
}

describe("source highlighting", () => {
  test("source highlighting", async () => {
    const sourceHighlight = await sourceHighlightStage();
    check("source highlighting reuses unchanged scoped ranges without traversing other owners",
      sourceHighlight?.ownership === true, JSON.stringify(sourceHighlight));
    check("source mutations rebuild only valid owners and clear stale or detached ranges without changing selection",
      sourceHighlight?.mutations === true, JSON.stringify(sourceHighlight));
    check("source fallback paints exact Range bounds in its own layer without editing page text, classes or selection",
      sourceHighlight?.fallback === true, JSON.stringify(sourceHighlight));
    check("a suspended source highlight publishes nothing, ignores matches meanwhile and repaints its exact ranges",
      sourceHighlight?.restored === true, JSON.stringify(sourceHighlight));
    check("source highlighting paints text-node sources one range per glyph box and clears when a box goes",
      sourceHighlight?.textSources === true, JSON.stringify(sourceHighlight));
  });
});
