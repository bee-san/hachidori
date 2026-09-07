// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPracticeView } from "../extension/startup-practice.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const OPTIONS = { hoverEnabled: true, lookupMode: "hover", activationKey: "Alt" };
const DICTIONARIES = [{ id: "installed-terms", enabled: true, termCount: 6 }];

function fixture(t) {
  const dom = new JSDOM('<main id="practice"></main><button id="finish">Finish</button>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/startup.html" });
  const { document } = dom.window;
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { extension: { isAllowedFileSchemeAccess: async () => false } };
  const el = id => document.getElementById(id);
  const view = createPracticeView({ document, onDismiss: () => el("finish").focus() });
  el("practice").append(view.node);
  t.after(() => { dom.window.close(); globalThis.chrome = previousChrome; });
  return { view, document, window: dom.window, el,
    reader: () => document.querySelector('script[src="content.js"]'),
    update: (options = OPTIONS, dictionaries = DICTIONARIES) => view.update(options, dictionaries) };
}

test("the keyboard lookup control selects the exercise's real text after the ordinary reader loads", t => {
  const f = fixture(t);
  f.update();
  const lookup = f.el("setup-practice-lookup");
  assert.equal(lookup.disabled, true);
  assert.equal(f.el("finish").disabled, false);
  f.reader().dispatchEvent(new f.window.Event("load"));
  assert.equal(lookup.disabled, false);
  lookup.focus();
  lookup.click();
  const selection = f.window.getSelection();
  assert.equal(selection.toString(), "辞書");
  assert.equal(selection.getRangeAt(0).commonAncestorContainer, f.el("setup-practice-word"));
  assert.ok(f.el("setup-practice-text").contains(selection.anchorNode));
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
});

test("option and inventory updates retain the scene, selected Range, reader script and local-file dismissal", async t => {
  const f = fixture(t);
  f.update();
  f.reader().dispatchEvent(new f.window.Event("load"));
  f.el("setup-practice-lookup").click();
  const textNode = f.el("setup-practice-text").firstChild;
  const wordNode = f.el("setup-practice-word").firstChild;
  const selection = f.window.getSelection();
  const range = selection.getRangeAt(0);
  const changed = { ...OPTIONS, lookupMode: "activation", activationKey: "Control" };
  f.update(changed, [...DICTIONARIES, { id: "frequency-only", enabled: true, termCount: 0 }]);
  assert.match(f.el("setup-practice-instruction").textContent, /Hold Control/u);
  assert.equal(f.el("setup-practice-text").firstChild, textNode);
  assert.equal(f.el("setup-practice-word").firstChild, wordNode);
  assert.equal(selection.getRangeAt(0), range);
  assert.equal(selection.toString(), "辞書");
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
  assert.equal(f.document.querySelectorAll('script[src="content.js"]').length, 1);
  await tick();
  f.el("local-file-skip").click();
  f.update();
  assert.equal(f.el("setup-file-access").hidden, true);
  assert.equal(f.document.activeElement, f.el("finish"));
  assert.equal(f.el("finish").disabled, false);
});

test("missing or disabled term dictionaries and disabled lookups give recovery without blocking Finish", t => {
  const f = fixture(t);
  for (const dictionaries of [[], [{ ...DICTIONARIES[0], enabled: false }], [{ id: "frequency-only", termCount: 0 }]]) {
    f.update(OPTIONS, dictionaries);
    assert.equal(f.el("setup-practice-scene").hidden, true);
    assert.match(f.el("setup-practice-recovery").textContent, /Install or enable a term dictionary/u);
    assert.equal(f.el("setup-practice-tools").hidden, true);
    assert.equal(f.el("setup-practice-recovery").querySelector("a").getAttribute("href"),
      dictionaries.some(entry => entry.termCount > 0) ? "settings.html#dictionaries" : "settings.html#add-dictionaries");
    assert.equal(f.reader(), null);
    assert.equal(f.el("finish").disabled, false);
  }
  f.update({ ...OPTIONS, hoverEnabled: false });
  const recovery = f.el("setup-practice-recovery");
  assert.equal(f.el("setup-practice-scene").hidden, false);
  assert.match(recovery.textContent, /Lookups are turned off/u);
  const link = recovery.querySelector("a");
  assert.equal(link.getAttribute("href"), "settings.html#lookup");
  link.focus();
  f.update({ ...OPTIONS, hoverEnabled: false });
  assert.equal(recovery.querySelector("a"), link);
  assert.equal(f.document.activeElement, link);
  assert.equal(f.el("finish").disabled, false);
  f.update();
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
  f.reader().dispatchEvent(new f.window.Event("load"));
  f.el("setup-practice-lookup").click();
  f.update({ ...OPTIONS, hoverEnabled: false });
  assert.equal(f.document.activeElement, link, "hiding the active exercise hands focus to its recovery action");
});

test("reader load failure leaves a recoverable optional exercise and cannot enable lookup", t => {
  const f = fixture(t);
  f.update();
  f.reader().dispatchEvent(new f.window.Event("error"));
  assert.equal(f.el("setup-practice-tools").hidden, true);
  assert.match(f.el("setup-practice-recovery").textContent, /reader could not load.*Reload/u);
  assert.equal(f.el("finish").disabled, false);
  f.update();
  assert.equal(f.document.querySelectorAll('script[src="content.js"]').length, 1);
  assert.equal(f.el("setup-practice-tools").hidden, true);
});
