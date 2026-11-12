// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import "../extension/reader-options.js";
import { applyCustomJavaScript, userScriptSource } from "../extension/custom-javascript.js";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const extension = new URL("../extension/", import.meta.url);
const warning = "Do not paste Javascript here you do not understand, it is a security risk.";

const script = (id, fields = {}) => ({ id, name: id, enabled: true, javascript: "", css: "", ...fields });

test("Advanced → User scripts holds the one warning, and Design points to it", async () => {
  const html = await readFile(new URL("settings.html", extension), "utf8");
  const section = html.slice(html.indexOf('id="user-scripts"'), html.indexOf('id="languages"'));
  assert.equal(html.split(warning).length - 1, 1);
  assert.match(section, new RegExp(`id="custom-javascript-warning">${warning.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}</p>`, "u"));
  assert.match(section, /id="user-script-javascript"/u);
  assert.match(section, /id="user-script-css"/u);
  assert.match(section, /once Allow User Scripts is on in Hachidori's details/u);
  assert.equal(html.includes("opt-custom-popup-javascript"), false);
  const design = html.slice(html.indexOf('id="design"'), html.indexOf('id="audio"'));
  assert.match(design, /id="custom-javascript-moved">Custom JavaScript is in <a href="#user-scripts">/u);
});

test("user scripts are a global option, and saved Custom JavaScript becomes the first", () => {
  const { DEFAULT_OPTIONS, DESIGN_OPTION_KEYS, GLOBAL_OPTION_KEYS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
  assert.deepEqual(DEFAULT_OPTIONS.userScripts, []);
  assert.equal(Object.hasOwn(DEFAULT_OPTIONS, "customPopupJavascript"), false);
  assert.equal(DESIGN_OPTION_KEYS.includes("userScripts"), false, "Reset Design keeps the scripts");
  assert.ok(GLOBAL_OPTION_KEYS.includes("userScripts"));
  const code = "document.body.dataset.test = 'yes';";
  assert.deepEqual(normaliseOptions({ customPopupJavascript: code }).userScripts,
    [{ id: "custom-javascript", name: "Custom JavaScript", enabled: true, javascript: code, css: "" }]);
  // Saved scripts win over the old key, and blank old code makes no script.
  assert.deepEqual(normaliseOptions({ customPopupJavascript: code, userScripts: [] }).userScripts, []);
  assert.deepEqual(normaliseOptions({ customPopupJavascript: " \n" }).userScripts, []);
  assert.equal(Object.hasOwn(normaliseOptions({ customPopupJavascript: code }), "customPopupJavascript"), false);
  // A write from an older linked browser cannot replace the scripts.
  assert.deepEqual(validateOptionsPatch({ customPopupJavascript: code }), {});
  const scripts = [script("a", { javascript: "window.a = 1;" }), script("b", { enabled: false, css: "p { color: red; }" })];
  assert.deepEqual(validateOptionsPatch({ userScripts: scripts }), { userScripts: scripts });
  for (const invalid of [[{ ...scripts[0], enabled: "yes" }], [scripts[0], scripts[0]], [{ ...scripts[0], name: " " }],
    [{ ...scripts[0], name: "a\tb" }], [{ ...scripts[0], css: null }], "window.a = 1;"]) {
    assert.throws(() => validateOptionsPatch({ userScripts: invalid }), /invalid reader option/u);
  }
  // Stored garbage keeps the valid packages.
  assert.deepEqual(normaliseOptions({ userScripts: [null, scripts[0], { id: "c" }, scripts[0]] }).userScripts, [scripts[0]]);
});

test("the popup's own styles are switched-on packages' CSS in order, then Custom CSS", () => {
  const { normaliseOptions, userPopupStyles } = globalThis.HDReaderOptions;
  const options = normaliseOptions({ customPopupCss: ".design {}", userScripts: [
    script("a", { css: ".a {}" }), script("b", { enabled: false, css: ".b {}" }), script("c", { javascript: "1;" }),
    script("d", { css: ".d {}" })] });
  assert.deepEqual(userPopupStyles(options), [".a {}", "", ".d {}", ".design {}"]);
});

test("switched-on JavaScript registers after the popup bridge, one source per package in list order", async () => {
  const calls = [];
  const browser = { userScripts: {
    async getScripts(filter) { calls.push(["get", filter]); return [{ id: "hachidori-custom-javascript" }]; },
    async unregister(filter) { calls.push(["unregister", filter]); },
    async register(scripts) { calls.push(["register", scripts]); },
  } };
  const first = script("first", { javascript: "window.first = 1;", css: ".first {}" });
  const second = script("second one", { javascript: "window.second = 2;" });
  assert.deepEqual(await applyCustomJavaScript(browser, [
    first, script("off", { enabled: false, javascript: "window.off = 1;" }), script("css", { css: ".css {}" }), second,
  ]), { supported: true, registered: true });
  assert.deepEqual(calls, [
    ["get", { ids: ["hachidori-custom-javascript"] }],
    ["unregister", { ids: ["hachidori-custom-javascript"] }],
    ["register", [{ id: "hachidori-custom-javascript", matches: ["<all_urls>"], allFrames: true,
      js: [{ file: "anki-preparation-runtime.js" }, { file: "custom-javascript-bridge.js" }, { code: userScriptSource(first) }, { code: userScriptSource(second) }],
      runAt: "document_idle", world: "USER_SCRIPT" }]],
  ]);
  assert.equal(userScriptSource(second),
    '(globalThis.HDAnkiPreparation?.runPackage ?? ((_id, run) => run.call(globalThis)))("second one", function () {\nwindow.second = 2;\n});\n//# sourceURL=hachidori-user-script/second%20one.js');
});

// Two packages may both declare `const popup` or return early (docs/search-history.md).
test("each package runs in its own function: top-level names stay its own and return works", () => {
  const context = vm.createContext({});
  for (const javascript of [
    "const popup = 1;\nglobalThis.first = popup;",
    "if (!globalThis.HDSearchHistory) return;\nglobalThis.unreached = true;",
    "\"use strict\";\nconst popup = 2;\nglobalThis.second = popup;\nglobalThis.self = this === globalThis; // a comment",
  ]) vm.runInContext(userScriptSource(script("package", { javascript })), context);
  assert.deepEqual({ ...context }, { first: 1, second: 2, self: true });
});

// The bridge runs in the user-script world, ahead of the saved code (#645).
test("the bridge attaches the reader's closed root and returns it through host.shadowRoot", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  window.eval(await readFile(new URL("custom-javascript-bridge.js", extension), "utf8"));
  const { document } = window;
  const request = element => element.dispatchEvent(new window.CustomEvent("hachidori-popup-root"));
  const host = document.body.appendChild(document.createElement("hachidori-host"));
  request(host);
  const root = host.shadowRoot;
  assert.equal(root?.mode, "closed");
  assert.equal(root.host, host);
  // Other elements keep the browser's answer: open roots, never closed ones.
  const open = document.body.appendChild(document.createElement("div"));
  const openRoot = open.attachShadow({ mode: "open" });
  const closed = document.body.appendChild(document.createElement("div"));
  closed.attachShadow({ mode: "closed" });
  assert.equal(open.shadowRoot, openRoot);
  assert.equal(closed.shadowRoot, null);
  // The request attaches nothing to any other element.
  const other = document.body.appendChild(document.createElement("span"));
  request(other);
  assert.equal(other.shadowRoot, null);
  assert.equal(other.attachShadow({ mode: "open" }).mode, "open");
});

test("no switched-on JavaScript removes the registration, and unavailable user scripts are harmless", async () => {
  const calls = [];
  const browser = { userScripts: {
    async getScripts() { return [{ id: "hachidori-custom-javascript" }]; },
    async unregister(filter) { calls.push(filter); },
  } };
  assert.deepEqual(await applyCustomJavaScript(browser, [script("off", { enabled: false, javascript: "window.off = 1;" }),
    script("css only", { css: ".css {}" })]), { supported: true, registered: false });
  assert.deepEqual(calls, [{ ids: ["hachidori-custom-javascript"] }]);
  // Hosts without `userScripts` report the gap instead of throwing.
  assert.deepEqual(await applyCustomJavaScript({}, [script("a", { javascript: "window.test = true;" })]),
    { supported: false, registered: false });
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
      registered.push(script.js.at(-1).code);
    },
  } };
  await Promise.all([
    applyCustomJavaScript(browser, [script("edit", { javascript: "window.edit = 1;" })]),
    applyCustomJavaScript(browser, [script("edit", { javascript: "window.edit = 2;" })]),
  ]);
  assert.deepEqual(registered, ["window.edit = 1;", "window.edit = 2;"].map(javascript => userScriptSource(script("edit", { javascript }))));
});
