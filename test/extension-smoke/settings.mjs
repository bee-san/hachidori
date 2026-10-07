/*
 * Settings navigation, reader controls and autosave.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { parseCustomDictionary } from "../../extension/custom-dictionary.js";
import {
  EXTENSION,
  EXTENSION_ORIGIN,
  genericPackage,
  loadJsdom,
  loadSettingsScript,
  navigateSettingsSection,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function settingsNavigationStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
  });
  const { window } = dom;
  const document = window.document;
  let listener;
  let pendingSave;
  const requests = [];
  const automaticReplies = [];
  const storedOptions = { revision: 1, maxResults: 32 };
  let state = { schemaVersion: 1, revision: 1, groups: [], dictionaries: [
    genericPackage({ id: "first", title: "First" }),
    genericPackage({ id: "second", title: "Second" }),
  ] };
  window.chrome = {
    runtime: { async sendMessage(message) {
      requests.push(structuredClone(message));
      if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 2 };
      if (message.type === "hd_memory") return { ok: true, heapBytes: 0, dictionaries: [] };
      if (message.type === "hd_custom_read") return { ok: true, document: { schemaVersion: 1, revision: 0,
        semanticRevision: "a".repeat(64), text: "" } };
      if (message.type === "hd_backup_auto_list") {
        return new Promise(resolveReply => automaticReplies.push(resolveReply));
      }
      if (message.type === "hd_options_write") return new Promise((resolveReply) => { pendingSave = resolveReply; });
      throw new Error(`Unexpected navigation request ${message.type}`);
    } },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const pause = () => new Promise((done) => setTimeout(done, 10));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await pause();
    if (!predicate()) throw new Error("Settings navigation did not reach its expected state");
  }
  const active = () => [...document.querySelectorAll("main > section")].filter((section) => !section.hidden);
  async function navigate(id) {
    await navigateSettingsSection(window, id);
  }
  const row = () => document.querySelector('.dict-row[data-dictionary-id="first"]');
  try {
    loadSettingsScript(window);
    await until(() => document.getElementById("engine-status").textContent.startsWith("Ready"));
    if (active().length !== 1 || !document.querySelector('.settings-nav [aria-current="page"]')) {
      return { navigation: false, draft: false, details: false };
    }
    const initial = active()[0].id === "lookup";
    const reading = document.getElementById("lookup");
    const libraryNavigation = document.getElementById("library-navigation");
    const initialLibraryContext = libraryNavigation?.hidden === true;
    const source = document.getElementById("custom-dictionary-source");
    const beforeNavigation = requests.length;
    await navigate("custom-dictionary");
    await until(() => !source.disabled);
    const personalLibraryContext = libraryNavigation?.hidden === false
      && document.querySelector('.settings-nav [aria-current="page"]')?.hash === "#dictionaries"
      && libraryNavigation.querySelector('[aria-current="page"]')?.hash === "#custom-dictionary";
    const emptyEditor = !document.getElementById("custom-dictionary-form").hidden
      && source.value === "" && source.placeholder.split("\n").length === 3
      && parseCustomDictionary(source.value).entries.length === 0
      && document.getElementById("custom-dictionary-save").disabled;
    document.getElementById("custom-dictionary-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    source.value = "蜂";
    source.dispatchEvent(new window.Event("input", { bubbles: true }));
    const typedOnly = source.value === "蜂";
    source.value = "";
    source.dispatchEvent(new window.Event("input", { bubbles: true }));
    await navigate("lookup");
    const navigation = initial && active().length === 1 && active()[0] === reading
      && initialLibraryContext && personalLibraryContext && libraryNavigation.hidden
      && source === document.getElementById("custom-dictionary-source")
      && document.querySelector('.settings-nav [aria-current="page"]').hash === "#lookup"
      && requests.length === beforeNavigation + 1
      && requests.at(-1).type === "hd_custom_read" && emptyEditor && typedOnly;

    const input = document.getElementById("opt-max-results");
    input.value = "64";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => pendingSave !== undefined);
    const beforeLeaving = requests.length;
    await navigate("dictionaries");
    pendingSave({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => document.getElementById("options-status").textContent.includes("Could not save"));
    const mirror = document.getElementById("nav-status-lookup");
    const failureVisible = mirror.textContent.startsWith("Reading: Could not save")
      && mirror.classList.contains("is-error") && !mirror.closest("[hidden]");
    await navigate("lookup");
    const draft = input === document.getElementById("opt-max-results") && input.value === "64"
      && !document.getElementById("options-conflict-actions").hidden && requests.length === beforeLeaving
      && failureVisible && mirror.textContent === "";

    await navigate("dictionaries");
    const disclosure = row().querySelector(".dict-details");
    if (!disclosure) return { navigation, draft, details: false };
    disclosure.open = true;
    row().querySelector(".dict-details-toggle").focus();
    state = { ...state, revision: 2, dictionaries: state.dictionaries.map((entry) => ({ ...entry, favorite: true })) };
    listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
    const focusKept = row().querySelector(".dict-details").open
      && document.activeElement === row().querySelector(".dict-details-toggle");
    const firstRow = row();
    const secondRow = document.querySelector('.dict-row[data-dictionary-id="second"]');
    const selectVisible = document.getElementById("dict-select-visible");
    const beforeFiltering = requests.length;
    selectVisible.click();
    const selectionKeptRows = row() === firstRow
      && document.querySelector('.dict-row[data-dictionary-id="second"]') === secondRow
      && firstRow.querySelector(".dict-selected").checked
      && secondRow.querySelector(".dict-selected").checked;
    selectVisible.click();
    const deselectionKeptRows = row() === firstRow
      && !firstRow.querySelector(".dict-selected").checked
      && !secondRow.querySelector(".dict-selected").checked;
    const search = document.getElementById("dict-search");
    search.focus();
    secondRow.classList.add("is-drop-target");
    let filteringKeptRows = true;
    for (const value of ["Second", ""]) {
      search.value = value;
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      filteringKeptRows &&= document.querySelector('.dict-row[data-dictionary-id="second"]') === secondRow;
    }
    let details = focusKept && row().querySelector(".dict-details").open
      && !document.querySelector('.dict-row[data-dictionary-id="second"] .dict-details').open
      && document.activeElement === search && selectionKeptRows && deselectionKeptRows
      && filteringKeptRows && !secondRow.classList.contains("is-drop-target")
      && requests.length === beforeFiltering;
    for (const action of ["search", "select-visible"]) {
      row().querySelector(".dict-display-name").focus();
      const oldRow = row();
      const label = `New name before ${action}`;
      state = { ...state, revision: state.revision + 1,
        dictionaries: state.dictionaries.map((entry) => entry.id === "first" ? { ...entry, displayName: label } : entry) };
      listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
      const deferred = row() === oldRow && row().querySelector(".dict-title").textContent !== label;
      if (action === "search") search.dispatchEvent(new window.Event("input", { bubbles: true }));
      else selectVisible.click();
      details &&= deferred && row() !== oldRow && row().querySelector(".dict-title").textContent === label;
    }
    await navigate("lookup");
    document.getElementById("options-use-saved").click();
    input.value = "96";
    const beforeSave = requests.length;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => requests.length > beforeSave);
    await navigate("dictionaries");
    pendingSave({ ok: true, options: { ...storedOptions, revision: 2, maxResults: 96 } });
    await until(() => document.getElementById("options-status").textContent === "Saved.");
    const unseenCompletion = mirror.textContent === "Reading: Saved.";
    await navigate("lookup");
    await navigate("dictionaries");
    let design = document.getElementById("design-preview") === null
      && document.getElementById("opt-popup-theme").options.length === 0;
    if (document.getElementById("design")) {
      await navigate("design");
      const preview = document.getElementById("design-preview");
      design &&= document.getElementById("opt-popup-theme").options.length === 43;
      const updates = [];
      preview.contentWindow.HDDesignPreview = { update(value) { updates.push(structuredClone(value)); } };
      preview.dispatchEvent(new window.Event("load"));
      const columns = document.getElementById("opt-popup-columns");
      const beforeEdit = requests.length;
      columns.value = "2";
      columns.dispatchEvent(new window.Event("change", { bubbles: true }));
      design &&= preview.getAttribute("src") === "design-preview.html"
        && columns.closest("section").id === "design"
        && document.getElementById("opt-scan-length").closest("section").id === "lookup"
        && updates.at(-1)?.popupColumns === 2 && requests.length === beforeEdit
        && document.getElementById("options-status").closest("section").id === "design";
      await until(() => requests.length > beforeEdit);
      pendingSave({ ok: false, conflict: true, error: "Settings changed elsewhere.", options: storedOptions });
      await until(() => document.getElementById("options-status").textContent.includes("Could not save"));
      await navigate("lookup");
      design &&= !document.getElementById("options-conflict-actions").hidden
        && document.getElementById("options-status").closest("section").id === "lookup";
      document.getElementById("options-use-saved").click();
      const beforeReturn = requests.length;
      await navigate("design");
      design &&= updates.at(-1)?.popupColumns === 1 && requests.length === beforeReturn;
    }
    const resumeLink = document.getElementById("setup-resume");
    let resume = resumeLink.hidden && resumeLink.getAttribute("href") === "startup.html"
      && !resumeLink.closest(".settings-nav");
    const setup = { schemaVersion: 1, revision: 1, startedAt: "2026-09-07T10:00:00.000Z", stage: "anki", completedAt: null };
    listener({ setupState: { newValue: setup } }, "local");
    resume &&= !resumeLink.hidden;
    listener({ setupState: { newValue: { ...setup, revision: 2, stage: "complete", completedAt: "2026-09-07T10:05:00.000Z" } } }, "local");
    resume &&= resumeLink.hidden;
    listener({ setupState: { newValue: { ...setup, revision: 3 } } }, "local");
    resume &&= !resumeLink.hidden;
    listener({ setupState: { newValue: { schemaVersion: 2, revision: 4 } } }, "local");
    resume &&= resumeLink.hidden;

    listener({ sharing: { newValue: { client: { address: "ws://127.0.0.1:8771/link" } } } }, "local");
    await navigate("backup");
    await until(() => automaticReplies.length === 1);
    automaticReplies[0]({ ok: true, backups: [], corruptCount: 0, linked: true });
    await until(() => document.getElementById("automatic-backup-status").textContent.includes("No automatic backup"));
    listener({ sharing: {
      newValue: { host: { enabled: false, port: 8771, network: false }, client: null },
    } }, "local");
    await until(() => automaticReplies.length === 2);
    listener({ automaticBackups: {
      oldValue: undefined,
      newValue: { schemaVersion: 1, backups: [{ id: "committed" }] },
    } }, "local");
    await until(() => automaticReplies.length === 3);
    const automatic = {
      id: "committed",
      createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      dictionaries: [],
      customEntryCount: 0,
    };
    automaticReplies[2]({ ok: true, backups: [automatic], corruptCount: 0 });
    await until(() => document.querySelectorAll("#automatic-backup-list .automatic-backup-row").length === 1);
    automaticReplies[1]({ ok: true, backups: [], corruptCount: 0 });
    await pause();
    const automaticRefresh = document.querySelectorAll("#automatic-backup-list .automatic-backup-row").length === 1
      && document.querySelector("#automatic-backup-list .automatic-backup-row")?.dataset.backupId === automatic.id
      && !document.getElementById("automatic-backups").hidden;
    return {
      navigation,
      draft: draft && unseenCompletion && mirror.textContent === "",
      details,
      design,
      resume,
      automaticRefresh,
    };
  } finally {
    window.close();
  }
}

async function settingsFrequencyStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
  });
  const { window } = dom;
  let listener;
  let storedOptions = { revision: 1, frequencyDictionary: "", frequencyOrder: "disabled" };
  let state = { schemaVersion: 1, revision: 1, groups: [], dictionaries: [
    genericPackage({ id: "rank", title: "Rank", frequencyCount: 3, frequencyMode: "rank-based" }),
    genericPackage({ id: "occurrence", title: "Occurrence", frequencyCount: 3, frequencyMode: "occurrence-based" }),
    genericPackage({ id: "unknown", title: "Unknown mode", frequencyCount: 3 }),
  ] };
  const writes = [];
  const emitOptions = (patch) => {
    storedOptions = { ...storedOptions, ...patch, revision: storedOptions.revision + 1 };
    listener({ options: { newValue: structuredClone(storedOptions) } }, "local");
  };
  const emitDictionaries = (patch, title = "Rank") => {
    state = { ...state, revision: state.revision + 1,
      dictionaries: state.dictionaries.map((dictionary) => dictionary.title === title ? { ...dictionary, ...patch } : dictionary) };
    listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  };
  window.chrome = {
    runtime: { onMessage: { addListener() {}, removeListener() {} }, async sendMessage(message) {
      if (message.type === "hd_audio_voices") return { ok: true, voices: [] };
      if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 3 };
      if (message.type !== "hd_options_write") throw new Error(`Unexpected frequency Settings request ${message.type}`);
      writes.push(structuredClone(message));
      if (message.baseRevision !== storedOptions.revision) {
        return { ok: false, conflict: true, error: "Settings changed in another page.", options: structuredClone(storedOptions) };
      }
      emitOptions(message.options);
      return { ok: true, options: structuredClone(storedOptions) };
    } },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const field = (name) => window.document.getElementById(`opt-frequency-${name}`);
  const status = () => window.document.getElementById("options-status").textContent;
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    if (!predicate()) throw new Error("Frequency Settings did not reach its expected state");
  }
  async function edit(name, value) {
    const count = writes.length;
    field(name).value = value;
    field(name).dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => writes.length === count + 1 && status() === "Saved.");
    return writes.at(-1).options;
  }
  try {
    loadSettingsScript(window);
    await until(() => window.document.getElementById("engine-status").textContent.startsWith("Ready"));
    const imageSource = window.document.getElementById("opt-image-source");
    const imageSourceDefault = imageSource?.value === "" && !imageSource.disabled && writes.length === 0;
    const auto = field("auto");
    if (!auto) return { explicit: false, availability: false, draft: false, error: "Auto direction is missing" };
    const passive = storedOptions.frequencyOrder === "disabled" && field("order").value === "disabled"
      && auto.disabled && writes.length === 0 && auto.getAttribute("aria-label")?.includes(auto.textContent.trim());
    const rank = await edit("dictionary", "Rank");
    const hint = window.document.getElementById("frequency-order-hint");
    const rankHint = hint.firstChild;
    await edit("order", "descending");
    const beforeMetadata = writes.length;
    emitDictionaries({ displayName: "Rank alias" });
    const manualKept = field("order").value === "descending" && writes.length === beforeMetadata
      && hint.firstChild === rankHint;
    auto.click();
    await until(() => writes.length === beforeMetadata + 1 && status() === "Saved.");
    const autoOrder = writes.at(-1).options.frequencyOrder;
    const occurrence = await edit("dictionary", "Occurrence");
    const occurrenceHint = hint.textContent.startsWith("Occurrence-based:");
    await edit("dictionary", "Unknown mode");
    const unknown = storedOptions.frequencyOrder;
    const any = await edit("dictionary", "");
    const explicit = passive && manualKept && occurrenceHint && autoOrder === "ascending"
      && rank.frequencyDictionary === "Rank" && rank.frequencyOrder === "ascending"
      && occurrence.frequencyDictionary === "Occurrence" && occurrence.frequencyOrder === "descending"
      && unknown === "descending" && any.frequencyDictionary === "" && any.frequencyOrder === "auto";

    const chooser = field("dictionary");
    chooser.focus();
    chooser.value = "Rank";
    chooser.dispatchEvent(new window.Event("input", { bubbles: true }));
    const beforeUnavailableChoice = writes.length;
    emitDictionaries({ frequencyCount: 0 });
    chooser.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 180));
    const unavailableChoiceRefused = writes.length === beforeUnavailableChoice
      && chooser.value === "" && storedOptions.frequencyDictionary === "";
    chooser.blur();
    emitOptions({ frequencyDictionary: "Rank", frequencyOrder: "descending" });
    emitDictionaries({ frequencyCount: 0 });
    const manual = [...field("order").options].filter(({ value }) => ["ascending", "descending"].includes(value));
    const global = [...field("order").options].filter(({ value }) => ["auto", "disabled"].includes(value));
    const availability = unavailableChoiceRefused && auto.disabled
      && manual.every(({ disabled }) => disabled) && global.every(({ disabled }) => !disabled)
      && field("dictionary").value === "Rank" && field("order").value === "descending";
    emitDictionaries({ frequencyCount: 3 });
    const baseRevision = storedOptions.revision;
    const select = field("dictionary");
    select.focus();
    select.value = "Occurrence";
    select.dispatchEvent(new window.Event("input", { bubbles: true }));
    emitOptions({ frequencyDictionary: "Unknown mode", frequencyOrder: "ascending" });
    const nativeDraftKept = select.value === "Occurrence";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const conflict = writes.at(-1);
    select.blur();
    window.document.getElementById("options-use-saved").click();
    const draft = nativeDraftKept && conflict.baseRevision === baseRevision
      && conflict.options.frequencyDictionary === "Occurrence" && conflict.options.frequencyOrder === "descending"
      && field("dictionary").value === "Unknown mode" && field("order").value === "ascending";
    const summaryToggle = window.document.getElementById("opt-compact-summary");
    const snippets = window.document.getElementById("opt-summary-count");
    const preferred = window.document.getElementById("opt-summary-dictionary");
    if (!summaryToggle || !snippets || !preferred) return { explicit, availability, draft, writes, summary: false };
    const summaryDefault = !summaryToggle.checked && snippets.value === "3" && snippets.disabled
      && preferred.value === "" && preferred.disabled;
    async function editControl(control, value) {
      const before = writes.length;
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
      control.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => writes.length === before + 1 && status() === "Saved.");
    }
    await editControl(summaryToggle, true);
    await editControl(snippets, "6");
    await editControl(preferred, "Rank");
    const beforePresentation = writes.length;
    preferred.focus();
    const choice = preferred.selectedOptions[0];
    emitDictionaries({ enabled: false, displayName: "Dormant source" });
    const focusedChoice = preferred.selectedOptions[0] === choice && preferred.value === "Rank";
    preferred.blur();
    const disabledKept = preferred.value === "Rank" && preferred.selectedOptions[0].textContent.includes("Dormant source")
      && !preferred.selectedOptions[0].disabled && writes.length === beforePresentation;
    emitDictionaries({ termCount: 0, frequencyCount: 3 });
    const unavailableKept = preferred.value === "Rank" && preferred.selectedOptions[0].textContent.includes("unavailable")
      && !preferred.selectedOptions[0].disabled && writes.length === beforePresentation;
    await editControl(summaryToggle, false);
    const offKept = snippets.disabled && preferred.disabled && snippets.value === "6" && preferred.value === "Rank"
      && JSON.stringify(writes.at(-1).options) === JSON.stringify({ showCompactDefinitionSummary: false });
    await editControl(summaryToggle, true);
    preferred.focus();
    preferred.value = "Occurrence";
    preferred.dispatchEvent(new window.Event("input", { bubbles: true }));
    const summaryRevision = storedOptions.revision;
    emitOptions({ compactDefinitionSummaryDictionary: "Unknown mode", showCompactDefinitionSummary: false });
    const nativeSummaryDraft = preferred.value === "Occurrence" && !preferred.disabled;
    preferred.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const summaryConflict = writes.at(-1).baseRevision === summaryRevision
      && writes.at(-1).options.compactDefinitionSummaryDictionary === "Occurrence";
    preferred.blur();
    window.document.getElementById("options-use-saved").click();
    const disabledAfterBlur = preferred.disabled;
    await editControl(summaryToggle, true);
    snippets.focus();
    snippets.value = "4";
    snippets.dispatchEvent(new window.Event("input", { bubbles: true }));
    const countRevision = storedOptions.revision;
    emitOptions({ showCompactDefinitionSummary: false });
    const countDraft = snippets.value === "4" && !snippets.disabled;
    snippets.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const countConflict = writes.at(-1).baseRevision === countRevision && writes.at(-1).options.compactDefinitionSummaryCount === 4;
    snippets.blur();
    window.document.getElementById("options-use-saved").click();
    const summary = summaryDefault && focusedChoice && disabledKept && unavailableKept && offKept
      && nativeSummaryDraft && summaryConflict && disabledAfterBlur && countDraft && countConflict
      && snippets.disabled && preferred.value === "Unknown mode" && snippets.value === "6";
    let imageSources = false;
    if (imageSource) {
      const supplier = { kind: "dictionary", title: "Pictures:日本語" };
      const group = { kind: "tabGroup", id: "pictures:stable" };
      const emitImageState = (patch) => {
        state = { ...state, ...patch, revision: state.revision + 1 };
        listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
      };
      emitImageState({ dictionaries: [...state.dictionaries,
        genericPackage({ id: "pictures", title: supplier.title, termCount: 0, kanjiCount: 1, mediaCount: 2 }),
      ], groups: [{ id: group.id, name: "Picture group", dictionaryIds: ["pictures"] }] });
      await editControl(imageSource, JSON.stringify(supplier));
      const dictionarySaved = JSON.stringify(writes.at(-1).options) === JSON.stringify({ popupImageSource: supplier });
      const beforeNames = writes.length;
      imageSource.focus();
      const focusedOption = imageSource.selectedOptions[0];
      emitImageState({ dictionaries: state.dictionaries.map(dictionary => dictionary.id === "pictures"
        ? { ...dictionary, displayName: "Picture book", enabled: false } : dictionary),
        groups: [{ ...state.groups[0], name: "Renamed pictures" }],
      });
      const nativeImageDraft = imageSource.selectedOptions[0] === focusedOption
        && imageSource.value === JSON.stringify(supplier);
      imageSource.blur();
      const disabledImageKept = imageSource.value === JSON.stringify(supplier)
        && imageSource.selectedOptions[0].textContent.includes("Picture book")
        && imageSource.selectedOptions[0].textContent.includes("disabled") && writes.length === beforeNames;
      await editControl(imageSource, JSON.stringify(group));
      const groupSaved = JSON.stringify(writes.at(-1).options) === JSON.stringify({ popupImageSource: group })
        && imageSource.selectedOptions[0].textContent.includes("Renamed pictures");
      const beforeRemoval = writes.length;
      emitImageState({ dictionaries: state.dictionaries.filter(dictionary => dictionary.id !== "pictures"), groups: [] });
      const missingGroupKept = imageSource.value === JSON.stringify(group)
        && imageSource.selectedOptions[0].textContent.includes("unavailable") && writes.length === beforeRemoval;
      imageSource.focus();
      const desiredSource = { kind: "dictionary", title: "Rank" };
      imageSource.value = JSON.stringify(desiredSource);
      imageSource.dispatchEvent(new window.Event("input", { bubbles: true }));
      const imageRevision = storedOptions.revision;
      emitOptions({ popupImageSource: null, hoverEnabled: false });
      const imageDraftKept = imageSource.value === JSON.stringify(desiredSource) && !imageSource.disabled;
      imageSource.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => status().includes("Could not save"));
      const imageConflict = writes.at(-1).baseRevision === imageRevision
        && JSON.stringify(writes.at(-1).options.popupImageSource) === JSON.stringify(desiredSource);
      imageSource.blur();
      window.document.getElementById("options-use-saved").click();
      imageSources = imageSourceDefault && dictionarySaved && nativeImageDraft && disabledImageKept
        && groupSaved && missingGroupKept && imageDraftKept && imageConflict
        && imageSource.value === "" && !imageSource.disabled;
    }
    const metadataFields = [
      ["opt-lookup-counts", "showLookupCounts", true],
      ["opt-frequency-names", "showFrequencyDictionaryNames", false],
      ["opt-frequency-compact", "compactFrequencyNumbers", false],
      ["opt-average-frequency", "averageFrequency", false],
      ["opt-pitch-badge", "showPitchAccentBadge", true],
      ["opt-pitch-names", "showPitchAccentDictionaryNames", true],
      ["opt-pitch-text", "showPitchAccentText", true],
      ["opt-pitch-position", "showPitchAccentPosition", true],
      ["opt-pitch-graph", "showPitchAccentGraph", false],
      ["opt-pitch-furigana", "showPitchAccentFurigana", true],
      ["opt-pitch-colors", "showPitchAccentColors", false],
      ["opt-grammar-tags", "hidePopupGrammarTags", false],
    ];
    const pitch = window.document.getElementById("opt-pitch-dictionary");
    let metadata = Boolean(pitch) && metadataFields.every(([id, , checked]) =>
      window.document.getElementById(id)?.checked === checked);
    const metadataDetails = [];
    if (metadata) {
      for (const [id, key, checked] of metadataFields) {
        await editControl(window.document.getElementById(id), !checked);
        metadataDetails.push(JSON.stringify(writes.at(-1).options)
          === JSON.stringify({ [key]: key === "hidePopupGrammarTags" ? checked : !checked }));
      }
      metadataDetails.push(window.document.getElementById("opt-corpus-url") === null
        && window.document.getElementById("opt-lookup-counts").closest("section").id === "lookup"
        && window.document.getElementById("opt-blur-frequency").closest("section").id === "lookup");
      const blurControl = id => window.document.getElementById(id);
      const countBlur = blurControl("opt-blur-count");
      const ankiBlur = blurControl("opt-blur-anki");
      const frequencyBlur = blurControl("opt-blur-frequency");
      const frequencyDictionary = blurControl("opt-blur-frequency-dictionary");
      metadataDetails.push(!countBlur.checked && !ankiBlur.checked && !frequencyBlur.checked
        && ["definition-blur-count-controls", "definition-blur-anki-help",
          "definition-blur-frequency-controls", "definition-blur-reveal-controls"]
          .every(id => blurControl(id).hidden)
        && ["opt-blur-direction", "opt-blur-threshold", "opt-blur-frequency-dictionary",
          "opt-blur-frequency-order", "opt-blur-frequency-threshold", "opt-blur-reveal", "opt-blur-delay"]
        .every(id => blurControl(id).disabled)
        && blurControl("opt-blur-direction").value === "atLeast" && blurControl("opt-blur-threshold").value === "5"
        && blurControl("opt-blur-frequency-order").value === "auto"
        && blurControl("opt-blur-frequency-threshold").value === "10000"
        && blurControl("opt-blur-reveal").value === "timed" && blurControl("opt-blur-delay").value === "5");
      await editControl(ankiBlur, true);
      metadataDetails.push(JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurAnkiMature: true })
        && blurControl("definition-blur-count-controls").hidden && !blurControl("definition-blur-anki-help").hidden
        && blurControl("definition-blur-anki-help").textContent.includes("30 minutes")
        && blurControl("definition-blur-anki-help").textContent.includes("Anki is closed")
        && !blurControl("definition-blur-reveal-controls").hidden
        && !blurControl("opt-blur-reveal").disabled && !blurControl("opt-blur-delay").disabled);
      await editControl(countBlur, true);
      metadataDetails.push(JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurCountEnabled: true })
        && storedOptions.definitionBlurAnkiMature && !storedOptions.showLookupCounts
        && !blurControl("definition-blur-any-help").hidden
        && !blurControl("definition-blur-count-controls").hidden
        && !blurControl("definition-blur-count-paused").hidden && !blurControl("opt-blur-threshold").disabled);
      const beforeEnableCounts = writes.length;
      blurControl("definition-blur-count-paused").querySelector("label").click();
      await until(() => writes.length === beforeEnableCounts + 1 && status() === "Saved.");
      metadataDetails.push(JSON.stringify(writes.at(-1).options) === JSON.stringify({ showLookupCounts: true })
        && blurControl("definition-blur-count-paused").hidden);
      await editControl(frequencyBlur, true);
      metadataDetails.push(JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurFrequencyEnabled: true })
        && !blurControl("definition-blur-frequency-controls").hidden && !frequencyDictionary.disabled
        // Same as sorting follows this page's sort dictionary, which declares no mode.
        && frequencyDictionary.value === "" && frequencyDictionary.options[0].textContent === "Same as sorting (Unknown mode)"
        && blurControl("definition-blur-frequency-help").textContent.includes("Using undeclared metadata")
        && !blurControl("definition-blur-any-help").hidden);
      await editControl(frequencyDictionary, "Occurrence");
      metadataDetails.push(JSON.stringify(writes.at(-1).options)
        === JSON.stringify({ definitionBlurFrequencyDictionary: "Occurrence" })
        && blurControl("definition-blur-frequency-help").textContent.includes("occurrence-based metadata")
        && blurControl("definition-blur-frequency-help").textContent.includes("at or above"));
      const beforeUnavailable = writes.length;
      emitDictionaries({ enabled: false, displayName: "Dormant occurrence" }, "Occurrence");
      metadataDetails.push(frequencyDictionary.value === "Occurrence"
        && frequencyDictionary.selectedOptions[0].textContent.includes("disabled")
        && blurControl("definition-blur-frequency-help").textContent.includes("fails open")
        && writes.length === beforeUnavailable);
      emitDictionaries({ enabled: true }, "Occurrence");
      metadataDetails.push(frequencyDictionary.value === "Occurrence"
        && !frequencyDictionary.selectedOptions[0].textContent.includes("disabled")
        && blurControl("definition-blur-frequency-help").textContent.includes("occurrence-based metadata")
        && writes.length === beforeUnavailable);
      await editControl(ankiBlur, false);
      await editControl(frequencyBlur, false);
      for (const { control, group, draft, external, key, saved, restore } of [
        { control: "opt-blur-threshold", group: "definition-blur-count-controls", draft: "7",
          external: { definitionBlurCountEnabled: false }, key: "definitionBlurThreshold", saved: 7, restore: ["opt-blur-count", true] },
        { control: "opt-blur-reveal", group: "definition-blur-reveal-controls", draft: "hover",
          external: { definitionBlurCountEnabled: false }, key: "definitionBlurReveal", saved: "hover", restore: ["opt-blur-count", true] },
        { control: "opt-blur-delay", group: "definition-blur-delay-control", draft: "2.5",
          external: { definitionBlurReveal: "hover" }, key: "definitionBlurDelayMs", saved: 2500, restore: ["opt-blur-reveal", "timed"] },
      ]) {
        const focusedControl = blurControl(control);
        focusedControl.focus();
        focusedControl.value = draft;
        focusedControl.dispatchEvent(new window.Event("input", { bubbles: true }));
        const focusedRevision = storedOptions.revision;
        emitOptions(external);
        metadataDetails.push(!blurControl(group).hidden && !focusedControl.disabled && focusedControl.value === draft);
        focusedControl.dispatchEvent(new window.Event("change", { bubbles: true }));
        await until(() => status().includes("Could not save"));
        metadataDetails.push(writes.at(-1).baseRevision === focusedRevision && writes.at(-1).options[key] === saved);
        focusedControl.blur();
        window.document.getElementById("options-use-saved").click();
        metadataDetails.push(blurControl(group).hidden && focusedControl.disabled);
        await editControl(blurControl(restore[0]), restore[1]);
      }
      await editControl(countBlur, false);
      await editControl(frequencyBlur, true);
      const focusedFrequencyThreshold = blurControl("opt-blur-frequency-threshold");
      focusedFrequencyThreshold.focus();
      focusedFrequencyThreshold.value = "12000";
      focusedFrequencyThreshold.dispatchEvent(new window.Event("input", { bubbles: true }));
      const frequencyRevision = storedOptions.revision;
      emitOptions({ definitionBlurFrequencyEnabled: false });
      metadataDetails.push(!blurControl("definition-blur-frequency-controls").hidden
        && !focusedFrequencyThreshold.disabled && focusedFrequencyThreshold.value === "12000");
      focusedFrequencyThreshold.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => status().includes("Could not save"));
      metadataDetails.push(writes.at(-1).baseRevision === frequencyRevision
        && writes.at(-1).options.definitionBlurFrequencyThreshold === 12000);
      focusedFrequencyThreshold.blur();
      window.document.getElementById("options-use-saved").click();
      metadataDetails.push(blurControl("definition-blur-frequency-controls").hidden
        && focusedFrequencyThreshold.disabled && frequencyDictionary.value === "Occurrence");
      await editControl(frequencyBlur, true);
      await editControl(blurControl("opt-blur-frequency-order"), "ascending");
      metadataDetails.push(JSON.stringify(writes.at(-1).options)
        === JSON.stringify({ definitionBlurFrequencyOrder: "ascending" })
        && blurControl("definition-blur-frequency-help").textContent.includes("at or below"));
      await editControl(focusedFrequencyThreshold, "0");
      metadataDetails.push(focusedFrequencyThreshold.value === "1"
        && JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurFrequencyThreshold: 1 }));
      await editControl(countBlur, true);
      metadataDetails.push(!blurControl("opt-blur-direction").disabled && !blurControl("opt-blur-delay").disabled);
      await editControl(blurControl("opt-blur-direction"), "below");
      metadataDetails.push(JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurDirection: "below" }));
      await editControl(blurControl("opt-blur-threshold"), "0");
      metadataDetails.push(blurControl("opt-blur-threshold").value === "1"
        && JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurThreshold: 1 }));
      await editControl(blurControl("opt-blur-delay"), "2.5");
      metadataDetails.push(blurControl("opt-blur-delay").value === "2.5"
        && JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurDelayMs: 2500 }));
      await editControl(blurControl("opt-blur-reveal"), "hover");
      metadataDetails.push(blurControl("opt-blur-delay").disabled
        && blurControl("definition-blur-delay-control").hidden
        && JSON.stringify(writes.at(-1).options) === JSON.stringify({ definitionBlurReveal: "hover" }));
      // The toggles above leave the contour off and colours on: the dictionary
      // still picks the headword's colour, so it stays editable until both are off.
      metadataDetails.push(!pitch.disabled);
      await editControl(window.document.getElementById("opt-pitch-colors"), false);
      metadataDetails.push(pitch.disabled);
      const furigana = window.document.getElementById("opt-pitch-furigana");
      const furiganaStyle = window.document.getElementById("opt-pitch-furigana-style");
      metadataDetails.push(furiganaStyle.disabled && furiganaStyle.value === "contour");
      await editControl(furigana, true);
      await editControl(furiganaStyle, "overline");
      metadataDetails.push(!furiganaStyle.disabled
        && JSON.stringify(writes.at(-1).options) === JSON.stringify({ pitchAccentFuriganaStyle: "overline" }));
      furiganaStyle.focus();
      emitOptions({ pitchAccentFuriganaStyle: "contour", showPitchAccentFurigana: false });
      metadataDetails.push(furiganaStyle.value === "overline" && !furiganaStyle.disabled);
      furiganaStyle.blur();
      metadataDetails.push(furiganaStyle.value === "contour" && furiganaStyle.disabled);
      await editControl(furigana, true);
      emitDictionaries({ pitchCount: 2 });
      await editControl(pitch, "Rank");
      metadataDetails.push(writes.at(-1).options.pitchAccentFuriganaDictionary === "Rank");
      pitch.focus();
      const focused = pitch.selectedOptions[0];
      emitDictionaries({ enabled: false, displayName: "Pitch source" });
      metadataDetails.push(pitch.selectedOptions[0] === focused);
      pitch.blur();
      metadataDetails.push(pitch.value === "Rank" && pitch.selectedOptions[0].textContent.includes("Pitch source (disabled)"));
      pitch.focus();
      pitch.value = "";
      pitch.dispatchEvent(new window.Event("input", { bubbles: true }));
      const revision = storedOptions.revision;
      emitOptions({ pitchAccentFuriganaDictionary: "Missing pitch", showPitchAccentFurigana: false });
      metadataDetails.push(!pitch.disabled && pitch.value === "");
      pitch.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => status().includes("Could not save"));
      metadataDetails.push(writes.at(-1).baseRevision === revision
        && writes.at(-1).options.pitchAccentFuriganaDictionary === "");
      pitch.blur();
      window.document.getElementById("options-use-saved").click();
      metadataDetails.push(pitch.disabled && pitch.value === "Missing pitch"
        && pitch.selectedOptions[0].textContent.includes("unavailable"));
      metadata = metadataDetails.every(Boolean);
    }
    const theme = window.document.getElementById("opt-popup-theme");
    window.location.hash = "#design";
    await until(() => theme.options.length === 43);
    let settingsTheme = window.document.documentElement.dataset.hoshidictsTheme === "default";
    const toolbarSelect = window.document.getElementById("opt-popup-toolbar");
    await editControl(toolbarSelect, "bottom");
    let toolbar = JSON.stringify(writes.at(-1).options) === JSON.stringify({ popupToolbarPosition: "bottom" });
    emitOptions({ popupToolbarPosition: "top" });
    toolbar &&= toolbarSelect.value === "top";
    toolbarSelect.focus();
    toolbarSelect.value = "bottom";
    toolbarSelect.dispatchEvent(new window.Event("input", { bubbles: true }));
    const toolbarRevision = storedOptions.revision;
    emitOptions({ popupToolbarPosition: "auto" });
    toolbar &&= toolbarSelect.value === "bottom";
    toolbarSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    toolbar &&= writes.at(-1).baseRevision === toolbarRevision && writes.at(-1).options.popupToolbarPosition === "bottom";
    toolbarSelect.blur();
    window.document.getElementById("options-use-saved").click();
    toolbar &&= toolbarSelect.value === "auto";
    emitOptions({ popupToolbarPosition: "bottom" });
    theme.focus();
    const previousTheme = theme.value;
    emitOptions({ popupTheme: "miku", popupWidthPx: 900, popupHeightPx: 700, popupOpacityPercent: 0,
      sourceHighlightEnabled: false, popupColumns: 4, scanLength: 24, frequencyOrder: "disabled",
      kanjiClickDictionary: { title: "Rank", kind: "term" }, pitchAccentFuriganaStyle: "overline" });
    const focusedThemeKept = theme.value === previousTheme;
    settingsTheme &&= window.document.documentElement.dataset.hoshidictsTheme === "miku";
    theme.blur();
    const themeRefreshed = focusedThemeKept && theme.value === "miku";
    const beforeReset = { ...storedOptions };
    const beforeResetCount = writes.length;
    window.document.getElementById("reset-design").click();
    await until(() => writes.length === beforeResetCount + 1 && status() === "Saved.");
    const { DESIGN_OPTION_KEYS, DEFAULT_OPTIONS } = window.HDReaderOptions;
    const designReset = themeRefreshed && DESIGN_OPTION_KEYS.every(key => JSON.stringify(storedOptions[key] ?? DEFAULT_OPTIONS[key])
        === JSON.stringify(DEFAULT_OPTIONS[key]))
      && Object.keys(beforeReset).filter(key => key !== "revision" && !DESIGN_OPTION_KEYS.includes(key))
        .every(key => JSON.stringify(storedOptions[key]) === JSON.stringify(beforeReset[key]))
      && Object.keys(writes.at(-1).options).every(key => DESIGN_OPTION_KEYS.includes(key));
    settingsTheme &&= window.document.documentElement.dataset.hoshidictsTheme === "default";
    toolbar &&= toolbarSelect.value === "auto";
    let css = false;
    const editor = window.document.getElementById("opt-custom-popup-css");
    if (editor) {
      editor.focus();
      const inputCss = value => {
        editor.value = value;
        editor.dispatchEvent(new window.Event("input", { bubbles: true }));
      };
      const text = "/* 日本語 */\n.gsm-hoshidicts-popup { color: red; }";
      inputCss(text);
      editor.setSelectionRange(4, 7);
      const revision = storedOptions.revision;
      emitOptions({ popupTheme: "light" });
      css = editor.value === text && editor.selectionStart === 4 && editor.selectionEnd === 7
        && window.document.getElementById("custom-css-count").textContent === `${text.length} characters`;
      settingsTheme &&= window.document.documentElement.dataset.hoshidictsTheme === "light";
      await until(() => status().includes("Could not save"));
      css &&= writes.at(-1).baseRevision === revision && writes.at(-1).options.customPopupCss === text;
      editor.blur();
      window.document.getElementById("options-use-saved").click();
      css &&= editor.value === "";
      editor.focus();
      inputCss(text);
      await until(() => status() === "Saved.");
      css &&= storedOptions.customPopupCss === text && editor.value === text;
      editor.blur();
      window.document.getElementById("reset-custom-css").click();
      await until(() => status() === "Saved.");
      css &&= editor.value === "" && storedOptions.customPopupCss === "" && storedOptions.popupTheme === "light"
        && Object.keys(writes.at(-1).options).join() === "customPopupCss";
    }
    window.location.hash = "#audio";
    const audioRows = () => [...window.document.querySelectorAll(".audio-source-row")];
    await until(() => audioRows().length === 1);
    let audio = audioRows()[0].querySelector(".audio-type").value === "text-to-speech-reading"
      && audioRows()[0].querySelector(".audio-enabled").checked;
    window.document.getElementById("audio-source-add").click();
    const url = audioRows()[1].querySelector(".audio-url");
    const urlText = "http://localhost:5050/?term={term}&reading={reading}";
    url.value = urlText;
    url.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => status() === "Saved.");
    audio &&= storedOptions.audioSources[1].url === urlText && window.document.activeElement === url;
    url.blur();
    audioRows()[1].querySelector(".audio-up").click();
    await until(() => status() === "Saved.");
    const enabled = audioRows()[0].querySelector(".audio-enabled");
    enabled.checked = false;
    enabled.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status() === "Saved.");
    audio &&= storedOptions.audioSources[0].url === urlText && !storedOptions.audioSources[0].enabled
      && storedOptions.audioSources[1].type === "text-to-speech-reading";
    const audioObserver = new window.MutationObserver(() => {});
    audioObserver.observe(window.document.getElementById("audio-source-list"), {
      attributes: true, childList: true, characterData: true, subtree: true,
    });
    emitOptions({ popupTheme: "dark" });
    audio &&= audioObserver.takeRecords().length === 0;
    audioObserver.disconnect();
    url.focus();
    url.value += "&draft=1";
    url.dispatchEvent(new window.Event("input", { bubbles: true }));
    const audioRevision = storedOptions.revision;
    emitOptions({ popupTheme: "dark" });
    await until(() => status().includes("Could not save"));
    audio &&= writes.at(-1).baseRevision === audioRevision && url.value.endsWith("&draft=1");
    url.blur();
    window.document.getElementById("options-use-saved").click();
    audio &&= url.value === urlText;
    while (audioRows().length) audioRows()[0].querySelector(".audio-remove").click();
    await until(() => status() === "Saved.");
    emitOptions({ popupTheme: "light" });
    audio &&= storedOptions.audioSources.length === 0 && audioRows().length === 0
      && !window.document.getElementById("audio-source-empty").hidden;
    settingsTheme &&= window.document.documentElement.dataset.hoshidictsTheme === "light";
    return { explicit, availability, draft, writes, summary, imageSources, metadata, metadataDetails,
      designReset, settingsTheme, toolbar, css, audio,
      summaryDetails: { summaryDefault, focusedChoice, disabledKept, unavailableKept, offKept, nativeSummaryDraft,
        summaryConflict, disabledAfterBlur, countDraft, countConflict } };
  } finally {
    window.close();
  }
}

