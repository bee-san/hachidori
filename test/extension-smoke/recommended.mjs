/*
 * The recommended catalogue, dictionary groups and the Settings installer.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import {
  RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE,
} from "../../extension/recommended-dictionaries.js";
import { createSetupInstaller } from "../../extension/setup-installer.js";
import {
  EXTENSION,
  EXTENSION_ORIGIN,
  genericPackage,
  loadClassicScript,
  loadJsdom,
  loadSettingsScript,
  RECOMMENDED_DICTIONARIES,
} from "./fakes.mjs";
import { check, fail, pass, section, test } from "./harness.mjs";

function checkRecommendedDictionaries() {
  const cataloguePath = resolve(EXTENSION, "recommended-dictionaries.js");
  if (!existsSync(cataloguePath)) {
    fail("the recommended catalogue exists", `${cataloguePath} is missing`);
    return;
  }
  pass("the recommended catalogue exists");
  const manifest = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
  check(
    "the extension requests the browser alarm permission for managed updates",
    manifest.permissions?.includes("alarms") === true,
    JSON.stringify(manifest.permissions),
  );
  const webResources = new Set(manifest.web_accessible_resources?.flatMap(({ resources }) => resources) ?? []);
  check(
    "the page-injected overlay module exposes its browser API dependency",
    ["overlay-mode.js", "browser-api.js"].every(resource => webResources.has(resource)),
    JSON.stringify([...webResources]),
  );
  check(
    "the popup exposes the shared Fluent stylesheet to content-script shadow roots",
    webResources.has("icons.css"),
    JSON.stringify([...webResources]),
  );
  const catalogueContract = (entry) => ({
    sourceId: entry.sourceId,
    name: entry.name,
    publisherUrl: entry.publisherUrl,
    downloadUrl: entry.downloadUrl,
    indexUrl: entry.indexUrl,
    githubRepositoryId: entry.githubRepositoryId,
    requiredCapability: entry.requiredCapability,
  });
  const actual = RECOMMENDED_CATALOGUE.map(catalogueContract);
  const expected = RECOMMENDED_DICTIONARIES.map(catalogueContract);
  check(
    "the catalogue names exactly five trusted recommendations and their publishers",
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );
  const html = readFileSync(resolve(EXTENSION, "settings.html"), "utf8");
  check(
    "settings has library and import entry points with a distinct partial retry action",
    (html.match(/id="install-recommended"/gu) ?? []).length === 1
      && (html.match(/id="retry-recommended"/gu) ?? []).length === 1
      && (html.match(/id="empty-install-recommended"/gu) ?? []).length === 1,
    "the starter/retry controls were missing or duplicated",
  );
  check(
    "settings keeps local import outside the hideable starter card",
    html.indexOf('id="import-file"') < html.indexOf('id="recommended-starter"'),
    "the local picker moved inside the starter card",
  );
}

function checkDictionaryGroupModule() {
  const groups = readFileSync(resolve(EXTENSION, "dictionary-groups.js"), "utf8");
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8");
  const background = readFileSync(resolve(EXTENSION, "background.js"), "utf8");
  const sharedFile = resolve(EXTENSION, "dictionary-group-state.js");
  const shared = existsSync(sharedFile) ? loadClassicScript(sharedFile, {}).HDDictionaryGroups : null;
  const dictionaries = [{ id: "first" }, { id: "disabled", enabled: false }, { id: "last" }];
  const input = [{
    id: "study", name: "  Ｓｔｕｄｙ\n\t Deck  ",
    dictionaryIds: ["disabled", "missing", "first", "disabled", "last", "first"],
    metadata: { retained: true },
  }, { id: "empty", name: "Empty" }];
  const before = JSON.stringify(input);
  const normalised = shared?.normaliseDictionaryGroups([...input, null, { id: "" }, { id: "blank", name: " " }], dictionaries);
  const pruned = shared?.pruneGroupMemberships(input, dictionaries);
  const members = ["disabled", "first", "last"];
  check(
    "settings imports its dictionary-group module",
    groups.includes("export function createDictionaryGroupController")
      && groups.includes('import "./dictionary-group-state.js"')
      && background.includes('import "./dictionary-group-state.js"')
      && settings.includes('from "./dictionary-groups.js"')
      && shared?.groupNameKey(input[0].name) === "study deck"
      && JSON.stringify(normalised) === JSON.stringify([
        { id: "study", name: "Study Deck", dictionaryIds: members },
        { id: "empty", name: "Empty", dictionaryIds: [] },
      ])
      && JSON.stringify(pruned) === JSON.stringify([
        { ...input[0], dictionaryIds: members }, { ...input[1], dictionaryIds: [] },
      ])
      && pruned[0].metadata === input[0].metadata
      && JSON.stringify(input) === before,
    JSON.stringify({ normalised, pruned }),
  );
}

async function settingsRecommendedImportStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html#add-dictionaries`,
  });
  const { window } = dom;
  let state = { schemaVersion: 1, revision: 0, dictionaries: [] };
  let storageListener = null;
  const fetches = [];
  const imports = [];
  const fetchAttempts = new Map();
  const importAttempts = new Map();
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  let activeImports = 0;
  let maxActiveImports = 0;
  let starterHiddenAfterFirst = false;

  window.URL.createObjectURL = (file) => `blob:recommended/${file.name}`;
  window.URL.revokeObjectURL = () => {};
  const downloadArchive = async (url) => {
    const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.downloadUrl === url);
    if (!entry) {
      throw new Error(`unexpected recommended URL ${url}`);
    }
    activeDownloads += 1;
    maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
    const attempt = (fetchAttempts.get(entry.sourceId) ?? 0) + 1;
    fetchAttempts.set(entry.sourceId, attempt);
    fetches.push({
      sourceId: entry.sourceId,
      state: window.document.getElementById("import-state")?.textContent ?? "",
    });
    await new Promise((done) => window.setTimeout(done, 0));
    activeDownloads -= 1;
    if (entry.sourceId === "jmnedict" && attempt === 1) {
      return { ok: false, status: 503, url };
    }
    return {
      ok: true,
      status: 200,
      url,
      async blob() {
        return new window.Blob([entry.sourceId], { type: "application/zip" });
      },
    };
  };
  window.fetch = async () => { throw new Error("Settings must leave recommended downloads to the offscreen installer"); };
  let progressListener;
  const installer = createSetupInstaller({
    ask: message => window.chrome.runtime.sendMessage(message),
    async dispatch(message) {
      if (message.type === "hd_status") return window.chrome.runtime.sendMessage(message);
      const response = await downloadArchive(message.archiveUrl);
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      installer.progress({ requestId: message.requestId, phase: "downloading", receivedBytes: 1024, totalBytes: 4096 });
      installer.progress({ requestId: message.requestId, phase: "installing" });
      return window.chrome.runtime.sendMessage(message);
    },
    notify: async () => ({ ok: true }),
    broadcast: message => progressListener?.(message),
  });
  window.chrome = {
    runtime: {
      id: "hachidorirecommendedsmoke",
      onMessage: { addListener(listener) { progressListener = listener; } },
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: state.dictionaries.length };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_import") {
          activeImports += 1;
          maxActiveImports = Math.max(maxActiveImports, activeImports);
          const entry = RECOMMENDED_DICTIONARIES.find(
            (candidate) => candidate.sourceId === message.sourceId,
          );
          const attempt = (importAttempts.get(message.sourceId) ?? 0) + 1;
          importAttempts.set(message.sourceId, attempt);
          imports.push({
            sourceId: message.sourceId,
            finalUrl: message.archiveUrl,
            fileName: message.fileName,
            state: window.document.getElementById("import-state")?.textContent ?? "",
          });
          await new Promise((done) => window.setTimeout(done, 0));
          activeImports -= 1;
          if (message.sourceId === "bees-ultimate-kanji-dictionary" && attempt === 1) {
            return { ok: false, error: "simulated import failure", report: { success: false } };
          }
          const counts = {
            termCount: entry.capabilities.includes("term") ? 1 : 0,
            frequencyCount: entry.capabilities.includes("freq") ? 1 : 0,
            pitchCount: entry.capabilities.includes("pitch") ? 1 : 0,
            kanjiCount: entry.capabilities.includes("kanji") ? 1 : 0,
            mediaCount: entry.capabilities.includes("media") ? 1 : 0,
          };
          const dictionary = genericPackage({
            id: `recommended-${entry.sourceId}`,
            title: entry.title,
            revision: entry.revision,
            sourceId: entry.sourceId,
            isUpdatable: true,
            indexUrl: entry.indexUrl,
            downloadUrl: entry.downloadUrl,
            ...counts,
          });
          state = {
            schemaVersion: 1,
            revision: state.revision + 1,
            dictionaries: [
              ...state.dictionaries.filter((candidate) => candidate.sourceId !== entry.sourceId),
              dictionary,
            ],
          };
          storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
          if (state.dictionaries.length === 1) {
            starterHiddenAfterFirst = window.document.getElementById("recommended-starter")?.hidden === true;
          }
          return { ok: true, report: { success: true, title: entry.title, ...counts } };
        }
        throw new Error(`unexpected recommended settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
      },
    },
  };
  loadSettingsScript(window, { recommendedInstall: async message => ({ ok: true, ...installer.attach(message.sourceIds) }) });
  const initialActionsHidden = window.document.getElementById("dict-empty").hidden
    && window.document.getElementById("recommended-starter").hidden;

  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const links = [...window.document.querySelectorAll("a.recommended-dictionary-link")].map((anchor) => ({
    name: anchor.textContent,
    href: anchor.href,
    target: anchor.target,
    rel: anchor.rel,
  }));
  const clean = {
    starterHidden: window.document.getElementById("recommended-starter")?.hidden,
    installHidden: window.document.getElementById("install-recommended")?.hidden,
    retryHidden: window.document.getElementById("recommended-retry")?.hidden,
    localImportVisible: window.document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    links,
  };

  window.document.getElementById("install-recommended")?.click();
  // Derived from the catalogue, not hardcoded: a stale count never matches, so the
  // loop would spin to the deadline and every measurement after this point would
  // be taken mid-flight instead of at the finished state.
  const allCount = RECOMMENDED_DICTIONARIES.length;
  while (!(window.document.getElementById("import-state")?.textContent ?? "").startsWith(
    `Finished ${allCount} of ${allCount} recommended dictionaries`,
  ) && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const firstOutcomes = [...window.document.querySelectorAll("#import-progress .setup-dictionary")].map((item) => ({
    text: item.querySelector(".setup-dictionary-status")?.textContent ?? "",
    error: item.querySelector(".setup-dictionary-status")?.classList.contains("is-error") === true,
  }));
  const partial = {
    state: window.document.getElementById("import-state")?.textContent ?? "",
    starterHidden: window.document.getElementById("recommended-starter")?.hidden,
    retryHidden: window.document.getElementById("recommended-retry")?.hidden,
    sourceIds: state.dictionaries.map((dictionary) => dictionary.sourceId),
  };

  const retryStart = fetches.length;
  window.document.getElementById("retry-recommended")?.click();
  while (!(window.document.getElementById("import-state")?.textContent ?? "").startsWith(
    "Finished 2 of 2 recommended dictionaries",
  ) && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const result = {
    initialActionsHidden,
    clean,
    fetches,
    imports,
    firstOutcomes,
    partial,
    retrySourceIds: fetches.slice(retryStart).map(({ sourceId }) => sourceId),
    completeSourceIds: state.dictionaries.map((dictionary) => dictionary.sourceId),
    retryHiddenWhenComplete: window.document.getElementById("recommended-retry")?.hidden,
    starterHiddenAfterFirst,
    maxActiveDownloads,
    maxActiveImports,
  };
  const [legacyDictionary, ...otherDictionaries] = state.dictionaries;
  const legacyIndexOnlyDictionary = { ...legacyDictionary };
  delete legacyIndexOnlyDictionary.sourceId;
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: [legacyIndexOnlyDictionary, ...otherDictionaries],
  };
  storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));
  const fetchCountBeforeLegacyRetry = fetches.length;
  window.document.getElementById("retry-recommended")?.click();
  await new Promise((done) => window.setTimeout(done, 10));
  result.legacyIndexOnlySkipped =
    window.document.getElementById("recommended-retry")?.hidden === true
    && fetches.length === fetchCountBeforeLegacyRetry;
  dom.window.close();
  return result;
}

describe("recommended dictionaries", () => {
  test("the catalogue names five trusted recommendations and Settings has their entry points", async () => {
    section("recommended dictionaries");
    checkRecommendedDictionaries();
  });

  test("the dictionary group module is shared by Settings and the worker", async () => {
    checkDictionaryGroupModule();
  });

  test("the Settings recommended installer", async () => {
    const recommendedSettings = await settingsRecommendedImportStage();
    check(
      "settings install the trusted catalogue sequentially and retry only missing entries",
      recommendedSettings?.initialActionsHidden === true
        && recommendedSettings.clean.starterHidden === false
        && recommendedSettings.clean.installHidden === false
        && recommendedSettings.clean.retryHidden === true
        && recommendedSettings.clean.localImportVisible === true
        && JSON.stringify(recommendedSettings.clean.links.map(({ name, href }) => [name, href]))
          === JSON.stringify(RECOMMENDED_DICTIONARIES.map((entry) => [entry.name, entry.publisherUrl]))
        && recommendedSettings.clean.links.every(({ target, rel }) =>
          target === "_blank" && rel.split(/\s+/u).includes("noopener") && rel.split(/\s+/u).includes("noreferrer"))
        && JSON.stringify(recommendedSettings.fetches.slice(0, RECOMMENDED_DICTIONARIES.length)
          .map(({ sourceId }) => sourceId))
          === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId))
        && recommendedSettings.imports.every(({ sourceId, finalUrl }) => {
          const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === sourceId);
          return finalUrl === entry.downloadUrl;
        })
        && recommendedSettings.maxActiveDownloads === 1
        && recommendedSettings.maxActiveImports === 1
        && recommendedSettings.firstOutcomes.length === RECOMMENDED_DICTIONARIES.length
        // The scenario injects exactly two failures: jmnedict fails to download and
        // the kanji dictionary fails to import. The rest succeed.
        && JSON.stringify(recommendedSettings.firstOutcomes.map(({ error }) => error))
          === JSON.stringify([false, true, true, false, false])
        && recommendedSettings.partial.state
          === `Finished ${RECOMMENDED_DICTIONARIES.length} of ${RECOMMENDED_DICTIONARIES.length}`
            + " recommended dictionaries — 3 imported, 2 failed."
        && recommendedSettings.starterHiddenAfterFirst === false
        && recommendedSettings.partial.starterHidden === false
        && recommendedSettings.partial.retryHidden === false
        && JSON.stringify(recommendedSettings.partial.sourceIds)
          === JSON.stringify(["jitendex", "jiten", "bees-ultimate-grammar-dictionary"])
        && JSON.stringify(recommendedSettings.retrySourceIds)
          === JSON.stringify(["jmnedict", "bees-ultimate-kanji-dictionary"])
        && recommendedSettings.completeSourceIds.length === RECOMMENDED_DICTIONARIES.length
        && RECOMMENDED_DICTIONARIES.every(({ sourceId }) =>
          recommendedSettings.completeSourceIds.includes(sourceId))
        && recommendedSettings.retryHiddenWhenComplete === true
        && recommendedSettings.legacyIndexOnlySkipped === true,
      JSON.stringify(recommendedSettings),
    );
  });
});
