// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings in jsdom with a language registry (docs/languages.md 5 and 7), for
// the capability and per-profile Settings tests. The page's modules run as
// one script, as in the existing Settings harnesses; the fake worker answers
// options and dictionary-state requests with the profile layer's own writer
// and raises storage events as the real worker's writes do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SETTINGS_PAGE_MODULES } from "./settings-modules.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
export const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const withoutModules = source => source.replace(/^import(?:[^;]+);\s*/gmu, "").replace(/^export\s+/gmu, "");
export const LANGUAGES = JSON.parse(readFileSync(new URL("./data/profile-languages.json", import.meta.url), "utf8"));
delete LANGUAGES.$comment;
export const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
export const settle = (ms = 20) => new Promise(resolveWait => setTimeout(resolveWait, ms));

export const PACKAGE = (id, title, extra = {}) => ({ id, title, revision: "1", enabled: true, favorite: false,
  displayName: null, termCount: 1, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0,
  path: `/dicts/g/${id}`, ...extra });

// A registry as registry.js publishes it: get(code) and the pack codes.
export function registryOf(languages) {
  return { get: code => languages[code] ?? null, codes: Object.keys(languages) };
}

/**
 * Settings opened at `hash` over `stored` records. `languages` is the registry
 * the page finds (null: none, as in a page without registry.js). `onMessage`
 * may answer a runtime message before the fake worker does.
 */
