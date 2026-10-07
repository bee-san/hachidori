/*
 * Settings library management, batch and MDX imports.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
} from "../../extension/custom-dictionary.js";
import {
  EXTENSION,
  EXTENSION_ORIGIN,
  genericPackage,
  loadJsdom,
  loadSettingsScript,
  navigateSettingsSection,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function settingsBatchImportStage() {
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
  const state = { schemaVersion: 1, revision: 0, dictionaries: [] };
  const importReplies = [
    { ok: true, report: { success: true, title: "First", termCount: 1 } },
    { ok: false, error: "broken archive", report: { success: false, error: "broken archive" } },
    { ok: true, report: { success: true, title: "First", termCount: 2 } },
  ];
  const importRequests = [];
  const createdUrls = [];
  const revokedUrls = [];
  let activeImports = 0;
  let maxActiveImports = 0;
  let stateReads = 0;
  let statusReads = 0;

  window.URL.createObjectURL = (file) => {
    const url = `blob:settings-batch/${createdUrls.length}-${file.name}`;
    createdUrls.push(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => revokedUrls.push(url);
  window.__readDictionaryArchiveIdentity = async (file) => ({
    title: file.name.replace(/\.zip$/u, ""),
    revision: "1",
    indexUrl: null,
    downloadUrl: null,
  });
  window.chrome = {
    runtime: {
      id: "hachidorisettingsbatchsmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          stateReads += 1;
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          statusReads += 1;
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_import") {
          activeImports += 1;
          maxActiveImports = Math.max(maxActiveImports, activeImports);
          const index = importRequests.length;
          importRequests.push({
            fileName: message.fileName,
            state: window.document.getElementById("import-state")?.textContent ?? "",
            completed: window.document.querySelectorAll(
              "#import-progress .setup-dictionary-status.is-ok, #import-progress .setup-dictionary-status.is-error",
            ).length,
          });
          await new Promise((done) => window.setTimeout(done, 0));
          activeImports -= 1;
          return importReplies[index];
        }
        throw new Error(`unexpected settings batch request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
      },
      onChanged: { addListener() {} },
    },
  };
  loadSettingsScript(window);

  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  stateReads = 0;
  statusReads = 0;

  const input = window.document.getElementById("import-file");
  const files = [
    new window.File(["first"], "first.zip", { type: "application/zip" }),
    new window.File(["broken"], "broken.zip", { type: "application/zip" }),
    new window.File(["replacement"], "replacement.zip", { type: "application/zip" }),
  ];
  const zone = window.document.getElementById("import-drop-zone");
  const transfer = { files, types: ["Files"], dropEffect: "none" };
  const dispatch = (type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    zone.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dragEnterPrevented = dispatch("dragenter");
  const dragOverPrevented = dispatch("dragover");
  const highlighted = zone.classList.contains("is-dragging") && transfer.dropEffect === "copy";
  const dropPrevented = dispatch("drop");
  const cleared = !zone.classList.contains("is-dragging");

  const batchDeadline = Date.now() + 2000;
  while ((importRequests.length < files.length || input.disabled) && Date.now() < batchDeadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const outcomes = [...window.document.querySelectorAll("#import-progress .setup-dictionary")].map((item) => ({
    name: item.querySelector(".setup-dictionary-name")?.textContent ?? "",
    text: item.querySelector(".setup-dictionary-status")?.textContent ?? "",
    error: item.querySelector(".setup-dictionary-status")?.classList.contains("is-error") === true,
    trackHidden: item.querySelector(".setup-track")?.hidden === true,
  }));
  const result = {
    multiple: input.multiple,
    pickerValue: input.value,
    drop: { dragEnterPrevented, dragOverPrevented, highlighted, dropPrevented, cleared },
    sharedRows: window.document.querySelector("#import-progress .setup-dictionary-list")
      ?.getAttribute("aria-label") === "Dictionary import progress",
    importRequests,
    maxActiveImports,
    createdUrls,
    revokedUrls,
    outcomes,
    finalState: window.document.getElementById("import-state")?.textContent ?? "",
    controlsRestored: input.disabled === false,
    stateReads,
    statusReads,
  };
  dom.window.close();
  return result;
}

// A dropped batch groups each .mdx with the
// .mdd files named after its stem into one hd_import carrying `resources`,
// still imports ZIPs on their own, and reports an .mdd without its .mdx.
async function settingsMdxImportStage() {
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
  const state = { schemaVersion: 1, revision: 0, dictionaries: [] };
  const importRequests = [];
  const identityReads = [];
  const createdUrls = [];
  const revokedUrls = [];
  window.URL.createObjectURL = (file) => {
    const url = `blob:settings-mdx/${createdUrls.length}-${file.name}`;
    createdUrls.push(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => revokedUrls.push(url);
  window.__readDictionaryArchiveIdentity = async (file) => {
    identityReads.push(file.name);
    return { title: file.name.replace(/\.zip$/u, ""), revision: "1", indexUrl: null, downloadUrl: null };
  };
  window.chrome = {
    runtime: {
      id: "hachidorisettingsmdxsmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
        if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        if (message.type === "hd_options_write") return { ok: true, options: structuredClone(message.options) };
        if (message.type === "hd_import") {
          importRequests.push({ fileName: message.fileName, blobUrl: message.blobUrl,
            resources: message.resources, importDecision: message.importDecision === undefined ? "absent" : "present" });
          await new Promise((done) => window.setTimeout(done, 0));
          // Dict.mdx left an alias and two resources out; plain.zip is a
          // Yomitan archive and reports zeros.
          const losses = message.fileName === "Dict.mdx"
            ? { unresolvedRedirectCount: 1, missingResourceCount: 2 }
            : { unresolvedRedirectCount: 0, missingResourceCount: 0 };
          return { ok: true, report: { success: true, title: message.fileName.replace(/\.\w+$/u, ""), termCount: 1,
            skippedRecordCount: 0, unreadableResourceCount: 0, ...losses } };
        }
        throw new Error(`unexpected settings mdx request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
      },
      onChanged: { addListener() {} },
    },
  };
  loadSettingsScript(window);
  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }

  const input = window.document.getElementById("import-file");
  const accept = input.accept;
  const files = [
    new window.File(["mdx"], "Dict.mdx"),
    new window.File(["mdd"], "dict.MDD"),
    new window.File(["zip"], "plain.zip", { type: "application/zip" }),
    new window.File(["mdd1"], "Dict.1.mdd"),
    new window.File(["orphan"], "Other.mdd"),
  ];
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  const batchDeadline = Date.now() + 2000;
  while ((importRequests.length < 2 || input.disabled) && Date.now() < batchDeadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const outcomes = [...window.document.querySelectorAll("#import-progress .setup-dictionary")].map((item) => ({
    name: item.querySelector(".setup-dictionary-name")?.textContent ?? "",
    text: item.querySelector(".setup-dictionary-status")?.textContent ?? "",
    error: item.querySelector(".setup-dictionary-status")?.classList.contains("is-error") === true,
    okTone: item.querySelector(".setup-dictionary-status")?.classList.contains("is-ok") === true,
    notesHidden: item.querySelector(".setup-dictionary-notes")?.hidden ?? null,
    notes: [...item.querySelectorAll(".setup-dictionary-notes li")].map((note) => note.textContent),
  }));
  const result = {
    accept,
    label: window.document.getElementById("import-file-label")?.textContent ?? "",
    importRequests,
    identityReads,
    createdUrls,
    revokedUrls,
    outcomes,
    finalState: window.document.getElementById("import-state")?.textContent ?? "",
  };
  dom.window.close();
  return result;
}

async function settingsConflictStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let state = {
    schemaVersion: 1,
    revision: 7,
    dictionaries: [genericPackage({ frequencyMode: "rank-based" })],
    groups: [],
  };
  let storageListener = null;
  const casRequests = [];
  let rejectNextApply = true;
  let rejectReorderWithMetadataChange = false;
  let holdNextApply = false;
  let releaseHeldApply = null;
  let directDictionaryWrites = 0;
  let removeStarted = false;
  let releaseRemove = null;
  let removeHandler = null;
  const customRequests = [];
  let customDocument = { schemaVersion: 1, revision: 0, semanticRevision: "", text: "" };
  let customSaveHandler = null;
  const statsResets = [];
  let statsResetReply = { ok: true };
  const acceptState = (nextDictionaries, nextGroups = state.groups) => {
    state = {
      schemaVersion: 1,
      revision: state.revision + 1,
      dictionaries: structuredClone(nextDictionaries),
      groups: structuredClone(nextGroups),
    };
    storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
    return { ok: true, state: structuredClone(state) };
  };
  window.chrome = {
    runtime: {
      id: "hachidorisettingssmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_state_cas") {
          casRequests.push({
            type: message.type,
            baseRevision: message.baseRevision,
            dictionaries: structuredClone(message.dictionaries),
            groups: message.groups === undefined ? undefined : structuredClone(message.groups),
          });
          return acceptState(message.dictionaries, message.groups);
        }
        if (message.type === "hd_apply_state") {
          casRequests.push({
            type: message.type,
            baseRevision: message.baseRevision,
            dictionaries: structuredClone(message.dictionaries),
            groups: message.groups === undefined ? undefined : structuredClone(message.groups),
          });
          if (rejectReorderWithMetadataChange) {
            rejectReorderWithMetadataChange = false;
            state = {
              ...state,
              revision: state.revision + 1,
              dictionaries: state.dictionaries.map((dictionary) => dictionary.id === ids.gamma
                ? { ...dictionary, displayName: "Alpha concurrent" }
                : dictionary),
            };
            storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
            return {
              ok: false,
              conflict: true,
              error: "simulated metadata change during reorder",
              state: structuredClone(state),
            };
          }
          if (!rejectNextApply) {
            if (!holdNextApply) {
              return acceptState(message.dictionaries);
            }
            holdNextApply = false;
            return new Promise((resolveApply) => {
              releaseHeldApply = () => {
                releaseHeldApply = null;
                resolveApply(acceptState(message.dictionaries));
              };
            });
          }
          rejectNextApply = false;
          state = {
            schemaVersion: 1,
            revision: state.revision + 1,
            dictionaries: [{
              ...state.dictionaries[0],
              displayName: "Concurrent final",
              enabled: true,
              favorite: true,
            }],
            groups: structuredClone(state.groups),
          };
          storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
          return {
            ok: false,
            conflict: true,
            error: "simulated change from another settings page",
            state: structuredClone(state),
          };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_remove") {
          if (removeHandler) return removeHandler(message);
          removeStarted = true;
          return new Promise((resolveRemove) => {
            releaseRemove = () => resolveRemove({ ok: false, error: "simulated held removal" });
          });
        }
        if (message.type === "hd_custom_read") {
          customRequests.push({ type: message.type, target: message.target });
          return { ok: true, document: structuredClone(customDocument), state: structuredClone(state) };
        }
        if (message.type === "hd_custom_save") {
          customRequests.push({ type: message.type, baseDocumentRevision: message.baseDocumentRevision, text: message.text });
          return customSaveHandler(message);
        }
        if (message.type === "hd_lookup_stats_reset") {
          statsResets.push(message.target);
          return structuredClone(statsResetReply);
        }
        throw new Error(`unexpected settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
        async set(values) {
          if (values.dictionaryState !== undefined || values.dictionaries !== undefined) {
            directDictionaryWrites += 1;
          }
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
      },
    },
  };
  loadSettingsScript(window);

  const deadline = Date.now() + 2000;
  let displayName = null;
  while (Date.now() < deadline) {
    displayName = window.document.querySelector("#dict-list .dict-display-name");
    if (displayName) break;
    await new Promise((done) => window.setTimeout(done, 5));
  }
  if (!displayName) {
    dom.window.close();
    return { error: "the settings dictionary row did not render" };
  }

  displayName.closest("details").querySelector("summary").click();
  displayName.focus();
  displayName.value = "My draft";
  state = {
    ...state,
    revision: 8,
    dictionaries: [{
      ...state.dictionaries[0],
      displayName: "Other writer",
      favorite: true,
    }],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  const draftSurvived = displayName.isConnected
    && window.document.activeElement === displayName
    && displayName.value === "My draft";

  displayName.dispatchEvent(new window.Event("change", { bubbles: true }));
  const checkbox = window.document.querySelector("#dict-list .dict-enabled");
  const secondActionTargetSurvived = checkbox?.isConnected === true && checkbox.disabled === false;
  checkbox?.focus();
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  const selectedValue = JSON.stringify({ title: "Generic", kind: "term" });
  while (casRequests.length < 1 && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  await new Promise((done) => window.setTimeout(done, 0));
  const conflictStatus = window.document.getElementById("engine-status")?.textContent ?? "";
  const checkboxFocused = window.document.activeElement?.classList.contains("dict-enabled") === true;

  window.confirm = () => true;
  window.document.querySelector("#dict-list .dict-remove")?.click();
  while (!removeStarted && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const removalControlsBlocked = [...window.document.querySelectorAll("#dict-list input, #dict-list button")]
    .every((control) => control.disabled)
    && [...window.document.querySelectorAll("#dict-list .dict-drag")]
      .every((drag) => drag.draggable === false);
  releaseRemove?.();
  await new Promise((done) => window.setTimeout(done, 0));
  const removalControlsRestored = [...window.document.querySelectorAll("#dict-list input, #dict-list button")]
    .some((control) => !control.disabled)
    && [...window.document.querySelectorAll("#dict-list .dict-drag")]
      .every((drag) => drag.draggable === true);

  const result = {
    draftSurvived,
    aliasConflict: window.document.querySelector(".name-draft-feedback")?.textContent ?? "",
    retainedAlias: window.document.querySelector(".dict-display-name")?.value,
    secondActionTargetSurvived,
    casRequests: structuredClone(casRequests),
    directDictionaryWrites,
    enabled: window.document.querySelector("#dict-list .dict-enabled")?.checked,
    kanjiChoice: [...window.document.querySelectorAll("#opt-kanji-dictionary option")]
      .some((option) => option.value === selectedValue),
    title: window.document.querySelector("#dict-list .dict-title")?.textContent,
    canonical: window.document.querySelector("#dict-list .dict-canonical")?.textContent,
    favorite: window.document.querySelector("#dict-list .dict-favorite")?.hidden === false,
    checkboxFocused,
    conflictStatus,
    removalControlsBlocked,
    removalControlsRestored,
  };

  casRequests.length = 0;
  const ids = {
    alpha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    beta: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    gamma: "cccccccccccccccccccccccccccccccc",
    hiddenOne: "11111111111111111111111111111111",
    hiddenTwo: "22222222222222222222222222222222",
  };
  const managementDictionaries = Array.from({ length: 12 }, (_, index) => genericPackage({
    id: String(index + 1).padStart(32, "0"),
    title: `Library ${index + 1}`,
    path: `/dicts/Library ${index + 1}`,
  }));
  Object.assign(managementDictionaries[0], {
    id: ids.alpha,
    title: "ＡＬＰＨＡ",
    path: "/dicts/ＡＬＰＨＡ",
  });
  Object.assign(managementDictionaries[1], {
    id: ids.hiddenOne,
    title: "Hidden one",
    path: "/dicts/Hidden one",
  });
  Object.assign(managementDictionaries[2], {
    id: ids.beta,
    title: "Beta",
    displayName: "Alpha alias",
    path: "/dicts/Beta",
  });
  Object.assign(managementDictionaries[3], {
    id: ids.hiddenTwo,
    title: "Hidden two",
    path: "/dicts/Hidden two",
  });
  Object.assign(managementDictionaries[11], {
    id: ids.gamma,
    title: "Gamma",
    displayName: "Ａｌｐｈａ notes",
    path: "/dicts/Gamma",
  });
  state = {
    schemaVersion: 1,
    revision: state.revision + 1,
    dictionaries: managementDictionaries,
    groups: [],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));

  const search = window.document.getElementById("dict-search");
  const selectAll = window.document.getElementById("dict-select-visible");
  const bulkButtonIds = [
    "dict-bulk-disable",
    "dict-bulk-enable",
    "dict-bulk-favorite",
    "dict-bulk-unfavorite",
  ];
  if (!(search instanceof window.HTMLInputElement)
      || !(selectAll instanceof window.HTMLInputElement)
      || bulkButtonIds.some((id) => !(window.document.getElementById(id) instanceof window.HTMLButtonElement))) {
    result.management = { error: "dictionary management controls did not render" };
    dom.window.close();
    return result;
  }

  const rowIds = () => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .map((row) => row.dataset.dictionaryId);
  const selectedRowIds = () => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .filter((row) => row.querySelector(".dict-selected")?.checked)
    .map((row) => row.dataset.dictionaryId);
  const rowFor = (id) => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .find((row) => row.dataset.dictionaryId === id);
  const waitForRequestCount = async (count) => {
    const requestDeadline = Date.now() + 2000;
    while (casRequests.length < count && Date.now() < requestDeadline) {
      await new Promise((done) => window.setTimeout(done, 5));
    }
    await new Promise((done) => window.setTimeout(done, 0));
  };

  const localeLowerCase = window.String.prototype.toLocaleLowerCase;
  window.String.prototype.toLocaleLowerCase = function toTurkishLowerCase() {
    return localeLowerCase.call(this, "tr");
  };
  search.value = "HIDDEN O";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const localeIndependentVisibleIds = rowIds();
  window.String.prototype.toLocaleLowerCase = localeLowerCase;

  search.value = " ＡｌＰｈＡ ";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const visibleIds = rowIds();
  selectAll.click();
  const selectedVisibleIds = selectedRowIds();

  for (const [index, buttonId] of bulkButtonIds.entries()) {
    window.document.getElementById(buttonId).click();
    await waitForRequestCount(index + 1);
  }
  const bulkRequests = structuredClone(casRequests);
  const selectedIds = [ids.alpha, ids.beta, ids.gamma];
  const bulkValues = bulkRequests.flatMap((request, index) => selectedIds.map((id) => {
    const dictionary = request.dictionaries.find((entry) => entry.id === id);
    return index < 2 ? dictionary.enabled : dictionary.favorite;
  }));
  const bulkHiddenUntouched = bulkRequests.every((request) =>
    [ids.hiddenOne, ids.hiddenTwo].every((id) => {
      const dictionary = request.dictionaries.find((entry) => entry.id === id);
      return dictionary.enabled === true && dictionary.favorite === false;
    }));

  holdNextApply = true;
  const queuedUp = rowFor(ids.gamma).querySelector(".dict-up");
  queuedUp.click();
  await waitForRequestCount(5);
  queuedUp.click();
  releaseHeldApply?.();
  await waitForRequestCount(6);
  const queuedOrderTitles = casRequests.slice(4).map((request) =>
    request.dictionaries.map((dictionary) => dictionary.displayName || dictionary.title));

  state = {
    schemaVersion: 1,
    revision: state.revision + 1,
    dictionaries: structuredClone(managementDictionaries),
    groups: [],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  casRequests.splice(4);

  // A settled local reorder reuses the moved row's DOM node instead of
  // rebuilding it from the template, and refreshes its rank to the new
  // position. Capturing the node before and finding it after proves reuse.
  rejectReorderWithMetadataChange = true;
  const gammaRowBeforeConflict = rowFor(ids.gamma);
  const conflictPosition = gammaRowBeforeConflict.querySelector(".dict-position-input");
  conflictPosition.value = "1";
  conflictPosition.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await waitForRequestCount(5);
  const reorderConflictRebuiltMetadata = gammaRowBeforeConflict !== rowFor(ids.gamma)
    && rowFor(ids.gamma).querySelector(".dict-display-name").value === "Alpha concurrent";

  const gammaRowBeforeReorder = rowFor(ids.gamma);
  const gammaMetadataBeforeReorder = structuredClone(state.dictionaries.find((entry) => entry.id === ids.gamma));
  const position = rowFor(ids.gamma).querySelector(".dict-position-input");
  position.value = "1";
  position.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await waitForRequestCount(6);
  const directPositionMovedTwelfthToFirst = state.dictionaries[0]?.id === ids.gamma
    && state.dictionaries.slice(1).every((entry, index) => entry.id === managementDictionaries[index].id);
  const directPositionPreservedMetadata = Object.keys(gammaMetadataBeforeReorder)
    .every((key) => JSON.stringify(state.dictionaries[0][key]) === JSON.stringify(gammaMetadataBeforeReorder[key]));
  const reorderReusedRowNode = gammaRowBeforeReorder === rowFor(ids.gamma);
  const reorderRankFollowsPosition = rowFor(ids.gamma).querySelector(".dict-rank").textContent === "1";

  rowFor(ids.gamma).querySelector(".dict-details-toggle").click();
  const secondPosition = rowFor(ids.gamma).querySelector(".dict-position-input");
  secondPosition.value = "12";
  secondPosition.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await waitForRequestCount(7);

  const dragStart = new window.Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(dragStart, "dataTransfer", {
    value: { effectAllowed: "", setData() {} },
  });
  rowFor(ids.alpha).querySelector(".dict-drag").dispatchEvent(dragStart);
  rowFor(ids.beta).dispatchEvent(new window.Event("dragover", { bubbles: true, cancelable: true }));
  rowFor(ids.beta).dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true }));
  await waitForRequestCount(8);

  rowFor(ids.gamma).querySelector(".dict-down").click();
  await waitForRequestCount(9);
  const orderRequests = casRequests.slice(5);
  const orderTitles = orderRequests.map((request) =>
    request.dictionaries.map((dictionary) => dictionary.displayName || dictionary.title));
  const hiddenOrderPreserved = orderRequests.every((request) =>
    request.dictionaries.findIndex((dictionary) => dictionary.id === ids.hiddenOne)
      < request.dictionaries.findIndex((dictionary) => dictionary.id === ids.hiddenTwo));
  const searchAfterOperations = search.value;
  const selectedAfterOperations = selectedRowIds().sort();

  const removedBeta = state.dictionaries.find((dictionary) => dictionary.id === ids.beta);
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: state.dictionaries.filter((dictionary) => dictionary.id !== ids.beta),
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: [...state.dictionaries.slice(0, 2), removedBeta, ...state.dictionaries.slice(2)],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");

  result.management = {
    localeIndependentVisibleIds,
    visibleIds,
    selectedVisibleIds,
    bulkRequests,
    bulkValues,
    bulkHiddenUntouched,
    queuedOrderTitles,
    orderRequests,
    orderTitles,
    hiddenOrderPreserved,
    reorderConflictRebuiltMetadata,
    directPositionMovedTwelfthToFirst,
    directPositionPreservedMetadata,
    reorderReusedRowNode,
    reorderRankFollowsPosition,
    searchAfterOperations,
    selectedAfterOperations,
    selectedAfterExternalChange: selectedRowIds(),
    visibleAfterExternalChange: rowIds(),
  };

  casRequests.length = 0;
  await navigateSettingsSection(window, "dictionary-groups");
  const newGroupName = window.document.getElementById("dict-group-name-new");
  const createGroup = window.document.getElementById("dict-group-create");
  const groupError = window.document.getElementById("dict-group-error");
  if (!(newGroupName instanceof window.HTMLInputElement)
      || !(createGroup instanceof window.HTMLButtonElement)
      || !(groupError instanceof window.HTMLElement)) {
    result.groups = { error: "dictionary group controls did not render" };
    result.directDictionaryWrites = directDictionaryWrites;
    dom.window.close();
    return result;
  }

  const groupRow = (id) => [...window.document.querySelectorAll("#dict-group-list .dict-group")]
    .find((row) => row.dataset.groupId === id);
  const groupMemberRow = (groupId, dictionaryId) => [...groupRow(groupId)
    ?.querySelectorAll(".dict-group-member") ?? []]
    .find((row) => row.dataset.dictionaryId === dictionaryId);
  const addGroupMember = async (groupId, dictionaryId, requestCount) => {
    const row = groupRow(groupId);
    const select = row?.querySelector(".dict-group-add-select");
    select.value = dictionaryId;
    row.querySelector(".dict-group-add").click();
    await waitForRequestCount(requestCount);
  };

  window.String.prototype.toLocaleLowerCase = function toTurkishLowerCase() {
    return localeLowerCase.call(this, "tr");
  };
  newGroupName.value = "  ＩＮＤＩＧＯ\t  Deck ";
  createGroup.click();
  await waitForRequestCount(1);
  const studyGroupId = state.groups[0]?.id;
  const normalisedGroupName = state.groups[0]?.name;

  newGroupName.value = "indigo deck";
  createGroup.click();
  await new Promise((done) => window.setTimeout(done, 0));
  const duplicateError = groupError.textContent;
  const requestsAfterDuplicate = casRequests.length;
  window.String.prototype.toLocaleLowerCase = localeLowerCase;

  newGroupName.value = " Ａｌｌ ";
  createGroup.click();
  await new Promise((done) => window.setTimeout(done, 0));
  const reservedError = groupError.textContent;
  const requestsAfterReserved = casRequests.length;

  newGroupName.value = "Grammar";
  createGroup.click();
  await waitForRequestCount(2);
  const grammarGroupId = state.groups.find((group) => group.name === "Grammar")?.id;
  const grammarUp = groupRow(grammarGroupId).querySelector(".dict-group-up");
  grammarUp.focus();
  grammarUp.click();
  await waitForRequestCount(3);
  const groupOrderAfterMove = state.groups.map((group) => group.name);
  const groupMoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-down") === true
    && window.document.activeElement.closest(".dict-group")?.dataset.groupId === grammarGroupId;

  const studyName = groupRow(studyGroupId).querySelector(".dict-group-name");
  studyName.focus();
  studyName.value = "Reading";
  studyName.dispatchEvent(new window.Event("change", { bubbles: true }));
  const outsideGroupControl = window.document.querySelector('.settings-nav a[href="#lookup"]');
  outsideGroupControl.focus();
  await waitForRequestCount(4);
  const externalFocusPreserved = window.document.activeElement === outsideGroupControl;

  const studyAdd = groupRow(studyGroupId).querySelector(".dict-group-add");
  studyAdd.focus();
  await addGroupMember(studyGroupId, ids.beta, 5);
  const groupAddFocusRetained = window.document.activeElement?.classList.contains("dict-group-add") === true
    && window.document.activeElement.closest(".dict-group")?.dataset.groupId === studyGroupId;
  await addGroupMember(studyGroupId, ids.alpha, 6);
  const membershipBeforeMove = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const alphaUp = groupMemberRow(studyGroupId, ids.alpha).querySelector(".dict-group-member-up");
  alphaUp.focus();
  alphaUp.click();
  await waitForRequestCount(7);
  const membershipAfterMove = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const memberMoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-member-down") === true
    && window.document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === ids.alpha;

  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: state.dictionaries.map((dictionary) => dictionary.id === ids.beta
      ? { ...dictionary, displayName: "Renamed after grouping" }
      : dictionary),
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));
  const membershipAfterAlias = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const renamedMemberLabel = groupMemberRow(studyGroupId, ids.beta)
    ?.querySelector(".dict-group-member-name")?.textContent;

  const betaRemove = groupMemberRow(studyGroupId, ids.beta).querySelector(".dict-group-member-remove");
  betaRemove.focus();
  betaRemove.click();
  await waitForRequestCount(8);
  const memberRemoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-member-remove") === true
    && window.document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === ids.alpha;
  groupRow(grammarGroupId).querySelector(".dict-group-delete").click();
  await waitForRequestCount(9);

  const finalGroups = structuredClone(state.groups);
  const requestTypes = casRequests.map((request) => request.type);
  const dictionarySnapshots = casRequests.map((request) =>
    request.dictionaries.map((dictionary) => dictionary.id));

  casRequests.length = 0;
  newGroupName.value = "Queued group";
  createGroup.click();
  newGroupName.value = " queued\tgroup ";
  createGroup.click();
  await waitForRequestCount(1);
  const queuedCreateNames = state.groups
    .filter((group) => group.name.toLowerCase() === "queued group")
    .map((group) => group.name);
  const queuedCreateError = groupError.textContent;
  const queuedCreateRequestCount = casRequests.length;

  state = {
    ...state,
    revision: state.revision + 1,
    groups: [
      { id: "rename-one", name: "Rename one", dictionaryIds: [] },
      { id: "rename-two", name: "Rename two", dictionaryIds: [] },
    ],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  casRequests.length = 0;

  const firstRename = groupRow("rename-one").querySelector(".dict-group-name");
  const secondRename = groupRow("rename-two").querySelector(".dict-group-name");
  firstRename.value = "Shared name";
  firstRename.dispatchEvent(new window.Event("change", { bubbles: true }));
  secondRename.value = " shared\tname ";
  secondRename.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitForRequestCount(1);
  const queuedRenameNames = state.groups.map((group) => group.name);
  const queuedRenameError = groupError.textContent;
  const queuedRenameRequestCount = casRequests.length;

  result.groups = {
    normalisedGroupName,
    duplicateError,
    reservedError,
    requestsAfterDuplicate,
    requestsAfterReserved,
    groupOrderAfterMove,
    groupMoveFocusRetained,
    externalFocusPreserved,
    groupAddFocusRetained,
    membershipBeforeMove,
    membershipAfterMove,
    memberMoveFocusRetained,
    memberRemoveFocusRetained,
    membershipAfterAlias,
    renamedMemberLabel,
    finalGroups,
    requestTypes,
    dictionarySnapshots,
    queuedCreateNames,
    queuedCreateError,
    queuedCreateRequestCount,
    queuedRenameNames,
    queuedRenameError,
    queuedRenameRequestCount,
  };
  await navigateSettingsSection(window, "dictionaries");
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  acceptState([
    genericPackage({ id: CUSTOM_DICTIONARY_ID, title: CUSTOM_DICTIONARY_TITLE }),
    ...managementDictionaries.slice(0, 3),
  ]);
  const bulkRemove = window.document.getElementById("dict-bulk-remove");
  const removalCalls = [];
  let finishFirst;
  removeHandler = async (message) => {
    removalCalls.push(message.id);
    if (removalCalls.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    if (message.id === ids.hiddenOne) throw new window.Error("simulated bulk failure");
    acceptState(state.dictionaries.filter(entry => entry.id !== message.id));
    return { ok: true };
  };
  selectAll.click();
  window.confirm = () => false;
  bulkRemove.click();
  if (removalCalls.length) throw new Error("cancelled bulk removal sent a request");
  let confirmations = 0;
  window.confirm = () => { confirmations += 1; return true; };
  bulkRemove.click();
  await new Promise(done => window.setTimeout(done, 0));
  if (removalCalls.join() !== ids.alpha || !bulkRemove.disabled
      || !window.document.getElementById("import-file").disabled) {
    throw new Error("bulk removal did not serialize requests and disable competing controls");
  }
  finishFirst();
  const removalDeadline = Date.now() + 2000;
  while (bulkRemove.disabled && Date.now() < removalDeadline) {
    await new Promise(done => window.setTimeout(done, 5));
  }
  if (confirmations !== 1 || removalCalls.join() !== [ids.alpha, ids.hiddenOne, ids.beta].join()
      || state.dictionaries.map(entry => entry.id).join() !== [CUSTOM_DICTIONARY_ID, ids.hiddenOne].join()
      || !rowFor(ids.hiddenOne).querySelector(".dict-selected").checked
      || !window.document.getElementById("engine-status").textContent.includes("simulated bulk failure")) {
    throw new Error("bulk removal lost custom protection, partial failure, selection or continuation");
  }
  removeHandler = async message => {
    removalCalls.push(message.id);
    acceptState(state.dictionaries.filter(entry => entry.id !== message.id));
    return { ok: true };
  };
  bulkRemove.click();
  await new Promise(done => window.setTimeout(done, 0));
  if (removalCalls.at(-1) !== ids.hiddenOne || !bulkRemove.disabled
      || state.dictionaries.length !== 1 || state.dictionaries[0].id !== CUSTOM_DICTIONARY_ID) {
    throw new Error("bulk retry did not remove only the failed package and protect the personal dictionary");
  }

  // Settings → Library → Remove all imported dictionaries, then Reading → Reset lookup counts.
  const settle = async (predicate) => {
    const until = Date.now() + 2000;
    while (!predicate() && Date.now() < until) await new Promise(done => window.setTimeout(done, 5));
    await new Promise(done => window.setTimeout(done, 0));
  };
  const importFile = window.document.getElementById("import-file");
  const removeAll = window.document.getElementById("library-remove-all");
  const erasePersonal = window.document.getElementById("library-reset-personal");
  const libraryStatus = window.document.getElementById("library-reset-status");
  const countsReset = window.document.getElementById("lookup-counts-reset");
  const countsStatus = window.document.getElementById("lookup-counts-reset-status");
  const outcome = (output) => ({ text: output.textContent, error: output.classList.contains("is-error"),
    ready: output.classList.contains("is-ready") });
  await settle(() => !importFile.disabled);
  const library = [
    genericPackage({ id: CUSTOM_DICTIONARY_ID, title: CUSTOM_DICTIONARY_TITLE }),
    ...managementDictionaries.slice(4, 8),
  ];
  library[2] = { ...library[2], enabled: false };
  acceptState(library);
  search.value = "Library 5";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const resetConfirmations = [];
  let answer = false;
  window.confirm = message => { resetConfirmations.push(message); return answer; };
  removalCalls.length = 0;
  removeHandler = async message => {
    removalCalls.push(message.id);
    if (message.title === "Library 7") return { ok: false, error: "simulated engine failure" };
    acceptState(state.dictionaries.filter(entry => entry.id !== message.id));
    return { ok: true };
  };
  const filtered = { visible: rowIds(), shown: !window.document.getElementById("library-reset").hidden,
    enabled: !removeAll.disabled };
  removeAll.click();
  await settle(() => resetConfirmations.length === 1 && !importFile.disabled);
  const cancelled = { removals: removalCalls.length, custom: customRequests.length, status: libraryStatus.textContent };
  answer = true;
  removeAll.click();
  await settle(() => libraryStatus.textContent.includes("Could not remove") && !importFile.disabled);
  const partial = { removals: [...removalCalls], remaining: state.dictionaries.map(entry => entry.id),
    ...outcome(libraryStatus), confirmation: resetConfirmations[1], custom: customRequests.length };

  // A Note appended after the confirmation keeps the personal source.
  customDocument = { schemaVersion: 1, revision: 3, semanticRevision: "a".repeat(64), text: "猫, ねこ, cat\n犬, いぬ, dog\n" };
  customSaveHandler = async () => {
    customDocument = { ...customDocument, revision: 4, text: `${customDocument.text}鳥, とり, bird\n` };
    return { ok: false, stale: true, error: "the custom dictionary source changed while it was being saved",
      document: structuredClone(customDocument), state: structuredClone(state) };
  };
  removeHandler = async message => {
    removalCalls.push(message.id);
    acceptState(state.dictionaries.filter(entry => entry.id !== message.id));
    return { ok: true };
  };
  removalCalls.length = 0;
  erasePersonal.checked = true;
  erasePersonal.dispatchEvent(new window.Event("change", { bubbles: true }));
  removeAll.click();
  await settle(() => libraryStatus.textContent.includes("changed after you confirmed") && !importFile.disabled);
  const stale = { removals: [...removalCalls], requests: structuredClone(customRequests),
    remaining: state.dictionaries.map(entry => entry.id), ...outcome(libraryStatus), confirmation: resetConfirmations[2] };

  // Only the personal dictionary is left: Remove all needs the explicit choice.
  erasePersonal.checked = false;
  erasePersonal.dispatchEvent(new window.Event("change", { bubbles: true }));
  const personalOnlyWithoutChoice = removeAll.disabled;
  erasePersonal.checked = true;
  erasePersonal.dispatchEvent(new window.Event("change", { bubbles: true }));
  const personalOnlyWithChoice = !removeAll.disabled;
  customRequests.length = 0;
  removalCalls.length = 0;
  customSaveHandler = async message => {
    if (message.baseDocumentRevision !== customDocument.revision) throw new Error("erase used an old revision");
    customDocument = { schemaVersion: 1, revision: customDocument.revision + 1, semanticRevision: "e".repeat(64), text: "" };
    const reply = acceptState(state.dictionaries.filter(entry => entry.id !== CUSTOM_DICTIONARY_ID));
    return { ...reply, document: structuredClone(customDocument), removed: true };
  };
  removeAll.click();
  await settle(() => libraryStatus.textContent.includes("Erased") && !importFile.disabled);
  const erased = { withoutChoice: personalOnlyWithoutChoice, withChoice: personalOnlyWithChoice,
    removals: [...removalCalls], requests: structuredClone(customRequests), remaining: state.dictionaries.length,
    hidden: window.document.getElementById("library-reset").hidden, ...outcome(libraryStatus),
    confirmation: resetConfirmations[3] };

  acceptState([managementDictionaries[8]]);
  storageListener({ sharing: { newValue: { host: null, client: { address: "ws://192.0.2.10:8771/link" } } } }, "local");
  const linked = { removeAll: removeAll.disabled, personal: erasePersonal.disabled, counts: countsReset.disabled,
    notices: !window.document.getElementById("library-reset-linked").hidden
      && !window.document.getElementById("lookup-counts-reset-linked").hidden };
  storageListener({ sharing: { newValue: { host: null, client: null } } }, "local");
  const unlinked = { removeAll: !removeAll.disabled, counts: !countsReset.disabled,
    notices: window.document.getElementById("library-reset-linked").hidden
      && window.document.getElementById("lookup-counts-reset-linked").hidden };

  const statesBeforeCounts = state.revision;
  answer = false;
  countsReset.click();
  const countsCancelled = statsResets.length;
  answer = true;
  countsReset.click();
  const countsBusy = countsReset.disabled;
  await settle(() => countsStatus.textContent.startsWith("Lookup counts reset"));
  const countsDone = { targets: [...statsResets], ...outcome(countsStatus), enabled: !countsReset.disabled,
    confirmation: resetConfirmations.at(-1) };
  statsResetReply = { ok: false, error: "Lookup counts belong to the linked Hachidori. Unlink to reset this browser's counts." };
  countsReset.click();
  await settle(() => countsStatus.textContent.startsWith("Could not"));
  result.reset = {
    filtered, cancelled, partial, stale, erased, linked, unlinked,
    library: library.map(entry => entry.id),
    counts: { cancelled: countsCancelled, busy: countsBusy, done: countsDone, failed: outcome(countsStatus),
      enabledAfterFailure: !countsReset.disabled, dictionariesUntouched: state.revision === statesBeforeCounts },
  };
  result.directDictionaryWrites = directDictionaryWrites;
  dom.window.close();
  return result;
}

describe("Settings library", () => {
  test("Settings library management, groups and removal", async () => {
    const settingsConflict = await settingsConflictStage();
    check(
      "settings refuse a conflicting alias draft, queue its next action, and restore a rejected edit",
      settingsConflict?.draftSurvived === true
        && settingsConflict.secondActionTargetSurvived === true
        && settingsConflict.casRequests?.length === 1
        && settingsConflict.casRequests[0].type === "hd_apply_state"
        && settingsConflict.casRequests[0].baseRevision === 8
        && settingsConflict.casRequests[0].dictionaries[0].displayName === "Other writer"
        && settingsConflict.casRequests[0].dictionaries[0].favorite === true
        && settingsConflict.casRequests[0].dictionaries[0].frequencyMode === "rank-based"
        && settingsConflict.casRequests[0].dictionaries[0].enabled === false
        && settingsConflict.aliasConflict.includes("changed elsewhere")
        && settingsConflict.retainedAlias === "My draft"
        && settingsConflict.directDictionaryWrites === 0
        && settingsConflict.enabled === true
        && settingsConflict.kanjiChoice === true
        && settingsConflict.title === "Concurrent final"
        && settingsConflict.canonical === "Generic"
        && settingsConflict.favorite === true
        && settingsConflict.checkboxFocused === true
        && settingsConflict.conflictStatus.includes("not saved")
        && settingsConflict.removalControlsBlocked === true
        && settingsConflict.removalControlsRestored === true,
      JSON.stringify(settingsConflict),
    );
    check(
      "settings search, visible selection, bulk changes, and every reorder path share stable package state",
      settingsConflict?.management?.localeIndependentVisibleIds?.join(",") === "11111111111111111111111111111111"
        && settingsConflict.management.visibleIds?.join(",") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccccccccccc"
        && settingsConflict.management.selectedVisibleIds?.join(",") === settingsConflict.management.visibleIds.join(",")
        && settingsConflict.management.bulkRequests?.length === 4
        && settingsConflict.management.bulkRequests.every((request, index) =>
          request.type === (index < 2 ? "hd_apply_state" : "hd_state_cas"))
        && settingsConflict.management.bulkHiddenUntouched === true
        && settingsConflict.management.bulkValues?.join(",") === "false,false,false,true,true,true,true,true,true,false,false,false"
        && settingsConflict.management.queuedOrderTitles?.length === 2
        && settingsConflict.management.queuedOrderTitles[0].indexOf("Ａｌｐｈａ notes") === 10
        && settingsConflict.management.queuedOrderTitles[1].indexOf("Ａｌｐｈａ notes") === 9
        && settingsConflict.management.queuedOrderTitles
          .every((titles) => titles.length === 12 && new Set(titles).size === 12)
        && settingsConflict.management.orderRequests?.every((request) => request.type === "hd_apply_state")
        && settingsConflict.management.orderTitles?.length === 3
        && settingsConflict.management.orderTitles[0][0] === "Alpha concurrent"
        && settingsConflict.management.orderTitles[1][0] === "ＡＬＰＨＡ"
        && settingsConflict.management.orderTitles[1][11] === "Alpha concurrent"
        && settingsConflict.management.orderTitles[2][0] === "Hidden one"
        && settingsConflict.management.orderTitles
          .every((titles) => titles.length === 12 && new Set(titles).size === 12)
        && settingsConflict.management.hiddenOrderPreserved === true
        && settingsConflict.management.reorderConflictRebuiltMetadata === true
        && settingsConflict.management.directPositionMovedTwelfthToFirst === true
        && settingsConflict.management.directPositionPreservedMetadata === true
        && settingsConflict.management.reorderReusedRowNode === true
        && settingsConflict.management.reorderRankFollowsPosition === true
        && settingsConflict.management.searchAfterOperations === " ＡｌＰｈＡ "
        && settingsConflict.management.selectedAfterOperations?.join(",") === settingsConflict.management.visibleIds.join(",")
        && settingsConflict.management.selectedAfterExternalChange?.join(",") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,cccccccccccccccccccccccccccccccc"
        && settingsConflict.management.visibleAfterExternalChange?.join(",") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccccccccccc",
      JSON.stringify(settingsConflict?.management),
    );
    const reset = settingsConflict?.reset;
    const ordinary = reset?.library?.slice(1) ?? [];
    const confirms = (message, parts) => typeof message === "string" && parts.every(part => message.includes(part));
    check(
      "Remove all removes every ordinary package after one confirmation, keeps the personal dictionary unless chosen, and reports failures by title",
      reset?.filtered.visible.length === 1 && reset.filtered.shown && reset.filtered.enabled
        && reset.cancelled.removals === 0 && reset.cancelled.custom === 0 && reset.cancelled.status === ""
        && JSON.stringify(reset.partial.removals) === JSON.stringify(ordinary)
        && JSON.stringify(reset.partial.remaining) === JSON.stringify([CUSTOM_DICTIONARY_ID, ordinary[2]])
        && reset.partial.error && reset.partial.custom === 0
        && confirms(reset.partial.text, ["Removed 3 of 4 dictionaries.", "Library 7: simulated engine failure"])
        && confirms(reset.partial.confirmation, ["Remove 4 imported dictionaries?", "disabled", "the search hides",
          "The personal dictionary is kept.", "Anki notes are not changed", "existing backups still hold them"]),
      JSON.stringify({ filtered: reset?.filtered, cancelled: reset?.cancelled, partial: reset?.partial }),
    );
    check(
      "erasing the personal source uses the confirmed revision, so a later Note keeps it until a fresh confirmation",
      JSON.stringify(reset?.stale.removals) === JSON.stringify([ordinary[2]])
        && JSON.stringify(reset.stale.requests) === JSON.stringify([
          { type: "hd_custom_read", target: "hoshidicts-worker" },
          { type: "hd_custom_save", baseDocumentRevision: 3, text: "" },
        ])
        && JSON.stringify(reset.stale.remaining) === JSON.stringify([CUSTOM_DICTIONARY_ID]) && reset.stale.error
        && confirms(reset.stale.text, ["Removed 1 dictionary.", "changed after you confirmed, so it was kept"])
        && confirms(reset.stale.confirmation, ["Remove 1 imported dictionary and erase the personal dictionary source and its 2 entries?"])
        && !reset.stale.confirmation.includes("is kept")
        && reset.erased.withoutChoice && reset.erased.withChoice && reset.erased.removals.length === 0
        && JSON.stringify(reset.erased.requests) === JSON.stringify([
          { type: "hd_custom_read", target: "hoshidicts-worker" },
          { type: "hd_custom_save", baseDocumentRevision: 4, text: "" },
        ])
        && reset.erased.remaining === 0 && reset.erased.hidden && reset.erased.ready
        && reset.erased.text === "Erased the personal dictionary source."
        && reset.erased.confirmation?.startsWith("Erase the personal dictionary source and its 3 entries?"),
      JSON.stringify({ stale: reset?.stale, erased: reset?.erased }),
    );
    check(
      "Reset lookup counts confirms once, asks the worker, and both resets are unavailable while linked",
      reset?.linked.removeAll && reset.linked.personal && reset.linked.counts && reset.linked.notices
        && reset.unlinked.removeAll && reset.unlinked.counts && reset.unlinked.notices
        && reset.counts.cancelled === 0 && reset.counts.busy
        && JSON.stringify(reset.counts.done.targets) === JSON.stringify(["hoshidicts-worker"])
        && reset.counts.done.ready && reset.counts.done.enabled
        && reset.counts.done.text === "Lookup counts reset."
        && confirms(reset.counts.done.confirmation, ["Reset lookup counts for every word?", "counts as 1",
          "Anki notes are not changed", "existing backups keep the earlier counts"])
        && reset.counts.failed.error && reset.counts.failed.text.includes("linked Hachidori")
        && reset.counts.enabledAfterFailure && reset.counts.dictionariesUntouched,
      JSON.stringify({ linked: reset?.linked, unlinked: reset?.unlinked, counts: reset?.counts }),
    );
    check(
      "settings manage normalized global groups and stable ordered memberships",
      settingsConflict?.groups?.normalisedGroupName === "INDIGO Deck"
        && settingsConflict.groups.duplicateError?.includes("already exists")
        && settingsConflict.groups.reservedError?.includes("reserved")
        && settingsConflict.groups.requestsAfterDuplicate === 1
        && settingsConflict.groups.requestsAfterReserved === 1
        && settingsConflict.groups.groupOrderAfterMove?.join(",") === "Grammar,INDIGO Deck"
        && settingsConflict.groups.groupMoveFocusRetained === true
        && settingsConflict.groups.groupAddFocusRetained === true
        && settingsConflict.groups.membershipBeforeMove?.join(",")
          === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        && settingsConflict.groups.membershipAfterMove?.join(",")
          === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        && settingsConflict.groups.memberMoveFocusRetained === true
        && settingsConflict.groups.memberRemoveFocusRetained === true
        && settingsConflict.groups.membershipAfterAlias?.join(",")
          === settingsConflict.groups.membershipAfterMove.join(",")
        && settingsConflict.groups.renamedMemberLabel === "Renamed after grouping"
        && settingsConflict.groups.finalGroups?.length === 1
        && settingsConflict.groups.finalGroups[0].name === "Reading"
        && settingsConflict.groups.finalGroups[0].dictionaryIds?.join(",")
          === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        && settingsConflict.groups.requestTypes?.length === 9
        && settingsConflict.groups.requestTypes.every((type) => type === "hd_state_cas")
        && settingsConflict.groups.dictionarySnapshots.every((snapshot) =>
          snapshot.join(",") === settingsConflict.groups.dictionarySnapshots[0].join(","))
       && settingsConflict.directDictionaryWrites === 0,
      JSON.stringify(settingsConflict?.groups),
    );
    check(
      "queued group creates and renames revalidate normalized unique names",
      settingsConflict?.groups?.queuedCreateNames?.length === 1
        && settingsConflict.groups.queuedCreateError?.includes("already exists")
        && settingsConflict.groups.queuedCreateRequestCount === 1
        && settingsConflict.groups.queuedRenameNames?.filter((name) => name === "Shared name").length === 1
        && settingsConflict.groups.queuedRenameNames?.includes("Rename two")
        && settingsConflict.groups.queuedRenameError?.includes("already exists")
        && settingsConflict.groups.queuedRenameRequestCount === 1,
      JSON.stringify(settingsConflict?.groups),
    );
    check(
      "group rerenders preserve newer focus outside the management lists",
      settingsConflict?.groups?.externalFocusPreserved === true,
      JSON.stringify(settingsConflict?.groups),
    );
  });

  test("Settings batch import", async () => {
    const settingsBatch = await settingsBatchImportStage();
    check(
      "settings imports dropped archives sequentially through the shared progress rows and retains each timed outcome",
      settingsBatch?.multiple === true
        && settingsBatch.pickerValue === ""
        && Object.values(settingsBatch.drop ?? {}).every(Boolean)
        && settingsBatch.sharedRows === true
        && JSON.stringify(settingsBatch.importRequests?.map(({ fileName }) => fileName))
          === JSON.stringify(["first.zip", "broken.zip", "replacement.zip"])
        && settingsBatch.importRequests?.every(({ state, completed }, index) =>
          state.includes(`${index + 1} of 3`)
            && state.includes(`${index} of 3 complete`)
            && completed === index)
        && settingsBatch.maxActiveImports === 1
        && JSON.stringify(settingsBatch.revokedUrls) === JSON.stringify(settingsBatch.createdUrls)
        && JSON.stringify(settingsBatch.outcomes?.map(({ error }) => error))
          === JSON.stringify([false, true, false])
        && JSON.stringify(settingsBatch.outcomes?.map(({ name }) => name))
          === JSON.stringify(["first.zip", "broken.zip", "replacement.zip"])
        && settingsBatch.outcomes.every(({ text, trackHidden }) =>
          /\d+(?:\.\d)? seconds/u.test(text) && trackHidden)
        && settingsBatch.outcomes[0].text.includes("Imported First")
        && settingsBatch.outcomes[1].text.includes("broken archive")
        && settingsBatch.outcomes[2].text.includes("Imported First")
        && settingsBatch.finalState === "Finished 3 of 3 archives — 2 imported, 1 failed."
        && settingsBatch.controlsRestored === true
        && settingsBatch.stateReads === 3
        && settingsBatch.statusReads === 1,
      JSON.stringify(settingsBatch),
    );
  });

  test("Settings MDX import", async () => {
    const settingsMdx = await settingsMdxImportStage();
    check(
      "settings groups an .mdx with its .mdd files into one resourced import and reports an orphan .mdd",
      settingsMdx?.accept === ".zip,application/zip,.mdx,.mdd"
        && settingsMdx.label === "Choose dictionary files"
        && JSON.stringify(settingsMdx.importRequests) === JSON.stringify([
          { fileName: "Dict.mdx", blobUrl: settingsMdx.createdUrls[0],
            resources: [{ fileName: "dict.MDD", blobUrl: settingsMdx.createdUrls[1] },
              { fileName: "Dict.1.mdd", blobUrl: settingsMdx.createdUrls[2] }],
            importDecision: "absent" },
          { fileName: "plain.zip", blobUrl: settingsMdx.createdUrls[3], resources: undefined, importDecision: "present" },
        ])
        && JSON.stringify(settingsMdx.identityReads) === JSON.stringify(["plain.zip"])
        && JSON.stringify([...settingsMdx.revokedUrls].sort()) === JSON.stringify([...settingsMdx.createdUrls].sort())
        && settingsMdx.createdUrls.length === 4
        && JSON.stringify(settingsMdx.outcomes.map(({ name, error }) => [name, error]))
          === JSON.stringify([["Dict.mdx", false], ["plain.zip", false], ["Other.mdd", true]])
        && settingsMdx.outcomes[0].text.includes("Imported Dict")
        && settingsMdx.outcomes[2].text.includes("together with the .mdx")
        && settingsMdx.finalState === "Finished 3 of 3 files — 2 imported (1 with notes), 1 failed.",
      JSON.stringify(settingsMdx),
    );
    check(
      "settings lists what an MDX import left out under its Imported line, which stays a success",
      settingsMdx?.outcomes[0].okTone === true
        && settingsMdx.outcomes[0].error === false
        && settingsMdx.outcomes[0].notesHidden === false
        && JSON.stringify(settingsMdx.outcomes[0].notes) === JSON.stringify([
          "1 redirect alias could not be resolved. "
            + "These aliases may not appear in search results; their target definitions may still be available.",
          "2 referenced resources were not included. Choose the .mdx together with all of its .mdd files "
            + "to include available images and styles. This does not count missing definitions.",
        ])
        && settingsMdx.outcomes[1].okTone === true
        && settingsMdx.outcomes[1].notesHidden === true
        && settingsMdx.outcomes[1].notes.length === 0
        && settingsMdx.outcomes[2].notes.length === 0,
      JSON.stringify(settingsMdx?.outcomes),
    );
  });
});
