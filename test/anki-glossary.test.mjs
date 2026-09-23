// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiDefinitionRenderer } from "../extension/anki-glossary.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

function fixture(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
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
