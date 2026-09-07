// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLocalFileAccessController } from "../extension/local-file-access.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { allowed = false, dismissible = true } = {}) {
  const dom = new JSDOM('<div id="files"></div><button id="finish">Finish</button>', { pretendToBeVisual: true });
  const { document } = dom.window;
  // Let jsdom's initial pageshow settle before mounting the controller.
  await tick();
  let current = allowed;
  const queries = [], tabs = [];
  const chromeApi = {
    extension: { isAllowedFileSchemeAccess() {
      queries.push(current);
      return current;
    } },
    runtime: { id: "hachidori-test-extension" },
    tabs: { async create(details) { tabs.push(details); } },
  };
  const el = id => document.getElementById(id);
  const controller = createLocalFileAccessController({ document, chromeApi, container: el("files"),
    onDismiss: dismissible ? () => el("finish").focus() : null });
  t.after(() => { controller.destroy(); dom.window.close(); });
  return { controller, document, window: dom.window, queries, tabs, el,
    access(value) { current = value; },
    returnToTab() { document.dispatchEvent(new dom.window.Event("visibilitychange")); } };
}

test("checks Chrome before showing the optional prompt and shows confirmed access quietly", async t => {
  let resolveAccess;
  const pending = new Promise(resolve => { resolveAccess = resolve; });
  const f = await fixture(t, { allowed: pending });
  assert.equal(f.el("files").hidden, true);
  f.el("finish").focus();
  resolveAccess(true);
  await tick();
  assert.equal(f.el("files").hidden, false);
  assert.equal(f.el("local-file-heading").hidden, true);
  assert.equal(f.el("local-file-actions").hidden, true);
  assert.equal(f.el("local-file-status").textContent, "Local-file lookups enabled");
  assert.equal(f.document.activeElement, f.el("finish"));
  assert.equal(f.tabs.length, 0);
});

test("details opens only this extension, retains manual instructions, and rechecks on return", async t => {
  const f = await fixture(t);
  await tick();
  const open = f.el("local-file-open");
  open.focus();
  open.click();
  await tick();
  assert.deepEqual(f.tabs, [{ url: "chrome://extensions/?id=hachidori-test-extension" }]);
  assert.equal(f.el("local-file-instruction").hidden, false);
  assert.match(f.el("local-file-instruction").textContent, /Turn on.*then return/u);
  assert.equal(f.el("local-file-status").textContent, "");
  f.returnToTab();
  await tick();
  assert.equal(f.queries.length, 2);
  assert.equal(f.el("local-file-actions").hidden, false);
  assert.equal(f.el("local-file-instruction").hidden, false);
  assert.equal(f.document.activeElement, open);
  f.access(true);
  f.returnToTab();
  await tick();
  assert.equal(f.el("local-file-actions").hidden, true);
  assert.equal(f.el("local-file-status").textContent, "Local-file lookups enabled");
  assert.equal(f.document.activeElement, f.el("local-file-status"));
  const observer = new f.window.MutationObserver(() => {});
  observer.observe(f.el("local-file-status"), { subtree: true, childList: true, characterData: true });
  await f.controller.refresh();
  assert.equal(observer.takeRecords().length, 0, "unchanged access must not repeat the live status");
  observer.disconnect();
});

test("Not now keeps Finish available and does not revive the prompt on return", async t => {
  const f = await fixture(t);
  await tick();
  f.el("local-file-skip").focus();
  f.el("local-file-skip").click();
  assert.equal(f.el("files").hidden, true);
  assert.equal(f.el("finish").disabled, false);
  assert.equal(f.document.activeElement, f.el("finish"));
  f.returnToTab();
  f.window.dispatchEvent(new f.window.Event("pageshow"));
  await tick();
  assert.equal(f.queries.length, 1);
  assert.equal(f.el("files").hidden, true);
});

test("Settings retains the shortcut, pageshow refreshes it, and stale checks cannot undo newer access", async t => {
  const f = await fixture(t, { allowed: true, dismissible: false });
  await tick();
  assert.equal(f.el("local-file-skip"), null);
  assert.equal(f.el("local-file-actions").hidden, false);
  let resolveOld;
  f.access(new Promise(resolve => { resolveOld = resolve; }));
  const pending = f.controller.refresh();
  f.access(false);
  f.window.dispatchEvent(new f.window.Event("pageshow"));
  await tick();
  assert.equal(f.el("local-file-heading").hidden, false);
  assert.equal(f.el("local-file-status").textContent, "");
  resolveOld(true);
  await pending;
  assert.equal(f.el("local-file-status").textContent, "");
  f.access(Promise.reject(new Error("Disconnected")));
  await f.controller.refresh();
  assert.match(f.el("local-file-status").textContent, /Could not check/u);
  assert.doesNotMatch(f.el("local-file-status").textContent, /enabled/u);
  assert.equal(f.el("local-file-actions").hidden, false);
});
