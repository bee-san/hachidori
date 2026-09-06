// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiDefinitionRenderer } from "../extension/anki-glossary.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

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

test("Anki glossary export reuses the production structured renderer and preserves ordered senses, aliases and safe media", t => {
  const { document, request } = fixture(t);
  const render = createAnkiDefinitionRenderer(document, request);
  const holder = document.createElement("div");
  holder.innerHTML = render({});
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

test("Anki first/brief/plain/dictionary variants keep their distinct source meanings", t => {
  const { document, request } = fixture(t);
  const render = createAnkiDefinitionRenderer(document, request);
  const first = render({ firstOnly: true });
  assert.match(first, /first/u);
  assert.doesNotMatch(first, /second/u);
  const brief = render({ dictionary: "B", brief: true });
  assert.match(brief, /second/u);
  assert.doesNotMatch(brief, /yomitan-glossary-meta|Rules:/u);
  const plain = render({ plain: true, noDictionary: true });
  assert.match(plain, /first<br>&lt;script&gt;literal&lt;\/script&gt;/u);
  assert.doesNotMatch(plain, /<img|<script|Alias|Rules:/u);
  assert.equal(render({ dictionary: "Missing" }), "");
  assert.match(render({ dictionary: "A", plain: true }), /\(Alias &lt;A&gt;\)/u);
});

test("serialized dictionary CSS cannot close its HTML style element and existing CSS escapes stay intact", t => {
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
  const html = createAnkiDefinitionRenderer(document, request)({ dictionary: "A" });
  const holder = document.createElement("div");
  holder.innerHTML = html;
  assert.equal(holder.querySelector("img"), null);
  assert.match(holder.querySelector("style").textContent, /\.x\\<y/u);
  assert.match(holder.querySelector("style").textContent, /<\\\/StYlE>/u);
});