async function settingsAutosaveStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
  });
  const { window } = dom;
  let listener;
  let storedOptions = { revision: 2, scanLength: 16, maxResults: 32, frequencyOrder: "auto" };
  let releaseInitialState;
  const writes = [];
  const pending = [];
  window.chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          await new Promise((release) => { releaseInitialState = release; });
          return { ok: true, state: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] } };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          writes.push(structuredClone(message));
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        }
        throw new Error(`unexpected autosave request ${message.type}`);
      },
    },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await wait(5);
    if (!predicate()) throw new Error("Settings autosave did not reach its expected state");
  }
  const field = (name) => window.document.getElementById(`opt-${name}`);
  const state = () => ({ maxResults: field("max-results").value, frequencyOrder: field("frequency-order").value });
  const edit = (name, value) => {
    field(name).value = value;
    field(name).dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const emit = (value) => listener({ options: { newValue: structuredClone(value) } }, "local");
  const commit = (value) => { storedOptions = value; emit(value); };
  const status = () => window.document.getElementById("options-status").textContent;
  try {
    loadSettingsScript(window);
    await until(() => typeof releaseInitialState === "function");
    field("max-results").focus();
    field("max-results").value = "64";
    field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    releaseInitialState();
    await until(() => window.document.getElementById("engine-status").textContent.startsWith("Ready"));
    commit({ ...storedOptions, revision: 3, maxResults: 16 });
    field("max-results").dispatchEvent(new window.Event("change", { bubbles: true }));
    field("max-results").blur();
    await until(() => writes.length === 1);
    const startupRequest = writes[0];
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    window.document.getElementById("options-use-saved").click();
    field("max-results").focus();
    for (const value of ["64", "16"]) {
      field("max-results").value = value;
      field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    field("max-results").blur();
    const leave = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    const undoCanLeave = !leave.defaultPrevented;
    commit({ ...storedOptions, revision: 4, maxResults: 32 });
    writes.length = 0;
    edit("scan-length", "25");
    edit("max-results", "64");
    const result = { writesBeforeDelay: writes.length, startupRequest, undoCanLeave };
    await until(() => writes.length === 1);
    result.firstRequest = writes[0];
    edit("max-results", "96");
    await wait(180);
    result.writesDuringSave = writes.length;
    const firstCommit = { revision: 5, scanLength: 25, maxResults: 64, frequencyOrder: "auto" };
    commit(firstCommit);
    commit({ ...firstCommit, revision: 6, frequencyOrder: "descending" });
    pending.shift().resolve({ ok: true, options: firstCommit });
    await until(() => writes.length === 2);
    result.secondRequest = writes[1];
    result.afterOldReply = state();
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    await wait(0);
    result.conflictVisible = !window.document.getElementById("options-conflict-actions").hidden;
    window.document.getElementById("options-use-saved").click();
    result.afterDiscard = state();
    edit("max-results", "80");
    await until(() => writes.length === 3);
    const thirdCommit = { ...storedOptions, revision: 7, maxResults: 80 };
    storedOptions = thirdCommit;
    pending.shift().resolve({ ok: true, options: thirdCommit });
    await until(() => status() === "Saved.");
    emit({ ...firstCommit, revision: 6 });
    emit(thirdCommit);
    result.afterStaleEvent = state();
    edit("max-results", "90");
    await until(() => writes.length === 4);
    pending.shift().reject(new Error("worker reply was lost"));
    await until(() => status().includes("Could not save"));
    await wait(0);
    result.failedDraft = field("max-results").value;
    window.document.getElementById("options-retry").click();
    await until(() => writes.length === 5);
    result.retryRequest = writes[4];
    commit({ ...storedOptions, revision: 8, maxResults: 90 });
    pending.shift().resolve({ ok: true, options: storedOptions });
    await until(() => status() === "Saved.");
    result.finalValue = field("max-results").value;
    result.finalStatus = status();
    field("max-results").focus();
    field("max-results").value = "128";
    field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    commit({ ...storedOptions, revision: 9, maxResults: 24 });
    field("max-results").dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => writes.length === 6);
    result.typedBeforeExternalRequest = writes[5];
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    return result;
  } finally {
    dom.window.close();
  }
}

