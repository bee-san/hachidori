// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/reader-options.js";
import { GOOGLE_DOCS_SCRIPT, applyGoogleDocsFlag } from "../extension/google-docs.js";

const extension = new URL("../extension/", import.meta.url);
const SCRIPT_ID = "hachidori-google-docs";

test("Google Docs is an experimental flag that starts off", () => {
  const { DEFAULT_OPTIONS, EXPERIMENTAL_FEATURES } = globalThis.HDReaderOptions;
  const feature = EXPERIMENTAL_FEATURES.find(entry => entry.id === "googleDocs");
  assert.equal(feature?.label, "Google Docs");
  assert.equal(feature.section, undefined, "the flag has no Settings section of its own");
  assert.equal(DEFAULT_OPTIONS.experimental.googleDocs, false);
});

test("the flag script sets exactly the allow-listed Docs value in the page's main world", async () => {
  const source = await readFile(new URL("google-docs-flag.js", extension), "utf8");
  const window = {};
  new Function("window", source)(window);
  assert.deepEqual(window, { _docs_annotate_canvas_by_ext: "ogmnaimimemjmbakcfefmnahgdfhfami" });
  assert.equal(GOOGLE_DOCS_SCRIPT.js[0], "google-docs-flag.js");
});

test("both manifests grant scripting so the flag script can be registered", async () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(await readFile(new URL(name, extension), "utf8"));
    assert.ok(manifest.permissions.includes("scripting"), name);
    assert.equal(JSON.stringify(manifest).includes("google-docs-flag.js"), false,
      `${name} neither injects nor exposes the flag script statically`);
  }
});

test("turning the flag on registers one document_start MAIN-world script for Docs", async () => {
  const calls = [];
  const browser = { scripting: {
    async getRegisteredContentScripts(filter) { calls.push(["get", filter]); return []; },
    async registerContentScripts(scripts) { calls.push(["register", scripts]); },
    async unregisterContentScripts(filter) { calls.push(["unregister", filter]); },
  } };
  assert.deepEqual(await applyGoogleDocsFlag(browser, true), { supported: true, registered: true });
  assert.deepEqual(calls, [
    ["get", { ids: [SCRIPT_ID] }],
    ["register", [{
      id: SCRIPT_ID,
      matches: ["*://docs.google.com/*"],
      js: ["google-docs-flag.js"],
      runAt: "document_start",
      allFrames: true,
      world: "MAIN",
    }]],
  ]);
  // Already registered: nothing to do.
  browser.scripting.getRegisteredContentScripts = async () => [{ id: SCRIPT_ID }];
  calls.length = 0;
  assert.deepEqual(await applyGoogleDocsFlag(browser, true), { supported: true, registered: true });
  assert.deepEqual(calls, []);
});

test("turning the flag off unregisters the script and a browser without scripting is harmless", async () => {
  const calls = [];
  const browser = { scripting: {
    async getRegisteredContentScripts() { return [{ id: SCRIPT_ID }]; },
    async registerContentScripts(scripts) { calls.push(["register", scripts]); },
    async unregisterContentScripts(filter) { calls.push(["unregister", filter]); },
  } };
  assert.deepEqual(await applyGoogleDocsFlag(browser, false), { supported: true, registered: false });
  assert.deepEqual(calls, [["unregister", { ids: [SCRIPT_ID] }]]);
  browser.scripting.getRegisteredContentScripts = async () => [];
  calls.length = 0;
  assert.deepEqual(await applyGoogleDocsFlag(browser, false), { supported: true, registered: false });
  assert.deepEqual(calls, [], "nothing registered means nothing to unregister");
  assert.deepEqual(await applyGoogleDocsFlag({}, true), { supported: false, registered: false });
});

test("rapid toggles apply in order without duplicate registrations", async () => {
  const active = new Set();
  const transitions = [];
  const browser = { scripting: {
    async getRegisteredContentScripts({ ids }) { return ids.filter(id => active.has(id)).map(id => ({ id })); },
    async registerContentScripts([script]) {
      assert.equal(active.has(script.id), false);
      active.add(script.id);
      transitions.push("on");
    },
    async unregisterContentScripts({ ids }) {
      for (const id of ids) active.delete(id);
      transitions.push("off");
    },
  } };
  await Promise.all([
    applyGoogleDocsFlag(browser, true),
    applyGoogleDocsFlag(browser, false),
    applyGoogleDocsFlag(browser, true),
  ]);
  assert.deepEqual(transitions, ["on", "off", "on"]);
  assert.deepEqual([...active], [SCRIPT_ID]);
});
