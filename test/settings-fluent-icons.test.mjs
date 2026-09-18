// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createAudioSettingsController } from "../extension/audio-settings.js";
import { createCustomLinkSettings } from "../extension/custom-link-settings.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const source = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
function page(t, file) {
  const dom = new JSDOM(source(file), { runScripts: "outside-only", url: `https://extension.test/${file}` });
  t.after(() => dom.window.close());
  return dom.window;
}
function icon(node, name) {
  assert.ok(node, `missing ${name} control`);
  const span = node.querySelector(`span.hd-icon[data-icon="${name}"]`);
  assert.ok(span, `${node.className || node.id} must render ${name} with the shared icon`);
  assert.equal(span.getAttribute("aria-hidden"), "true");
  assert.equal(span.textContent, "");
}

test("dynamic Settings reorder icons preserve accessible names, disabled boundaries and click behavior", t => {
  const window = page(t, "settings.html");
  const { document } = window;
  window.eval(source("reader-options.js"));
  window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
  let sources = ["first", "second"].map(id => ({ id, type: "custom", enabled: true, url: "", voice: "" }));
  const audio = createAudioSettingsController({ document, readSources: () => sources,
    editSources: value => { sources = value; }, send: async () => ({ ok: false }) });
  audio.render();
  let links = ["First", "Second"].map(label => ({ label, url: "https://example.test/%w" }));
  createCustomLinkSettings({ document, readLinks: () => links, saveLinks: value => { links = value; } });
  for (const [listId, selector] of [["audio-source-list", direction => `.audio-${direction}`],
    ["custom-link-list", direction => `[data-action="${direction}"]`]]) {
    const list = document.getElementById(listId);
    for (const direction of ["up", "down"]) {
      const button = list.children[0].querySelector(selector(direction));
      icon(button, `arrow-${direction}`);
      assert.ok(button.getAttribute("aria-label").startsWith(`Move ${direction}:`));
    }
    assert.equal(list.children[0].querySelector(selector("up")).disabled, true);
    assert.equal(list.children[1].querySelector(selector("down")).disabled, true);
    list.children[1].querySelector(`${selector("up")} .hd-icon`).click();
  }
  assert.deepEqual(sources.map(item => item.id), ["second", "first"]);
  assert.deepEqual(links.map(item => item.label), ["Second", "First"]);
});

test("startup completed markers contain a Fluent child while pending steps retain their numbers", t => {
  const window = page(t, "startup.html");
  // Exercise the production view without starting storage/network setup.
  const view = source("startup.js").split("function ankiProgressView(")[1].split("\nfunction automaticAnkiView(")[0];
  const render = window.Function("document", "ANKI_PROGRESS_STEPS", "ankiProgressStep",
    `return function ankiProgressView(${view}`)(window.document, 3, () => 1);
  const list = render({ status: "configured", model: "Mining", deck: "Japanese" });
  const markers = list.querySelectorAll(".setup-anki-progress-marker");
  icon(markers[0], "checkmark");
  assert.equal(markers[0].classList.contains("hd-icon"), false, "the numbered marker itself must not be masked");
  assert.equal(markers[1].textContent, "2");
  assert.equal(markers[2].textContent, "3");
  assert.equal(list.children[1].getAttribute("aria-current"), "step");
  for (const marker of render({ status: "configured", model: "Mining", deck: "Japanese" }, true)
    .querySelectorAll(".setup-anki-progress-marker")) icon(marker, "checkmark");
});

test("visual-novel next background uses a decorative Fluent arrow and retains its action", t => {
  const window = page(t, "startup.html");
  window.eval(source("visual-novel.js"));
  const scene = window.document.createElement("div");
  window.HDVisualNovel.initialize(scene);
  const button = scene.querySelector(".vn-next");
  icon(button, "arrow-right");
  assert.equal(button.getAttribute("aria-label"), "Next background");
  assert.equal(button.dataset.focusKey, "next-background");
  assert.equal(button.type, "button");
  const before = scene.style.getPropertyValue("--vn-background");
  button.querySelector(".hd-icon").click();
  assert.notEqual(scene.style.getPropertyValue("--vn-background"), before);
});

test("Settings, startup and toolbar static icons share the local stylesheet without changing controls", t => {
  for (const file of ["settings.html", "startup.html", "toolbar.html"]) {
    const { document } = page(t, file);
    assert.equal(document.querySelectorAll('link[rel="stylesheet"][href="icons.css"]').length, 1, file);
    if (file === "settings.html") {
      for (const [template, prefix] of [["dict-row-template", "dict"], ["dict-group-template", "dict-group"],
        ["dict-group-member-template", "dict-group-member"]]) {
        const content = document.getElementById(template).content;
        for (const direction of ["up", "down"]) {
          const button = content.querySelector(`.${prefix}-${direction}`);
          icon(button, `arrow-${direction}`);
          assert.equal(button.type, "button");
          assert.ok(button.getAttribute("aria-label").includes(direction));
          assert.ok(button.title.includes(direction));
        }
      }
      const dictionary = document.getElementById("dict-row-template").content;
      icon(dictionary.querySelector(".dict-order"), "reorder");
      assert.equal(dictionary.querySelector(".dict-drag").draggable, true);
      icon(dictionary.querySelector(".dict-favorite"), "star");
      assert.equal(dictionary.querySelector(".dict-favorite").getAttribute("aria-label"), "Favourite");
      assert.equal(document.querySelector(".empty-state-icon").textContent, "辞", "meaningful dictionary text stays text");
    } else if (file === "startup.html") {
      icon(document.querySelector(".startup-star-link"), "star");
    } else {
      icon(document.getElementById("record-screen"), "desktop");
      icon(document.getElementById("open-settings"), "settings");
      assert.equal(document.querySelectorAll("svg").length, 0);
      assert.equal(document.getElementById("record-screen").disabled, true);
      assert.equal(document.getElementById("record-label").textContent, "Record context for Anki");
      assert.equal(document.querySelector("header img").getAttribute("src"), "icons/hachidori-32.png");
    }
  }
});
