// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { preserveLinkedAnkiTemplateFields } from "../extension/linked-anki-options.js";

const defaults = { futureChoice: null, futureMode: "first" };
const current = { templates: [
  { id: "word", name: "Words", deck: "Default", futureChoice: { id: "a", mode: "selected" }, futureMode: "chosen" },
  { id: "sentence", name: "Sentences", deck: "Sentences", futureChoice: { id: "b", mode: "selected" }, futureMode: "first" },
] };

test("an older flat writer edits the first Template while keeping unsupported settings", () => {
  const incoming = { deck: "New deck", model: "Basic" };
  const result = preserveLinkedAnkiTemplateFields(current, incoming, defaults);
  assert.deepEqual(result, { ...incoming, futureChoice: current.templates[0].futureChoice, futureMode: "chosen" });
  assert.deepEqual(incoming, { deck: "New deck", model: "Basic" });
});

test("older multi-Template writes retain settings by ID across rename and reorder, and new Templates get defaults", () => {
  const incoming = { templates: [{ id: "sentence", name: "Renamed" }, { id: "new", name: "New" }, { id: "word", name: "Words" }] };
  const result = preserveLinkedAnkiTemplateFields(current, incoming, defaults);
  assert.deepEqual(result.templates.map(({ id, futureChoice, futureMode }) => ({ id, futureChoice, futureMode })), [
    { id: "sentence", futureChoice: current.templates[1].futureChoice, futureMode: "first" },
    { id: "new", ...defaults },
    { id: "word", futureChoice: current.templates[0].futureChoice, futureMode: "chosen" },
  ]);
  assert.deepEqual(result.futureChoice, current.templates[1].futureChoice, "the first-Template projection follows the new order");
  assert.equal(result.futureMode, "first");
  assert.equal(Object.hasOwn(incoming.templates[0], "futureChoice"), false);
});

test("explicitly unchanged unsupported values remain valid, while changes and additions are refused", () => {
  assert.doesNotThrow(() => preserveLinkedAnkiTemplateFields(current,
    { futureChoice: { mode: "selected", id: "a" }, futureMode: "chosen" }, defaults));
  for (const incoming of [
    { futureChoice: null },
    { futureMode: "first" },
    { templates: [{ id: "word", futureChoice: { id: "different", mode: "selected" } }] },
    { templates: [{ id: "new", futureChoice: { id: "a" } }] },
  ]) assert.throws(() => preserveLinkedAnkiTemplateFields(current, incoming, defaults, "Update before changing this setting."),
    /Update before changing this setting/u);
});
