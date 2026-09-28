// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createActivationSettings } from "../extension/activation-settings.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const MARKUP = `<select id="opt-activation-key"></select>
  <button id="opt-activation-record" type="button" aria-pressed="false">Press to set</button>
  <a id="elsewhere" href="https://example.test/">elsewhere</a>`;

function fixture(t) {
  const dom = new JSDOM(MARKUP, { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  const reports = [];
  const controller = createActivationSettings({ document: window.document, report: message => reports.push(message) });
  controller.render("Shift");
  const el = id => window.document.getElementById(id);
  // Settings saves from the picker's change event, which a recorded input fires.
  const chosen = [];
  el("opt-activation-key").addEventListener("change", event => chosen.push(event.target.value));
  const recorder = el("opt-activation-record");
  // Returns whether the event's default action was cancelled.
  const mouse = (type, button, target = el("elsewhere")) => !target.dispatchEvent(
    new window.MouseEvent(type, { button, bubbles: true, cancelable: true }));
  const key = (value, extra = {}) => !recorder.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra }));
  return { window, el, recorder, chosen, reports, mouse, key,
    armed: () => recorder.getAttribute("aria-pressed") === "true" };
}

test("the picker lists No key, then the mouse buttons above the keys", t => {
  const f = fixture(t);
  const select = f.el("opt-activation-key");
  assert.deepEqual([select.children[0].value, select.children[0].textContent], ["", "No key"]);
  const groups = [...select.querySelectorAll("optgroup")];
  assert.deepEqual(groups.map(group => group.label), ["Mouse buttons", "Keys"]);
  assert.deepEqual([...groups[0].children].map(option => [option.value, option.textContent]), [
    ["MouseMiddle", "Middle mouse button"],
    ["MouseBack", "Back mouse button (mouse 4)"],
    ["MouseForward", "Forward mouse button (mouse 5)"],
  ]);
  assert.equal(groups[1].children[0].value, "Shift");
  assert.equal(select.value, "Shift");
});

test("Press to set records the next supported button and keeps its native actions from running", t => {
  const f = fixture(t);
  f.recorder.click();
  assert.equal(f.armed(), true);
  assert.equal(f.recorder.textContent, "Press a key or button…");
  assert.equal(f.mouse("mousedown", 1), true, "the press starts no autoscroll");
  assert.deepEqual(f.chosen, ["MouseMiddle"]);
  assert.equal(f.el("opt-activation-key").value, "MouseMiddle");
  assert.equal(f.armed(), false);
  assert.equal(f.recorder.textContent, "Press to set");
  assert.equal(f.mouse("mouseup", 1), true);
  assert.equal(f.mouse("auxclick", 1), true, "the recorded press opens no link in a new tab");

  f.recorder.click();
  assert.equal(f.mouse("mousedown", 3), true);
  assert.equal(f.mouse("mouseup", 3), true, "the recorded Back press does not navigate");
  assert.deepEqual(f.chosen, ["MouseMiddle", "MouseBack"]);

  assert.equal(f.mouse("mousedown", 1), false, "an unarmed press keeps its native actions");
  assert.equal(f.mouse("auxclick", 1), false);
  assert.deepEqual(f.chosen, ["MouseMiddle", "MouseBack"]);
  assert.deepEqual(f.reports, []);
});

test("Press to set records listed keys and reports every other input without saving it", t => {
  const f = fixture(t);
  f.recorder.click();
  assert.equal(f.key("k"), true);
  f.recorder.click();
  assert.equal(f.key(" "), true);
  assert.deepEqual(f.chosen, ["K", "Space"]);

  f.recorder.click();
  assert.equal(f.key("CapsLock"), true);
  f.recorder.click();
  assert.equal(f.mouse("mousedown", 2), true);
  assert.equal(f.mouse("contextmenu", 2), true, "the refused press opens no menu");
  f.recorder.click();
  assert.equal(f.mouse("mousedown", 0), false, "a click elsewhere cancels and keeps its own action");
  f.recorder.click();
  f.recorder.click();
  assert.equal(f.armed(), false, "a second click on the recorder cancels it");
  assert.deepEqual(f.reports, [
    "CapsLock cannot be used to scan.",
    "The right mouse button cannot be used to scan.",
    "The left mouse button cannot be used to scan.",
    "The left mouse button cannot be used to scan.",
  ]);

  f.recorder.click();
  assert.equal(f.key("Shift", { repeat: true }), true);
  assert.equal(f.armed(), true, "a held key's repeats are ignored");
  assert.equal(f.key("Escape"), true);
  assert.equal(f.armed(), false);
  assert.equal(f.key("k"), false, "an unarmed key press is left alone");
  assert.deepEqual(f.chosen, ["K", "Space"]);
  assert.equal(f.reports.length, 4);
  assert.equal(f.el("opt-activation-key").value, "Space");
});
