// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/reader-options.js";
import { NETFLIX_SCRIPTS, applyNetflixFlag } from "../extension/netflix.js";

const extension = new URL("../extension/", import.meta.url);
const IDS = ["hachidori-netflix-page", "hachidori-netflix-content"];

function scriptingFake(active = new Set()) {
  const calls = [];
  return { calls, active, browser: { scripting: {
    async getRegisteredContentScripts({ ids }) { calls.push(["get", ids]); return ids.filter(id => active.has(id)).map(id => ({ id })); },
    async registerContentScripts(scripts) {
      calls.push(["register", scripts.map(script => script.id)]);
      for (const script of scripts) {
        assert.equal(active.has(script.id), false, `${script.id} registered twice`);
        active.add(script.id);
      }
    },
    async unregisterContentScripts({ ids }) { calls.push(["unregister", ids]); for (const id of ids) active.delete(id); },
  } } };
}

test("Netflix mining is an experimental flag that starts off", () => {
  const { DEFAULT_OPTIONS, EXPERIMENTAL_FEATURES, normaliseOptions } = globalThis.HDReaderOptions;
  const feature = EXPERIMENTAL_FEATURES.find(entry => entry.id === "netflixMining");
  assert.equal(feature?.label, "Netflix mining");
  assert.match(feature.description, /Subadub/u);
  assert.equal(feature.section, undefined, "the flag has no Settings section of its own");
  assert.equal(DEFAULT_OPTIONS.experimental.netflixMining, false);
  assert.equal(normaliseOptions({}).experimental.netflixMining, false);
});

test("the flag registers the main-world hook and the reader's scripts for Netflix's top frame only", async () => {
  assert.deepEqual(NETFLIX_SCRIPTS, [
    { id: "hachidori-netflix-page", matches: ["https://www.netflix.com/*"], js: ["netflix-page.js"],
      runAt: "document_start", allFrames: false, world: "MAIN" },
    { id: "hachidori-netflix-content", matches: ["https://www.netflix.com/*"],
      js: ["netflix-subtitles.js", "netflix-content.js"], runAt: "document_start", allFrames: false, world: "ISOLATED" },
  ]);
  const fake = scriptingFake();
  assert.deepEqual(await applyNetflixFlag(fake.browser, true), { supported: true, registered: true });
  assert.deepEqual(fake.calls, [["get", IDS], ["register", IDS]]);
  fake.calls.length = 0;
  assert.deepEqual(await applyNetflixFlag(fake.browser, true), { supported: true, registered: true });
  assert.deepEqual(fake.calls, [["get", IDS]], "nothing is registered twice");
  // A half-registered pair is completed rather than duplicated.
  fake.active.delete("hachidori-netflix-content");
  fake.calls.length = 0;
  await applyNetflixFlag(fake.browser, true);
  assert.deepEqual(fake.calls, [["get", IDS], ["register", ["hachidori-netflix-content"]]]);
});

test("turning the flag off unregisters both scripts, rapid toggles apply in order, and no scripting is harmless", async () => {
  const fake = scriptingFake(new Set(IDS));
  assert.deepEqual(await applyNetflixFlag(fake.browser, false), { supported: true, registered: false });
  assert.deepEqual(fake.calls, [["get", IDS], ["unregister", IDS]]);
  fake.calls.length = 0;
  await applyNetflixFlag(fake.browser, false);
  assert.deepEqual(fake.calls, [["get", IDS]], "nothing registered means nothing to unregister");
  const ordered = scriptingFake();
  await Promise.all([true, false, true].map(enabled => applyNetflixFlag(ordered.browser, enabled)));
  assert.deepEqual(ordered.calls.filter(([name]) => name !== "get"), [["register", IDS], ["unregister", IDS], ["register", IDS]]);
  assert.deepEqual([...ordered.active].sort(), [...IDS].sort());
  assert.deepEqual(await applyNetflixFlag({}, true), { supported: false, registered: false });
});

test("the manifest asks for tab capture, exposes only the recorder page to Netflix and never injects the scripts itself", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extension), "utf8"));
  assert.ok(manifest.permissions.includes("tabCapture"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(/netflix/iu.test(JSON.stringify(manifest.content_scripts)), false, "no Netflix content script is declared");
  const netflixResources = manifest.web_accessible_resources.filter(entry => /netflix/iu.test(JSON.stringify(entry)));
  assert.deepEqual(netflixResources, [{ resources: ["netflix-recorder.html"], matches: ["https://www.netflix.com/*"] }]);
  const page = await readFile(new URL("netflix-recorder.html", extension), "utf8");
  assert.match(page, /<script type="module" src="netflix-recorder\.js"><\/script>/u);
});

test("the offscreen document keeps its reasons: the recording happens in the tab", async () => {
  const created = [];
  globalThis.chrome = {
    runtime: { getContexts: async () => [], getURL: path => `chrome-extension://test/${path}` },
    offscreen: { async createDocument(parameters) { created.push(parameters); } },
  };
  try {
    const { ensureChromeOffscreen } = await import("../extension/chrome-offscreen.js");
    await ensureChromeOffscreen("offscreen.html");
  } finally {
    delete globalThis.chrome;
  }
  assert.deepEqual(created.map(({ reasons }) => reasons), [["DOM_SCRAPING", "AUDIO_PLAYBACK"]]);
});
