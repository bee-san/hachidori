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
  assert.doesNotThrow(() => validateOptionsPatch({ anki: { ...config, preparationScript: { handlerId: selected.handlerId, scriptId: selected.scriptId } } }));
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

test("native USER_SCRIPT ports run a preparation and route only its own external requests", async () => {
  const f = fixture();
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const listener of this.listeners) listener(value); } });
  const client = { onMessage: event(), onDisconnect: event() };
  const server = { name: "hachidori-anki-preparation", sender, onMessage: event(), onDisconnect: event() };
  client.postMessage = value => queueMicrotask(() => server.onMessage.emit(structuredClone(value)));
  server.postMessage = value => queueMicrotask(() => client.onMessage.emit(structuredClone(value)));
  const context = vm.createContext({ addEventListener() {}, chrome: { runtime: { connect() { f.service.connect(server); return client; } } } });
  vm.runInContext(await readFile(new URL("../extension/anki-preparation-runtime.js", import.meta.url), "utf8"), context);
  context.HDAnkiPreparation.enableNative();
  vm.runInContext(userScriptSource(script), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.service.execute(sender, selected, { term: { expression: "猫" } }), { example: "猫はここ。" });
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.service.execute({ ...sender, documentId: "other" }, selected, {}), /unavailable/u);
  const waiting = { ...script, javascript: 'HDAnkiPreparation.register("wait", async (_context, { request }) => { await new Promise(resolve => { globalThis.continuePreparation = resolve; }); return { example: (await request("https://example.org/late")).status }; });' };
  f.setScripts([waiting]);
  vm.runInContext(userScriptSource(waiting), context);
  await new Promise(resolve => setImmediate(resolve));
  const selectedWait = { scriptId: script.id, handlerId: "wait" };
  const operationId = await f.service.beginNative(sender, selectedWait);
  const executing = f.service.execute(sender, selectedWait, {}, operationId);
  const rejected = assert.rejects(executing, /cancelled/u);
  await new Promise(resolve => setImmediate(resolve));
  f.service.cancel(sender, operationId);
  await rejected;
  context.continuePreparation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1, "a cancelled native callback cannot begin a late external request");
  assert.equal(f.service.diagnostics().activePreparations, 0);
  server.onDisconnect.emit();
  assert.equal(f.service.diagnostics().registeredDocuments, 0);
});

test("a cancelled preparation cannot start fetch after its awaited script read completes", async () => {
  let block = false;
  const held = Promise.withResolvers(), requests = [];
  const service = createAnkiPreparationService({ readScripts: async () => {
    if (block) await held.promise;
    return [script];
  }, fetch: async (...args) => { requests.push(args); return new Response("{}"); } });
  const operationId = await service.begin(sender, selected, source);
  block = true;
  const pending = service.request(sender, operationId, "https://example.org/");
  service.cancel(sender, operationId);
  held.resolve();
  await assert.rejects(pending, /active/u);
  assert.equal(requests.length, 0);
});

test("older complete Template records and flat projection writes keep preparation state", () => {
  const { normaliseAnki, validateOptionsPatch } = globalThis.HDReaderOptions;
  const current = normaliseAnki({ model: "Basic", preparationScript: selected });
  const legacy = structuredClone(current);
  delete legacy.preparationScript;
  delete legacy.templates[0].preparationScript;
  assert.doesNotThrow(() => validateOptionsPatch({ anki: legacy }));
  const projected = structuredClone(current);
  delete projected.preparationScript;
  projected.deck = "Legacy edit";
  const normalized = normaliseAnki(projected);
  assert.equal(normalized.templates[0].deck, "Legacy edit");
  assert.deepEqual(normalized.templates[0].preparationScript, selected);
});

test("same-world lifecycle disconnect retires its operation and cancels an active request", async () => {
  const f = fixture();
  let disconnected;
  f.service.connectLifecycle({ name: "hachidori-anki-preparation-document", sender,
    onDisconnect: { addListener(fn) { disconnected = fn; } } });
  const operationId = await f.service.beginDocument(sender, selected, source);
  disconnected();
  assert.equal(f.service.diagnostics().activePreparations, 0);
  await assert.rejects(f.service.request(sender, operationId, "https://example.org/"), /active/u);
  await assert.rejects(f.service.beginDocument(sender, selected, source), /disconnected/u);
});
