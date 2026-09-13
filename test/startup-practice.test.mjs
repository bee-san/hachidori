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
  let readerLoads = 0;
  let loaded, failed;
  const pendingReader = new Promise((resolve, reject) => { loaded = resolve; failed = reject; });
  const view = createPracticeView({ document, onDismiss: () => el("finish").focus(),
    loadReader: () => { readerLoads += 1; return pendingReader; } });
  el("practice").append(view.node);
  t.after(() => { dom.window.close(); globalThis.chrome = previousChrome; });
  return { view, document, window: dom.window, el,
    reader: () => readerLoads === 0 ? null : pendingReader,
    readerLoads: () => readerLoads,
    loaded: async () => { loaded(); await tick(); },
    failed: async () => { failed(new Error("reader failed")); await tick(); },
    update: (options = OPTIONS, dictionaries = DICTIONARIES, outcome = "ready") => view.update(options, dictionaries, outcome) };
}

test("the keyboard lookup control selects the exercise's real text after the ordinary reader loads", async t => {
  const f = fixture(t);
  f.update();
  const lookup = f.el("setup-practice-lookup");
  assert.equal(lookup.disabled, true);
  assert.equal(f.el("finish").disabled, false);
  await f.loaded();
  assert.equal(lookup.disabled, false);
  lookup.focus();
  lookup.click();
  const selection = f.window.getSelection();
  assert.equal(selection.toString(), "辞書");
  assert.equal(selection.getRangeAt(0).commonAncestorContainer, f.el("setup-practice-word"));
  assert.ok(f.el("setup-practice-text").contains(selection.anchorNode));
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
});

test("the final step can trigger the same precise lookup as soon as the reader is ready", async t => {
  const f = fixture(t);
  f.update();
  assert.equal(f.view.lookup(), false);
  await f.loaded();
  assert.equal(f.view.lookup(), true);
  assert.equal(f.window.getSelection().toString(), "辞書");
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
});

test("a passage-only result keeps the reader available without advertising an unanswered shortcut", async t => {
  const f = fixture(t);
  assert.equal(f.update(OPTIONS, DICTIONARIES, "passage").heading, "You’re ready.");
  await f.loaded();
  assert.equal(f.el("setup-practice-scene").hidden, false);
  assert.equal(f.el("setup-practice-tools").hidden, false);
  assert.equal(f.el("setup-practice-lookup").hidden, true);
  assert.equal(f.el("setup-practice-lookup").disabled, true);
  assert.equal(f.el("setup-practice-recovery").hidden, true);
  assert.equal(f.el("setup-practice-instruction").textContent,
    "Try looking up a word below. Hover over Japanese text.");
  f.update({ ...OPTIONS, lookupMode: "activation", activationKey: "Control" }, DICTIONARIES, "passage");
  assert.equal(f.el("setup-practice-instruction").textContent,
    "Try looking up a word below. Hold Control and hover over a word.");
  f.update();
  f.el("setup-practice-lookup").focus();
  f.update(OPTIONS, DICTIONARIES, "passage");
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
  assert.equal(f.readerLoads(), 1);
  assert.equal(f.el("finish").disabled, false);
});

test("option and inventory updates retain the scene, selected Range, reader script and local-file dismissal", async t => {
  const f = fixture(t);
  f.update();
  await f.loaded();
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
  assert.equal(f.readerLoads(), 1);
  await tick();
  f.el("local-file-skip").click();
  f.update();
  assert.equal(f.el("setup-file-access").hidden, true);
  assert.equal(f.document.activeElement, f.el("finish"));
  assert.equal(f.el("finish").disabled, false);
});

