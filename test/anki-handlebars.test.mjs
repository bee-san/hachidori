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
