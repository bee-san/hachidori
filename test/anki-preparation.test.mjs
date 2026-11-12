// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import "../extension/reader-options.js";
import { createAnkiPreparationService, preparationData } from "../extension/anki-preparation-service.js";
import { userScriptSource } from "../extension/custom-javascript.js";
import { buildAnkiFields } from "../extension/anki-values.js";

const code = 'HDAnkiPreparation.register("examples", async (context, { request }) => ({ example: (await (await request("https://example.org/sentences", { method: "POST", body: context.term.expression })).json()).sentence }));';
const script = { id: "sentences", name: "Sentences", enabled: true, javascript: code, css: "" };
const selected = { scriptId: script.id, handlerId: "examples" };
const source = `function () {\n${code}\n}`;
const sender = { id: "extension", tab: { id: 3 }, frameId: 0, documentId: "document-a" };

function fixture() {
  let scripts = [script];
  const requests = [];
  const service = createAnkiPreparationService({ readScripts: async () => scripts,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ sentence: "猫はここ。" }), { status: 200 });
    } });
  return { service, requests, setScripts: next => { scripts = next; } };
}

test("Template preparation references normalize, validate and survive a legacy projection edit", () => {
  const { normaliseAnki, validateOptionsPatch } = globalThis.HDReaderOptions;
  const config = normaliseAnki({ model: "Basic", preparationScript: selected });
  assert.deepEqual(config.templates[0].preparationScript, selected);
  assert.deepEqual(validateOptionsPatch({ anki: config }).anki.templates[0].preparationScript, selected);
  assert.deepEqual(normaliseAnki({ ...config, deck: "Words" }).templates[0].preparationScript, selected);
  assert.equal(normaliseAnki({ preparationScript: { scriptId: 2, handlerId: "a" } }).preparationScript, null);
  assert.throws(() => validateOptionsPatch({ anki: { ...config, preparationScript: { ...selected, extra: true } } }), /invalid reader option/u);
});

test("preparation runs only when asked, exports named data, and authenticated requests end with its operation", async () => {
  const f = fixture();
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL("../extension/anki-preparation-runtime.js", import.meta.url), "utf8"), context);
  vm.runInContext(userScriptSource(script), context);
  assert.equal(f.requests.length, 0, "registration does not request external data");
  const descriptor = context.HDAnkiPreparation.describe(selected);
  assert.equal(descriptor.source, source);
  const operationId = await f.service.begin(sender, selected, descriptor.source);
  await assert.rejects(f.service.request({ ...sender, documentId: "other" }, operationId, "https://example.org/"), /document/u);
  const result = await context.HDAnkiPreparation.execute(selected, { term: { expression: "猫" } },
    (url, options) => f.service.request(sender, operationId, url, options));
  assert.deepEqual(await f.service.finish(sender, operationId, result), { example: "猫はここ。" });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.credentials, "omit");
  await assert.rejects(f.service.request(sender, operationId, "https://example.org/"), /active/u);
  assert.deepEqual(f.service.diagnostics(), { registeredDocuments: 0, registeredHandlers: 0, activePreparations: 0, lastFailure: null });
});

test("a disabled, changed or missing script cannot prepare or continue its external requests", async () => {
  const f = fixture();
  await assert.rejects(f.service.begin(sender, selected, "outdated"), /changed/u);
  const operationId = await f.service.begin(sender, selected, source);
  f.setScripts([{ ...script, enabled: false }]);
  await assert.rejects(f.service.request(sender, operationId, "https://example.org/"), /disabled|unavailable/u);
  await assert.rejects(f.service.finish(sender, operationId, { example: "old" }), /disabled|unavailable/u);
  assert.equal(f.requests.length, 0);
});

test("named preparation markers are escaped and JSON data rejects unsupported values", async () => {
  const request = { term: { expression: "猫", reading: "ねこ", glossaries: [], frequencies: [], pitches: [] },
    sentence: "猫", matched: "猫", matchOffset: 0, dictionaryAliases: {}, preparation: { example: '<b>猫</b>{{c1::x}}' } };
  const fields = await buildAnkiFields(request, { Back: { value: "{preparation-example}", overwriteMode: "coalesce" } }, {});
  assert.equal(fields.Back, "&lt;b&gt;猫&lt;/b&gt;&#123;&#123;c1::x&#125;&#125;");
  for (const value of [null, [], { bad: undefined }, { bad: NaN }, { bad: () => {} }]) assert.throws(() => preparationData(value), /JSON|object/u);
  assert.deepEqual(preparationData({ example: ["a", { extra: true }] }), { example: ["a", { extra: true }] });
});
