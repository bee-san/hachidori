// SPDX-License-Identifier: GPL-3.0-or-later
// Dictionary markup against Yomitan's own renderer. Expected values are what
// yomidevs/yomitan@67db60d produces for the same input under the same jsdom;
// the generating function is named with each group, so no Yomitan checkout is
// needed at test time.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function fixture(t) {
  const { window } = new JSDOM("<!doctype html><body></body>",
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/" });
  for (const file of ["external-links.js", "render/glossary.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  t.after(() => window.close());
  const { document, HDGlossary } = window;
  return (content) => {
    const parent = document.createElement("div");
    HDGlossary.appendStructuredValue(document, parent, content,
      { nodes: 0, resolveMedia: () => new Promise(() => {}) }, 0);
    return parent.firstElementChild;
  };
}

// StructuredContentGenerator._setStructuredContentElementStyle on
// {tag: "span", style, content: "x"}: the resulting style attribute.
const YOMITAN_STYLES = [
  // JMdict [2026-09-18] draws every ⟶ cross-reference 30 % larger.
  [{ fontSize: "130%" }, "font-size: 130%;"],
  [{ fontSize: "small" }, "font-size: small;"],
  [{ fontSize: "calc(1em - 2px)" }, "font-size: calc(1em - 2px);"],
  [{ fontSize: ".5em" }, "font-size: 0.5em;"],
  [{ fontSize: "12pt" }, "font-size: 12pt;"],
  [{ marginLeft: "20em", paddingLeft: "300px" }, "margin-left: 20em; padding-left: 300px;"],
  [{ background: "linear-gradient(red, blue)" }, "background: linear-gradient(red, blue);"],
  [{ borderStyle: "solid", borderWidth: "thin" }, "border-style: solid; border-width: thin;"],
  // Numeric margin longhands are em, and the shorthand goes first whatever
  // the dictionary's key order.
  [{ marginTop: 0.5, marginBottom: -1, margin: "0 auto" }, "margin: 0.5em auto -1em;"],
  [{ padding: "1em 2em", paddingTop: "0" }, "padding: 0px 2em 1em;"],
  [{ textDecorationLine: ["underline", "overline"], textDecorationStyle: "wavy", textDecorationColor: "red" },
    "text-decoration: underline overline; text-decoration-style: wavy; text-decoration-color: red;"],
  [{ fontWeight: "bold", fontStyle: "italic", color: "color-mix(in srgb, red 50%, blue)" },
    "font-style: italic; font-weight: bold; color: color-mix(in srgb, red, blue);"],
  [{ verticalAlign: "super", textAlign: "center", whiteSpace: "pre-line", wordBreak: "keep-all", cursor: "help",
    listStyleType: "\"※ \"" },
  "vertical-align: super; text-align: center; word-break: keep-all; white-space: pre-line; cursor: help; list-style-type: \"※ \";"],
  [{ borderColor: "currentColor", borderRadius: "0.25em", clipPath: "inset(0 0 0 0)", textEmphasis: "filled red",
    textShadow: "1px 1px 2px red" },
  "text-emphasis: filled red; text-shadow: 1px 1px 2px red; border-color: currentcolor; border-radius: 0.25em; clip-path: inset(0 0 0 0);"],
  // Only strings are styles, apart from the numeric margin longhands above.
  [{ fontWeight: 700, fontSize: 14, margin: 1, padding: 2 }, null],
];

test("structured-content inline styles are applied as Yomitan applies them", t => {
  const render = fixture(t);
  for (const [style, expected] of YOMITAN_STYLES) {
    const span = render({ tag: "span", style, content: "x" });
    assert.equal(span.getAttribute("style"), expected, JSON.stringify(style));
  }
});

test("inline styles still refuse values that could fetch or read page state", t => {
  const render = fixture(t);
  for (const value of ["url(x)", "URL (x)", "no-repeat url(x)", "image-set(\"x.png\" 1x)",
    "-webkit-image-set(\"x.png\" 1x)", "cross-fade(url(x), red)", "paint(page-worklet)", "src(\"x\")",
    "attr(data-sc-x)", "var(--page-color)", "VAR (--page-color)", "--page-function(red)", "\\75 rl(x)",
    "linear-gradient(red, \\62 lue)"]) {
    const span = render({ tag: "span", style: { background: value, cursor: value, fontSize: "130%" }, content: "x" });
    assert.equal(span.getAttribute("style"), "font-size: 130%;", value);
  }
});

test("an image's border and border radius follow the same rule", t => {
  const render = fixture(t);
  const container = (image) => render({ tag: "img", path: "img/a.png", ...image })
    .querySelector(".gloss-image-container");
  const styled = container({ border: "thin dotted red", borderRadius: "50% / 10%" });
  assert.equal(styled.style.getPropertyValue("border"), "thin dotted red");
  assert.equal(styled.style.getPropertyValue("border-radius"), "50% / 10%");
  const refused = container({ border: "var(--page-border)", borderRadius: "attr(data-sc-r)" });
  assert.equal(refused.style.getPropertyValue("border"), "");
  assert.equal(refused.style.getPropertyValue("border-radius"), "");
});

// DisplayGenerator._createTermDefinition (templates-display.html definition-item
// and gloss-item) on one term-bank row with dictionary "D": its ul.gloss-list.
// The rows are the dictionary's own, as hoshidicts hands them to the popup.
// For images Yomitan rendered the row its importer stores: _createImageData
// makes the dictionary's size the preferred size, beside the media's own 16px.
const sc = content => ({ type: "structured-content", content });
const YOMITAN_GLOSS_LISTS = [
  ["a plain string's newlines become <br>", ["to eat\nto live on"],
    '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content" lang="ja">to eat<br>to live on</span></li></ul>'],
  ["Pixiv's indented continuation lines keep their text", ["ゲーム\n  主人公の名前。  愛称は「アキ」。"],
    '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content" lang="ja">ゲーム<br>  主人公の名前。  愛称は「アキ」。</span></li></ul>'],
  ["each element is its own item", ["to eat", "to live on"],
    '<ul class="gloss-list" data-count="2"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content" lang="ja">to eat</span></li><li class="gloss-item click-scannable" data-index="1"><span class="gloss-separator"> </span><span class="gloss-content" lang="ja">to live on</span></li></ul>'],
  ["form-of data is not a gloss", [["食べる", ["past"]], "kept"],
    '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content" lang="ja">kept</span></li></ul>'],
  ["JMdict [2026-09-18] redirect span", [sc({ tag: "span", style: { fontSize: "130%" }, content: ["⟶",
    { tag: "a", href: "?query=阿吽の呼吸", lang: "ja", content: "阿吽の呼吸" }] })],
  '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content structured-content"><span class="gloss-sc-span" style="font-size: 130%;">⟶<a class="gloss-link" data-external="false" lang="ja" href="https://extension.test/search.html?query=阿吽の呼吸"><span class="gloss-link-text">阿吽の呼吸</span></a></span></span></li></ul>'],
  ["Jitendex gaiji 乄 inside 〆粕", [sc([{ tag: "img", path: "img/乄.svg", width: 1, height: 1, sizeUnits: "em",
    appearance: "monochrome", background: false, collapsible: false }, "粕"])],
  '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content structured-content" lang="ja"><a class="gloss-image-link" target="_blank" rel="noreferrer noopener" data-path="img/乄.svg" data-dictionary="D" data-image-load-state="not-loaded" data-has-aspect-ratio="true" data-image-rendering="auto" data-appearance="monochrome" data-background="false" data-collapsed="false" data-collapsible="false" data-size-units="em"><span class="gloss-image-container" style="width: 1em;"><span class="gloss-image-sizer" style="padding-top: 100%;"></span><span class="gloss-image-background"></span><span class="gloss-image-container-overlay"></span><img class="gloss-image" style="width: 100%; height: 100%;" width="28" height="28"></span><span class="gloss-image-link-text">Image</span></a>粕</span></li></ul>'],
  ["an image glossary shows its description", [{ type: "image", path: "img/b.png", width: 40, height: 20,
    title: "t", description: "caption\n二行目" }],
  '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content"><a class="gloss-image-link" target="_blank" rel="noreferrer noopener" data-path="img/b.png" data-dictionary="D" data-image-load-state="not-loaded" data-has-aspect-ratio="true" data-image-rendering="auto" data-appearance="auto" data-background="true" data-collapsed="false" data-collapsible="true"><span class="gloss-image-container" style="width: 40em;" title="t"><span class="gloss-image-sizer" style="padding-top: 50%;"></span><span class="gloss-image-background"></span><span class="gloss-image-container-overlay"></span><img class="gloss-image" width="40" height="20" style="width: 100%; height: 100%;"></span><span class="gloss-image-link-text">Image</span></a> <span class="gloss-image-description" lang="ja">caption<br>二行目</span></span></li></ul>'],
  ["a table's Japanese cells are labelled", [sc({ tag: "table", content: [{ tag: "tr", content: [
    { tag: "th", content: "表記" }, { tag: "td", content: ["絶対", { tag: "br" }, "absolute"] }] }] })],
  '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content structured-content"><div class="gloss-sc-table-container"><table class="gloss-sc-table"><tr class="gloss-sc-tr"><th class="gloss-sc-th" lang="ja">表記</th><td class="gloss-sc-td" lang="ja">絶対<br class="gloss-sc-br">absolute</td></tr></table></div></span></li></ul>'],
  ["an external link", [sc({ tag: "div", content: ["See ", { tag: "a", href: "https://example.com/", content: "example" }] })],
    '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content structured-content"><div class="gloss-sc-div">See <a class="gloss-link" data-external="true" href="https://example.com/" target="_blank" rel="noreferrer noopener"><span class="gloss-link-text">example</span><span class="gloss-link-external-icon icon" data-icon="external-link"></span></a></div></span></li></ul>'],
  ["a dictionary's own lang stops detection below it", [sc(["x", { tag: "div", content: ["abc", "直す",
    { tag: "span", lang: "en", content: ["直", { tag: "span", content: "日本" }] }] },
  { tag: "ruby", content: ["漢", { tag: "rt", content: "かん" }] }])],
  '<ul class="gloss-list" data-count="1"><li class="gloss-item click-scannable" data-index="0"><span class="gloss-separator"> </span><span class="gloss-content structured-content">x<div class="gloss-sc-div" lang="ja">abc直す<span class="gloss-sc-span" lang="en">直<span class="gloss-sc-span">日本</span></span></div><ruby class="gloss-sc-ruby" lang="ja">漢<rt class="gloss-sc-rt" lang="ja">かん</rt></ruby></span></li></ul>'],
];

// The documented differences. Hachidori adds its own hooks: gsm-hoshidicts-*
// classes and data attributes, the gloss-sc-a/gloss-sc-img gaiji hooks,
// img alt/draggable/decoding and aria-hidden on the decorative link icon, and
// resolves internal links itself rather than through a search-page href.
// Yomitan draws popup images on a canvas sized by width/height attributes, and
// writes image boxes in em where Hachidori writes px (both containers make
// 1em one pixel). Hachidori's image layer is an <img> that a dictionary's
// `img` rules can reach, so it pins that layer's margin and padding inline.
// Yomitan's DisplayGenerator labels a glossary string with the profile
// language ("ja") even when it has no Japanese, so English glosses would read
// as Japanese to assistive technology; here glossary strings get the same
// detection as structured-content text.
const JAPANESE_OR_CHINESE = /[\u3000-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uffee]/u;
function canonical(element, side) {
  if (element.nodeType === element.TEXT_NODE) return element.nodeValue;
  const children = () => [...element.childNodes].map(child => canonical(child, side)).join("");
  // Re-parsing the reference string adds the tbody an HTML parser implies.
  if (side === "yomitan" && element.localName === "tbody" && !element.attributes.length) return children();
  const attributes = [...element.attributes].map(({ name, value }) => [name, value]).filter(([name]) =>
    !(side === "hachidori" && (/^data-hoshidicts-/u.test(name) || name === "aria-hidden"
      || (element.localName === "img" && ["alt", "draggable", "decoding"].includes(name))))
    && !(side === "yomitan" && element.localName === "img" && ["width", "height"].includes(name))
    && !(name === "href" && element.dataset.external === "false")
    && !(side === "yomitan" && name === "lang" && element.matches(".gloss-content:not(.structured-content), .gloss-image-description")
      && !JAPANESE_OR_CHINESE.test(element.textContent)))
    .map(([name, value]) => {
      if (name === "class") {
        value = value.split(" ").filter(token => !/^gsm-hoshidicts-|^gloss-sc-(?:a|img)$/u.test(token)).sort().join(" ");
      } else if (name === "rel") value = value.split(" ").sort().join(" ");
      else if (side === "hachidori" && name === "style" && element.localName === "img") {
        value = value.replace(/ margin: 0px; padding: 0px;$/u, "");
      } else if (name === "style") value = value.replace(/(\d)em;/gu, (match, digit) =>
        element.matches(".gloss-image-link:not([data-size-units=em]) > .gloss-image-container") ? `${digit}px;` : match);
      return `${name}=${JSON.stringify(value)}`;
    }).sort();
  return `<${element.localName}${attributes.map(attribute => ` ${attribute}`).join("")}>${children()}</${element.localName}>`;
}

test("glossary markup matches Yomitan's gloss list", t => {
  const { window } = new JSDOM("<!doctype html><body></body>",
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/" });
  for (const file of ["external-links.js", "render/glossary.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  t.after(() => window.close());
  const { document, HDGlossary } = window;
  for (const [name, entries, expected] of YOMITAN_GLOSS_LISTS) {
    const parent = document.createElement("div");
    HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify(entries),
      { dictionary: "D", resolveMedia: () => new Promise(() => {}) });
    const yomitan = document.createElement("div");
    yomitan.innerHTML = expected;
    assert.equal(canonical(parent.firstElementChild, "hachidori"), canonical(yomitan.firstElementChild, "yomitan"), name);
  }
});

test("each term-bank row is a definition-item that carries its dictionary and tag list", t => {
  const { window } = new JSDOM('<p>直す</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/" });
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const { document, HDGlossary, HDPopup, HDReaderOptions } = window;
  const popup = document.getElementById("popup");
  const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
    appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent });
  t.after(() => { view.destroy(); window.close(); });
  const source = document.querySelector("p");
  view.renderResults([{ matched: "直す", deinflected: "直す", trace: [], term: { expression: "直す", reading: "なおす",
    rules: "", frequencies: [], pitches: [], glossaries: [
      { dictionary: "D", glossary: JSON.stringify(["to fix"]), definitionTags: "v5s vt", termTags: "" },
      { dictionary: "D", glossary: JSON.stringify(["to cure", "to heal"]), definitionTags: "", termTags: "" },
    ] } }], { anchor: source, query: "直す", sentence: "直す", sourceElements: [source], matchOffset: 0 },
  HDReaderOptions.normaliseOptions({}));
  const list = popup.querySelector(".gsm-hoshidicts-glossary-card > ol.definition-list");
  assert.equal(list.dataset.count, "2");
  const items = [...list.children];
  assert.deepEqual(items.map(item => [item.className, item.dataset.dictionary, item.dataset.index]),
    [["definition-item", "D", "0"], ["definition-item", "D", "1"]]);
  assert.deepEqual([...items[0].querySelectorAll(".definition-tag-list > *")].map(tag => tag.textContent), ["v5s", "vt"]);
  assert.equal(items[1].querySelector(".definition-tag-list"), null);
  assert.deepEqual(items.map(item => item.querySelector(".gloss-list").dataset.count), ["1", "2"]);
  assert.equal(popup.querySelector(".gsm-hoshidicts-expression").lang, "ja");
});

// PronunciationGenerator.createPronunciationText / createPronunciationDownstepPosition /
// createPronunciationGraph on getKanaMorae(reading). "LHL" and 2 are the same accent.
const HASHI_TEXT = '<span class="pronunciation-text"><span class="pronunciation-mora" data-position="0" data-pitch="low" data-pitch-next="high"><span class="pronunciation-character">は</span><span class="pronunciation-mora-line"></span></span><span class="pronunciation-mora" data-position="1" data-pitch="high" data-pitch-next="low"><span class="pronunciation-character">し</span><span class="pronunciation-mora-line"></span></span></span>';
const HASHI_POSITION = '<span class="pronunciation-downstep-notation" data-downstep-position="2"><span class="pronunciation-downstep-notation-prefix">[</span><span class="pronunciation-downstep-notation-number">2</span><span class="pronunciation-downstep-notation-suffix">]</span></span>';
const HASHI_GRAPH = '<svg xmlns="http://www.w3.org/2000/svg" class="pronunciation-graph" focusable="false" viewBox="0 0 150 100"><path class="pronunciation-graph-line" d="M25 75 L75 25"></path><path class="pronunciation-graph-line-tail" d="M75 25 L125 75"></path><circle class="pronunciation-graph-dot" cx="25" cy="75" r="15"></circle><circle class="pronunciation-graph-dot-downstep1" cx="75" cy="25" r="15"></circle><circle class="pronunciation-graph-dot-downstep2" cx="75" cy="25" r="5"></circle><path class="pronunciation-graph-triangle" d="M0 13 L15 -13 L-15 -13 Z" transform="translate(125,75)"></path></svg>';
const YOMITAN_PRONUNCIATIONS = [
  ["はし", "LHL", [], [], HASHI_TEXT, HASHI_POSITION, HASHI_GRAPH],
  ["はし", 2, [], [], HASHI_TEXT, HASHI_POSITION, HASHI_GRAPH],
  ["がくせい", 0, [1], [2],
    '<span class="pronunciation-text"><span class="pronunciation-mora" data-position="0" data-pitch="low" data-pitch-next="high" data-nasal="true" data-original-text="が"><span class="pronunciation-character-group"><span class="pronunciation-character" data-original-text="が">か</span><span class="pronunciation-nasal-diacritic">゚</span><span class="pronunciation-nasal-indicator"></span></span><span class="pronunciation-mora-line"></span></span><span class="pronunciation-mora" data-position="1" data-pitch="high" data-pitch-next="high" data-devoice="true"><span class="pronunciation-character">く</span><span class="pronunciation-devoice-indicator"></span><span class="pronunciation-mora-line"></span></span><span class="pronunciation-mora" data-position="2" data-pitch="high" data-pitch-next="high"><span class="pronunciation-character">せ</span><span class="pronunciation-mora-line"></span></span><span class="pronunciation-mora" data-position="3" data-pitch="high" data-pitch-next="high"><span class="pronunciation-character">い</span><span class="pronunciation-mora-line"></span></span></span>',
    '<span class="pronunciation-downstep-notation" data-downstep-position="0"><span class="pronunciation-downstep-notation-prefix">[</span><span class="pronunciation-downstep-notation-number">0</span><span class="pronunciation-downstep-notation-suffix">]</span></span>',
    '<svg xmlns="http://www.w3.org/2000/svg" class="pronunciation-graph" focusable="false" viewBox="0 0 250 100"><path class="pronunciation-graph-line" d="M25 75 L75 25 L125 25 L175 25"></path><path class="pronunciation-graph-line-tail" d="M175 25 L225 25"></path><circle class="pronunciation-graph-dot" cx="25" cy="75" r="15"></circle><circle class="pronunciation-graph-dot" cx="75" cy="25" r="15"></circle><circle class="pronunciation-graph-dot" cx="125" cy="25" r="15"></circle><circle class="pronunciation-graph-dot" cx="175" cy="25" r="15"></circle><path class="pronunciation-graph-triangle" d="M0 13 L15 -13 L-15 -13 Z" transform="translate(225,25)"></path></svg>'],
];

test("pitch accents are drawn with Yomitan's PronunciationGenerator markup", t => {
  const { window } = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  for (const file of ["external-links.js", "render/glossary.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  t.after(() => window.close());
  const { document, HDGlossary } = window;
  for (const [reading, positions, nasal, devoice, text, position, graph] of YOMITAN_PRONUNCIATIONS) {
    const morae = HDGlossary.splitPitchAccentMorae(reading);
    const name = `${reading} ${positions}`;
    assert.equal(HDGlossary.createPronunciationText(document, morae, positions, nasal, devoice).outerHTML, text, name);
    assert.equal(HDGlossary.createPronunciationDownstepPosition(document, positions).outerHTML, position, name);
    assert.equal(HDGlossary.createPronunciationGraph(document, morae, positions).outerHTML, graph, name);
  }
  // The engine's shape for "LHL" is { position: 0, pattern: "LHL" }.
  const item = HDGlossary.createPronunciationPitchAccent(document, "はし",
    { position: 0, pattern: "LHL", nasal: [], devoice: [] }, { graph: true });
  assert.equal(item.dataset.pitchAccentDownstepPosition, "LHL");
  assert.equal(item.querySelector(".pronunciation-text-container").innerHTML, HASHI_TEXT);
  assert.equal(item.querySelector(".pronunciation-downstep-notation-container").innerHTML, HASHI_POSITION);
  assert.equal(item.querySelector(".pronunciation-graph-container").innerHTML, HASHI_GRAPH);
});
