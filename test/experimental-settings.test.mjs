// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createExperimentalSettings } from "../extension/experimental-settings.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const MARKUP = `<ul id="experimental-features"></ul><p id="experimental-empty" hidden>None</p>`;
const FEATURES = [
  { id: "mediaMining", label: "Media mining", section: "media", description: "Record clips." },
  { id: "sample", label: "Sample", description: "No section of its own." },
];

function fixture(t, features) {
  const dom = new JSDOM(MARKUP);
  t.after(() => dom.window.close());
  const toggles = [];
  const controller = createExperimentalSettings({
    document: dom.window.document, features, onToggle: (id, value) => toggles.push([id, value]),
  });
  return { window: dom.window, document: dom.window.document, controller, toggles };
}

test("each registered feature renders one labelled switch that reports changes", () => {
  const { window, document, controller, toggles } = fixture(test, FEATURES);
  controller.render({ mediaMining: true, sample: false });
  const rows = document.querySelectorAll("#experimental-features > li");
  assert.equal(rows.length, 2);
  assert.equal(document.getElementById("experimental-empty").hidden, true);

  const media = document.getElementById("opt-experimental-mediaMining");
  assert.equal(media.type, "checkbox");
  assert.equal(media.checked, true);
  assert.equal(media.closest("label").querySelector("span").textContent, "Media mining");
  const hint = document.getElementById(media.getAttribute("aria-describedby"));
  assert.match(hint.textContent, /Record clips\./);
  const link = hint.querySelector("a");
  assert.equal(link.getAttribute("href"), "#media");
  assert.equal(link.hidden, false, "an enabled feature links to its own section");

  const sample = document.getElementById("opt-experimental-sample");
  assert.equal(sample.checked, false);
  assert.equal(document.getElementById(sample.getAttribute("aria-describedby")).querySelector("a"), null);

  sample.checked = true;
  sample.dispatchEvent(new window.Event("change", { bubbles: true }));
  media.checked = false;
  media.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(toggles, [["sample", true], ["mediaMining", false]]);

  controller.render({ mediaMining: false, sample: true });
  assert.equal(media.checked, false);
  assert.equal(link.hidden, true, "a disabled feature hides the section link");
  assert.equal(sample.checked, true);
  assert.equal(document.querySelectorAll("#experimental-features > li").length, 2, "render reuses the rows");
});

test("an empty registry shows the empty state instead of a list", () => {
  const { document, controller } = fixture(test, []);
  controller.render({});
  assert.equal(document.querySelectorAll("#experimental-features > li").length, 0);
  assert.equal(document.getElementById("experimental-empty").hidden, false);
});
