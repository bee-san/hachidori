// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function fixture(t, onAddCustomEntry = async () => {}) {
  const dom = new JSDOM('<p>知らない言葉</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test" });
  const { window } = dom;
  const { document } = window;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const popup = document.getElementById("popup");
  const view = window.HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
    parseTagList: window.HDGlossary.parseTagList, positionPopup() {}, onAddCustomEntry,
  });
  const anchor = document.querySelector("p");
  const candidate = { anchor, query: anchor.textContent, sentence: anchor.textContent,
    sourceElements: [anchor], matchOffset: 0, exactSelection: true };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, window, candidate };
}

test("unknown selected words expose a pencil with a selected-text prefill and one managed save", async t => {
  const entries = [];
  const f = fixture(t, entry => {
    entries.push({ ...entry });
  });
  f.view.renderNotice("No definition found. Add your own with the pencil.", f.candidate);
  const button = f.popup.querySelector(".gsm-hoshidicts-note-button");
  assert.ok(button, "a dictionary miss must still offer the editor");
  assert.equal(button.getAttribute("aria-label"), "Edit personal dictionary");
  assert.equal(button.querySelector(".gsm-hoshidicts-note-icon").dataset.icon, "edit");
  button.click();
  const form = f.popup.querySelector("form");
  assert.equal(form.hidden, false);
  assert.equal(form.elements.term.value, f.candidate.query);
  assert.equal(form.elements.reading.value, "");
  assert.equal(form.elements.definition.value, "");
  form.elements.reading.value = "しらないことば";
  form.elements.definition.value = "My meaning";
  form.dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  form.dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  assert.deepEqual(entries, [{ term: f.candidate.query, reading: "しらないことば", definition: "My meaning" }]);
  assert.equal(form.hidden, true);
});

test("lookup and kanji results expose the same pencil editor with their own term prefill", t => {
  const f = fixture(t);
  const results = [{ matched: "食べた", term: { expression: "食べる", reading: "たべる",
    frequencies: [], pitches: [], glossaries: [{ dictionary: "Published dictionary", glossary: '["to eat"]' }] } }];
  f.view.renderResults(results, { ...f.candidate, exactSelection: false });
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  assert.equal(f.popup.querySelector("form").elements.term.value, "食べる");
  assert.equal(f.popup.querySelector("form").elements.reading.value, "たべる");
  f.view.renderResults(results, { ...f.candidate, query: "食べた" });
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  assert.equal(f.popup.querySelector("form").elements.term.value, "食べた", "an exact selection adds the highlighted text");
  assert.equal(f.popup.querySelector("form").elements.reading.value, "");
  f.view.renderKanji({ character: "食", entries: [] }, f.candidate);
  const button = f.popup.querySelector(".gsm-hoshidicts-note-button");
  assert.equal(button.getAttribute("aria-label"), "Edit personal dictionary");
  button.click();
  assert.equal(f.popup.querySelector("form").elements.term.value, "食");
  assert.equal(f.popup.querySelector("form").elements.reading.value, "");
});
