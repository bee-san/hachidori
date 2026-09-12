// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createKeybindSettingsController, formatKeybind, KEYBIND_OPTION_LABELS } from "../extension/keybind-settings.js";
import "../extension/reader-options.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { DEFAULT_OPTIONS, KEYBIND_TOGGLE_OPTIONS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
const plain = value => JSON.parse(JSON.stringify(value));

test("default keybinds keep Yomitan's keys for the actions Hachidori supports and patches stay strict", () => {
  assert.deepEqual(DEFAULT_OPTIONS.keybinds.map(({ action, argument, key, modifiers }) =>
    `${formatKeybind(key, modifiers)} ${action}${argument ? ` ${argument}` : ""}`), [
    "Escape close", "Alt + PageUp previousEntry 3", "Alt + PageDown nextEntry 3", "Alt + End lastEntry",
    "Alt + Home firstEntry", "Alt + ArrowUp previousEntry 1", "Alt + ArrowDown nextEntry 1",
    "Alt + B historyBackward", "Alt + E addNote", "Alt + P playAudio", "Alt + V viewNotes",
  ]);
  assert.ok(DEFAULT_OPTIONS.keybinds.every(bind => bind.enabled && bind.scopes.join() === "popup"));
  assert.deepEqual(plain(normaliseOptions({}).keybinds), plain(DEFAULT_OPTIONS.keybinds));
  assert.deepEqual(plain(normaliseOptions({ keybinds: [
    { action: "nextEntry", argument: "0", key: "", modifiers: ["shift", "alt", "hyper", "alt"], scopes: ["search", "web"] },
    { action: "profileNext", argument: "", key: "Equal", modifiers: ["alt"], scopes: ["popup"], enabled: true },
    { action: "toggleOption", argument: "scanLength", key: "KeyT", modifiers: [], scopes: ["web"], enabled: false },
    null,
  ] }).keybinds), [
    { action: "nextEntry", argument: "1", key: null, modifiers: ["alt", "shift"], scopes: ["web"], enabled: true },
    { action: "toggleOption", argument: "", key: "KeyT", modifiers: [], scopes: ["web"], enabled: false },
  ]);
  assert.deepEqual(plain(validateOptionsPatch({ keybinds: [] })), { keybinds: [] });
  validateOptionsPatch({ keybinds: DEFAULT_OPTIONS.keybinds });
  const valid = { action: "playAudioFromSource", argument: "source-id", key: null, modifiers: ["ctrl"], scopes: ["popup"], enabled: true };
  validateOptionsPatch({ keybinds: [valid] });
  for (const invalid of [{ ...valid, action: "copyHostSelection" }, { ...valid, modifiers: ["shift", "ctrl"] },
    { ...valid, scopes: ["search"] }, { ...valid, key: "" }, { ...valid, enabled: "yes" },
    { ...valid, action: "nextEntry", argument: "-1" }, { ...valid, action: "toggleOption", argument: "maxResults" }]) {
    assert.throws(() => validateOptionsPatch({ keybinds: [invalid] }), /invalid reader option/u, JSON.stringify(invalid));
  }
  assert.throws(() => validateOptionsPatch({ keybinds: {} }), /invalid reader option/u);
  assert.deepEqual(Object.keys(KEYBIND_OPTION_LABELS), KEYBIND_TOGGLE_OPTIONS, "every toggleable option has its Settings label");
});

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: "https://extension.test/settings.html" });
  const { window } = dom;
  window.HDReaderOptions = globalThis.HDReaderOptions;
  const { document } = window;
  document.getElementById("keybinds").hidden = false;
  let keybinds = plain(DEFAULT_OPTIONS.keybinds);
  const sources = [{ id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" },
    { id: "json", type: "custom-json", enabled: true, url: "https://audio.test/{term}", voice: "" }];
  let writes = 0;
  const controller = createKeybindSettingsController({ document, readKeybinds: () => keybinds,
    editKeybinds(value) { writes += 1; keybinds = value; }, readAudioSources: () => sources });
  controller.render();
  const rows = () => [...document.querySelectorAll("#keybind-list > .keybind-row")];
  const row = index => rows()[index];
  const control = (index, name) => row(index).querySelector(`.keybind-${name}`);
  function press(index, init) {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    control(index, "input").dispatchEvent(event);
    return event.defaultPrevented;
  }
  function choose(node, value) {
    node.value = value;
    node.dispatchEvent(new window.Event(node.type === "number" ? "input" : "change", { bubbles: true }));
  }
  t.after(() => window.close());
  return { window, document, controller, rows, row, control, press, choose,
    get keybinds() { return keybinds; }, get writes() { return writes; },
    receive(value) { keybinds = value; controller.render(); } };
}

