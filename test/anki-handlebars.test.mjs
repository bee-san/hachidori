// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ankiTemplateErrors, ankiTemplateMarkerNames, ankiTemplateDependencies, resolveAnkiTemplates } from "../extension/anki-templates.js";
import "../extension/reader-options.js";
import { normaliseAnkiMarkerName } from "../extension/anki-marker-name.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";
import { ankiRequestFixture } from "./anki-request-fixture.mjs";

const template = value => ({ value, syntax: "handlebars", overwriteMode: "coalesce" });

test("Handlebars is an explicit field syntax and marker mappings keep literal Anki cloze braces", () => {
  const source = { Front: { value: "{{c1::{expression}}}", overwriteMode: "coalesce" },
    Back: template('{{#if term.reading}}{{term.reading}}{{/if}}{{marker "glossary-first"}}') };
  const config = globalThis.HDReaderOptions.normaliseOptions({ anki: { fieldTemplates: source } }).anki;
  assert.deepEqual(config.fieldTemplates, source);
  assert.deepEqual(resolveAnkiTemplates(config, ["Front", "Back"]).errors, []);
  assert.deepEqual(ankiTemplateMarkerNames(source.Front), ["expression"]);
  assert.deepEqual(ankiTemplateMarkerNames(source.Back), ["glossary-first"]);
});

