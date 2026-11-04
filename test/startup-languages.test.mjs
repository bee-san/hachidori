// SPDX-License-Identifier: GPL-3.0-or-later
//
// The startup page with language packs (docs/languages.md 16.1): the welcome
// card is today's whatever packs the build has, and a language added in
// Settings → Advanced → Languages and used for lookups gets its own dictionary
// step when setup resumes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { EXTENSION, EXTENSION_MANIFEST, EXTENSION_ORIGIN, loadJsdom, loadStartupScript } from "./extension-smoke/fakes.mjs";
import { LANGUAGES, registryOf, settle } from "./language-settings-harness.mjs";

const WELCOME = { schemaVersion: 1, revision: 1, startedAt: "2026-11-04T00:00:00.000Z", stage: "welcome", completedAt: null,
  dictionaries: { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] }, anki: null };

async function openStartup(t, stored) {
  const { JSDOM } = await loadJsdom();
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "startup.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/startup.html`,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HDLanguages = registryOf(LANGUAGES);
  const records = structuredClone(stored);
  const requests = [];
  window.chrome = {
    runtime: {
      getManifest: () => structuredClone(EXTENSION_MANIFEST),
      async sendMessage(message) {
        requests.push(structuredClone(message));
        if (message.type === "hd_sharing_status") return { ok: true, sharing: { enabled: true, connected: false, client: { linked: false } } };
        if (message.type === "hd_sharing_client_probe") return { ok: false, error: "No shared Hachidori answered." };
        if (message.type === "hd_setup_cas") {
          records.setupState = { ...records.setupState, revision: message.baseRevision + 1, stage: message.stage };
          return { ok: true, state: structuredClone(records.setupState) };
        }
        throw new Error(`unexpected startup request ${message.type}`);
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: { async get(keys) {
        return structuredClone(Object.fromEntries([keys].flat().filter(key => records[key] !== undefined).map(key => [key, records[key]])));
      } },
      onChanged: { addListener() {} },
    },
    tabs: { async getCurrent() { return { id: 7 }; }, async remove() {} },
  };
  // Each pack's vendored language.json (docs/languages.md 9.1).
  window.fetch = async url => {
    const code = String(url).match(/vendor\/languages\/([a-z]{2,3})\/language\.json$/u)?.[1];
    const path = new URL(`./data/languages/${code}/language.json`, import.meta.url);
    return code && code !== "ja" ? { ok: true, json: async () => JSON.parse(readFileSync(path, "utf8")) } : { ok: false, status: 404 };
  };
  await loadStartupScript(window);
  const { document } = window;
  return {
    document, requests,
    heading: () => document.getElementById("setup-heading").textContent,
    actions: () => [...document.querySelectorAll("#setup-actions button")].map(button => [button.id, button.textContent]),
  };
}

test("the welcome card has no language menu whatever packs the build has", async t => {
  const page = await openStartup(t, { setupState: WELCOME, options: { revision: 1 } });
  assert.equal(page.heading(), "Welcome to Hachidori");
  assert.deepEqual(page.actions(), [["setup-start", "Start Setup"], ["setup-manual", "Set up manually"]]);
  assert.equal(page.document.querySelector("#setup-card select"), null);
  assert.doesNotMatch(page.document.getElementById("setup-card").textContent, /I'm learning/u);
  page.document.getElementById("setup-manual").click();
  await settle(50);
  assert.deepEqual(page.requests.map(message => message.type).filter(type => !type.startsWith("hd_sharing")), ["hd_setup_cas"]);
});

test("setup resumed with another language used for lookups shows that language's dictionary step", async t => {
  const page = await openStartup(t, {
    setupState: WELCOME,
    options: { revision: 2, profiles: [{ id: "ja", language: "ja", settings: {}, packSettings: {} },
      { id: "en", language: "en", settings: {}, packSettings: {} }] },
    dictionaryState: { schemaVersion: 2, revision: 1, dictionaries: [],
      profiles: { ja: { dictionaries: [], groups: [] }, en: { dictionaries: [], groups: [] } } },
    languageSelection: { revision: 1, activeProfileId: "en", autoSwitch: false },
  });
  assert.equal(page.document.querySelector("#setup-card select"), null);
  page.document.getElementById("setup-start").click();
  await settle(50);
  assert.equal(page.heading(), "Add English dictionaries");
  const link = page.document.querySelector("#setup-language-recommendations a");
  assert.deepEqual([link?.textContent, link?.href], ["Fixture", "https://example.org/en"]);
  assert.equal(page.requests.some(message => message.type === "hd_setup_install"), false, "nothing is downloaded");
});
