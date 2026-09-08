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
const result = (expression, reading, dictionary) => ({ matched: expression,
  term: { expression, reading, frequencies: [], pitches: [], glossaries: [
    { dictionary, glossary: '["sample definition"]' },
  ] } });

function fixture(t) {
  const dom = new JSDOM('<p>昨日、食べる & 飲む。</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test" });
  const { window } = dom;
  const { document } = window;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const popup = document.getElementById("popup");
  const opened = [];
  const links = [{ label: "Look up", url: "https://example.test/search?word=%w&reading=%r&sentence=%s" }];
  const view = window.HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
    parseTagList: window.HDGlossary.parseTagList, positionPopup() {}, customLinks: links,
    onCustomLinkClick: link => opened.push({ ...link }),
  });
  const anchor = document.querySelector("p");
  const candidate = { anchor, query: "食べる", sentence: anchor.textContent,
    sourceElements: [anchor], matchOffset: 3 };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, window, candidate, opened, links,
    link: () => popup.querySelector(".gsm-hoshidicts-external-link-button") };
}

test("named toolbar links use the current projected word, reading and source sentence", t => {
  const f = fixture(t);
  f.view.renderResults([result("食べる", "たべる", "A"), result("飲む", "のむ", "B")], f.candidate);
  assert.equal(f.link().textContent, "Look up");
  f.link().click();
  let url = new URL(f.opened[0].url);
  assert.equal(url.searchParams.get("word"), "食べる");
  assert.equal(url.searchParams.get("reading"), "たべる");
  assert.equal(url.searchParams.get("sentence"), f.candidate.sentence);
  assert.equal(f.opened[0].active, true);
  f.popup.querySelectorAll('[role="tab"]')[2].click();
  f.link().dispatchEvent(new f.window.MouseEvent("auxclick", { button: 1, bubbles: true }));
  url = new URL(f.opened[1].url);
  assert.equal(url.searchParams.get("word"), "飲む");
  assert.equal(url.searchParams.get("reading"), "のむ");
  assert.equal(f.opened[1].active, false);
});

test("live custom-link edits preserve dictionary cards, the Note draft and keyboard focus", t => {
  const f = fixture(t);
  f.view.renderResults([result("食べる", "たべる", "A")], f.candidate);
  const card = f.popup.querySelector(".gsm-hoshidicts-glossary-card");
  f.popup.querySelector(".gsm-hoshidicts-note-button").click();
  const form = f.popup.querySelector("form");
  form.elements.definition.value = "Keep my draft";
  form.elements.definition.focus();
  const button = f.link();
  f.view.setCustomLinks([{ label: "New search", url: "https://example.test/new/%w" },
    { label: "Reading", url: "https://example.test/read/%r" }]);
  assert.equal(f.link(), button);
  assert.equal(f.link().textContent, "New search");
  assert.equal(f.popup.ownerDocument.activeElement, form.elements.definition);
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-glossary-card"), card);
  assert.equal(f.popup.querySelector("form"), form);
  assert.equal(form.elements.definition.value, "Keep my draft");
  f.link().click();
  assert.equal(f.opened[0].url, `https://example.test/new/${encodeURIComponent("食べる")}`);
  f.view.setCustomLinks([]);
  button.click();
  assert.equal(f.opened.length, 1, "removed links cannot navigate");
  assert.equal(f.link(), null);
  assert.equal(form.hidden, false);
});

test("kanji and missing selections use their own word, and a replaced toolbar cannot navigate", t => {
  const f = fixture(t);
  f.view.renderKanji({ character: "食", entries: [] }, f.candidate);
  const oldLink = f.link();
  oldLink.click();
  const kanji = new URL(f.opened[0].url);
  assert.equal(kanji.searchParams.get("word"), "食");
  assert.equal(kanji.searchParams.get("reading"), "");
  f.view.renderNotice("No definition found.", { ...f.candidate, query: "unknown & ?word" });
  oldLink.click();
  assert.equal(f.opened.length, 1);
  f.link().click();
  assert.equal(new URL(f.opened[1].url).searchParams.get("word"), "unknown & ?word");
});

test("still-mounted links from an obsolete term, kanji or selection request cannot navigate", t => {
  const f = fixture(t);
  for (const kind of ["term", "kanji", "notice"]) {
    let current = true;
    const context = { isCurrentRequest: () => current };
    if (kind === "term") f.view.renderResults([result("食べる", "たべる", "A")], f.candidate, context);
    if (kind === "kanji") f.view.renderKanji({ character: "食", entries: [] }, f.candidate, context);
    if (kind === "notice") f.view.renderNotice("No definition found.", f.candidate, context);
    assert.equal(f.link().isConnected, true);
    current = false;
    f.link().click();
    assert.equal(f.opened.length, 0, kind);
  }
});
