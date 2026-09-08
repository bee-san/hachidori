// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createCustomLinkSettings, parseCustomLinks } from "../extension/custom-link-settings.js";
import { createSettingsSearch } from "../extension/settings-search.js";
import "../extension/reader-options.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { expandCustomLinkUrl } = globalThis.HDExternalLinks;

test("GSM word/sentence templates and reading encode values exactly once and reject unsafe URLs", () => {
  const values = { word: "蜂 & %s", reading: "はち", sentence: "蜂はどこ？ / a=b" };
  const expanded = expandCustomLinkUrl("https://example.test/search?word=%w&reading=%r&sentence=%s", values);
  const url = new URL(expanded);
  assert.equal(url.searchParams.get("word"), values.word);
  assert.equal(url.searchParams.get("reading"), values.reading);
  assert.equal(url.searchParams.get("sentence"), values.sentence);
  for (const template of ["javascript:alert('%w')", "data:text/html,%s", "file:///tmp/%w", "https://user:pass@example.test/%w", "https://example.test/\n%w"]) {
    assert.equal(expandCustomLinkUrl(template, values), null, template);
    assert.throws(() => parseCustomLinks(`Unsafe, ${template}`), /Line/u);
  }
  assert.deepEqual(parseCustomLinks("Jisho, https://jisho.org/search/%w\n\nPair, https://example.test/?q=%w,%r"), [
    { label: "Jisho", url: "https://jisho.org/search/%w" },
    { label: "Pair", url: "https://example.test/?q=%w,%r" },
  ]);
  assert.deepEqual(globalThis.HDReaderOptions.normaliseOptions({}).customLinks, []);
  assert.throws(() => globalThis.HDReaderOptions.validateOptionsPatch({ customLinks: [{ label: "", url: "https://example.test" }] }));
});

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: "https://extension.test/settings.html" });
  const { document } = dom.window;
  const el = id => document.getElementById(id);
  let links = [];
  const saves = [];
  const controller = createCustomLinkSettings({ document, readLinks: () => links,
    saveLinks(value) { saves.push(value); links = value; } });
  const editor = el("opt-custom-links");
  function type(value) {
    editor.value = value;
    editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  t.after(() => dom.window.close());
  return { window: dom.window, document, el, controller, editor, saves, type,
    get links() { return links; }, receive(value) { links = value; controller.render(); } };
}

test("link editor saves only explicit valid edits and preserves order, invalid drafts and concurrent changes", t => {
  const f = fixture(t);
  assert.equal(f.editor.value, "", "placeholder examples never become configured links");
  assert.equal(f.el("save-custom-links").disabled, true);
  f.type("Jisho, https://jisho.org/search/%w\nSentence, https://example.test/?q=%s");
  assert.equal(f.saves.length, 0);
  f.el("save-custom-links").click();
  assert.deepEqual(f.links.map(link => link.label), ["Jisho", "Sentence"]);
  f.type("Sentence, https://example.test/?q=%s\nJisho, https://jisho.org/search/%w");
  f.el("save-custom-links").click();
  assert.deepEqual(f.links.map(link => link.label), ["Sentence", "Jisho"]);
  f.type("Bad, javascript:alert(1)");
  f.el("save-custom-links").click();
  f.controller.render();
  assert.equal(f.editor.value, "Bad, javascript:alert(1)");
  assert.equal(f.saves.length, 2);
  assert.match(f.el("custom-links-status").textContent, /Line 1/u);
  f.type("Local, https://example.test/local/%w");
  f.receive([{ label: "Other window", url: "https://example.test/current/%w" }]);
  f.el("save-custom-links").click();
  assert.match(f.el("custom-links-status").textContent, /changed elsewhere/u);
  assert.equal(f.editor.value, "Local, https://example.test/local/%w");
  assert.equal(f.saves.length, 2);
  f.el("discard-custom-links").click();
  assert.equal(f.editor.value, "Other window, https://example.test/current/%w");
  f.type("");
  f.el("save-custom-links").click();
  assert.deepEqual(f.links, [], "clearing the editor removes the links");
});

test("global search reaches Custom toolbar links in inactive Design without discarding a draft", t => {
  const f = fixture(t);
  f.type("Unfinished link");
  f.window.HTMLElement.prototype.scrollIntoView = function () {};
  const search = createSettingsSearch({ document: f.document, navigate(section) {
    search.clear();
    for (const node of f.document.querySelectorAll("main > section")) node.hidden = node.id !== section;
    f.controller.render();
  } });
  const input = f.el("settings-search");
  input.value = "custom toolbar links";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  const result = [...f.el("settings-search-matches").querySelectorAll("a")]
    .find(node => node.querySelector("strong").textContent === "Names and URL templates");
  assert.ok(result);
  result.click();
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.document.activeElement, f.editor);
  assert.equal(f.editor.value, "Unfinished link");
});
