/*
 * Settings page: dictionary import, load order, and lookup options.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import {
  createDictionaryGroupController,
  normaliseDictionaryGroups,
} from "./dictionary-groups.js";
import {
  managedDictionarySource,
  managedUpdateSchedule,
} from "./managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const UPDATE_TARGET = "hachidori-updates";
const {
  DEFAULT_OPTIONS, LOOKUP_MODES, ACTIVATION_KEYS, FREQUENCY_ORDERS,
  clampOption, normaliseKanjiSelection, normaliseOptions,
} = globalThis.HDReaderOptions;
const STATUS_POLL_MS = 1000;
// Slower than the boot poll: a failing poll may be failing for a while, and the
// settings page can be left open.
const STATUS_RETRY_MS = 5000;

const NUMBER_FIELDS = [
  { key: "scanLength", id: "opt-scan-length" },
  { key: "maxResults", id: "opt-max-results" },
  { key: "hoverDelayMs", id: "opt-hover-delay" },
  { key: "popupHideDelayMs", id: "opt-hide-delay" },
  { key: "popupNestingMaxDepth", id: "opt-popup-nesting-depth" },
  { key: "popupColumns", id: "opt-popup-columns" },
  { key: "compactDefinitionSummaryCount", id: "opt-summary-count" },
];
const METADATA_FIELDS = [
  { key: "showFrequencyDictionaryNames", id: "opt-frequency-names" },
  { key: "averageFrequency", id: "opt-average-frequency" },
  { key: "showPitchAccentFurigana", id: "opt-pitch-furigana" },
  { key: "showPitchAccentBadge", id: "opt-pitch-badge" },
  { key: "hidePopupGrammarTags", id: "opt-grammar-tags", inverted: true },
];

const numberFormat = new Intl.NumberFormat();

let dictionaryState = { schemaVersion: 1, revision: -1, dictionaries: [], groups: [] };
let dictionaries = dictionaryState.dictionaries;
let options = { ...DEFAULT_OPTIONS };
let savedOptions = { ...DEFAULT_OPTIONS };
let optionsRevision = -1;
let pendingOptions = {};
let pendingOptionsRevision = 0;
let savingOptions = null;
let optionsTimer = null;
let optionsSaveFailed = false;
let optionsEditRevision = null;
const OPTIONS_SAVE_DELAY_MS = 150;
let updateSettings = { schedule: "off", lastCheckedAt: null };
let customDocument = null;
let customBaseDocument = null;
let customBaseEditorText = "";
let customValidationTimer = null;
let customEditorLoaded = false;
let customLoading = false;
let customSaving = false;
let customDraftStale = false;
let customDraftNewline = "\n";
let importing = false;
let updating = false;
let removing = false;
let committing = false;
let pendingDictionaryCommits = 0;
let dictionaryCommitTail = Promise.resolve();
let dictionaryCommitFailed = false;
let dictionaryRenderDeferred = false;
let pendingManagementFocus = null;
let managementPointerDown = false;
let dictionarySearch = "";
const selectedDictionaryIds = new Set();
const expandedDictionaryIds = new Set();
let draggedDictionaryId = null;
let statusTimer = null;
let requestCounter = 0;

const SECTION_STATUSES = {
  "import-state": { section: "add-dictionaries", label: "Import" },
  "update-state": { section: "updates", label: "Updates" },
  "custom-dictionary-status": { section: "custom-dictionary", label: "Personal dictionary" },
  "options-status": { section: "lookup", label: "Reading" },
  "dict-group-error": { section: "dictionary-groups", label: "Groups" },
};
let activeSection = "dictionaries";
const unseenSectionCompletions = new Set();

function element(id) {
  return document.getElementById(id);
}

function sectionHasPendingWork(id) {
  switch (id) {
    case "import-state": return importing;
    case "update-state": return updating;
    case "custom-dictionary-status": return customLoading || customSaving || customDictionaryDirty();
    case "options-status": return savingOptions !== null || Object.keys(pendingOptions).length > 0;
    default: return false;
  }
}

function syncNavigationStatus(id) {
  const { section, label } = SECTION_STATUSES[id];
  const source = element(id);
  const notice = element(`nav-status-${section}`);
  if (section === activeSection) unseenSectionCompletions.delete(id);
  const attention = source.classList.contains("is-error") || unseenSectionCompletions.has(id) || sectionHasPendingWork(id);
  const message = section !== activeSection && attention && source.textContent
    ? `${label}: ${source.textContent}` : "";
  if (notice.textContent !== message) notice.textContent = message;
  notice.classList.toggle("is-error", source.classList.contains("is-error"));
  notice.classList.toggle("is-ready", source.classList.contains("is-ready"));
}

function setSectionStatus(id, message, tone, completed = false) {
  const output = element(id);
  output.textContent = message;
  output.classList.toggle("is-error", tone === "error");
  output.classList.toggle("is-ready", tone === "ready");
  if (completed && SECTION_STATUSES[id].section !== activeSection) unseenSectionCompletions.add(id);
  syncNavigationStatus(id);
}

function showSettingsSection(focus = false) {
  const fragment = window.location.hash.slice(1);
  const requested = fragment === "settings-content" ? activeSection : fragment;
  const sections = [...document.querySelectorAll("main > section")];
  activeSection = sections.some((section) => section.id === requested) ? requested : "dictionaries";
  pendingManagementFocus = null;
  for (const section of sections) section.hidden = section.id !== activeSection;
  for (const link of document.querySelectorAll(".settings-nav a")) {
    if (link.hash === `#${activeSection}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const id of Object.keys(SECTION_STATUSES)) syncNavigationStatus(id);
  if (fragment === "settings-content") element("settings-content").focus();
  else if (focus) element(activeSection).querySelector("h1").focus();
}

function attachSettingsNavigation() {
  window.addEventListener("hashchange", () => showSettingsSection(true));
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    element("settings-content").focus();
  });
  for (const link of document.querySelectorAll(".settings-nav a, .section-action")) {
    link.addEventListener("click", (event) => {
      if (link.hash === window.location.hash
          && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        // The native same-fragment action would move focus back to the section
        // after our heading focus. Modified clicks retain their browser action.
        event.preventDefault();
        showSettingsSection(true);
      }
    });
  }
  showSettingsSection();
}

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function send(type, fields = {}, target = TARGET) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target,
    type,
    requestId: `${type.replace(/^hd_/, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) {
    throw new Error("the extension's service worker did not reply");
  }
  return reply;
}

function nonnegativeCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nonemptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function displayName(value) {
  const name = stringValue(value).trim();
  return name === "" ? null : name;
}

function normaliseDictionary(row) {
  const title = stringValue(row?.title);
  if (title === "") {
    return null;
  }
  const sourceId = nonemptyString(row?.sourceId);
  return {
    id: stringValue(row?.id),
    title,
    displayName: displayName(row?.displayName),
    path: nonemptyString(row?.path) ?? `/dicts/${title}`,
    enabled: row?.enabled !== false,
    favorite: row?.favorite === true,
    revision: stringValue(row?.revision),
    isUpdatable: row?.isUpdatable === true,
    indexUrl: nonemptyString(row?.indexUrl),
    downloadUrl: nonemptyString(row?.downloadUrl),
    language: nonemptyString(row?.language),
    frequencyMode: nonemptyString(row?.frequencyMode),
    termCount: nonnegativeCount(row?.termCount),
    frequencyCount: nonnegativeCount(row?.frequencyCount),
    pitchCount: nonnegativeCount(row?.pitchCount),
    kanjiCount: nonnegativeCount(row?.kanjiCount),
    mediaCount: nonnegativeCount(row?.mediaCount),
    installedAt: stringValue(row?.installedAt),
    lastUpdateCheck: row?.lastUpdateCheck ?? null,
    ...(sourceId === null ? {} : { sourceId }),
  };
}

function normaliseDictionaries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normaliseDictionary).filter((entry) => entry !== null);
}

function normaliseDictionaryState(value) {
  if (value?.schemaVersion !== 1) {
    throw new Error(`Unsupported dictionary state schema ${String(value?.schemaVersion)}`);
  }
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  const dictionaries = normaliseDictionaries(value?.dictionaries);
  return {
    schemaVersion: 1,
    revision,
    dictionaries,
    groups: normaliseDictionaryGroups(value?.groups, dictionaries),
  };
}

function normaliseUpdateSettings(value) {
  return {
    schedule: managedUpdateSchedule(value?.schedule) ?? "off",
    lastCheckedAt: typeof value?.lastCheckedAt === "string" ? value.lastCheckedAt : null,
  };
}

function adoptDictionaryState(value) {
  const next = normaliseDictionaryState(value);
  if (next.revision <= dictionaryState.revision) {
    return false;
  }
  dictionaryState = next;
  dictionaries = dictionaryState.dictionaries;
  pruneDictionarySelection();
  return true;
}

function pruneDictionarySelection() {
  const installedIds = new Set(dictionaries.map((dictionary) => dictionary.id));
  for (const id of selectedDictionaryIds) {
    if (!installedIds.has(id)) {
      selectedDictionaryIds.delete(id);
    }
  }
}

function normaliseDictionarySearch(value) {
  return stringValue(value).normalize("NFKC").trim().toLowerCase();
}

function visibleDictionaries() {
  const search = normaliseDictionarySearch(dictionarySearch);
  if (search === "") {
    return dictionaries;
  }
  return dictionaries.filter((dictionary) =>
    [dictionary.title, dictionary.displayName].some((name) =>
      normaliseDictionarySearch(name).includes(search)));
}

function hasCapability(dictionary, kind) {
  if (kind === "freq") return dictionary.frequencyCount > 0;
  if (kind === "pitch") return dictionary.pitchCount > 0;
  if (kind === "kanji") return dictionary.kanjiCount > 0;
  if (dictionary.termCount > 0) return true;
  return dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0;
}

function dictionaryLabel(dictionary) {
  return dictionary.displayName || dictionary.title;
}

function isManagedCustomDictionary(dictionary) {
  return dictionary?.id === CUSTOM_DICTIONARY_ID;
}

function selectionParts(value) {
  if (value && typeof value === "object") {
    return value;
  }
  return typeof value === "string" && value !== ""
    ? { title: value, kind: "" }
    : null;
}

function selectionValue(selection) {
  return selection ? JSON.stringify(selection) : "";
}

function selectionFromValue(value) {
  if (!value) {
    return "";
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return normaliseKanjiSelection(parsed);
    }
  } catch {
    // Legacy title-only values are not JSON.
  }
  return normaliseKanjiSelection(value);
}

function isAvailableFrequencyDictionary(dictionary) {
  return dictionary.enabled !== false && hasCapability(dictionary, "freq");
}

function selectedFrequencyDictionary(title = options.frequencyDictionary) {
  return dictionaries.find((dictionary) => dictionary.title === title
    && isAvailableFrequencyDictionary(dictionary));
}

function normaliseDictionarySelections() {
  let changed = false;
  const kanjiSelection = selectionParts(options.kanjiClickDictionary);
  if (kanjiSelection) {
    const selected = dictionaries.find((entry) => entry.title === kanjiSelection.title);
    const requestedKind = kanjiSelection.kind || (selected && hasCapability(selected, "kanji") ? "kanji" : "term");
    if (!selected || selected.enabled === false || !hasCapability(selected, requestedKind)) {
      options.kanjiClickDictionary = "";
      changed = true;
    } else if (kanjiSelection.kind === "") {
      options.kanjiClickDictionary = { title: kanjiSelection.title, kind: requestedKind };
      changed = true;
    }
  }
  return changed;
}

function setStatus(message, tone) {
  const status = element("engine-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-ready", tone === "ready");
}

function setImportState(message, tone) {
  setSectionStatus("import-state", message, tone, tone === "ready");
  element("import-progress").hidden = tone !== "busy";
}

function setUpdateState(message, tone = "") {
  setSectionStatus("update-state", message, tone, tone === "ready");
}

function setCustomDictionaryStatus(message, tone = "", completed = false) {
  setSectionStatus("custom-dictionary-status", message, tone, completed);
}

function renderCustomDictionaryErrors(errors) {
  const list = element("custom-dictionary-errors");
  const messages = (Array.isArray(errors) ? errors : []).map((error) =>
    `Line ${String(error?.lineNumber)}: ${stringValue(error?.reason, "invalid entry")}`);
  if (list.childElementCount === messages.length
      && messages.every((message, index) => list.children[index].textContent === message)) {
    return;
  }
  const items = document.createDocumentFragment();
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    items.appendChild(item);
  }
  list.replaceChildren(items);
  list.hidden = list.childElementCount === 0;
}

function customDictionaryDirty() {
  return customEditorLoaded
    && customBaseDocument !== null
    && element("custom-dictionary-source").value !== customBaseEditorText;
}

function customDictionaryDraftSource() {
  // Textareas expose LF-normalized text; restore the document's newline only on save.
  const source = element("custom-dictionary-source").value;
  return customDraftNewline === "\r\n" ? source.replaceAll("\n", "\r\n") : source;
}

function renderCustomDictionaryControls() {
  const busy = importing || updating || removing || committing || customLoading || customSaving;
  const open = element("custom-dictionary-open");
  const source = element("custom-dictionary-source");
  open.disabled = busy;
  source.disabled = busy;
  element("custom-dictionary-save").disabled = busy
    || !customDictionaryDirty()
    || customDraftStale;
  element("custom-dictionary-reload").disabled = busy;
}

function showCustomDictionaryEditor(visible) {
  element("custom-dictionary-form").hidden = !visible;
  const open = element("custom-dictionary-open");
  open.setAttribute("aria-expanded", String(visible));
  open.textContent = visible ? "Close editor" : "Edit source";
}

function cancelCustomDictionaryValidation() {
  clearTimeout(customValidationTimer);
  customValidationTimer = null;
}

function renderCustomDictionaryValidation(source = element("custom-dictionary-source").value) {
  cancelCustomDictionaryValidation();
  const parsed = parseCustomDictionary(source);
  renderCustomDictionaryErrors(parsed.errors);
  return parsed;
}

function resetCustomDictionaryDraft(documentValue) {
  customBaseDocument = documentValue;
  customDraftStale = false;
  customDraftNewline = documentValue.text.includes("\r\n") ? "\r\n" : "\n";
  element("custom-dictionary-source").value = documentValue.text;
  customBaseEditorText = element("custom-dictionary-source").value;
  renderCustomDictionaryValidation();
  renderCustomDictionaryControls();
}

function markCustomDictionaryStale() {
  customDraftStale = true;
  setCustomDictionaryStatus(
    "The custom dictionary source changed elsewhere. Reload the saved source before saving.",
    "error",
  );
  renderCustomDictionaryControls();
}

function adoptCustomDictionaryDocument(value) {
  const next = normaliseCustomDictionaryDocument(value);
  if (customDocument !== null && next.revision <= customDocument.revision) {
    return false;
  }
  const preserveDraft = customEditorLoaded
    && (customDictionaryDirty() || customDraftStale || customSaving);
  customDocument = next;
  if (!customEditorLoaded) {
    return true;
  }
  if (preserveDraft) {
    if (customBaseDocument === null || next.revision > customBaseDocument.revision) {
      markCustomDictionaryStale();
    }
  } else {
    resetCustomDictionaryDraft(next);
    setCustomDictionaryStatus("Loaded the newest saved source.", "ready");
  }
  return true;
}

function adoptCustomDictionaryState(value) {
  if (value === null || value === undefined) return;
  if (adoptDictionaryState(value)) {
    renderChangedDictionaryState();
  }
}

async function loadCustomDictionarySource() {
  if (customLoading || customSaving) return;
  cancelCustomDictionaryValidation();
  customLoading = true;
  setCustomDictionaryStatus("Loading the saved custom dictionary source…");
  renderCustomDictionaryControls();
  try {
    const reply = await send("hd_custom_read", {}, WORKER_TARGET);
    if (!reply.ok || reply.document === undefined) {
      throw new Error(reply.error || "the custom dictionary source could not be read");
    }
    adoptCustomDictionaryDocument(reply.document);
    adoptCustomDictionaryState(reply.state);
    if (customDocument === null) {
      throw new Error("the custom dictionary source reply was empty");
    }
    customEditorLoaded = true;
    resetCustomDictionaryDraft(customDocument);
    showCustomDictionaryEditor(true);
    setCustomDictionaryStatus(`Loaded source revision ${customDocument.revision}.`, "ready", true);
  } catch (error) {
    setCustomDictionaryStatus(`Could not load the custom dictionary source: ${describe(error)}`, "error");
  } finally {
    customLoading = false;
    syncNavigationStatus("custom-dictionary-status");
    renderCustomDictionaryControls();
  }
}

function customDictionarySavedMessage(reply, validCount, errorCount) {
  let message;
  if (reply.removed === true) {
    message = "Saved the source and removed the custom dictionary because it has no valid entries.";
  } else if (reply.rebuilt === false) {
    message = `Saved ${validCount} valid ${validCount === 1 ? "entry" : "entries"} without rebuilding.`;
  } else {
    message = `Saved ${validCount} valid ${validCount === 1 ? "entry" : "entries"} and rebuilt the custom dictionary.`;
  }
  if (errorCount > 0) {
    message += ` Skipped ${errorCount} malformed ${errorCount === 1 ? "line" : "lines"}.`;
  }
  return message;
}

async function saveCustomDictionarySource(event) {
  event.preventDefault();
  if (!customEditorLoaded || customLoading || customSaving || !customDictionaryDirty()) {
    return;
  }
  if (customDraftStale) {
    markCustomDictionaryStale();
    return;
  }

  const source = customDictionaryDraftSource();
  const parsed = renderCustomDictionaryValidation(source);
  const pending = {
    baseRevision: customBaseDocument.revision,
    source,
    parsed,
    editorText: element("custom-dictionary-source").value,
  };
  customSaving = true;
  setCustomDictionaryStatus("Saving and compiling the custom dictionary…");
  setControlsDisabled(importing);
  try {
    const reply = await send("hd_custom_save", {
      baseDocumentRevision: pending.baseRevision,
      text: pending.source,
    });
    if (reply.document !== undefined) {
      adoptCustomDictionaryDocument(reply.document);
    }
    adoptCustomDictionaryState(reply.state);
    renderCustomDictionaryErrors(reply.errors ?? pending.parsed.errors);
    if (!reply.ok) {
      if (reply.stale === true
          || (customDocument !== null && customDocument.revision > pending.baseRevision)) {
        markCustomDictionaryStale();
      }
      setCustomDictionaryStatus(
        `Could not save the custom dictionary: ${reply.error || "the source changed elsewhere"}`,
        "error",
      );
      return;
    }

    const saved = normaliseCustomDictionaryDocument(reply.document);
    if (saved.text !== pending.source) {
      throw new Error("the saved custom dictionary source did not match the submitted draft");
    }
    customBaseDocument = saved;
    customBaseEditorText = pending.editorText;
    const newerDocumentExists = customDocument !== null
      && (customDocument.revision > saved.revision
        || customDocument.text !== saved.text
        || customDocument.semanticRevision !== saved.semanticRevision);
    customDraftStale = newerDocumentExists;
    if (newerDocumentExists) {
      setCustomDictionaryStatus(
        "Saved this draft, but the source changed again elsewhere. Reload before saving.",
        "error",
      );
    } else {
      setCustomDictionaryStatus(
        customDictionarySavedMessage(reply, pending.parsed.entries.length, pending.parsed.errors.length),
        "ready",
        true,
      );
    }
  } catch (error) {
    setCustomDictionaryStatus(`Could not save the custom dictionary: ${describe(error)}`, "error");
  } finally {
    customSaving = false;
    syncNavigationStatus("custom-dictionary-status");
    setControlsDisabled(importing);
  }
}

function isUpdateCheckable(dictionary) {
  return managedDictionarySource(dictionary) !== null;
}

function availableUpdates() {
  return dictionaries.filter((dictionary) =>
    isUpdateCheckable(dictionary) && dictionary.lastUpdateCheck?.status === "update-available");
}

function renderUpdateControls() {
  const schedule = element("update-schedule");
  if (schedule !== document.activeElement) {
    schedule.value = updateSettings.schedule;
  }
  const checked = updateSettings.lastCheckedAt === null
    ? null
    : new Date(updateSettings.lastCheckedAt);
  element("update-last-checked").textContent = checked !== null && !Number.isNaN(checked.getTime())
    ? `Last checked ${checked.toLocaleString()}.`
    : "Never checked.";
  const busy = updating || importing || removing || committing || customSaving;
  element("update-all").disabled = busy || availableUpdates().length === 0;
  element("update-check-now").disabled = busy;
  schedule.disabled = busy;
}

function clearImportResults() {
  const detail = element("import-detail");
  detail.textContent = "";
  detail.hidden = true;
}

function appendImportResult(fileName, message, tone) {
  const detail = element("import-detail");
  const result = document.createElement("li");
  result.className = `import-result is-${tone}`;
  result.textContent = `${fileName} — ${message}`;
  detail.appendChild(result);
  detail.hidden = false;
}

function renderRecommendedCatalogue() {
  const list = element("recommended-dictionary-list");
  for (const entry of RECOMMENDED_DICTIONARIES) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "recommended-dictionary-link";
    link.href = entry.publisherUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = entry.name;
    const description = document.createElement("span");
    description.textContent = entry.description;
    item.append(link, description);
    list.appendChild(item);
  }
}

function missingRecommendedDictionaries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => !dictionaries.some((dictionary) =>
    dictionary.sourceId === entry.sourceId || dictionary.indexUrl === entry.indexUrl));
}

function renderRecommendedActions() {
  const missing = missingRecommendedDictionaries();
  element("recommended-starter").hidden = dictionaries.length > 0;
  element("recommended-retry").hidden =
    missing.length === 0 || missing.length === RECOMMENDED_DICTIONARIES.length;
}

function setControlsDisabled(disabled) {
  const blocked = disabled || removing || updating || customSaving;
  element("import-file").disabled = blocked || committing;
  element("install-recommended").disabled = blocked || committing;
  element("retry-recommended").disabled = blocked || committing;
  for (const control of document.querySelectorAll(".dict-row select, .dict-row input, .dict-row button")) {
    control.disabled = blocked || control.dataset.pinnedDisabled === "true";
  }
  for (const drag of document.querySelectorAll(".dict-drag")) {
    drag.draggable = !blocked && drag.dataset.pinnedDisabled !== "true";
  }
  for (const control of document.querySelectorAll(
    "#dict-group-create-form input, #dict-group-create-form button, #dict-group-list input, #dict-group-list select, #dict-group-list button",
  )) {
    control.disabled = blocked || control.dataset.pinnedDisabled === "true";
  }
  element("dict-select-visible").disabled = blocked || visibleDictionaries().length === 0;
  for (const control of element("dict-controls").querySelectorAll(".dict-bulk-actions button")) {
    control.disabled = blocked || selectedDictionaryIds.size === 0;
  }
  renderUpdateControls();
  renderCustomDictionaryControls();
}

function elapsedSince(started) {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function scheduleStatusPoll(delay = STATUS_POLL_MS) {
  if (statusTimer !== null) {
    return;
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    refreshStatus();
  }, delay);
}

async function refreshStatus() {
  let reply;
  try {
    reply = await send("hd_status");
  } catch (error) {
    // A poll can fail transiently: the service worker can be torn down mid-relay,
    // or the offscreen document can be recreated faster than background.js's
    // retries. Keep polling, or one blip freezes this line on a stale error while
    // the engine finishes booting and every lookup works.
    setStatus(`Cannot reach the engine: ${describe(error)}`, "error");
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  if (!reply.ok) {
    // Either a boot failure or background.js's relay giving up, and the two are
    // not distinguishable from here, so retry both: a boot error survives the
    // retry and keeps saying so.
    setStatus(`Engine error: ${reply.error ?? "unknown"}`, "error");
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  const count = dictionaries.filter((entry) => entry.enabled !== false).length;
  if (reply.ready) {
    const enabled = count === 1 ? "1 dictionary enabled" : `${numberFormat.format(count)} dictionaries enabled`;
    setStatus(reply.loading ? `Ready, ${enabled}, working…` : `Ready, ${enabled}.`, "ready");
  } else {
    setStatus("Starting the engine and loading dictionaries…");
  }
  if (!reply.ready || reply.loading) {
    scheduleStatusPoll();
  }
}

function renderFrequencyChoices() {
  const select = element("opt-frequency-dictionary");
  if (select === document.activeElement) return;
  const previous = options.frequencyDictionary;
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Any — automatic across all dictionaries";
  select.appendChild(automatic);

  const enabled = dictionaries.filter(isAvailableFrequencyDictionary);
  const withFrequencies = new Set(
    enabled.map((entry) => entry.title),
  );
  const groups = [{ label: "Frequency dictionaries", titles: [...withFrequencies] }];
  for (const group of groups) {
    if (group.titles.length === 0) {
      continue;
    }
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const title of group.titles) {
      const dictionary = enabled.find((entry) => entry.title === title);
      const option = document.createElement("option");
      option.value = title;
      option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  // Keep a removed selection visible rather than silently rewriting the option.
  if (previous !== "" && !withFrequencies.has(previous)) {
    const stale = document.createElement("option");
    stale.value = previous;
    stale.textContent = `${previous} (unavailable)`;
    stale.disabled = true;
    select.appendChild(stale);
  }
  select.value = previous;
}

function renderCompactSummaryControls() {
  const enabled = options.showCompactDefinitionSummary;
  element("opt-compact-summary").checked = enabled;
  const count = element("opt-summary-count");
  // Disabling Chrome's focused select emits blur before its pending change.
  // Keep that draft's captured revision until the existing focusout boundary.
  if (count !== document.activeElement) count.disabled = !enabled;
  renderPreferredDictionary("opt-summary-dictionary", options.compactDefinitionSummaryDictionary,
    "term", "Automatic — first available definition", enabled);
}

function renderPreferredDictionary(id, preferred, kind, automaticLabel, enabled) {
  const select = element(id);
  if (select === document.activeElement) return;
  select.disabled = !enabled;
  select.replaceChildren(new Option(automaticLabel, ""));
  let available = preferred === "";
  for (const dictionary of dictionaries) {
    if (!hasCapability(dictionary, kind)) continue;
    const label = dictionaryLabel(dictionary) + (dictionary.enabled === false ? " (disabled)" : "");
    select.add(new Option(label, dictionary.title));
    available ||= dictionary.title === preferred;
  }
  // Already-missing sources remain a soft preference, not a lookup filter.
  if (!available) select.add(new Option(`${preferred} (unavailable)`, preferred));
  select.value = preferred;
}

function renderMetadataControls() {
  for (const field of METADATA_FIELDS) {
    element(field.id).checked = field.inverted ? !options[field.key] : options[field.key];
  }
  renderPreferredDictionary("opt-pitch-dictionary", options.pitchAccentFuriganaDictionary,
    "pitch", "Automatic — first available pitch", options.showPitchAccentFurigana);
}

function renderPopupImageSources() {
  const select = element("opt-image-source");
  if (select === document.activeElement) return;
  const source = options.popupImageSource;
  const previous = selectionValue(source);
  select.replaceChildren(new Option("Automatic — current tab", ""));
  let available = source === null;
  function addSource(value, label) {
    const encoded = selectionValue(value);
    select.add(new Option(label, encoded));
    available ||= encoded === previous;
  }
  for (const dictionary of dictionaries) {
    addSource({ kind: "dictionary", title: dictionary.title },
      `Dictionary: ${dictionaryLabel(dictionary)}${dictionary.enabled === false ? " (disabled)" : ""}`);
  }
  for (const group of dictionaryState.groups) {
    addSource({ kind: "tabGroup", id: group.id }, `Group: ${group.name}`);
  }
  if (!available) addSource(source, `${source.title || source.id} (unavailable)`);
  select.value = previous;
}

function renderFrequencyOrder() {
  const order = element("opt-frequency-order");
  if (order !== document.activeElement) order.value = options.frequencyOrder;
  const selected = selectedFrequencyDictionary();
  for (const choice of order.options) {
    choice.disabled = !selected && (choice.value === "ascending" || choice.value === "descending");
  }
  element("opt-frequency-auto").disabled = !selected;
  let hint;
  if (options.frequencyOrder === "auto") hint = "Automatic compares all enabled frequency dictionaries in their listed order.";
  else if (options.frequencyOrder === "disabled") hint = "Frequency sorting is off. Your dictionary choice is remembered.";
  else if (!selected) hint = "Choose an available frequency dictionary to use this direction.";
  else if (selected.frequencyMode === "rank-based") hint = "Rank-based: Auto puts the lowest numbers first.";
  else if (selected.frequencyMode === "occurrence-based") hint = "Occurrence-based: Auto puts the highest numbers first.";
  else hint = "No mode declared: Auto uses highest numbers first.";
  const hintElement = element("frequency-order-hint");
  if (hintElement.textContent !== hint) hintElement.textContent = hint;
}

function applyFrequencyDirection() {
  const direction = selectedFrequencyDictionary()?.frequencyMode === "rank-based" ? "ascending" : "descending";
  options.frequencyOrder = options.frequencyDictionary === "" ? "auto" : direction;
  renderFrequencyOrder();
  writeOptions();
}

function appendKanjiGroup(select, enabled, group, availableValues) {
  if (group.titles.length === 0) {
    return;
  }
  const optgroup = document.createElement("optgroup");
  optgroup.label = group.label;
  for (const title of group.titles) {
    const dictionary = enabled.find((entry) => entry.title === title);
    const option = document.createElement("option");
    option.value = selectionValue({ title, kind: group.kind });
    option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
    availableValues.add(option.value);
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
}

function selectedKanjiValue(previousSelection, withKanji, withTerms) {
  if (previousSelection?.kind !== "") {
    return selectionValue(previousSelection);
  }
  let kind = "";
  if (withKanji.has(previousSelection.title)) {
    kind = "kanji";
  } else if (withTerms.has(previousSelection.title)) {
    kind = "term";
  }
  return kind === ""
    ? previousSelection.title
    : selectionValue({ title: previousSelection.title, kind });
}

function appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues) {
  if (!previousSelection || availableValues.has(selectedValue)) {
    return;
  }
  const stale = document.createElement("option");
  stale.value = selectedValue;
  stale.textContent = `${previousSelection.title} (not available)`;
  select.appendChild(stale);
}

function renderKanjiChoices() {
  const select = element("opt-kanji-dictionary");
  const previousSelection = selectionParts(options.kanjiClickDictionary);
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Automatic — use every kanji dictionary";
  select.appendChild(automatic);

  const enabled = dictionaries.filter((entry) => entry.enabled !== false);
  const withKanji = new Set(
    enabled.filter((entry) => hasCapability(entry, "kanji")).map((entry) => entry.title),
  );
  const withTerms = new Set(
    enabled.filter((entry) => hasCapability(entry, "term")).map((entry) => entry.title),
  );
  const groups = [
    { kind: "kanji", label: "Kanji dictionaries", titles: [...withKanji] },
    {
      kind: "term",
      label: "Term dictionaries — requires a matching single-kanji entry",
      titles: [...withTerms],
    },
  ];
  const availableValues = new Set();
  for (const group of groups) {
    appendKanjiGroup(select, enabled, group, availableValues);
  }

  const selectedValue = selectedKanjiValue(previousSelection, withKanji, withTerms);
  appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues);
  select.value = selectedValue;
}

function renderOptions() {
  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    if (input !== document.activeElement) {
      input.value = String(options[field.key]);
    }
  }
  element("opt-hover-enabled").checked = options.hoverEnabled;
  element("opt-japanese-only").checked = options.onlyScanJapaneseText;
  const mode = element("opt-lookup-mode");
  if (mode !== document.activeElement) mode.value = options.lookupMode;
  const activation = element("opt-activation-key");
  if (activation.options.length === 0) {
    for (const key of ACTIVATION_KEYS) activation.add(new Option(key, key));
  }
  if (activation !== document.activeElement) activation.value = options.activationKey;
  activation.disabled = options.lookupMode !== "activation";
  renderFrequencyOrder();
  renderKanjiChoices();
  renderFrequencyChoices();
  renderCompactSummaryControls();
  renderPopupImageSources();
  renderMetadataControls();
}

function addCountBadge(container, label, count) {
  const badge = document.createElement("span");
  badge.className = "dict-badge";
  badge.dataset.capability = label.toLowerCase();
  badge.classList.toggle("is-empty", count === 0);
  badge.textContent = `${label} ${numberFormat.format(count)}`;
  container.appendChild(badge);
}

function dictionaryMetadata(entry) {
  const details = [];
  if (entry.revision) {
    details.push(`Revision ${entry.revision}`);
  }
  if (entry.language) {
    details.push(entry.language);
  }
  if (entry.installedAt) {
    const installed = new Date(entry.installedAt);
    if (!Number.isNaN(installed.getTime())) {
      details.push(`Imported ${installed.toLocaleString()}`);
    }
  }
  details.push(isUpdateCheckable(entry) ? "Update source available" : "Local archive");
  return details.join(" · ");
}

function dictionaryUpdateStatus(entry) {
  if (!isUpdateCheckable(entry)) {
    return { text: "Not update-checkable", tone: "" };
  }
  const check = entry.lastUpdateCheck;
  if (check?.status === "up-to-date") {
    return { text: "Up to date", tone: "ready" };
  }
  if (check?.status === "update-available") {
    const revision = check.remoteRevision ? `: ${check.remoteRevision}` : "";
    const failure = check.error ? ` · Update failed: ${check.error}` : "";
    return { text: `Update available${revision}${failure}`, tone: "available" };
  }
  if (check?.status === "check-failed") {
    return { text: `Check failed: ${check.error || "unknown error"}`, tone: "error" };
  }
  return { text: "Not checked", tone: "" };
}

function bindDictionaryUpdate(row, entry) {
  const status = dictionaryUpdateStatus(entry);
  const output = row.querySelector(".dict-update-status");
  output.textContent = status.text;
  output.hidden = !entry.lastUpdateCheck;
  output.classList.toggle("is-ready", status.tone === "ready");
  output.classList.toggle("is-available", status.tone === "available");
  output.classList.toggle("is-error", status.tone === "error");

  const update = row.querySelector(".dict-update");
  update.hidden = entry.lastUpdateCheck?.status !== "update-available" || !isUpdateCheckable(entry);
  update.setAttribute("aria-label", `Update ${dictionaryLabel(entry)}`);
  update.title = `Update ${dictionaryLabel(entry)}`;
  update.addEventListener("click", () => {
    void runManagedUpdate("hd_updates_install", [entry.id]);
  });
}

function updateItemById(current, id, update) {
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return null;
  }
  const replacement = update(current[index]);
  if (replacement === current[index]) {
    return null;
  }
  const next = [...current];
  next[index] = replacement;
  return next;
}

function updateDictionary(id, update) {
  return (current) => updateItemById(current, id, update);
}

function moveListItem(values, index, target) {
  if (index < 0 || target < 0 || target >= values.length || index === target) {
    return null;
  }
  const next = [...values];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return next;
}

function updateSelectedDictionaries(field, value, reloadEngine) {
  const ids = new Set(selectedDictionaryIds);
  void commitDictionaries((current) => {
    let changed = false;
    const next = current.map((dictionary) => {
      if ((field === "enabled" && isManagedCustomDictionary(dictionary))
          || !ids.has(dictionary.id)
          || dictionary[field] === value) {
        return dictionary;
      }
      changed = true;
      return { ...dictionary, [field]: value };
    });
    return changed ? next : null;
  }, reloadEngine);
}

function focusedManagementControl() {
  const active = document.activeElement;
  const dictionaryRow = active?.closest?.(".dict-row");
  if (dictionaryRow?.dataset.dictionaryId) {
    const controlClass = [
      "dict-selected",
      "dict-details-toggle",
      "dict-display-name",
      "dict-enabled",
      "dict-up",
      "dict-down",
      "dict-position-input",
      "dict-move",
      "dict-update",
      "dict-remove",
    ].find((name) => active.classList.contains(name));
    return controlClass
      ? { kind: "dictionary", id: dictionaryRow.dataset.dictionaryId, controlClass }
      : null;
  }

  const groupRow = active?.closest?.(".dict-group");
  if (!groupRow?.dataset.groupId) return null;
  const memberRow = active.closest(".dict-group-member");
  const controlClasses = memberRow
    ? ["dict-group-member-up", "dict-group-member-down", "dict-group-member-remove"]
    : ["dict-group-name", "dict-group-up", "dict-group-down", "dict-group-delete", "dict-group-add-select", "dict-group-add"];
  const controlClass = controlClasses.find((name) => active.classList.contains(name));
  if (!controlClass) return null;

  const groupRows = [...groupRow.parentElement.children];
  const focus = {
    kind: memberRow ? "group-member" : "group",
    groupId: groupRow.dataset.groupId,
    groupIndex: groupRows.indexOf(groupRow),
    controlClass,
  };
  if (memberRow) {
    focus.dictionaryId = memberRow.dataset.dictionaryId;
    focus.memberIndex = [...memberRow.parentElement.children].indexOf(memberRow);
  }
  return focus;
}

function renderDictionarySelection(visible) {
  const visibleSelected = visible.filter((dictionary) => selectedDictionaryIds.has(dictionary.id)).length;
  const selectVisible = element("dict-select-visible");
  selectVisible.checked = visible.length > 0 && visibleSelected === visible.length;
  selectVisible.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  element("dict-selection-count").textContent = `${selectedDictionaryIds.size} selected`;
  element("dict-bulk-actions").hidden = selectedDictionaryIds.size === 0;
  element("dict-match-count").textContent = `${visible.length} of ${dictionaries.length}`;
}

function clearDictionaryDropTargets() {
  for (const row of document.querySelectorAll("#dict-list .is-drop-target")) {
    row.classList.remove("is-drop-target");
  }
}

function bindDictionarySelection(row, entry) {
  const selected = row.querySelector(".dict-selected");
  selected.checked = selectedDictionaryIds.has(entry.id);
  selected.setAttribute("aria-label", `Select ${dictionaryLabel(entry)}`);
  selected.addEventListener("change", () => {
    if (selected.checked) {
      selectedDictionaryIds.add(entry.id);
    } else {
      selectedDictionaryIds.delete(entry.id);
    }
    renderDictionarySelection(visibleDictionaries());
    setControlsDisabled(importing);
  });
}

function bindDictionaryDrag(row, entry) {
  const drag = row.querySelector(".dict-drag");
  drag.title = `Drag ${dictionaryLabel(entry)} to reorder`;
  if (isManagedCustomDictionary(entry)) {
    drag.dataset.pinnedDisabled = "true";
    drag.draggable = false;
    return;
  }
  drag.addEventListener("dragstart", (event) => {
    draggedDictionaryId = entry.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", entry.id);
    }
  });
  drag.addEventListener("dragend", () => {
    draggedDictionaryId = null;
    clearDictionaryDropTargets();
  });
  row.addEventListener("dragover", (event) => {
    if (draggedDictionaryId && draggedDictionaryId !== entry.id) {
      event.preventDefault();
      clearDictionaryDropTargets();
      row.classList.add("is-drop-target");
    }
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("is-drop-target");
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    clearDictionaryDropTargets();
    if (draggedDictionaryId && draggedDictionaryId !== entry.id) {
      moveDictionary(draggedDictionaryId, { targetId: entry.id });
    }
    draggedDictionaryId = null;
  });
}

function renderDeferredAfterBlur(control) {
  control.addEventListener("blur", () => {
    if (!dictionaryRenderDeferred) {
      return;
    }
    setTimeout(() => {
      if (dictionaryRenderDeferred) renderChangedDictionaryState();
    }, 0);
  });
}

function bindDictionaryAlias(row, entry) {
  const input = row.querySelector(".dict-display-name");
  input.value = entry.displayName || "";
  input.placeholder = entry.title;
  input.setAttribute("aria-label", `Display name for ${entry.title}`);
  input.title = `Display name for ${entry.title}`;
  input.addEventListener("change", () => {
    const value = input.value.trim() || null;
    void commitDictionaries(updateDictionary(entry.id, (dictionary) =>
      dictionary.displayName === value ? dictionary : { ...dictionary, displayName: value }), false);
  });
  renderDeferredAfterBlur(input);
}

function bindDictionaryEnabled(row, entry) {
  const enabled = row.querySelector(".dict-enabled");
  enabled.checked = entry.enabled;
  enabled.setAttribute(
    "aria-label",
    isManagedCustomDictionary(entry)
      ? `Enabled for ${entry.title} (managed; always enabled)`
      : `Enabled for ${entry.title}`,
  );
  enabled.title = `Enabled for ${entry.title}`;
  if (isManagedCustomDictionary(entry)) {
    enabled.checked = true;
    enabled.dataset.pinnedDisabled = "true";
    enabled.disabled = true;
    return;
  }
  enabled.addEventListener("change", () => {
    const value = enabled.checked;
    void commitDictionaries(updateDictionary(entry.id, (dictionary) =>
      dictionary.enabled === value ? dictionary : { ...dictionary, enabled: value }), true);
  });
}

function bindDictionaryOrder(row, entry, index) {
  const fixed = isManagedCustomDictionary(entry);
  const minimumIndex = isManagedCustomDictionary(dictionaries[0]) ? 1 : 0;
  const up = row.querySelector(".dict-up");
  const down = row.querySelector(".dict-down");
  up.setAttribute("aria-label", `Move ${entry.title} up`);
  up.title = `Move ${entry.title} up`;
  down.setAttribute("aria-label", `Move ${entry.title} down`);
  down.title = `Move ${entry.title} down`;
  up.dataset.pinnedDisabled = String(fixed || index <= minimumIndex);
  down.dataset.pinnedDisabled = String(fixed || index === dictionaries.length - 1);
  up.addEventListener("click", () => {
    moveDictionary(entry.id, { step: -1 });
  });
  down.addEventListener("click", () => {
    moveDictionary(entry.id, { step: 1 });
  });

  const position = row.querySelector(".dict-position-input");
  const move = row.querySelector(".dict-move");
  position.value = String(index + 1);
  position.min = String(minimumIndex + 1);
  position.max = String(dictionaries.length);
  position.dataset.pinnedDisabled = String(fixed);
  move.dataset.pinnedDisabled = String(fixed);
  position.setAttribute("aria-label", `Position for ${dictionaryLabel(entry)}`);
  move.setAttribute("aria-label", `Move ${dictionaryLabel(entry)} to position`);
  move.title = `Move ${dictionaryLabel(entry)} to position`;
  if (fixed) {
    up.setAttribute("aria-label", `Move ${entry.title} up (managed; fixed first)`);
    down.setAttribute("aria-label", `Move ${entry.title} down (managed; fixed first)`);
    position.setAttribute("aria-label", `Position for ${dictionaryLabel(entry)} (managed; fixed first)`);
    move.setAttribute("aria-label", `Move ${dictionaryLabel(entry)} (managed; fixed first)`);
  }
  const moveToPosition = () => {
    const target = Number(position.value);
    if (!fixed
        && Number.isInteger(target)
        && target >= minimumIndex + 1
        && target <= dictionaries.length) {
      moveDictionary(entry.id, { position: target });
    } else {
      position.value = String(index + 1);
    }
  };
  position.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveToPosition();
    }
  });
  move.addEventListener("click", moveToPosition);
}

function renderDictionaryRow(template, entry, index) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.dictionaryId = entry.id;
  row.querySelector(".dict-details").open = expandedDictionaryIds.has(entry.id);
  row.querySelector(".dict-details-toggle").setAttribute("aria-label", `Details for ${entry.title}`);
  row.querySelector(".dict-pinned").hidden = !isManagedCustomDictionary(entry);
  row.classList.toggle("is-off", !entry.enabled);
  row.querySelector(".dict-rank").textContent = String(index + 1);
  bindDictionarySelection(row, entry);
  bindDictionaryDrag(row, entry);

  const title = row.querySelector(".dict-title");
  title.textContent = dictionaryLabel(entry);
  title.title = entry.path;

  const canonical = row.querySelector(".dict-canonical");
  canonical.textContent = entry.displayName ? entry.title : "";
  canonical.hidden = !entry.displayName;
  row.querySelector(".dict-favorite").hidden = !entry.favorite;

  const badges = row.querySelector(".dict-badges");
  addCountBadge(badges, "Terms", entry.termCount);
  addCountBadge(badges, "Frequency", entry.frequencyCount);
  addCountBadge(badges, "Pitch", entry.pitchCount);
  addCountBadge(badges, "Kanji", entry.kanjiCount);
  addCountBadge(badges, "Media", entry.mediaCount);
  const metadata = dictionaryMetadata(entry);
  row.querySelector(".dict-metadata").textContent = isManagedCustomDictionary(entry)
    ? `Managed · always enabled and first · ${metadata}`
    : metadata;
  bindDictionaryUpdate(row, entry);

  bindDictionaryAlias(row, entry);
  bindDictionaryEnabled(row, entry);
  bindDictionaryOrder(row, entry, index);

  const remove = row.querySelector(".dict-remove");
  remove.setAttribute("aria-label", `Remove ${entry.title}`);
  remove.title = `Remove ${entry.title}`;
  if (isManagedCustomDictionary(entry)) {
    remove.dataset.pinnedDisabled = "true";
    remove.disabled = true;
    remove.hidden = true;
  } else {
    remove.addEventListener("click", () => {
      removeDictionary(entry.id, entry.title);
    });
  }
  return row;
}

function renderDictionaries(reuseRows = false) {
  const list = element("dict-list");
  const reusableRows = new Map();
  // Retain disclosure state by package identity, including temporarily filtered rows.
  for (const row of list.children) {
    if (row.querySelector(".dict-details").open) expandedDictionaryIds.add(row.dataset.dictionaryId);
    else expandedDictionaryIds.delete(row.dataset.dictionaryId);
    // Filtering can retain unchanged controls, but an adopted state awaiting
    // blur has newer metadata and listener inputs than the displayed rows.
    if (reuseRows && !dictionaryRenderDeferred) reusableRows.set(row.dataset.dictionaryId, row);
  }
  const installedIds = new Set(dictionaries.map((entry) => entry.id));
  for (const id of expandedDictionaryIds) {
    if (!installedIds.has(id)) expandedDictionaryIds.delete(id);
  }
  const template = element("dict-row-template");
  const visible = visibleDictionaries();
  const visibleIds = new Set(visible.map((dictionary) => dictionary.id));
  draggedDictionaryId = null;
  if (reusableRows.size > 0) clearDictionaryDropTargets();
  list.textContent = "";

  dictionaries.forEach((entry, index) => {
    if (!visibleIds.has(entry.id)) {
      return;
    }
    list.appendChild(reusableRows.get(entry.id) ?? renderDictionaryRow(template, entry, index));
  });

  element("dict-controls").hidden = dictionaries.length === 0;
  const empty = element("dict-empty");
  empty.textContent = dictionaries.length === 0 ? "Nothing imported yet." : "No dictionaries match your search.";
  empty.hidden = visible.length > 0;
  renderDictionarySelection(visible);
  setControlsDisabled(importing);
}

function dictionaryMoveTarget(current, index, move) {
  if (move.targetId) {
    return current.findIndex((entry) => entry.id === move.targetId);
  }
  if (move.step) {
    return index + move.step;
  }
  return move.position - 1;
}

function moveDictionary(id, move) {
  void commitDictionaries((current) => {
    const index = current.findIndex((entry) => entry.id === id);
    if (index < 0 || isManagedCustomDictionary(current[index])) return null;
    const minimumIndex = isManagedCustomDictionary(current[0]) ? 1 : 0;
    const target = Math.max(minimumIndex, dictionaryMoveTarget(current, index, move));
    return moveListItem(current, index, target);
  }, true);
}

async function restoreAuthoritativeState(reply) {
  if (reply?.state) {
    adoptDictionaryState(reply.state);
    return;
  }
  const fresh = await send("hd_state_read", {}, WORKER_TARGET);
  if (!fresh.ok || !fresh.state) {
    throw new Error(fresh.error || "the dictionary state could not be read");
  }
  adoptDictionaryState(fresh.state);
}

function directionalFocus(row, controlClass, upClass, downClass) {
  let control = row?.querySelector(`.${controlClass}`);
  if (control?.disabled && controlClass === upClass) {
    control = row.querySelector(`.${downClass}`);
  } else if (control?.disabled && controlClass === downClass) {
    control = row.querySelector(`.${upClass}`);
  }
  return control?.disabled ? null : control;
}

function restoreManagementFocus(focus) {
  const section = focus.kind === "dictionary" ? "dictionaries" : "dictionary-groups";
  if (element(section).hidden) return;
  if (focus.kind === "dictionary") {
    const row = [...element("dict-list").children]
      .find((candidate) => candidate.dataset.dictionaryId === focus.id);
    const control = directionalFocus(row, focus.controlClass, "dict-up", "dict-down")
      ?? row?.querySelector(".dict-details-toggle");
    control?.focus();
    return;
  }

  const groupRows = [...element("dict-group-list").children];
  const groupRow = groupRows.find((candidate) => candidate.dataset.groupId === focus.groupId)
    ?? groupRows[Math.min(focus.groupIndex, groupRows.length - 1)];
  if (!groupRow) {
    element("dict-group-name-new").focus();
    return;
  }

  if (focus.kind === "group") {
    const control = directionalFocus(groupRow, focus.controlClass, "dict-group-up", "dict-group-down")
      ?? groupRow.querySelector(".dict-group-name");
    control?.focus();
    return;
  }

  const memberRows = [...groupRow.querySelectorAll(".dict-group-member")];
  const memberRow = memberRows.find((candidate) => candidate.dataset.dictionaryId === focus.dictionaryId)
    ?? memberRows[Math.min(focus.memberIndex, memberRows.length - 1)];
  const control = directionalFocus(
    memberRow,
    focus.controlClass,
    "dict-group-member-up",
    "dict-group-member-down",
  ) ?? groupRow.querySelector(".dict-group-add-select:not(:disabled), .dict-group-name");
  control?.focus();
}

function renderDictionaryState() {
  const focus = focusedManagementControl()
    ?? (document.activeElement === document.body ? pendingManagementFocus : null);
  pendingManagementFocus = null;
  dictionaries = dictionaryState.dictionaries;
  dictionaryRenderDeferred = false;
  renderDictionaries();
  dictionaryGroupController.render();
  renderRecommendedActions();
  setControlsDisabled(importing);
  normaliseDictionarySelections();
  renderOptions();
  if (focus) restoreManagementFocus(focus);
}

async function commitDictionaryStateChange(update, reloadEngine) {
  const next = update(dictionaryState);
  if (next === null) {
    return;
  }
  const baseRevision = dictionaryState.revision;
  try {
    const target = reloadEngine ? TARGET : WORKER_TARGET;
    const type = reloadEngine ? "hd_apply_state" : "hd_state_cas";
    const fields = {
      baseRevision,
      dictionaries: next.dictionaries,
    };
    if (!reloadEngine) {
      fields.groups = next.groups;
    }
    const reply = await send(type, fields, target);
    if (!reply.ok) {
      await restoreAuthoritativeState(reply);
      dictionaryCommitFailed = true;
      setStatus(`Dictionary change was not saved: ${reply.error ?? "the state changed elsewhere"}`, "error");
      return;
    }
    adoptDictionaryState(reply.state);
  } catch (error) {
    try {
      await restoreAuthoritativeState();
    } catch {
      // Keep the visible error from the failed write; a later storage event or
      // page reload will supply the authoritative state.
    }
    dictionaryCommitFailed = true;
    setStatus(`Dictionary change was not saved: ${describe(error)}`, "error");
  }
}

function queueDictionaryStateChange(update, reloadEngine) {
  if (pendingDictionaryCommits === 0) {
    dictionaryCommitFailed = false;
  }
  pendingDictionaryCommits += 1;
  committing = true;
  pendingManagementFocus = focusedManagementControl() ?? pendingManagementFocus;
  setControlsDisabled(importing);

  const run = dictionaryCommitTail.then(
    () => commitDictionaryStateChange(update, reloadEngine),
    () => commitDictionaryStateChange(update, reloadEngine),
  );
  const settled = run.finally(async () => {
    pendingDictionaryCommits -= 1;
    if (pendingDictionaryCommits > 0) {
      return;
    }
    committing = false;
    renderChangedDictionaryState();
    if (!dictionaryCommitFailed) {
      await refreshStatus();
    }
  });
  dictionaryCommitTail = settled.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}

function commitDictionaries(update, reloadEngine) {
  return queueDictionaryStateChange((current) => {
    const dictionaries = update(current.dictionaries);
    return dictionaries === null ? null : { ...current, dictionaries };
  }, reloadEngine);
}

function commitGroups(update) {
  return queueDictionaryStateChange((current) => {
    const groups = update(current.groups);
    return groups === null ? null : { ...current, groups };
  }, false);
}

const dictionaryGroupController = createDictionaryGroupController({
  setError: (message) => setSectionStatus("dict-group-error", message, "error"),
  readState: () => dictionaryState,
  readDictionaries: () => dictionaries,
  commitGroups,
  dictionaryLabel,
  moveListItem,
  updateItemById,
  renderDeferredAfterBlur,
});

async function removeDictionary(id, title) {
  if (!window.confirm(`Remove ${title}? Its imported data is deleted and has to be imported again.`)) {
    return;
  }
  removing = true;
  setControlsDisabled(true);
  try {
    await dictionaryCommitTail;
    const reply = await send("hd_remove", { id, title });
    if (!reply.ok) {
      throw new Error(reply.error ?? "unknown error");
    }
    if (await reloadDictionaries()) {
      await refreshStatus();
    }
  } catch (error) {
    setStatus(`Could not remove ${title}: ${describe(error)}`, "error");
  } finally {
    removing = false;
    setControlsDisabled(importing);
  }
}

async function reloadDictionaries() {
  try {
    let reply = await send("hd_state_read", {}, WORKER_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the dictionary state could not be read");
    }
    if (!reply.state) {
      const reloaded = await send("hd_reload");
      if (!reloaded.ok) {
        throw new Error(reloaded.error || "the dictionary state could not be migrated");
      }
      reply = await send("hd_state_read", {}, WORKER_TARGET);
    }
    if (!reply.ok || !reply.state) {
      throw new Error(reply.error || "the dictionary state could not be read");
    }
    adoptDictionaryState(reply.state);
  } catch (error) {
    setStatus(`Could not read the dictionary list: ${describe(error)}`, "error");
    return false;
  }
  renderDictionaryState();
  return true;
}

function summariseReport(report) {
  const counts = [
    [report.termCount, "term", "terms"],
    [report.frequencyCount, "frequency entry", "frequency entries"],
    [report.pitchCount, "pitch entry", "pitch entries"],
    [report.kanjiCount, "kanji", "kanji"],
    [report.mediaCount, "media file", "media files"],
  ]
    .filter(([value]) => Number(value) > 0)
    .map(([value, singular, plural]) => `${numberFormat.format(value)} ${value === 1 ? singular : plural}`);
  return counts.length === 0 ? "no entries" : counts.join(", ");
}

async function importFile(file, index, total, request = {}, label = file.name, started = Date.now()) {
  const blobUrl = URL.createObjectURL(file);
  const tick = () => {
    setImportState(
      `Importing ${label} (${index + 1} of ${total}) — ${index} of ${total} complete — ${elapsedSince(started)} elapsed`,
      "busy",
    );
  };
  tick();
  const ticker = setInterval(tick, 1000);

  try {
    const reply = await send("hd_import", { blobUrl, fileName: file.name, ...request });
    const report = reply.report ?? {};
    if (reply.ok && report.success) {
      appendImportResult(label, `Imported ${report.title}: ${summariseReport(report)}.`, "ready");
      return true;
    }
    const reason = reply.error ?? report.error ?? "The engine gave no reason.";
    appendImportResult(label, `Could not be imported: ${reason}`, "error");
  } catch (error) {
    appendImportResult(label, `Could not be imported: ${describe(error)}`, "error");
  } finally {
    clearInterval(ticker);
    // The offscreen document has read the bytes by now; holding the URL any
    // longer just pins the file.
    URL.revokeObjectURL(blobUrl);
  }
  return false;
}

async function importRecommendedDictionary(entry, index, total) {
  const started = Date.now();
  const tick = () => {
    setImportState(
      `Downloading ${entry.name} (${index + 1} of ${total}) — ${index} of ${total} complete — ${elapsedSince(started)} elapsed`,
      "busy",
    );
  };
  tick();
  const ticker = setInterval(tick, 1000);
  try {
    const response = await fetch(entry.downloadUrl, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const file = new File([await response.blob()], entry.archiveName, { type: "application/zip" });
    clearInterval(ticker);
    return await importFile(
      file,
      index,
      total,
      { sourceId: entry.sourceId, finalUrl: response.url },
      entry.name,
      started,
    );
  } catch (error) {
    appendImportResult(entry.name, `Could not be downloaded: ${describe(error)}`, "error");
    return false;
  } finally {
    clearInterval(ticker);
  }
}

async function runImportBatch(items, importOne, singular, plural) {
  if (importing) {
    return;
  }
  importing = true;
  setControlsDisabled(true);
  clearImportResults();

  let imported = 0;
  try {
    for (const [index, item] of items.entries()) {
      if (await importOne(item, index, items.length)) {
        imported += 1;
      }
    }
    const failed = items.length - imported;
    const itemLabel = items.length === 1 ? singular : plural;
    setImportState(
      `Finished ${items.length} of ${items.length} ${itemLabel} — ${imported} imported, ${failed} failed.`,
      failed === 0 ? "ready" : "error",
    );
    await reloadDictionaries();
    await refreshStatus();
  } finally {
    importing = false;
    syncNavigationStatus("import-state");
    setControlsDisabled(false);
  }
}

function runImports(files) {
  return runImportBatch(files, importFile, "archive", "archives");
}

function installMissingRecommendedDictionaries() {
  const missing = missingRecommendedDictionaries();
  if (missing.length > 0) {
    void runImportBatch(
      missing,
      importRecommendedDictionary,
      "recommended dictionary",
      "recommended dictionaries",
    );
  }
}

function updateOutcomeSummary(type, outcomes) {
  const failed = outcomes.filter((outcome) => outcome.status === "check-failed" || outcome.error).length;
  if (type === "hd_updates_check") {
    const available = outcomes.filter((outcome) => outcome.status === "update-available").length;
    const dictionariesLabel = outcomes.length === 1 ? "managed dictionary" : "managed dictionaries";
    const updatesLabel = available === 1 ? "update" : "updates";
    return {
      message: `Checked ${outcomes.length} ${dictionariesLabel} — ${available} ${updatesLabel} available, ${failed} failed.`,
      tone: failed === 0 ? "ready" : "error",
    };
  }
  const updated = outcomes.filter((outcome) => outcome.status === "updated").length;
  const updatesLabel = outcomes.length === 1 ? "dictionary update" : "dictionary updates";
  return {
    message: `Finished ${outcomes.length} ${updatesLabel} — ${updated} updated, ${failed} failed.`,
    tone: failed === 0 ? "ready" : "error",
  };
}

async function runManagedUpdate(type, dictionaryIds = null) {
  if (updating) {
    return;
  }
  updating = true;
  setControlsDisabled(true);
  setUpdateState(type === "hd_updates_check" ? "Checking managed dictionaries…" : "Updating dictionaries…");
  try {
    const fields = dictionaryIds === null ? {} : { dictionaryIds };
    const reply = await send(type, fields, UPDATE_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the dictionary update operation failed");
    }
    updateSettings = normaliseUpdateSettings(reply.settings);
    await reloadDictionaries();
    const summary = updateOutcomeSummary(type, reply.outcomes ?? []);
    setUpdateState(summary.message, summary.tone);
  } catch (error) {
    setUpdateState(`Dictionary updates failed: ${describe(error)}`, "error");
  } finally {
    updating = false;
    syncNavigationStatus("update-state");
    setControlsDisabled(importing);
  }
}

async function writeUpdateSchedule(schedule) {
  try {
    const reply = await send("hd_updates_schedule", { schedule }, UPDATE_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the dictionary update schedule could not be saved");
    }
    updateSettings = normaliseUpdateSettings(reply.settings);
    renderUpdateControls();
  } catch (error) {
    element("update-schedule").value = updateSettings.schedule;
    setUpdateState(`Could not save the update schedule: ${describe(error)}`, "error");
  }
}

function attachHandlers() {
  element("custom-dictionary-open").addEventListener("click", () => {
    if (!customEditorLoaded) {
      void loadCustomDictionarySource();
      return;
    }
    showCustomDictionaryEditor(element("custom-dictionary-form").hidden);
  });
  element("custom-dictionary-form").addEventListener("submit", (event) => {
    void saveCustomDictionarySource(event);
  });
  element("custom-dictionary-reload").addEventListener("click", () => {
    void loadCustomDictionarySource();
  });
  element("custom-dictionary-source").addEventListener("input", () => {
    cancelCustomDictionaryValidation();
    if (customDraftStale) {
      markCustomDictionaryStale();
    } else {
      setCustomDictionaryStatus(customDictionaryDirty() ? "Unsaved changes." : "No unsaved changes.");
    }
    renderCustomDictionaryControls();
    // Keep full-document parsing and diagnostics off the typing path. Saving
    // cancels this preview and validates the exact submitted source immediately.
    customValidationTimer = setTimeout(() => {
      const parsed = renderCustomDictionaryValidation();
      if (customDraftStale || !customDictionaryDirty()) return;
      setCustomDictionaryStatus(
        `${parsed.entries.length} valid ${parsed.entries.length === 1 ? "entry" : "entries"} ready to save.`,
      );
    }, 150);
  });

  const file = element("import-file");
  file.addEventListener("change", () => {
    const picked = [...(file.files ?? [])];
    // Snapshot before clearing so picking the same batch again fires a change event.
    file.value = "";
    if (picked.length > 0) {
      void runImports(picked);
    }
  });

  element("dict-search").addEventListener("input", (event) => {
    dictionarySearch = event.target.value;
    renderDictionaries(true);
  });

  element("dict-select-visible").addEventListener("change", (event) => {
    const visible = visibleDictionaries();
    for (const dictionary of visible) {
      if (event.target.checked) {
        selectedDictionaryIds.add(dictionary.id);
      } else {
        selectedDictionaryIds.delete(dictionary.id);
      }
    }
    if (dictionaryRenderDeferred) {
      renderDictionaries();
    } else {
      for (const row of element("dict-list").children) {
        row.querySelector(".dict-selected").checked = selectedDictionaryIds.has(row.dataset.dictionaryId);
      }
      renderDictionarySelection(visible);
      setControlsDisabled(importing);
    }
  });

  element("dict-bulk-enable").addEventListener("click", () => {
    updateSelectedDictionaries("enabled", true, true);
  });
  element("dict-bulk-disable").addEventListener("click", () => {
    updateSelectedDictionaries("enabled", false, true);
  });
  element("dict-bulk-favorite").addEventListener("click", () => {
    updateSelectedDictionaries("favorite", true, false);
  });
  element("dict-bulk-unfavorite").addEventListener("click", () => {
    updateSelectedDictionaries("favorite", false, false);
  });

  element("dict-group-create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    dictionaryGroupController.create();
  });
  document.querySelector("main").addEventListener("pointerdown", (event) => {
    if (event.target.closest("#dict-list, #dict-group-list")) managementPointerDown = true;
  });
  const finishManagementPointer = () => {
    managementPointerDown = false;
    setTimeout(() => {
      if (dictionaryRenderDeferred) renderChangedDictionaryState();
    }, 0);
  };
  window.addEventListener("pointerup", finishManagementPointer, true);
  window.addEventListener("pointercancel", finishManagementPointer, true);

  element("install-recommended").addEventListener("click", installMissingRecommendedDictionaries);
  element("retry-recommended").addEventListener("click", installMissingRecommendedDictionaries);
  element("update-check-now").addEventListener("click", () => {
    void runManagedUpdate("hd_updates_check");
  });
  element("update-all").addEventListener("click", () => {
    void runManagedUpdate("hd_updates_install", availableUpdates().map((dictionary) => dictionary.id));
  });
  element("update-schedule").addEventListener("change", (event) => {
    void writeUpdateSchedule(event.target.value);
  });

  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    input.addEventListener("change", () => {
      options[field.key] = clampOption(field.key, input.value);
      input.value = String(options[field.key]);
      writeOptions();
    });
  }

  element("opt-hover-enabled").addEventListener("change", (event) => {
    options.hoverEnabled = event.target.checked;
    writeOptions();
  });
  for (const field of METADATA_FIELDS) {
    element(field.id).addEventListener("change", (event) => {
      options[field.key] = field.inverted ? !event.target.checked : event.target.checked;
      renderMetadataControls();
      writeOptions();
    });
  }
  element("opt-pitch-dictionary").addEventListener("change", (event) => {
    options.pitchAccentFuriganaDictionary = event.target.value;
    writeOptions();
  });
  element("opt-japanese-only").addEventListener("change", (event) => {
    options.onlyScanJapaneseText = event.target.checked;
    writeOptions();
  });
  element("opt-compact-summary").addEventListener("change", (event) => {
    options.showCompactDefinitionSummary = event.target.checked;
    renderCompactSummaryControls();
    writeOptions();
  });
  element("opt-summary-dictionary").addEventListener("change", (event) => {
    options.compactDefinitionSummaryDictionary = event.target.value;
    writeOptions();
  });
  element("opt-image-source").addEventListener("change", (event) => {
    // Values come from the canonical descriptors rendered above, not labels.
    options.popupImageSource = event.target.value ? JSON.parse(event.target.value) : null;
    writeOptions();
  });
  element("opt-lookup-mode").addEventListener("change", (event) => {
    options.lookupMode = LOOKUP_MODES.includes(event.target.value) ? event.target.value : "hover";
    element("opt-activation-key").disabled = options.lookupMode !== "activation";
    writeOptions();
  });
  element("opt-activation-key").addEventListener("change", (event) => {
    options.activationKey = event.target.value;
    writeOptions();
  });

  element("opt-frequency-order").addEventListener("change", (event) => {
    options.frequencyOrder = FREQUENCY_ORDERS.includes(event.target.value) ? event.target.value : "auto";
    renderFrequencyOrder();
    writeOptions();
  });

  element("opt-frequency-dictionary").addEventListener("change", (event) => {
    // A focused native chooser can outlive a dictionary capability change.
    if (event.target.value && !selectedFrequencyDictionary(event.target.value)) {
      event.target.value = options.frequencyDictionary;
      setOptionsStatus("That frequency dictionary is no longer available.");
      return;
    }
    options.frequencyDictionary = event.target.value;
    applyFrequencyDirection();
  });
  element("opt-frequency-auto").addEventListener("click", applyFrequencyDirection);

  element("opt-kanji-dictionary").addEventListener("change", (event) => {
    options.kanjiClickDictionary = selectionFromValue(event.target.value);
    writeOptions();
  });
  element("lookup").addEventListener("input", () => {
    optionsEditRevision ??= Math.max(0, optionsRevision);
  });
  element("lookup").addEventListener("change", () => {
    optionsEditRevision = null;
  });
  element("lookup").addEventListener("focusout", (event) => {
    optionsEditRevision = null;
    if (event.target.id === "opt-frequency-dictionary") renderFrequencyChoices();
    if (event.target.id === "opt-image-source") renderPopupImageSources();
    if (event.target.id === "opt-pitch-dictionary") renderMetadataControls();
    if (event.target.id === "opt-summary-dictionary" || event.target.id === "opt-summary-count") renderCompactSummaryControls();
    const field = NUMBER_FIELDS.find(({ id }) => id === event.target.id);
    if (field) event.target.value = String(options[field.key]);
  });
  element("options-retry").addEventListener("click", () => {
    optionsSaveFailed = false;
    pendingOptionsRevision = optionsRevision;
    void flushOptions();
  });
  element("options-use-saved").addEventListener("click", () => {
    window.clearTimeout(optionsTimer);
    optionsTimer = null;
    pendingOptions = {};
    optionsEditRevision = null;
    optionsSaveFailed = false;
    renderCurrentOptions();
    setOptionsStatus("Using saved settings.");
  });

  window.addEventListener("beforeunload", (event) => {
    if (!importing && savingOptions === null && optionsEditRevision === null
        && Object.keys(pendingOptions).length === 0) {
      return;
    }
    // Leaving revokes the blob URL the offscreen document is still reading from.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.storage.onChanged.addListener(handleStorageChange);
}

function dictionaryNameIsBeingEdited() {
  const active = document.activeElement;
  return active instanceof HTMLInputElement
    && (active.classList.contains("dict-display-name") || active.classList.contains("dict-group-name"));
}

function renderChangedDictionaryState() {
  if (committing || managementPointerDown || dictionaryNameIsBeingEdited()) {
    dictionaryRenderDeferred = true;
    return;
  }
  renderDictionaryState();
}

function handleDictionaryStateChange(change) {
  let adopted;
  try {
    adopted = adoptDictionaryState(change.newValue);
  } catch (error) {
    setStatus(describe(error), "error");
    return false;
  }
  if (adopted) {
    renderChangedDictionaryState();
  }
  return true;
}

function renderCurrentOptions() {
  options = { ...savedOptions, ...savingOptions?.patch, ...pendingOptions };
  renderOptions();
}

function adoptOptions(value) {
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  if (revision <= optionsRevision) return false;
  optionsRevision = revision;
  savedOptions = normaliseOptions(value);
  renderCurrentOptions();
  return true;
}

function handleOptionsChange(change) {
  adoptOptions(change.newValue);
}

function handleCustomDictionarySourceChange(change) {
  try {
    adoptCustomDictionaryDocument(change.newValue);
  } catch (error) {
    setCustomDictionaryStatus(`Could not read the changed custom dictionary source: ${describe(error)}`, "error");
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes[CUSTOM_DICTIONARY_SOURCE_KEY]) {
    handleCustomDictionarySourceChange(changes[CUSTOM_DICTIONARY_SOURCE_KEY]);
  }
  if (changes.dictionaryState && !handleDictionaryStateChange(changes.dictionaryState)) {
    return;
  }
  if (changes.options) {
    handleOptionsChange(changes.options);
  }
  if (changes.dictionaryUpdates) {
    updateSettings = normaliseUpdateSettings(changes.dictionaryUpdates.newValue);
    renderUpdateControls();
  }
}

function setOptionsStatus(message, completed = false) {
  setSectionStatus("options-status", message, optionsSaveFailed ? "error" : "", completed);
  element("options-conflict-actions").hidden = !optionsSaveFailed;
}

// Keep only edited fields. A storage event can update the committed snapshot,
// but cannot replace a local draft or authorize a stale draft's write.
function writeOptions() {
  const previous = { ...savedOptions, ...savingOptions?.patch };
  const changes = Object.fromEntries(Object.entries(options).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(previous[key])));
  if (Object.keys(pendingOptions).length === 0) {
    pendingOptionsRevision = optionsEditRevision ?? Math.max(0, optionsRevision);
  }
  pendingOptions = changes;
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (optionsSaveFailed) return;
  setOptionsStatus("Unsaved changes…");
  optionsTimer = window.setTimeout(() => { void flushOptions(); }, OPTIONS_SAVE_DELAY_MS);
}

async function flushOptions() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (savingOptions !== null || optionsSaveFailed) return;
  if (Object.keys(pendingOptions).length === 0) {
    setOptionsStatus("Saved.");
    return;
  }
  const sent = { patch: pendingOptions, baseRevision: pendingOptionsRevision };
  savingOptions = sent;
  pendingOptions = {};
  setOptionsStatus("Saving…");
  try {
    const reply = await send("hd_options_write", {
      baseRevision: sent.baseRevision,
      options: sent.patch,
    }, WORKER_TARGET);
    if (reply.options) adoptOptions(reply.options);
    if (!reply.ok) {
      throw new Error(reply.error || "the options could not be saved");
    }
    // A newer external event may already have arrived; keep that state, while
    // binding queued edits to the reply we actually committed, not that event.
    pendingOptionsRevision = Math.max(pendingOptionsRevision, reply.options.revision);
    if (optionsEditRevision !== null) {
      optionsEditRevision = Math.max(optionsEditRevision, reply.options.revision);
    }
    setOptionsStatus(Object.keys(pendingOptions).length > 0 ? "Unsaved changes…" : "Saved.", true);
  } catch (error) {
    pendingOptions = { ...sent.patch, ...pendingOptions };
    optionsSaveFailed = true;
    // A reply can be lost after storage commits. Read the current revision for
    // explicit retry; do not silently overwrite it or drop the retained draft.
    try {
      const stored = await chrome.storage.local.get("options");
      adoptOptions(stored.options);
    } catch { /* The draft stays available even while storage is unreachable. */ }
    setOptionsStatus(`Could not save settings: ${describe(error)}`);
  } finally {
    savingOptions = null;
    syncNavigationStatus("options-status");
    renderCurrentOptions();
    if (!optionsSaveFailed && optionsTimer === null && Object.keys(pendingOptions).length > 0) {
      void flushOptions();
    }
  }
}

async function start() {
  attachSettingsNavigation();
  renderRecommendedCatalogue();
  attachHandlers();
  const stored = await chrome.storage.local.get(["options", "dictionaryUpdates"]);
  adoptOptions(stored.options);
  updateSettings = normaliseUpdateSettings(stored.dictionaryUpdates);
  renderCustomDictionaryControls();
  if (await reloadDictionaries()) {
    writeOptions();
  }
  renderOptions();
  renderUpdateControls();
  await refreshStatus();
}

start();