describe("Settings", () => {
  test("Settings navigation", async () => {
    const navigationSettings = await settingsNavigationStage();
    check("Settings navigation loads personal source on first visit and preserves mounted drafts",
      navigationSettings?.navigation === true && navigationSettings.draft === true,
      JSON.stringify(navigationSettings));
    check("dictionary details retain their stable identity and focus across rerenders and filtering",
      navigationSettings?.details === true, JSON.stringify(navigationSettings));
    check("Design lazily previews unsaved presentation edits and retains the shared save feedback across sections",
      navigationSettings?.design === true, JSON.stringify(navigationSettings));
    check("Settings shows Resume setup only while the first-run setup record is incomplete",
      navigationSettings?.resume === true, JSON.stringify(navigationSettings));
    check("Unlink refreshes retained automatic backups and a concurrent storage change cannot be erased by a stale list",
      navigationSettings?.automaticRefresh === true, JSON.stringify(navigationSettings));
  });

  test("Settings reader controls", async () => {
    const frequencySettings = await settingsFrequencyStage();
    check("Audio Settings start with reading TTS, add ordered custom URLs and retain revision-bound drafts and explicit removal",
      frequencySettings?.audio === true, JSON.stringify(frequencySettings?.audio));
    check("the CSS editor counts unsaved text, preserves revision-bound drafts and resets only custom CSS",
      frequencySettings?.css === true, JSON.stringify(frequencySettings?.css));
    check("Settings toolbar choices save sparsely, retain focused drafts and refresh on storage events and reset",
      frequencySettings?.toolbar === true, JSON.stringify(frequencySettings));
    check("Settings applies the selected popup theme live across local edits and storage events",
      frequencySettings?.settingsTheme === true, JSON.stringify(frequencySettings));
    check("Design resets only its shared appearance and content keys through one sparse options write",
      frequencySettings?.designReset === true, JSON.stringify(frequencySettings));
    check("Settings derives frequency direction only on dictionary selection or explicit Auto",
      frequencySettings?.explicit === true, JSON.stringify(frequencySettings));
    check("frequency controls preserve unavailable selections and revision-bound native drafts",
      frequencySettings?.availability === true && frequencySettings.draft === true,
      JSON.stringify(frequencySettings));
    check("compact-summary Settings preserve count, soft canonical source and focused revision-bound drafts",
      frequencySettings?.summary === true, JSON.stringify(frequencySettings));
    check("image-source Settings preserve canonical dictionary and group choices through availability changes and focused conflicts",
      frequencySettings?.imageSources === true, JSON.stringify(frequencySettings));
    check("metadata Settings save independent fields and preserve a focused preferred-pitch draft",
      frequencySettings?.metadata === true, JSON.stringify(frequencySettings?.metadataDetails));
  });

  test("Settings autosave", async () => {
    const autosave = await settingsAutosaveStage();
    check(
      "Settings coalesces edited fields and queues only one revisioned save at a time",
      autosave?.writesBeforeDelay === 0 && autosave.writesDuringSave === 1
        && autosave.firstRequest?.baseRevision === 4
        && JSON.stringify(autosave.firstRequest?.options) === JSON.stringify({ scanLength: 25, maxResults: 64 })
        && autosave.secondRequest?.baseRevision === 5
        && JSON.stringify(autosave.secondRequest?.options) === JSON.stringify({ maxResults: 96 }),
      JSON.stringify(autosave),
    );
    check(
      "Settings keeps newer committed state and local drafts across old replies and explicit conflicts",
      autosave?.afterOldReply?.maxResults === "96"
        && autosave.afterOldReply.frequencyOrder === "descending"
        && autosave.conflictVisible === true
        && autosave.afterDiscard?.maxResults === "64"
        && autosave.afterDiscard.frequencyOrder === "descending"
        && autosave.afterStaleEvent?.maxResults === "80"
        && autosave.afterStaleEvent.frequencyOrder === "descending",
      JSON.stringify(autosave),
    );
    check(
      "Settings retains failed drafts and retries against the current committed revision",
      autosave?.failedDraft === "90"
        && autosave.retryRequest?.baseRevision === 7
        && autosave.retryRequest?.options?.maxResults === 90
        && autosave.finalValue === "90" && autosave.finalStatus === "Saved."
        && autosave.typedBeforeExternalRequest?.baseRevision === 8
        && autosave.startupRequest?.baseRevision === 2 && autosave.undoCanLeave === true,
      JSON.stringify(autosave),
    );
  });
});
