// SPDX-License-Identifier: GPL-3.0-or-later
// The search page's Anki Template switch once the records have profiles
// (docs/languages.md 5.2, 8.1, 12): the search page reads in the active
// profile, so the switch lists that profile's Templates and its write names it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import "../extension/reader-options.js";
import { activeTemplates, templateSwitch } from "../extension/search-shell.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { normaliseAnki } = globalThis.HDReaderOptions;

const template = (id, name, deck) => ({ id, name, deck, model: "Basic", tags: ["hachidori"],
  fields: { expression: "Front" }, duplicateScope: "deck", duplicateBehavior: "prevent", captureScreenshot: false,
  fieldTemplates: null });
const japanese = normaliseAnki({ templates: [template("ja-words", "Japanese words", "Mining")] }).templates;
const english = normaliseAnki({ templates: [template("en-words", "English words", "English"),
  template("en-sentences", "English sentences", "English")] }).templates;
const records = () => ({ revision: 7, profiles: [
  { id: "ja", language: "ja", settings: { anki: { templates: japanese } }, packSettings: {} },
  { id: "en", language: "en", settings: { anki: { templates: english } }, packSettings: {} },
] });
const selection = { revision: 2, activeProfileId: "en", autoSwitch: false };

test("with profiles the switch lists the active profile's Templates; without them today's", () => {
  const listed = activeTemplates(records(), selection);
  assert.deepEqual(listed.anki.templates.map(({ id }) => id), ["en-words", "en-sentences"]);
  assert.deepEqual(listed.fields, { profileId: "en" });
  assert.deepEqual(activeTemplates(records(), null).fields, { profileId: "ja" }, "no stored choice: Japanese");
  const single = activeTemplates({ revision: 3, anki: { templates: japanese } }, selection);
  assert.deepEqual(single.fields, {});
  assert.deepEqual(single.anki.templates.map(({ id }) => id), ["ja-words"]);
});

test("a choice is written into the active profile, naming it", async () => {
  const stored = records();
  const writes = [];
  const api = {
    storage: { local: { get: async () => ({ options: structuredClone(stored), languageSelection: selection }) } },
    runtime: { async sendMessage(message) { writes.push(message); return { ok: true }; } },
  };
  const { document } = new JSDOM("<select hidden></select>").window;
  const select = document.querySelector("select");
  const ui = templateSwitch(select, { focus() {} }, api);
  ui.show(activeTemplates(stored, selection).anki);
  assert.equal(select.hidden, false);
  select.value = "en-sentences";
  select.dispatchEvent(new document.defaultView.Event("change"));
  await new Promise(done => { setTimeout(done, 20); });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].profileId, "en");
  assert.equal(writes[0].baseRevision, 7);
  assert.deepEqual(writes[0].options.anki.templates.map(({ id }) => id), ["en-sentences", "en-words"]);
});
