// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { applyPageTheme, setStatusOutput } from "../extension/settings-dom.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

test("status outputs switch one semantic tone at a time without repeating unchanged live-region mutations", () => {
  const dom = new JSDOM("<output></output>");
  const output = dom.window.document.querySelector("output");
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(output, { childList: true, characterData: true, attributes: true });

  setStatusOutput(output, "Checking AnkiConnect…", "working");
  assert.equal(output.textContent, "Checking AnkiConnect…");
  assert.deepEqual([...output.classList], ["is-working"]);
  observer.takeRecords();

  setStatusOutput(output, "Checking AnkiConnect…", "working");
  assert.equal(observer.takeRecords().length, 0);

  setStatusOutput(output, "Connected · configuration ready", "ready");
  assert.deepEqual([...output.classList], ["is-ready"]);
  setStatusOutput(output, "Not connected");
  assert.equal(output.className, "");
  setStatusOutput(output, "AnkiConnect returned HTTP 503.", "error");
  assert.deepEqual([...output.classList], ["is-error"]);
  dom.window.close();
});

test("AUTO page themes follow live browser preference without changing explicit choices", () => {
  const dom = new JSDOM("<main></main>");
  let dark = false;
  let changed;
  dom.window.matchMedia = () => ({
    get matches() { return dark; },
    addEventListener(type, listener) { if (type === "change") changed = listener; },
  });

  applyPageTheme(dom.window.document, { popupTheme: "auto" });
  assert.equal(dom.window.document.documentElement.dataset.hoshidictsTheme, "light");
  dark = true;
  changed();
  assert.equal(dom.window.document.documentElement.dataset.hoshidictsTheme, "dark");

  applyPageTheme(dom.window.document, { popupTheme: "dracula" });
  dark = false;
  changed();
  assert.equal(dom.window.document.documentElement.dataset.hoshidictsTheme, "dracula");

  const detached = { defaultView: null, documentElement: { dataset: {} } };
  applyPageTheme(detached, { popupTheme: "auto" });
  assert.equal(detached.documentElement.dataset.hoshidictsTheme, "light");
  dom.window.close();
});
