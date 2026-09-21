// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/reader-options.js";
import { applyCustomJavaScript } from "../extension/custom-javascript.js";

const extension = new URL("../extension/", import.meta.url);
const warning = "Do not paste Javascript here you do not understand, it is a security risk.";

test("Custom JavaScript is directly beneath Custom CSS with one warning", async () => {
  const html = await readFile(new URL("settings.html", extension), "utf8");
  const css = html.indexOf('id="opt-custom-popup-css"');
  const javascript = html.indexOf('id="opt-custom-popup-javascript"');
  assert.ok(css >= 0);
  assert.ok(javascript > css);
  assert.equal(html.split(warning).length - 1, 1);
  assert.match(html, new RegExp(`id="custom-javascript-warning">${warning.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}</p>`, "u"));
  assert.equal(html.slice(css, javascript).includes("reset-design"), false);
  assert.match(html, /Enable user scripts for Hachidori on Chrome's Extensions page/u);
});

test("custom JavaScript is a persisted Design option", () => {
  const { DEFAULT_OPTIONS, DESIGN_OPTION_KEYS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
  assert.equal(DEFAULT_OPTIONS.customPopupJavascript, "");
  assert.ok(DESIGN_OPTION_KEYS.includes("customPopupJavascript"));
  assert.equal(normaliseOptions({ customPopupJavascript: "document.body.dataset.test = 'yes';" }).customPopupJavascript,
    "document.body.dataset.test = 'yes';");
  assert.deepEqual(validateOptionsPatch({ customPopupJavascript: "window.test = true;" }),
    { customPopupJavascript: "window.test = true;" });
  assert.throws(() => validateOptionsPatch({ customPopupJavascript: 1 }), /invalid reader option/u);
});

test("saved JavaScript is registered unchanged for every reader page", async () => {
  const calls = [];
  const browser = { userScripts: {
    async getScripts(filter) { calls.push(["get", filter]); return [{ id: "hachidori-custom-javascript" }]; },
    async unregister(filter) { calls.push(["unregister", filter]); },
    async register(scripts) { calls.push(["register", scripts]); },
  } };
  const code = "window.addEventListener('hachidori-popup-shown', () => {});";
  assert.deepEqual(await applyCustomJavaScript(browser, code), { supported: true, registered: true });
  assert.deepEqual(calls, [
    ["get", { ids: ["hachidori-custom-javascript"] }],
    ["unregister", { ids: ["hachidori-custom-javascript"] }],
    ["register", [{ id: "hachidori-custom-javascript", matches: ["<all_urls>"],
      js: [{ code }], runAt: "document_idle", world: "USER_SCRIPT" }]],
  ]);
});

test("clearing JavaScript removes its registration and unavailable user scripts are harmless", async () => {
  const calls = [];
  const browser = { userScripts: {
    async getScripts() { return [{ id: "hachidori-custom-javascript" }]; },
    async unregister(filter) { calls.push(filter); },
  } };
  assert.deepEqual(await applyCustomJavaScript(browser, ""), { supported: true, registered: false });
  assert.deepEqual(calls, [{ ids: ["hachidori-custom-javascript"] }]);
  // Firefox MV2 and other hosts without `userScripts` report the gap instead of throwing.
  assert.deepEqual(await applyCustomJavaScript({}, "window.test = true;"), { supported: false, registered: false });
});

test("rapid edits are applied in order without duplicate registrations", async () => {
  const active = new Set();
  const registered = [];
  const browser = { userScripts: {
    async getScripts() {},
    async unregister({ ids }) { for (const id of ids) active.delete(id); },
    async register([script]) {
      assert.equal(active.has(script.id), false);
      active.add(script.id);
      registered.push(script.js[0].code);
    },
  } };
  await Promise.all([
    applyCustomJavaScript(browser, "window.edit = 1;"),
    applyCustomJavaScript(browser, "window.edit = 2;"),
  ]);
  assert.deepEqual(registered, ["window.edit = 1;", "window.edit = 2;"]);
});

test("popup shadow DOM is open to the user script", async () => {
  const source = await readFile(new URL("content.js", extension), "utf8");
  assert.match(source, /host\.attachShadow\(\{ mode: "open" \}\)/u);
});