test("missing or disabled term dictionaries and disabled lookups give recovery without blocking Finish", async t => {
  const f = fixture(t);
  for (const dictionaries of [[], [{ ...DICTIONARIES[0], enabled: false }], [{ id: "frequency-only", termCount: 0 }]]) {
    const state = f.update(OPTIONS, dictionaries);
    const installed = dictionaries.some(entry => entry.termCount > 0);
    assert.equal(state.heading, installed ? "Enable a dictionary to try Hachidori" : "Add a dictionary to try Hachidori");
    assert.equal(state.canProbe, false);
    assert.equal(f.el("setup-practice-recovery").querySelector("a").textContent, installed ? "Open Library" : "Add dictionaries");
    assert.equal(f.el("setup-practice-scene").hidden, true);
    assert.match(f.el("setup-practice-recovery").textContent, dictionaries.some(entry => entry.termCount > 0)
      ? /Your term dictionaries are turned off/u : /Add a term dictionary/u);
    assert.equal(f.el("setup-practice-tools").hidden, true);
    assert.equal(f.el("setup-practice-recovery").querySelector("a").getAttribute("href"),
      dictionaries.some(entry => entry.termCount > 0) ? "settings.html#dictionaries" : "settings.html#add-dictionaries");
    assert.equal(f.reader(), null);
    assert.equal(f.el("finish").disabled, false);
  }
  assert.equal(f.update({ ...OPTIONS, hoverEnabled: false }).heading, "Turn on lookups to try Hachidori");
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
  assert.equal(f.update().heading, "You’re ready.");
  assert.equal(f.document.activeElement, f.el("setup-practice-text"));
  await f.loaded();
  f.el("setup-practice-lookup").click();
  f.update({ ...OPTIONS, hoverEnabled: false });
  assert.equal(f.document.activeElement, link, "hiding the active exercise hands focus to its recovery action");
});

test("the practice invitation follows the current probe outcome even when the reader finishes loading later", async t => {
  const f = fixture(t);
  const scene = f.el("setup-practice-scene");
  const text = f.el("setup-practice-text").firstChild;
  const tools = f.el("setup-practice-tools");
  const recovery = f.el("setup-practice-recovery");
  f.update(OPTIONS, DICTIONARIES, null);
  assert.equal(scene.hidden, true);
  assert.equal(tools.hidden, true);
  assert.equal(recovery.hidden, true);
  assert.match(f.el("setup-practice-instruction").textContent, /Checking/u);
  assert.equal(f.readerLoads(), 0);
  f.update(OPTIONS, DICTIONARIES, "missing");
  assert.equal(scene.hidden, true);
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /do not have the words in this sample/u);
  assert.equal(recovery.querySelector("a").getAttribute("href"), "settings.html#add-dictionaries");
  assert.equal(f.readerLoads(), 0);
  f.update();
  assert.equal(scene.hidden, false);
  assert.equal(f.readerLoads(), 1);
  f.update(OPTIONS, DICTIONARIES, "missing");
  await f.loaded();
  assert.equal(scene.hidden, true, "a late reader load must not revive a retired invitation");
  assert.equal(tools.hidden, true);
  f.update({ ...OPTIONS, lookupMode: "activation", activationKey: "Control" }, DICTIONARIES, "unavailable");
  assert.match(f.el("setup-practice-instruction").textContent, /Hold Control.*on any webpage/u);
  assert.match(recovery.textContent, /engine could not answer/u);
  assert.equal(f.el("finish").disabled, false);
  f.update();
  assert.equal(f.el("setup-practice-scene"), scene);
  assert.equal(f.el("setup-practice-text").firstChild, text);
  assert.equal(scene.hidden, false);
  assert.equal(tools.hidden, false);
  assert.equal(f.el("setup-practice-lookup").disabled, false);
  assert.equal(f.readerLoads(), 1);
});

test("reader load failure leaves a recoverable optional exercise and cannot enable lookup", async t => {
  const f = fixture(t);
  f.update();
  await f.failed();
  assert.equal(f.el("setup-practice-tools").hidden, true);
  assert.match(f.el("setup-practice-recovery").textContent, /reader could not load.*Reload/u);
  assert.equal(f.el("finish").disabled, false);
  f.update();
  assert.equal(f.readerLoads(), 1);
  assert.equal(f.el("setup-practice-tools").hidden, true);
});
