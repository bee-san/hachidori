// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiDefinitionRenderer } from "../extension/anki-glossary.js";
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

function fixture(t, options) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", options);
  t.after(() => dom.window.close());
  const request = { term: { rules: "v1", glossaries: [
    { dictionary: "A", definitionTags: "common", termTags: "", glossary: '["first", "<script>literal</script>"]' },
    { dictionary: "B", definitionTags: "", termTags: "", glossary: JSON.stringify([{ type: "structured-content", content: [
      { tag: "p", content: "second" }, { tag: "img", path: "image.png", width: 20, height: 10, title: "Picture" },
      { tag: "script", content: "never" }, { tag: "a", href: "javascript:alert(1)", content: "safe text" },
    ] }]) },
  ] }, trace: [{ name: "polite" }], dictionaryAliases: { A: "Alias <A>" }, dictionaryStyles: [],
  dictionaryMedia: [{ dictionary: "B", path: "image.png", filename: "hd-image.png" }], generation: 3 };
  return { document: dom.window.document, request };
}

test("Anki glossary export reuses the production structured renderer and preserves ordered senses, aliases and safe media", async t => {
  const { document, request } = fixture(t);
  const render = createAnkiDefinitionRenderer(document, request);
  const holder = document.createElement("div");
  holder.innerHTML = await render({});
  assert.deepEqual([...holder.querySelectorAll(".yomitan-glossary > ol > li")].map(node => node.dataset.dictionary), ["A", "B"]);
  assert.match(holder.textContent, /Alias <A>/u);
  assert.match(holder.textContent, /<script>literal<\/script>/u);
  assert.equal(holder.querySelector("script"), null);
  assert.equal(holder.querySelector('[href^="javascript:"]'), null);
  assert.equal(holder.querySelector("img").getAttribute("src"), "hd-image.png");
  assert.equal(holder.querySelector("img").getAttribute("width"), "20");
  assert.match(holder.textContent, /Rules: v1/u);
  assert.match(holder.textContent, /Deinflection: polite/u);
  assert.equal(document.body.children.length, 0, "export does not mount a popup or load images into the live document");
});

test("Smaller Anki cards leaves out the Rules/Deinflection footer that Yomitan's glossary does not write (#399)", async t => {
  // jsdom resolves no scoped CSS (test/chrome-e2e.mjs checks the cascade); a
  // silent console drops its not-implemented notices.
  const { document, request } = fixture(t, { virtualConsole: new VirtualConsole() });
  request.term.rules = "vs";
  const html = await createAnkiDefinitionRenderer(document, request, undefined, { compact: true })({});
  assert.match(html, /<i class="yomitan-glossary-meta">/u);
  assert.match(html, /<\/ol><\/div>$/u);
  assert.doesNotMatch(html, /Rules:|Deinflection:|yomitan-glossary-details/u);
});

test("Anki first/brief/plain/dictionary variants keep their distinct source meanings", async t => {
  const { document, request } = fixture(t);
  const render = createAnkiDefinitionRenderer(document, request);
  const first = await render({ firstOnly: true });
  assert.match(first, /first/u);
  assert.doesNotMatch(first, /second/u);
  const brief = await render({ dictionary: "B", brief: true });
  assert.match(brief, /second/u);
  assert.doesNotMatch(brief, /yomitan-glossary-meta|Rules:/u);
  const plain = await render({ plain: true, noDictionary: true });
  assert.match(plain, /first<br>&lt;script&gt;literal&lt;\/script&gt;/u);
  assert.doesNotMatch(plain, /<img|<script|Alias|Rules:/u);
  assert.equal(await render({ dictionary: "Missing" }), "");
  assert.match(await render({ dictionary: "A", plain: true }), /\(Alias &lt;A&gt;\)/u);
});

test("rich Anki glossaries turn dictionary line breaks into <br> as Yomitan does, and plain glossaries keep their lines", async t => {
  const { document, request } = fixture(t);
  // A note field has none of the popup's white-space: pre-wrap, so a raw newline renders as a space (#359).
  request.term.glossaries = [
    { dictionary: "A", glossary: JSON.stringify([{ type: "structured-content", content: [
      "ぜっ-たい【絶対】\n㊀〘名〙", { tag: "span", content: "\n① 他に比較するものがないこと。\n「一の真理」" },
    ] }]) },
    { dictionary: "B", glossary: JSON.stringify(["first line\r\nsecond line", { type: "text", text: "third\nfourth" }]) },
  ];
  const render = createAnkiDefinitionRenderer(document, request);
  const html = await render({});
  assert.doesNotMatch(html, /[\r\n]/u);
  const holder = document.createElement("div");
  holder.innerHTML = html;
  assert.equal(holder.querySelectorAll(".gsm-hoshidicts-glossary-content br").length, 5);
  assert.equal(holder.querySelector(".gloss-sc-span").innerHTML, "<br>① 他に比較するものがないこと。<br>「一の真理」");
  assert.equal(await render({ plain: true, noDictionary: true }), "ぜっ-たい【絶対】<br>㊀〘名〙<br>"
    + "① 他に比較するものがないこと。<br>「一の真理」<br>first line<br>second line<br>third<br>fourth");
});

