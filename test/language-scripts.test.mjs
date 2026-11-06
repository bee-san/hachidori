// SPDX-License-Identifier: GPL-3.0-or-later
// The language layer (docs/languages.md 5): no frame of an installation
// without profiles loads it. The worker registers it beside the manifest's
// content scripts while the records have profiles, and content.js imports the
// same files into a frame that was open before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LANGUAGE_SCRIPTS, applyLanguageScripts } from "../extension/language-scripts.js";

const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(extension("manifest.json"));

test("the registered layer is the files content.js imports, in the frames the manifest's content scripts run in", () => {
  const [entry] = manifest.content_scripts;
  const imported = JSON.parse(/const LANGUAGE_LAYER = (\[[^\]]*\]);/u.exec(extension("content.js"))[1]);
  assert.deepEqual(LANGUAGE_SCRIPTS, [{ id: "hachidori-language-layer", matches: entry.matches, js: imported,
    runAt: entry.run_at, allFrames: entry.all_frames }]);
  for (const file of imported) {
    assert.equal(entry.js.includes(file), false, `${file} is not one of the manifest's content scripts`);
    assert.ok(manifest.web_accessible_resources.some(resource => resource.resources.includes(file)
      && resource.matches.includes("<all_urls>")), `${file} can be imported from any page`);
  }
});

test("the worker registers the layer while the records have profiles and removes it when they have none", async () => {
  const active = new Set();
  const browser = { scripting: {
    getRegisteredContentScripts: async ({ ids }) => ids.filter(id => active.has(id)).map(id => ({ id })),
    registerContentScripts: async scripts => { for (const script of scripts) active.add(script.id); },
    unregisterContentScripts: async ({ ids }) => { for (const id of ids) active.delete(id); },
  } };
  assert.deepEqual(await applyLanguageScripts(browser, true), { supported: true, registered: true });
  assert.deepEqual([...active], ["hachidori-language-layer"]);
  assert.deepEqual(await applyLanguageScripts(browser, false), { supported: true, registered: false });
  assert.equal(active.size, 0);
});
