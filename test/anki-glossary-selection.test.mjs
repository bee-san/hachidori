// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createAnkiDefinitionRenderer } from "../extension/anki-glossary.js";
import { buildAnkiFields } from "../extension/anki-values.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM || resolve(homedir(), ".cache/hachidori-e2e")] }));
const source = () => ({ generation: 1, term: { expression: "猫", reading: "ねこ", rules: "", frequencies: [], pitches: [], glossaries: [
  { dictionary: "A", glossary: '["first"]' },
  { dictionary: "B", glossary: JSON.stringify([{ type: "structured-content", content: ["猫 repeated ", { tag: "em", content: "猫 repeated" }, " suffix"] }]) },
  { dictionary: "B", glossary: '["another row"]' },
] }, trace: [], dictionaryAliases: {}, dictionaryStyles: [], dictionaryMedia: [] });

test("selected glossary preserves a complete exact row and highlights only the chosen source occurrence", async t => {
  const dom = new JSDOM("<!doctype html>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const request = source();
  request.glossarySelection = { dictionary: "B", index: 0, ranges: [{ path: ["glossary", 0, "content", 1, "content"], start: 0, end: 1 }] };
  const renderer = createAnkiDefinitionRenderer(document, request);
  const html = await renderer({ selectedOnly: true, selection: request.glossarySelection });
  const holder = document.createElement("div");
  holder.innerHTML = html;
  assert.equal(holder.querySelectorAll("li[data-dictionary]").length, 1);
  assert.equal(holder.querySelector("b").textContent, "猫");
  assert.equal(holder.querySelectorAll("b").length, 1);
  assert.match(holder.textContent, /猫 repeated 猫 repeated suffix/u);
  assert.doesNotMatch(html, /first|another row/u);
  assert.match(await renderer({}), /first/u, "legacy glossary retains all rows");
});

test("selected marker aliases share the source and first fallback exports one row", async () => {
  const request = source();
  const options = [];
  const fields = await buildAnkiFields(request, { Back: { value: "{selected-glossary}|{glossary-selection}", overwriteMode: "coalesce" } },
    { definition: value => { options.push(value); return "selected"; } });
  assert.equal(fields.Back, "selected|selected");
  assert.equal(options.length, 1);
  assert.deepEqual(options[0], { selectedOnly: true, selection: undefined, brief: true });
});

test("popup and Anki text paths agree across multiline text, repeated strings and UTF-16 characters", async t => {
  const dom = new JSDOM("<!doctype html>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const request = source();
  request.term.glossaries[1].glossary = '["same\\n🍵same", {"type":"text","text":"same"}]';
  const popup = document.createElement("div");
  globalThis.HDGlossary.appendTextOnlyGlossary(document, popup, request.term.glossaries[1].glossary, { trackSelection: true });
  const text = popup.querySelector(".gloss-content").lastChild;
  const range = document.createRange();
  range.setStart(text, 2); range.setEnd(text, 6);
  const ranges = globalThis.HDGlossary.glossarySelectionRanges(range, popup);
  assert.deepEqual(ranges, [{ path: ["glossary", 0], start: 7, end: 11 }]);
  const html = await createAnkiDefinitionRenderer(document, request)({ selectedOnly: true, selection: { dictionary: "B", index: 0, ranges } });
  assert.match(html, /🍵<b>same<\/b>/u);
  assert.equal((html.match(/<b>/gu) ?? []).length, 1);
});

// The text themes must preserve their exact existing presentation while
// exporting ranges through the same rich renderer as Default.
test("plain popup fragments preserve list/table layout and exact repeated source paths", async t => {
  const dom = new JSDOM("<!doctype html>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  for (const raw of ['  raw text\nnext line  ', JSON.stringify([{ type: "structured-content", content: [
    { tag: "ol", content: [{ tag: "li", content: "same" }, { tag: "li", content: "same" }] },
    { tag: "table", content: { tag: "tr", content: [{ tag: "td", content: "猫" }, { tag: "td", content: "same" }] } },
  ] }])]) {
    const holder = document.createElement("div");
    globalThis.HDGlossary.appendPlainGlossary(document, holder, raw, null);
    assert.equal(holder.textContent, globalThis.HDGlossary.glossaryToPlainText(raw));
    const last = holder.lastChild;
    if (raw.startsWith("[")) {
      const walker = document.createTreeWalker(holder, 4);
      const occurrences = [];
      while (walker.nextNode()) if (walker.currentNode.textContent === "same") occurrences.push(walker.currentNode);
      const range = document.createRange(); range.selectNodeContents(occurrences[1]);
      assert.deepEqual(globalThis.HDGlossary.glossarySelectionRanges(range, holder), [{
        path: ["glossary", 0, "content", 0, "content", 1, "content"], start: 0, end: 4,
      }]);
    } else assert.ok(last.textContent.includes("next line"));
  }
});
