// SPDX-License-Identifier: GPL-3.0-or-later
// Issue #656: the search page's Anki Template switch chooses the Template the
// built-in Anki button uses, as Settings → Anki → Set built-in does, and lists
// the Templates the same way in search.html and in its frame.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import "../extension/reader-options.js";
import { templateSwitch } from "../extension/search-shell.js";
import { renderTemplateChoices, withBuiltinTemplate } from "../extension/search-templates.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { normaliseAnki, validateOptionsPatch } = globalThis.HDReaderOptions;

const template = (id, name, deck) => ({ id, name, deck, model: "Lapis", tags: ["hachidori"],
  fields: { expression: "Word" }, duplicateScope: "deck", duplicateBehavior: "prevent", captureScreenshot: false,
  fieldTemplates: null });
const anki = normaliseAnki({ url: "http://127.0.0.1:8766", apiKey: "secret",
  templates: [template("sentences", "Sentences", "Mining"), template("words", "Words", "Vocabulary"),
    template("kanji", "kanji", "Kanji")] });

test("choosing a Template moves it first, keeps the others' order and the connection, and is a valid write", () => {
  const chosen = withBuiltinTemplate(anki, "kanji");
  assert.deepEqual(chosen.templates.map(({ id }) => id), ["kanji", "sentences", "words"]);
  assert.deepEqual(chosen.templates, [anki.templates[2], anki.templates[0], anki.templates[1]]);
  assert.equal(chosen.deck, "Kanji", "the first Template's projection, which the built-in button reads");
  assert.equal(chosen.url, "http://127.0.0.1:8766");
  assert.equal(chosen.apiKey, "secret");
  assert.deepEqual(validateOptionsPatch({ anki: chosen }).anki, chosen);
  assert.equal(withBuiltinTemplate(anki, "removed"), null);
});

function switchElement() {
  const { document } = new JSDOM("<select hidden></select>").window;
  return document.querySelector("select");
}

test("the switch lists the Templates by name under its heading, the built-in one chosen, and only with more than one", () => {
  const select = switchElement();
  renderTemplateChoices(select, anki);
  const listed = () => [...select.options].map(option => [option.value, option.text]);
  assert.deepEqual(listed(), [["kanji", "kanji"], ["sentences", "Sentences"], ["words", "Words"]]);
  assert.deepEqual([...select.children].map(group => group.label), ["Anki Template"]);
  assert.equal(select.value, "sentences");
  assert.equal(select.hidden, false);

  // The list stays put as a choice moves its Template first, so the arrow
  // keys can walk it, and its options are not rebuilt.
  const [first] = select.options;
  renderTemplateChoices(select, withBuiltinTemplate(anki, "words"));
  assert.deepEqual(listed(), [["kanji", "kanji"], ["sentences", "Sentences"], ["words", "Words"]]);
  assert.equal(select.value, "words");
  assert.equal(select.options[0], first);
  // A choice still being saved stays shown.
  renderTemplateChoices(select, anki, "kanji");
  assert.equal(select.value, "kanji");

  renderTemplateChoices(select, normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
    templates: [{ ...anki.templates[1], name: "Vocabulary" }, anki.templates[0]] }));
  assert.deepEqual(listed(), [["sentences", "Sentences"], ["words", "Vocabulary"]]);
  assert.equal(select.value, "words");

  renderTemplateChoices(select, normaliseAnki({ templates: [anki.templates[0]] }));
  assert.equal(select.hidden, true);
});

// search.html's switch (search-shell.js) against a worker that checks each
// write's revision as hd_options_write does. `hold` keeps a write waiting, and
// a written choice comes back as the storage change search.html adopts.
function switchedWorker(stored, { conflictFirst = false, failing = false } = {}) {
  const writes = [];
  let hold = null;
  let release = () => {};
  let ui = null;
  const api = {
    storage: { local: { get: async () => ({ options: structuredClone(stored) }) } },
    runtime: {
      async sendMessage(message) {
        writes.push(message.options.anki.templates[0].id);
        if (hold) await hold;
        if (failing) return { ok: false, error: "the worker went away" };
        // Another page writes first, once.
        if (conflictFirst && writes.length === 1) stored.revision += 1;
        if (message.baseRevision !== stored.revision) return { ok: false, conflict: true, options: stored };
        stored.anki = message.options.anki;
        stored.revision += 1;
        ui.show(normaliseAnki(stored.anki));
        return { ok: true, options: stored };
      },
    },
  };
  const select = switchElement();
  ui = templateSwitch(select, { focus() {} }, api);
  ui.show(normaliseAnki(stored.anki));
  const choose = (id) => {
    select.value = id;
    select.dispatchEvent(new select.ownerDocument.defaultView.Event("change"));
  };
  const holdWrites = () => { hold = new Promise((resolve) => { release = () => { hold = null; resolve(); }; }); };
  return { select, writes, choose, holdWrites, release: () => release() };
}

const settle = () => new Promise(resolve => { setTimeout(resolve, 20); });

test("the switch writes again after a conflict and saves only the last choice made while one is saved", async () => {
  const stored = { revision: 4, audioAutoplay: true, anki };
  const worker = switchedWorker(stored, { conflictFirst: true });
  worker.holdWrites();
  worker.choose("words");
  await settle();
  // Made while words is being saved.
  worker.choose("kanji");
  worker.choose("sentences");
  assert.deepEqual(worker.writes, ["words"]);
  assert.equal(worker.select.value, "sentences", "the last choice is shown while it waits");
  worker.release();
  await settle();
  // words met the other page's write and went again; kanji was never saved.
  assert.deepEqual(worker.writes, ["words", "words", "sentences"]);
  assert.deepEqual(stored.anki.templates.map(({ id }) => id), ["sentences", "words", "kanji"]);
  assert.equal(stored.anki.apiKey, "secret");
  assert.equal(stored.anki.url, "http://127.0.0.1:8766");
  assert.equal(stored.revision, 7);
  assert.equal(worker.select.value, "sentences");
});

test("a failed write shows the stored Template again, and choosing the first Template writes nothing", async (t) => {
  t.mock.method(console, "error", () => {});
  const stored = { revision: 1, anki };
  const failing = switchedWorker(stored, { failing: true });
  failing.choose("kanji");
  await settle();
  assert.deepEqual(failing.writes, ["kanji"]);
  assert.equal(failing.select.value, "sentences");
  assert.equal(console.error.mock.callCount(), 1);

  const unchanged = switchedWorker(stored);
  unchanged.choose("sentences");
  await settle();
  assert.deepEqual(unchanged.writes, []);
  assert.equal(unchanged.select.value, "sentences");
});
