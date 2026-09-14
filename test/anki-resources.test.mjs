// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildAnkiResourceFields } from "../extension/anki-resources.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

function fixture(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  t.after(() => dom.window.close());
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [
    { dictionary: "A", glossary: JSON.stringify([{ type: "structured-content", content: [
      { tag: "img", path: "猫.png" }, { tag: "img", path: "猫.png" },
    ] }]) },
    { dictionary: "B", glossary: JSON.stringify([{ type: "image", path: "unused.png" }]) },
  ] }, trace: [], dictionaryAliases: {}, frequencyDictionaries: [], generation: 2 };
  return { document: dom.window.document, request };
}
const template = value => ({ value, overwriteMode: "coalesce" });

test("Anki media planning is lazy, deduplicated and bound to the committed dictionary generation", async t => {
  const { document, request } = fixture(t);
  let styles = 0;
  const resources = { document, dictionaryPaths: { A: "/dicts/generation-a/A", B: "/dicts/generation-b/B" },
    styles: async () => { styles++; return []; } };
  const plain = await buildAnkiResourceFields(request, { Front: template("{expression}") }, resources);
  assert.deepEqual(plain, { fields: { Front: "猫" }, media: [] });
  assert.equal(styles, 0, "ordinary expression fields do no glossary or stylesheet work");
  const fields = { Front: template("{glossary-first}"), Back: template("{single-glossary-a}") };
  const result = await buildAnkiResourceFields(request, fields, resources);
  assert.equal(styles, 1, "concurrent glossary variants share style loading");
  assert.equal(result.media.length, 1, "repeated paths across images and fields share one planned upload");
  assert.equal(result.media[0].dictionary, "A");
  assert.equal(result.media[0].path, "猫.png");
  assert.match(result.media[0].filename, /^hachidori_[0-9a-f]{64}\.png$/u);
  assert.ok(result.fields.Front.includes(result.media[0].filename));
  assert.ok(result.fields.Back.includes(result.media[0].filename));
  const again = await buildAnkiResourceFields({ ...request, generation: 9 }, fields, resources);
  assert.equal(again.media[0].filename, result.media[0].filename, "engine restart does not rename a committed image");
  resources.dictionaryPaths.A = "/dicts/reimport/A";
  const replaced = await buildAnkiResourceFields(request, fields, resources);
  assert.notEqual(replaced.media[0].filename, result.media[0].filename, "reimport cannot overwrite another generation's media");
});

test("plain glossary fields neither load CSS nor plan media, while unavailable rich generations are rejected", async t => {
  const { document, request } = fixture(t);
  const resources = { document, dictionaryPaths: {}, styles: () => assert.fail("Plain glossary must not load CSS") };
  assert.deepEqual((await buildAnkiResourceFields(request, { Front: template("{glossary-plain}") }, resources)).media, []);
  await assert.rejects(buildAnkiResourceFields(request, { Front: template("{glossary}") }, { ...resources, styles: async () => [] }),
    /dictionary generation is no longer available/u);
});