test("keybind rows capture Yomitan-style key combinations and edit actions, arguments and scopes", t => {
  const f = fixture(t);
  assert.equal(f.rows().length, 11);
  assert.equal(f.control(0, "input").value, "Escape");
  assert.equal(f.control(0, "action").value, "close");
  assert.equal(f.control(8, "input").value, "Alt + E");

  assert.equal(f.press(8, { key: "r", code: "KeyR", altKey: true, shiftKey: true }), true);
  assert.deepEqual(plain(f.keybinds[8]), { ...plain(DEFAULT_OPTIONS.keybinds[8]), key: "KeyR", modifiers: ["alt", "shift"] });
  assert.equal(f.control(8, "input").value, "Alt + Shift + R");
  assert.equal(f.press(8, { key: "Tab", code: "Tab" }), false, "plain Tab leaves the field");
  f.press(8, { key: "Control", code: "ControlLeft", ctrlKey: true });
  assert.deepEqual([f.keybinds[8].key, ...f.keybinds[8].modifiers], ["KeyR", "ctrl"], "a modifier press keeps the key");
  f.control(8, "clear").click();
  f.press(8, { key: "Alt", code: "AltLeft", altKey: true });
  assert.deepEqual([f.keybinds[8].key, ...f.keybinds[8].modifiers], [null, "alt"], "modifier-only input is kept");
  f.control(8, "reset").click();
  assert.deepEqual(plain(f.keybinds[8]), plain(DEFAULT_OPTIONS.keybinds[8]));

  f.choose(f.control(8, "action"), "nextEntry");
  assert.deepEqual([f.keybinds[8].action, f.keybinds[8].argument, f.keybinds[8].scopes.join()], ["nextEntry", "1", "popup"]);
  assert.equal(f.row(8).querySelector(".keybind-count-field").hidden, false);
  f.choose(f.control(8, "count"), "4");
  f.choose(f.control(8, "count"), "0");
  assert.equal(f.keybinds[8].argument, "4", "an invalid count draft is not written");
  f.control(8, "reset").click();
  assert.deepEqual([f.keybinds[8].key, f.keybinds[8].argument], ["PageDown", "3"], "Reset uses the action's first default");

  f.choose(f.control(8, "action"), "scanSelectedText");
  const [popupScope, webScope] = f.row(8).querySelectorAll(".keybind-scope");
  assert.deepEqual([f.keybinds[8].scopes.join(), popupScope.hidden, webScope.hidden, f.control(8, "reset").disabled], ["web", true, false, true]);
  f.choose(f.control(8, "action"), "toggleOption");
  assert.deepEqual([popupScope.hidden, webScope.hidden, f.keybinds[8].scopes.join()], [false, false, "popup,web"]);
  webScope.querySelector("input").click();
  assert.equal(f.keybinds[8].scopes.join(), "popup");
  assert.equal([...f.control(8, "option").options].find(option => option.value === "hoverEnabled").textContent, "Enable hover lookups");
  f.choose(f.control(8, "option"), "hoverEnabled");
  assert.equal(f.keybinds[8].argument, "hoverEnabled");

  f.choose(f.control(8, "action"), "playAudioFromSource");
  assert.deepEqual([...f.control(8, "source").options].map(option => option.textContent),
    ["Choose a source", "1. Speech: reading", "2. Yomitan JSON"]);
  f.choose(f.control(8, "source"), "json");
  f.receive(f.keybinds.map((bind, index) => index === 8 ? { ...bind, argument: "gone" } : bind));
  assert.equal(f.control(8, "source").selectedOptions[0].textContent, "Removed source");

  f.control(8, "enabled-input").click();
  assert.equal(f.keybinds[8].enabled, false);
  f.control(0, "remove").click();
  assert.equal(f.rows().length, 10);
  assert.equal(f.keybinds[0].action, "previousEntry");
  assert.equal(f.document.activeElement.id, "keybind-add");
  assert.equal(f.row(0).querySelector(".keybind-number").textContent, "Keybind 1");
});

test("keybind lists add blank rows, show an empty state and reset to the defaults", t => {
  const f = fixture(t);
  f.document.getElementById("keybind-add").click();
  assert.deepEqual(plain(f.keybinds.at(-1)), { action: "", argument: "", key: null, modifiers: [], scopes: ["popup"], enabled: true });
  assert.equal(f.document.activeElement, f.control(11, "input"));
  assert.equal(f.control(11, "input").value, "");
  assert.ok([...f.row(11).querySelectorAll(".keybind-scope")].every(scope => scope.hidden), "None offers no scope");
  f.receive([]);
  assert.equal(f.rows().length, 0);
  assert.equal(f.document.getElementById("keybind-empty").hidden, false);
  f.document.getElementById("keybind-reset-all").click();
  assert.deepEqual(plain(f.keybinds), plain(DEFAULT_OPTIONS.keybinds));
  assert.equal(f.rows().length, 11);
  assert.equal(f.document.getElementById("keybind-empty").hidden, true);
  f.control(0, "clear").click();
  assert.equal(DEFAULT_OPTIONS.keybinds[0].key, "Escape", "editing never mutates the defaults");
});