test("Handlebars validates syntax and discovers static marker dependencies in every branch", () => {
  assert.deepEqual(ankiTemplateMarkerNames(template('{{#if preparation.example}}{{marker "audio"}}{{else}}{{marker "screenshot"}}{{/if}}')),
    ["audio", "screenshot"]);
  assert.match(ankiTemplateErrors(template("{{#if term.expression}}")).join("\n"), /Parse error/u);
  assert.match(ankiTemplateErrors(template('{{marker "not-a-marker"}}')).join("\n"), /Unknown marker/u);
  assert.match(ankiTemplateErrors(template("{{marker preparation.name}}")).join("\n"), /literal/u);
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildAnkiFields } from "../extension/anki-values.js";
const compiler = vm.createContext({});
vm.runInContext(readFileSync(new URL("../extension/vendor/handlebars/compiler.js", import.meta.url), "utf8"), compiler);
const Handlebars = compiler.HDHandlebars;
const escapeData = Handlebars.Utils.escapeExpression;
Handlebars.Utils.escapeExpression = value => escapeData(value).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
const handlebars = (value, context, markers) => Handlebars.compile(value)(context, {
  helpers: { marker: name => new Handlebars.SafeString(markers[normaliseAnkiMarkerName(name)]) },
  allowProtoMethodsByDefault: false, allowProtoPropertiesByDefault: false,
});

test("Handlebars uses escaped structured data, rich production markers and named preparation values", async () => {
  let definitions = 0;
  const request = { term: { expression: "<食べる>", reading: "たべる", glossaries: [], pitches: [], frequencies: [] },
    sentence: "A {{c1::word}}", dictionaryAliases: {}, dictionaryIds: {}, preparation: { example: "A & B" } };
  const fields = await buildAnkiFields(request, {
    Front: template("{{term.expression}}"),
    Back: template('{{marker "glossary-first"}}<br>{{preparation.example}}<br>{{sentence.text}}'),
    Legacy: { value: "{{c1::{expression}}}", overwriteMode: "coalesce" },
  }, { handlebars, definition: () => { definitions++; return "<b>to eat</b>"; } });
  assert.deepEqual(fields, { Front: "&lt;食べる&gt;", Back: "<b>to eat</b><br>A &amp; B<br>A &#123;&#123;c1::word&#125;&#125;",
    Legacy: "{{c1::&lt;食べる&gt;}}" });
  assert.equal(definitions, 1);
  assert.equal(handlebars("{{term.constructor}}", { term: {} }, {}), "");
});

import { renderHandlebars } from "../extension/anki-template-sandbox.js";
test("closing a rendering document rejects a request still waiting for its sandbox to load", async () => {
  let close;
  const frame = { setAttribute() {}, addEventListener() {}, remove() {} };
  const document = { defaultView: { addEventListener(type, listener) { if (type === "pagehide") close = listener; } },
    createElement: () => frame, body: { append() {} } };
  const pending = renderHandlebars(document, "{{term.expression}}", { term: { expression: "猫" } }, {});
  close();
  await assert.rejects(pending, /renderer was closed/u);
});


test("Handlebars dependencies include raw selection/groups contexts and preserve opaque group marker IDs", () => {
  assert.deepEqual(ankiTemplateDependencies(template("{{selection.dictionary}}")), { markers: [], selection: true, groups: false });
  assert.deepEqual(ankiTemplateDependencies(template("{{#each @root.groups}}{{id}}{{../selection.index}}{{/each}}")),
    { markers: [], selection: true, groups: true });
  assert.deepEqual(ankiTemplateDependencies(template('{{lookup @root "selection"}}')),
    { markers: [], selection: true, groups: false });
  assert.deepEqual(ankiTemplateDependencies(template('{{#with this as |context|}}{{context.selection.dictionary}}{{lookup context "groups"}}{{/with}}')),
    { markers: [], selection: true, groups: true });
  assert.deepEqual(ankiTemplateDependencies(template('{{#with this as |context|}}{{lookup context preparation.contextKey}}{{/with}}')),
    { markers: [], selection: true, groups: true });
  assert.deepEqual(ankiTemplateDependencies(template('{{marker "GLOSSARY-SELECTION-GROUP-Mono"}}')),
    { markers: ["glossary-selection-group-Mono"], selection: true, groups: true });
  assert.deepEqual(ankiTemplateDependencies(template('{{"selection"}} {{term.expression}}')),
    { markers: [], selection: false, groups: false });
});

test("the worker loads authoritative groups for Handlebars contexts/helpers and skips unused groups", async () => {
  const f = ankiRequestFixture();
  let groups = [{ id: "Mono", name: "Monolingual", dictionaryIds: ["a"] }], reads = 0;
  const setBack = value => { f.options.anki = globalThis.HDReaderOptions.normaliseAnki({ model: "Basic",
    fieldTemplates: { Front: { value: "{expression}", overwriteMode: "coalesce" }, Back: template(value) } }); };
  setBack('{{marker "glossary-selection-group-Mono"}}');
  const service = createAnkiWorkerService({ gateway: f.gateway, readOptions: async () => f.options,
    readGroups: async () => { reads++; return structuredClone(groups); },
    readDictionaries: async () => [{ title: "Mono A", id: "a", enabled: true, path: "/dicts/a" }],
    duplicateIndex: { async recordWrite() {} }, engine: async () => ({ ready: true, loading: false, generation: 3 }),
    offscreen: async message => ({ media: [], fields: await buildAnkiFields(message.request, message.templates,
      { handlebars, definition: options => options.selection.dictionary }) }),
  });
  const configKey = (await service.status()).configKey;
  assert.ok(reads > 0);
  const source = { term: { expression: "猫", reading: "ねこ", frequencies: [], pitches: [],
    glossaries: [{ dictionary: "Mono A", glossary: '["cat"]' }] }, generation: 3,
    sentence: "猫だ。", matchOffset: 0, matched: "猫", configKey, dictionaryAliases: {},
    glossaryGroups: [{ id: "Mono", dictionaryIds: [] }] };
  assert.equal((await service.submit(source)).state, "added");
  assert.equal([...f.notes.values()][0].Back, "Mono A");
  setBack("{{#each groups}}{{id}}:{{name}}{{/each}}");
  const rawKey = (await service.status()).configKey;
  groups = [{ ...groups[0], name: "Updated" }];
  assert.notEqual((await service.status()).configKey, rawKey, "raw group context participates in the checked configuration");
  setBack("{{term.reading}}");
  reads = 0;
  await service.status();
  assert.equal(reads, 0, "a Handlebars field without group dependencies needs no group storage read");
  const built = await buildAnkiFields({ ...source, glossaryGroups: groups }, { Back: template("{{#each groups}}{{id}}:{{name}}{{/each}}") },
    { handlebars });
  assert.equal(built.Back, "Mono:Updated");
});
