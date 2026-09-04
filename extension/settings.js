/*
 * Settings page: dictionary import, load order, and lookup options.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);
const MODIFIERS = ["none", "shift", "ctrl", "alt"];
const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
const STATUS_POLL_MS = 1000;
// Slower than the boot poll: a failing poll may be failing for a while, and the
// settings page can be left open.
const STATUS_RETRY_MS = 5000;

const DEFAULT_OPTIONS = {
  scanLength: 16,
  maxResults: 32,
  modifier: "none",
  hoverDelayMs: 50,
  kanjiClickDictionary: "",
  frequencyDictionary: "",
  frequencyOrder: "auto",
};

const NUMBER_FIELDS = [
  { key: "scanLength", id: "opt-scan-length", min: 1, max: 64 },
  { key: "maxResults", id: "opt-max-results", min: 1, max: 256 },
  { key: "hoverDelayMs", id: "opt-hover-delay", min: 0, max: 2000 },
];

const numberFormat = new Intl.NumberFormat();

let dictionaryState = { schemaVersion: 1, revision: -1, dictionaries: [] };
let dictionaries = dictionaryState.dictionaries;
let options = { ...DEFAULT_OPTIONS };
let importing = false;
let removing = false;
let committing = false;
let pendingDictionaryCommits = 0;
let dictionaryCommitTail = Promise.resolve();
let dictionaryCommitFailed = false;
let dictionaryRenderDeferred = false;
let dictionarySearch = "";
const selectedDictionaryIds = new Set();
let draggedDictionaryId = null;
let statusTimer = null;
let requestCounter = 0;

function element(id) {
  return document.getElementById(id);
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

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
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
    termCount: nonnegativeCount(row?.termCount),
    frequencyCount: nonnegativeCount(row?.frequencyCount),
    pitchCount: nonnegativeCount(row?.pitchCount),
    kanjiCount: nonnegativeCount(row?.kanjiCount),
    mediaCount: nonnegativeCount(row?.mediaCount),
    installedAt: stringValue(row?.installedAt),
    lastUpdateCheck: row?.lastUpdateCheck ?? null,
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
  return {
    schemaVersion: 1,
    revision,
    dictionaries: normaliseDictionaries(value?.dictionaries),
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
  return stringValue(value).normalize("NFKC").trim().toLocaleLowerCase();
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

function normaliseKanjiSelection(value) {
  if (
    value
    && typeof value === "object"
    && typeof value.title === "string"
    && value.title !== ""
    && KANJI_SELECTION_KINDS.has(value.kind)
  ) {
    return { title: value.title, kind: value.kind };
  }
  return typeof value === "string" ? value : "";
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

function normaliseDictionarySelections() {
  let changed = false;
  if (options.frequencyDictionary) {
    const selected = dictionaries.find((entry) => entry.title === options.frequencyDictionary);
    if (!selected || selected.enabled === false || !hasCapability(selected, "freq")) {
      options.frequencyDictionary = "";
      changed = true;
    }
  }
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

function normaliseOptions(value) {
  const stored = value ?? {};
  const next = { ...DEFAULT_OPTIONS };
  for (const field of NUMBER_FIELDS) {
    next[field.key] = clampInt(stored[field.key], field.min, field.max, DEFAULT_OPTIONS[field.key]);
  }
  next.modifier = MODIFIERS.includes(stored.modifier) ? stored.modifier : DEFAULT_OPTIONS.modifier;
  next.frequencyOrder = FREQUENCY_ORDERS.includes(stored.frequencyOrder)
    ? stored.frequencyOrder
    : DEFAULT_OPTIONS.frequencyOrder;
  next.frequencyDictionary =
    typeof stored.frequencyDictionary === "string" ? stored.frequencyDictionary : "";
  next.kanjiClickDictionary = normaliseKanjiSelection(stored.kanjiClickDictionary);
  return next;
}

function setStatus(message, tone) {
  const status = element("engine-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-ready", tone === "ready");
}

function setImportState(message, tone) {
  const state = element("import-state");
  state.textContent = message;
  state.classList.toggle("is-error", tone === "error");
  state.classList.toggle("is-ready", tone === "ready");
  element("import-progress").hidden = tone !== "busy";
}

function setImportDetail(message) {
  const detail = element("import-detail");
  detail.textContent = message ?? "";
  detail.hidden = !message;
}

function setControlsDisabled(disabled) {
  const blocked = disabled || removing;
  element("import-file").disabled = blocked || committing;
  for (const control of document.querySelectorAll(".dict-row select, .dict-row input, .dict-row button")) {
    control.disabled = blocked || control.dataset.pinnedDisabled === "true";
  }
  element("dict-select-visible").disabled = blocked || visibleDictionaries().length === 0;
  for (const control of element("dict-controls").querySelectorAll(".dict-bulk-actions button")) {
    control.disabled = blocked || selectedDictionaryIds.size === 0;
  }
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
  const previous = options.frequencyDictionary;
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Any — use every frequency dictionary";
  select.appendChild(automatic);

  const enabled = dictionaries.filter((entry) => entry.enabled !== false);
  const withFrequencies = new Set(
    enabled.filter((entry) => hasCapability(entry, "freq")).map((entry) => entry.title),
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
  if (previous !== "" && !enabled.some((entry) => entry.title === previous)) {
    const stale = document.createElement("option");
    stale.value = previous;
    stale.textContent = `${previous} (not imported)`;
    select.appendChild(stale);
  }
  select.value = previous;
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
  const modifier = element("opt-modifier");
  if (modifier !== document.activeElement) {
    modifier.value = options.modifier;
  }
  const order = element("opt-frequency-order");
  if (order !== document.activeElement) {
    order.value = options.frequencyOrder;
  }
  renderKanjiChoices();
  renderFrequencyChoices();
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
  details.push(entry.isUpdatable && entry.indexUrl && entry.downloadUrl ? "Update source available" : "Local archive");
  return details.join(" · ");
}

function updateDictionary(id, update) {
  return (current) => {
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
  };
}

function updateSelectedDictionaries(field, value, reloadEngine) {
  const ids = new Set(selectedDictionaryIds);
  void commitDictionaries((current) => {
    let changed = false;
    const next = current.map((dictionary) => {
      if (!ids.has(dictionary.id) || dictionary[field] === value) {
        return dictionary;
      }
      changed = true;
      return { ...dictionary, [field]: value };
    });
    return changed ? next : null;
  }, reloadEngine);
}

function focusedDictionaryControl() {
  const active = document.activeElement;
  const row = active?.closest?.(".dict-row");
  if (!row?.dataset.dictionaryId) {
    return null;
  }
  const controlClass = [
    "dict-selected",
    "dict-display-name",
    "dict-enabled",
    "dict-up",
    "dict-down",
    "dict-position-input",
    "dict-move",
    "dict-remove",
  ]
    .find((name) => active.classList.contains(name));
  return controlClass ? { id: row.dataset.dictionaryId, controlClass } : null;
}

function renderDictionarySelection(visible) {
  const visibleSelected = visible.filter((dictionary) => selectedDictionaryIds.has(dictionary.id)).length;
  const selectVisible = element("dict-select-visible");
  selectVisible.checked = visible.length > 0 && visibleSelected === visible.length;
  selectVisible.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  element("dict-selection-count").textContent = `${selectedDictionaryIds.size} selected`;
  element("dict-match-count").textContent = `${visible.length} of ${dictionaries.length}`;
}

function clearDictionaryDropTargets() {
  for (const row of document.querySelectorAll("#dict-list .is-drop-target")) {
    row.classList.remove("is-drop-target");
  }
}

function renderDictionaries() {
  const list = element("dict-list");
  const template = element("dict-row-template");
  const visible = visibleDictionaries();
  const visibleIds = new Set(visible.map((dictionary) => dictionary.id));
  draggedDictionaryId = null;
  list.textContent = "";

  dictionaries.forEach((entry, index) => {
    if (!visibleIds.has(entry.id)) {
      return;
    }
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.dictionaryId = entry.id;
    row.classList.toggle("is-off", !entry.enabled);
    row.querySelector(".dict-rank").textContent = String(index + 1);

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

    const drag = row.querySelector(".dict-drag");
    drag.title = `Drag ${dictionaryLabel(entry)} to reorder`;
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

    const title = row.querySelector(".dict-title");
    title.textContent = dictionaryLabel(entry);
    title.title = entry.path;

    const canonical = row.querySelector(".dict-canonical");
    canonical.textContent = entry.displayName ? entry.title : "";
    canonical.hidden = !entry.displayName;

    const favorite = row.querySelector(".dict-favorite");
    favorite.hidden = !entry.favorite;

    const badges = row.querySelector(".dict-badges");
    addCountBadge(badges, "Terms", entry.termCount);
    addCountBadge(badges, "Frequency", entry.frequencyCount);
    addCountBadge(badges, "Pitch", entry.pitchCount);
    addCountBadge(badges, "Kanji", entry.kanjiCount);
    addCountBadge(badges, "Media", entry.mediaCount);

    row.querySelector(".dict-metadata").textContent = dictionaryMetadata(entry);

    const displayName = row.querySelector(".dict-display-name");
    displayName.value = entry.displayName || "";
    displayName.placeholder = entry.title;
    displayName.setAttribute("aria-label", `Display name for ${entry.title}`);
    displayName.title = `Display name for ${entry.title}`;
    displayName.addEventListener("change", () => {
      const value = displayName.value.trim() || null;
      void commitDictionaries(updateDictionary(entry.id, (dictionary) =>
        dictionary.displayName === value ? dictionary : { ...dictionary, displayName: value }), false);
    });
    displayName.addEventListener("blur", () => {
      if (!dictionaryRenderDeferred) {
        return;
      }
      setTimeout(() => {
        if (!committing && dictionaryRenderDeferred) {
          renderDictionaryState();
        }
      }, 0);
    });

    const enabled = row.querySelector(".dict-enabled");
    enabled.checked = entry.enabled;
    enabled.setAttribute("aria-label", `Enabled for ${entry.title}`);
    enabled.title = `Enabled for ${entry.title}`;
    enabled.addEventListener("change", () => {
      const value = enabled.checked;
      void commitDictionaries(updateDictionary(entry.id, (dictionary) =>
        dictionary.enabled === value ? dictionary : { ...dictionary, enabled: value }), true);
    });

    const up = row.querySelector(".dict-up");
    const down = row.querySelector(".dict-down");
    up.setAttribute("aria-label", `Move ${entry.title} up`);
    up.title = `Move ${entry.title} up`;
    down.setAttribute("aria-label", `Move ${entry.title} down`);
    down.title = `Move ${entry.title} down`;
    up.dataset.pinnedDisabled = String(index === 0);
    down.dataset.pinnedDisabled = String(index === dictionaries.length - 1);
    up.addEventListener("click", () => {
      moveDictionary(entry.id, { step: -1 });
    });
    down.addEventListener("click", () => {
      moveDictionary(entry.id, { step: 1 });
    });

    const position = row.querySelector(".dict-position-input");
    const move = row.querySelector(".dict-move");
    position.value = String(index + 1);
    position.max = String(dictionaries.length);
    position.setAttribute("aria-label", `Position for ${dictionaryLabel(entry)}`);
    move.setAttribute("aria-label", `Move ${dictionaryLabel(entry)} to position`);
    move.title = `Move ${dictionaryLabel(entry)} to position`;
    const moveToPosition = () => {
      const target = Number(position.value);
      if (Number.isInteger(target) && target >= 1 && target <= dictionaries.length) {
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

    const remove = row.querySelector(".dict-remove");
    remove.setAttribute("aria-label", `Remove ${entry.title}`);
    remove.title = `Remove ${entry.title}`;
    remove.addEventListener("click", () => {
      removeDictionary(entry.title);
    });

    list.appendChild(row);
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
    const target = dictionaryMoveTarget(current, index, move);
    if (index < 0 || target < 0 || target >= current.length || index === target) {
      return null;
    }
    const next = [...current];
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry);
    return next;
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

function renderDictionaryState() {
  const focus = focusedDictionaryControl();
  dictionaries = dictionaryState.dictionaries;
  dictionaryRenderDeferred = false;
  renderDictionaries();
  normaliseDictionarySelections();
  renderOptions();
  if (focus) {
    const row = [...element("dict-list").children]
      .find((candidate) => candidate.dataset.dictionaryId === focus.id);
    let control = row?.querySelector(`.${focus.controlClass}`);
    if (control?.disabled && focus.controlClass === "dict-up") {
      control = row.querySelector(".dict-down");
    } else if (control?.disabled && focus.controlClass === "dict-down") {
      control = row.querySelector(".dict-up");
    }
    (control?.disabled ? row?.querySelector(".dict-display-name") : control)?.focus();
  }
}

async function commitDictionaryChange(update, reloadEngine) {
  const next = update(dictionaryState.dictionaries);
  if (next === null) {
    return;
  }
  const baseRevision = dictionaryState.revision;
  try {
    const target = reloadEngine ? TARGET : WORKER_TARGET;
    const type = reloadEngine ? "hd_apply_state" : "hd_state_cas";
    const reply = await send(type, {
      baseRevision,
      dictionaries: next,
    }, target);
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

function commitDictionaries(update, reloadEngine) {
  if (pendingDictionaryCommits === 0) {
    dictionaryCommitFailed = false;
  }
  pendingDictionaryCommits += 1;
  committing = true;
  setControlsDisabled(importing);

  const run = dictionaryCommitTail.then(
    () => commitDictionaryChange(update, reloadEngine),
    () => commitDictionaryChange(update, reloadEngine),
  );
  const settled = run.finally(async () => {
    pendingDictionaryCommits -= 1;
    if (pendingDictionaryCommits > 0) {
      return;
    }
    committing = false;
    renderDictionaryState();
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

async function removeDictionary(title) {
  if (!window.confirm(`Remove ${title}? Its imported data is deleted and has to be imported again.`)) {
    return;
  }
  removing = true;
  setControlsDisabled(true);
  try {
    await dictionaryCommitTail;
    const reply = await send("hd_remove", { title });
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

async function runImport(file) {
  if (importing) {
    return;
  }
  importing = true;
  setControlsDisabled(true);
  setImportDetail("");

  const blobUrl = URL.createObjectURL(file);
  const started = Date.now();
  const tick = () => {
    setImportState(`Importing ${file.name} — ${elapsedSince(started)} elapsed`, "busy");
  };
  tick();
  const ticker = setInterval(tick, 1000);

  try {
    const reply = await send("hd_import", { blobUrl, fileName: file.name });
    const report = reply.report ?? {};
    if (reply.ok && report.success) {
      setImportState(`Imported ${report.title} in ${elapsedSince(started)}.`, "ready");
      setImportDetail(`${report.title}: ${summariseReport(report)}.`);
      await reloadDictionaries();
    } else {
      setImportState(`${file.name} could not be imported.`, "error");
      setImportDetail(reply.error ?? report.error ?? "The engine gave no reason.");
    }
  } catch (error) {
    setImportState(`${file.name} could not be imported.`, "error");
    setImportDetail(describe(error));
  } finally {
    clearInterval(ticker);
    // The offscreen document has read the bytes by now; holding the URL any
    // longer just pins the file.
    URL.revokeObjectURL(blobUrl);
    importing = false;
    setControlsDisabled(false);
  }
  await refreshStatus();
}

function attachHandlers() {
  const file = element("import-file");
  file.addEventListener("change", () => {
    const picked = file.files?.[0];
    // Clear it so picking the same file again still fires a change event.
    file.value = "";
    if (picked) {
      runImport(picked);
    }
  });

  element("dict-search").addEventListener("input", (event) => {
    dictionarySearch = event.target.value;
    renderDictionaries();
  });

  element("dict-select-visible").addEventListener("change", (event) => {
    for (const dictionary of visibleDictionaries()) {
      if (event.target.checked) {
        selectedDictionaryIds.add(dictionary.id);
      } else {
        selectedDictionaryIds.delete(dictionary.id);
      }
    }
    renderDictionaries();
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

  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    input.addEventListener("change", () => {
      options[field.key] = clampInt(input.value, field.min, field.max, DEFAULT_OPTIONS[field.key]);
      input.value = String(options[field.key]);
      writeOptions();
    });
  }

  element("opt-modifier").addEventListener("change", (event) => {
    options.modifier = MODIFIERS.includes(event.target.value) ? event.target.value : "none";
    writeOptions();
  });

  element("opt-frequency-order").addEventListener("change", (event) => {
    options.frequencyOrder = FREQUENCY_ORDERS.includes(event.target.value) ? event.target.value : "auto";
    writeOptions();
  });

  element("opt-frequency-dictionary").addEventListener("change", (event) => {
    options.frequencyDictionary = event.target.value;
    writeOptions();
  });

  element("opt-kanji-dictionary").addEventListener("change", (event) => {
    options.kanjiClickDictionary = selectionFromValue(event.target.value);
    writeOptions();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!importing) {
      return;
    }
    // Leaving revokes the blob URL the offscreen document is still reading from.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.storage.onChanged.addListener(handleStorageChange);
}

function dictionaryAliasIsBeingEdited() {
  const active = document.activeElement;
  return active instanceof HTMLInputElement
    && active.classList.contains("dict-display-name");
}

function renderChangedDictionaryState() {
  if (committing || dictionaryAliasIsBeingEdited()) {
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

function handleOptionsChange(change) {
  const next = normaliseOptions(change.newValue);
  if (JSON.stringify(next) === JSON.stringify(options)) {
    return;
  }
  options = next;
  const changedSelections = normaliseDictionarySelections();
  renderOptions();
  if (changedSelections) {
    void writeOptions();
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes.dictionaryState && !handleDictionaryStateChange(changes.dictionaryState)) {
    return;
  }
  if (changes.options) {
    handleOptionsChange(changes.options);
  }
}

// Lookup options are read per request by the content script, so nothing needs a
// reload here.
async function writeOptions() {
  try {
    const reply = await send("hd_options_write", { options }, WORKER_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the options could not be saved");
    }
    options = normaliseOptions(reply.options);
  } catch (error) {
    setStatus(`Could not save the options: ${describe(error)}`, "error");
  }
}

async function start() {
  const stored = await chrome.storage.local.get("options");
  options = normaliseOptions(stored.options);
  attachHandlers();
  if (await reloadDictionaries()) {
    await writeOptions();
  }
  renderOptions();
  await refreshStatus();
}

start();