export function openSettings(t, { hash = "#dictionaries", stored = {}, languages = LANGUAGES, onMessage = null } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: `https://settings.example/${hash}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.OVERLAY_MODE = false;
  window.isFirefox = () => false;
  window.HOST_CAPABILITIES = {
    browserShortcuts: true, linkButtons: true, externalLinkHost: false, customJavaScript: true,
    localFileAccessPrompt: false, lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: true, browserSpeech: true };
  if (languages !== null) window.HDLanguages = registryOf(languages);
  const records = structuredClone(stored);
  const messages = [];
  const storageListeners = new Set();
  function emit(changes) {
    for (const listener of storageListeners) listener(changes, "local");
  }
  function write(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: records[key], newValue: structuredClone(value) };
      records[key] = structuredClone(value);
    }
    emit(structuredClone(changes));
  }
  const reader = () => window.HDReaderOptions;
  function worker(message) {
    switch (message.type) {
      case "hd_options_write": {
        const current = records.options;
        const revision = Number.isInteger(current?.revision) ? current.revision : 0;
        if (message.baseRevision !== revision) {
          return { ok: false, conflict: true, error: "Settings changed in another page.", options: current ?? { revision } };
        }
        const patch = reader().validateOptionsPatch(message.options);
        let next = reader().applyOptionsPatch(current, patch, message.profileId ?? "ja");
        if (message.packSettings !== undefined) next = reader().applyPackSettingsPatch(next, message.packSettings, message.profileId);
        next = { ...next, revision: revision + 1 };
        write({ options: next });
        return { ok: true, options: next };
      }
      case "hd_state_read":
        return { ok: true, state: records.dictionaryState ?? { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] } };
      case "hd_status":
        return { ok: true, ready: true, loading: false, failedDictionaries: [] };
      case "hd_custom_read":
        return { ok: true, document: { schemaVersion: 1, revision: 0, semanticRevision: "", text: "" },
          state: records.dictionaryState };
      default:
        return { ok: true };
    }
  }
  window.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        const answered = await onMessage?.(message, { records, write });
        return answered ?? worker(message);
      },
      onMessage: { addListener() {} },
    },
    storage: {
      onChanged: { addListener(listener) { storageListeners.add(listener); } },
      local: {
        async get(keys) {
          const list = keys === null || keys === undefined ? Object.keys(records)
            : (Array.isArray(keys) ? keys : [keys]);
          return structuredClone(Object.fromEntries(list.filter(key => records[key] !== undefined)
            .map(key => [key, records[key]])));
        },
      },
    },
    permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    commands: { getAll: async () => [] },
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("dictionary-group-state.js"));
  window.eval(extension("external-links.js"));
  for (const [file, exports] of [
    ["recommended-install-client.js", ["createRecommendedInstallClient"]],
    ["debug-log.js", ["DEBUG_LOG", "captureDebugLog", "captureDocumentActions", "formatDebugErrorReport",
      "openDebugLogStore", "recordUserError"]],
    ["settings-dom.js", ["applyPageTheme", "setStatusOutput", "showErrorCopy", "reorderSettingsRows"]],
    ["settings-search.js", ["createSettingsSearch"]],
    ["experimental-settings.js", ["createExperimentalSettings"]],
    ["theme-store.js", ["createThemeStore", "applyDesignSettings"]],
    ["activation-settings.js", ["createActivationSettings"]],
    ["dictionary-progress.js", ["formatBytes"]],
    ["memory-settings.js", ["createMemorySettings"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
    ["error-text.js", ["describeErrorOrJson"]],
    ["custom-dictionary.js", ["CUSTOM_DICTIONARY_ID", "CUSTOM_DICTIONARY_TITLE", "CUSTOM_DICTIONARY_SOURCE_KEY",
      "normaliseCustomDictionaryDocument", "parseCustomDictionary"]],
    ["recommended-dictionaries.js", ["RECOMMENDED_DICTIONARIES"]],
    ["managed-dictionary-source.js", ["effectiveDictionarySchedule", "managedDictionarySource",
      "nextDictionaryUpdateCheck", "normaliseUpdateSettings", "recommendedDictionaryInstalled"]],
    ["keybind-settings.js", ["createKeybindSettingsController", "KEYBIND_OPTION_LABELS", "formatKeybind"]],
    ["custom-button-settings.js", ["createCustomButtonSettings", "validateLinkButton"]],
    ["setup-state.js", ["SETUP_STATE_KEY", "normaliseSetupState", "setupIncomplete"]],
    ["dictionary-import.js", ["dictionaryImportMatches", "dictionaryImportTarget", "describeRevisionComparison",
      "compareDictionaryRevisions", "mdxImportNotes"]],
    ["dictionary-import-errors.js", ["dictionaryImportError"]],
    ["dictionary-import-attempts.js", ["IMPORT_ATTEMPTS", "importWithRetries"]],
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  // The theme catalogue the Theme Store and Design's filter read.
  const catalogue = JSON.parse(extension("vendor/themes/index.json"));
  window.fetch = async () => ({ ok: true, json: async () => catalogue });
  const source = withoutModules(SETTINGS_PAGE_MODULES.map(extension).join("\n"));
  assert.ok(source.endsWith("await start();\n"));
  window.eval(source.replace(/await start\(\);\s*$/u, `
    globalThis.__settings = {
      start,
      options: () => options,
      pending: () => pendingOptions,
      activeSection: () => activeSection,
      editedProfile: () => editedProfile,
      // Edits a profile as the Language menu does, for the capability tests.
      edit(profile) { editedProfile = profile; renderOptions(); },
      dictionaries: () => dictionaries,
      render: () => renderOptions(),
    };
  `));
  const page = window.__settings;
  const el = id => window.document.getElementById(id);
  const visible = () => [...window.document.querySelectorAll("main > section")].filter(node => !node.hidden).map(node => node.id);
  function search(words) {
    el("settings-search").value = words;
    el("settings-search").dispatchEvent(new window.Event("input"));
    const found = [...el("settings-search-matches").querySelectorAll("strong")].map(node => node.textContent);
    el("settings-search").value = "";
    el("settings-search").dispatchEvent(new window.Event("input"));
    return found;
  }
  function navigate(section) {
    window.location.hash = `#${section}`;
    window.dispatchEvent(new window.Event("hashchange"));
  }
  return { window, document: window.document, el, page, records, messages, write, visible, search, navigate };
}