test("each Anki glossary row is its own li[data-dictionary] with no nested list, as in Yomitan's glossary template", async t => {
  const { document, request } = fixture(t);
  request.term.glossaries = [
    { dictionary: "A", definitionTags: "", termTags: "", glossary: '["main entry"]' },
    { dictionary: "A", definitionTags: "子", termTags: "", glossary: '["compound list"]' },
    { dictionary: "B", definitionTags: "", termTags: "", glossary: '["other entry"]' },
  ];
  const render = createAnkiDefinitionRenderer(document, request);
  const holder = document.createElement("div");
  const items = async options => {
    holder.innerHTML = await render(options);
    return [...holder.querySelectorAll(".yomitan-glossary > ol > li")];
  };
  const all = await items({});
  assert.deepEqual(all.map(item => item.dataset.dictionary), ["A", "A", "B"]);
  // Note types page by li[data-dictionary] and pad any other list, so the entry sits directly in its item.
  assert.deepEqual(all.map(item => item.querySelector(":scope > div > .yomitan-glossary-meta")?.textContent),
    ["(Alias <A>)", "(子, Alias <A>)", "(B)"]);
  assert.deepEqual((await items({ dictionary: "A" })).map(item => item.dataset.dictionary), ["A", "A"]);
});

test("plain Anki definitions omit decorative link icons and preferred image sizes retain the intrinsic ratio", async t => {
  const { document, request } = fixture(t);
  request.term.glossaries = [{ dictionary: "B", glossary: JSON.stringify([{ type: "structured-content", content: [
    { tag: "a", href: "https://example.com/", content: "definition link" },
    { tag: "img", path: "image.png", width: 200, height: 100, preferredWidth: 400 },
    { tag: "img", path: "image.png", width: 200, height: 100, preferredHeight: 200 },
  ] }]) }];
  const render = createAnkiDefinitionRenderer(document, request);
  assert.equal(await render({ plain: true, noDictionary: true }), "definition link");
  const holder = document.createElement("div");
  holder.innerHTML = await render({});
  const [wide, tall] = holder.querySelectorAll("img");
  assert.equal(wide.style.width, "400px");
  assert.equal(wide.style.height, "auto");
  assert.equal(tall.style.height, "200px");
  assert.equal(tall.style.width, "auto");
});

test("Anki export sizes em images with CSS in em while pixel and unitless images keep their width/height attributes", async t => {
  const { document, request } = fixture(t);
  request.term.glossaries = [{ dictionary: "B", glossary: JSON.stringify([{ type: "structured-content", content: [
    // sankoku8's pitch-accent mark: HTML width/height attributes are CSS pixels, so
    // "0.5" × "1" would be a sub-pixel image on the Anki note.
    { tag: "img", path: "image.png", width: 0.5, height: 1, sizeUnits: "em" },
    { tag: "img", path: "image.png", width: 200, height: 100, preferredWidth: 2, sizeUnits: "em" },
    { tag: "img", path: "image.png", width: 200, height: 100, sizeUnits: "px" },
    { tag: "img", path: "image.png", width: 200, height: 100 },
  ] }]) }];
  const holder = document.createElement("div");
  holder.innerHTML = await createAnkiDefinitionRenderer(document, request)({});
  const [accent, preferred, pixels, unitless] = holder.querySelectorAll("img");
  assert.equal(accent.style.width, "0.5em");
  assert.equal(accent.style.height, "1em");
  assert.equal(accent.getAttribute("width"), null);
  assert.equal(accent.getAttribute("height"), null);
  assert.equal(preferred.style.width, "2em");
  assert.equal(preferred.style.height, "auto");
  assert.equal(preferred.getAttribute("width"), null);
  assert.equal(preferred.getAttribute("height"), null);
  for (const image of [pixels, unitless]) {
    assert.equal(image.getAttribute("width"), "200");
    assert.equal(image.getAttribute("height"), "100");
    assert.equal(image.style.width, "");
    assert.equal(image.style.height, "");
  }
});

