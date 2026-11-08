// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced → User scripts' list and editor (user-script-settings.js) on the
// section's markup from settings.html.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createUserScriptSettings, nameFromFile, packageSize } from "../extension/user-script-settings.js";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const html = await readFile(new URL("../extension/settings.html", import.meta.url), "utf8");
const section = html.slice(html.indexOf("<section", html.indexOf('id="user-scripts"') - 80), html.indexOf("</section>",
  html.indexOf('id="user-scripts"')) + "</section>".length);

function open(scripts = []) {
  const { window } = new JSDOM(`<!doctype html><body><main>${section}</main></body>`);
  const { document } = window;
  document.getElementById("user-scripts").hidden = false;
  const saves = [];
  let stored = scripts;
  let next = 0;
  const controller = createUserScriptSettings({ document, readScripts: () => stored,
    saveScripts: value => { stored = value; saves.push(value); }, createId: () => `id-${next += 1}` });
  controller.render();
  const el = id => document.getElementById(id);
  const row = index => el("user-script-list").children[index];
  const action = (index, name) => row(index).querySelector(`[data-action="${name}"]`);
  const type = (id, value) => { el(id).value = value; el(id).dispatchEvent(new window.Event("input", { bubbles: true })); };
  const submit = () => el("user-script-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  return { window, document, el, row, action, type, submit, controller, saves, stored: () => stored };
}

const script = (id, fields = {}) => ({ id, name: id, enabled: true, javascript: "window.a = 1;", css: "", ...fields });

test("a new script needs a name and JavaScript or CSS, and saves switched on at the end", () => {
  const page = open();
  assert.equal(page.el("user-script-empty").hidden, false);
  page.el("user-script-add").click();
  assert.equal(page.el("user-script-form").hidden, false);
  assert.equal(page.el("user-script-form-heading").textContent, "New script");
  assert.equal(page.document.activeElement, page.el("user-script-name"));
  page.submit();
  assert.equal(page.el("user-script-error").textContent, "Enter a name for the script.");
  page.type("user-script-name", "Bold\theadwords");
  page.submit();
  assert.equal(page.el("user-script-error").textContent, "Enter a name without tabs or other control characters.");
  page.type("user-script-name", " Bold headwords ");
  page.submit();
  assert.equal(page.el("user-script-error").textContent, "Add JavaScript, CSS or both.");
  assert.equal(page.document.activeElement, page.el("user-script-javascript"));
  page.type("user-script-css", "b { font-weight: 800; }");
  assert.equal(page.controller.dirty(), true);
  assert.equal(page.el("user-script-css-count").textContent, "23 characters");
  page.submit();
  assert.deepEqual(page.stored(), [{ id: "id-1", enabled: true, name: "Bold headwords", javascript: "", css: "b { font-weight: 800; }" }]);
  assert.equal(page.el("user-script-form").hidden, true);
  assert.equal(page.controller.dirty(), false);
  assert.equal(page.row(0).querySelector(".user-script-summary").textContent, "CSS · 23 B");
  assert.equal(page.document.activeElement, page.action(0, "edit"));
});

test("Edit replaces a package's parts in place and keeps its switch; Cancel keeps the saved one", () => {
  const page = open([script("first", { enabled: false }), script("second")]);
  page.action(0, "edit").click();
  assert.equal(page.el("user-script-form-heading").textContent, "Edit “first”");
  assert.equal(page.el("user-script-submit").textContent, "Save script");
  assert.equal(page.row(0).getAttribute("aria-current"), "true");
  assert.equal(page.controller.dirty(), false);
  page.type("user-script-javascript", "window.b = 2;");
  page.type("user-script-css", "p {}");
  page.el("user-script-cancel").click();
  assert.equal(page.saves.length, 0);
  assert.equal(page.document.activeElement, page.action(0, "edit"));
  page.action(0, "edit").click();
  page.type("user-script-javascript", "window.b = 2;");
  page.submit();
  assert.deepEqual(page.stored()[0], script("first", { enabled: false, javascript: "window.b = 2;" }));
  assert.equal(page.stored().length, 2);
});

test("the switch, the arrows and Delete save at once and keep focus on the row", () => {
  const page = open([script("first"), script("second"), script("third")]);
  page.action(1, "toggle").checked = false;
  page.action(1, "toggle").dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(page.stored()[1].enabled, false);
  assert.ok(page.row(1).classList.contains("is-off"));
  assert.match(page.row(1).querySelector(".user-script-summary").textContent, / · Off$/u);
  assert.equal(page.document.activeElement, page.action(1, "toggle"));
  page.action(0, "down").click();
  assert.deepEqual(page.stored().map(value => value.id), ["second", "first", "third"]);
  assert.equal(page.document.activeElement, page.action(1, "down"));
  assert.equal(page.action(0, "up").disabled, true);
  assert.equal(page.action(2, "down").disabled, true);
  // Delete asks first, with Cancel focused; Cancel keeps the package.
  page.action(1, "delete").click();
  assert.equal(page.document.activeElement, page.row(1).querySelector('[data-action="keep"]'));
  assert.match(page.row(1).querySelector(".user-script-confirm").textContent, /^Delete “first”\?/u);
  page.row(1).querySelector('[data-action="keep"]').click();
  assert.equal(page.row(1).querySelector(".user-script-confirm"), null);
  assert.equal(page.stored().length, 3);
  page.action(1, "delete").click();
  page.row(1).querySelector('[data-action="confirm"]').click();
  assert.deepEqual(page.stored().map(value => value.id), ["second", "third"]);
  assert.equal(page.document.activeElement, page.action(1, "edit"));
});

test("Import files opens a .js and a .css file as one new package, and refuses other files", async () => {
  const page = open();
  const choose = async (input, files) => {
    Object.defineProperty(page.el(input), "files", { configurable: true, value: files });
    page.el(input).dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const file = (name, text) => ({ name, text: async () => text });
  await choose("user-script-import", [file("notes.txt", "x")]);
  assert.equal(page.el("user-script-status").textContent, "Choose a .js file, a .css file or one of each.");
  await choose("user-script-import", [file("copy-word.js", "navigator.clipboard;"), file("copy-word.css", "p {}")]);
  assert.equal(page.el("user-script-form").hidden, false);
  assert.equal(page.el("user-script-name").value, "copy word");
  assert.equal(page.el("user-script-javascript").value, "navigator.clipboard;");
  assert.equal(page.el("user-script-css").value, "p {}");
  assert.equal(page.controller.dirty(), true, "an import is unsaved until Add script");
  // Load .css file replaces the editor's CSS only.
  await choose("user-script-css-file", [file("other.css", "b {}")]);
  assert.equal(page.el("user-script-css").value, "b {}");
  assert.equal(page.el("user-script-javascript").value, "navigator.clipboard;");
  page.submit();
  assert.equal(page.stored()[0].name, "copy word");
});

test("a package's size counts both parts in UTF-8, and names come from file names", () => {
  assert.equal(packageSize({ javascript: "a", css: "食" }), "4 B");
  assert.equal(packageSize({ javascript: "a".repeat(1536), css: "" }), "1.5 KB");
  assert.equal(nameFromFile("one_pitch-dictionary.JS"), "one pitch dictionary");
});
