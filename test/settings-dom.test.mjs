import "../extension/reader-options.js";
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { applyPageTheme, setStatusOutput, showErrorCopy } from "../extension/settings-dom.js";

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

test("a focused Copy error details hands keyboard focus to its status when the error clears", () => {
  const dom = new JSDOM("<main><output id=\"status\" aria-live=\"polite\"></output><button id=\"other\">Other</button></main>",
    { pretendToBeVisual: true });
  const { document } = dom.window;
  const output = document.getElementById("status");
  showErrorCopy(output, { message: "Cannot reach the engine" });
  const copy = output.nextElementSibling;
  assert.equal(copy.textContent, "Copy error details");
  copy.focus();
  assert.equal(document.activeElement, copy);
  showErrorCopy(output, null);
  assert.equal(copy.hidden, true);
  assert.equal(document.activeElement, output, "focus moves to the status, not the page");
  assert.equal(output.getAttribute("tabindex"), "-1", "the status takes focus without joining the tab order");

  // Focus elsewhere stays where the reader put it.
  showErrorCopy(output, { message: "Cannot reach the engine" });
  document.getElementById("other").focus();
  showErrorCopy(output, null);
  assert.equal(document.activeElement, document.getElementById("other"));
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