test("serialized dictionary CSS cannot close its HTML style element and existing CSS escapes stay intact", async t => {
  const { document, request } = fixture(t);
  const original = globalThis.HDGlossary.applyDictionaryStyles;
  t.after(() => { globalThis.HDGlossary.applyDictionaryStyles = original; });
  globalThis.HDGlossary.applyDictionaryStyles = (doc, parent) => {
    const style = doc.createElement("style");
    style.textContent = '.x\\<y { content: "</StYlE><img src=x onerror=evil()>"; }';
    parent.append(style);
    return [style];
  };
  request.dictionaryStyles = [{ dictionary: "A", styles: "parsed by the shared native sanitizer" }];
  const html = await createAnkiDefinitionRenderer(document, request)({ dictionary: "A" });
  const holder = document.createElement("div");
  holder.innerHTML = html;
  assert.equal(holder.querySelector("img"), null);
  assert.match(holder.querySelector("style").textContent, /\.x\\<y/u);
  assert.match(holder.querySelector("style").textContent, /<\\\/StYlE>/u);
});

test("rich glossary markers carry Yomitan's structured-content inline styles", async t => {
  const { document, request } = fixture(t);
  request.term.glossaries = [{ dictionary: "B", definitionTags: "", termTags: "", glossary: JSON.stringify([{ type: "structured-content", content: [
    { tag: "table", content: [{ tag: "tr", content: [{ tag: "th", content: "表記" }, { tag: "td", style: { textAlign: "center" }, content: "絶対" }] }] },
    { tag: "span", style: { fontSize: "130%" }, content: "⟶" },
    { tag: "a", href: "https://example.com/", content: "example" },
  ] }]) }];
  const holder = document.createElement("div");
  holder.innerHTML = await createAnkiDefinitionRenderer(document, request)({});
  const style = selector => holder.querySelector(selector).getAttribute("style");
  // What Yomitan's AnkiTemplateRenderer writes for the same content at 67db60d
  // (CssStyleApplier.applyClassStyles with structured-content-style.json): the
  // class rules first, then the element's own inline style.
  assert.equal(style(".gloss-sc-table-container"), "display:block;");
  assert.equal(style(".gloss-sc-table"), "table-layout:auto;border-collapse:collapse;");
  assert.equal(style(".gloss-sc-th"),
    "font-weight:bold;border-style:solid;padding:0.25em;vertical-align:top;border-width:1px;border-color:currentColor;");
  assert.equal(style(".gloss-sc-td"),
    "border-style:solid;padding:0.25em;vertical-align:top;border-width:1px;border-color:currentColor;text-align: center;");
  assert.equal(style(".gloss-sc-span"), "font-size: 130%;");
  assert.equal(style(".gloss-link-external-icon"), "display:none;");
  const plain = await createAnkiDefinitionRenderer(document, request)({ plain: true, noDictionary: true });
  assert.doesNotMatch(plain, /style=/u, "plain markers stay unstyled");
});

test("Anki dictionary styles are scoped by selector prefix rather than @scope", async t => {
  const { document, request } = fixture(t);
  request.dictionaryStyles = [{ dictionary: "A \"quoted\"", styles: [
    ".gloss-sc-strong, [data-sc-content=\"a,b\"] :is(.x, .y)::before { color: red }",
    "@media (min-width: 1px) { .gloss-sc-span { color: blue } }",
    "@font-face { font-family: page }",
  ].join("\n") }];
  request.term.glossaries = [{ dictionary: "A \"quoted\"", definitionTags: "", termTags: "", glossary: '["first"]' }];
  const holder = document.createElement("div");
  holder.innerHTML = await createAnkiDefinitionRenderer(document, request)({});
  const css = holder.querySelector("style").textContent;
  const scope = `.yomitan-glossary [data-dictionary=${document.defaultView.CSS.escape("A \"quoted\"")}]`;
  assert.doesNotMatch(css, /@scope|@font-face/u);
  const sheet = new document.defaultView.CSSStyleSheet();
  sheet.replaceSync(css);
  const selectors = [...sheet.cssRules].flatMap(rule => rule.selectorText ?? [...rule.cssRules].map(inner => inner.selectorText));
  assert.deepEqual(selectors.map(selector => selector.replaceAll(scope, "SCOPE")), [
    "SCOPE .gloss-sc-strong, SCOPE [data-sc-content=\"a,b\"] :is(.x, .y)::before",
    "SCOPE .gloss-sc-span",
  ]);
  assert.ok(holder.querySelector("li[data-dictionary]").matches(scope), "the scope selects the dictionary's own list item");
});
