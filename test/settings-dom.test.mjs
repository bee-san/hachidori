// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setStatusOutput } from "../extension/settings-dom.js";

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
