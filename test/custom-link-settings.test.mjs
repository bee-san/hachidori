// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createCustomLinkSettings, validateCustomLink } from "../extension/custom-link-settings.js";
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
  for (const template of [
    "javascript:alert('%w')",
    "data:text/html,%s",
    "file:///tmp/%w",
    "https:example.test/%w",
    "https:/example.test/%w",
    "https://user:pass@example.test/%w",
    "\nhttps://example.test/%w",
    "https://example.test/%w\r",
    "https://example.test/\n%w",
  ]) {
    assert.equal(expandCustomLinkUrl(template, values), null, template);
    assert.match(validateCustomLink("Unsafe", template), /http/u, template);
  }
  assert.equal(validateCustomLink("Pair", "https://example.test/?q=%w,%r"), "");
  assert.match(validateCustomLink("", "https://example.test/%w"), /name/u);
  assert.match(validateCustomLink("Bad\u0007", "https://example.test/%w"), /name/u);
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
  function type(id, value) {
    el(id).value = value;
    el(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function add(label, url) {
    type("opt-custom-link-name", label);
    type("opt-custom-link-url", url);
    el("custom-link-submit").click();
  }
  const rows = () => [...el("custom-link-list").children];
  const row = label => rows().find(node => node.querySelector("strong").textContent === label);
  const action = (label, text) => [...row(label).querySelectorAll("button")].find(node => node.textContent === text);
  t.after(() => dom.window.close());
  return { window: dom.window, document, el, controller, saves, type, add, rows, action,
    labels: () => rows().map(node => node.querySelector("strong").textContent),
    get links() { return links; }, receive(value) { links = value; controller.render(); } };
}

test("link editor adds, edits, reorders and deletes links, saving each change at once", t => {
  const f = fixture(t);
  assert.equal(f.el("custom-link-empty").hidden, false);
  assert.equal(f.el("opt-custom-link-name").value, "", "placeholder examples never become configured links");
  f.add("Jisho", "https://jisho.org/search/%w");
  f.add("Sentence", "https://example.test/?q=%s");
  assert.deepEqual(f.links.map(link => link.label), ["Jisho", "Sentence"]);
  assert.equal(f.saves.length, 2);
  assert.equal(f.el("custom-link-empty").hidden, true);
  assert.equal(f.rows()[1].querySelector("code").textContent, "https://example.test/?q=%s");
  assert.equal(f.el("opt-custom-link-name").value, "", "adding clears the form");

  f.rows()[1].querySelector('[data-action="up"]').click();
  assert.deepEqual(f.labels(), ["Sentence", "Jisho"]);
  assert.deepEqual(f.links.map(link => link.label), ["Sentence", "Jisho"]);
  assert.equal(f.rows()[0].querySelector('[data-action="up"]').disabled, true);
  assert.equal(f.rows()[1].querySelector('[data-action="down"]').disabled, true);

  f.action("Jisho", "Edit").click();
  assert.equal(f.el("custom-link-submit").textContent, "Save link");
  assert.equal(f.el("custom-link-cancel").hidden, false);
  assert.equal(f.el("opt-custom-link-url").value, "https://jisho.org/search/%w");
  assert.equal(f.controller.dirty(), false);
  f.type("opt-custom-link-name", "Jisho word");
  assert.equal(f.controller.dirty(), true);
  f.el("custom-link-cancel").click();
  assert.equal(f.el("custom-link-submit").textContent, "Add link");
  assert.equal(f.links[1].label, "Jisho", "cancel discards the edit");

  f.action("Jisho", "Edit").click();
  f.type("opt-custom-link-name", "Jisho word");
  f.el("custom-link-submit").click();
  assert.deepEqual(f.links, [{ label: "Sentence", url: "https://example.test/?q=%s" },
    { label: "Jisho word", url: "https://jisho.org/search/%w" }]);

  f.add("Bad", "javascript:alert(1)");
  assert.match(f.el("custom-links-status").textContent, /http/u);
  assert.equal(f.el("opt-custom-link-name").value, "Bad", "an invalid draft stays in the form");
  assert.equal(f.saves.length, 4);
  f.type("opt-custom-link-name", "");
  f.type("opt-custom-link-url", "");

  f.action("Sentence", "Delete").click();
  assert.deepEqual(f.links.map(link => link.label), ["Jisho word"]);
  f.action("Jisho word", "Delete").click();
  assert.deepEqual(f.links, []);
  assert.equal(f.el("custom-link-empty").hidden, false);
});

test("saving an edit refuses a link that changed elsewhere and keeps the draft", t => {
  const f = fixture(t);
  f.add("Jisho", "https://jisho.org/search/%w");
  f.action("Jisho", "Edit").click();
  f.type("opt-custom-link-url", "https://example.test/local/%w");
  f.receive([{ label: "Other window", url: "https://example.test/current/%w" }]);
  assert.equal(f.el("opt-custom-link-url").value, "https://example.test/local/%w", "a storage echo keeps the draft");
  const saves = f.saves.length;
  f.el("custom-link-submit").click();
  assert.match(f.el("custom-links-status").textContent, /changed elsewhere/u);
  assert.equal(f.saves.length, saves);
  f.controller.reset();
  assert.equal(f.el("opt-custom-link-url").value, "");
  assert.deepEqual(f.labels(), ["Other window"]);
});

test("global search reaches Custom toolbar links in inactive Design without discarding a draft", t => {
  const f = fixture(t);
  f.type("opt-custom-link-name", "Unfinished link");
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
    .find(node => node.querySelector("strong").textContent === "Link name");
  assert.ok(result);
  result.click();
  assert.equal(f.el("design").hidden, false);
  assert.equal(f.document.activeElement, f.el("opt-custom-link-name"));
  assert.equal(f.el("opt-custom-link-name").value, "Unfinished link");
});
