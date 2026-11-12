// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ankiTemplateErrors, ankiTemplateMarkerNames, resolveAnkiTemplates } from "../extension/anki-templates.js";
import "../extension/reader-options.js";

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
  helpers: { marker: name => new Handlebars.SafeString(markers[name]) },
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
