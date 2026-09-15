/*
 * Settings page: dictionary import, load order, and lookup options.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const KINDS = ["term", "freq", "pitch", "kanji"];
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
  frequencyDictionary: "",
  frequencyOrder: "auto",
};

const NUMBER_FIELDS = [
  { key: "scanLength", id: "opt-scan-length", min: 1, max: 64 },
  { key: "maxResults", id: "opt-max-results", min: 1, max: 256 },
  { key: "hoverDelayMs", id: "opt-hover-delay", min: 0, max: 2000 },
];

const numberFormat = new Intl.NumberFormat();

let dictionaries = [];
let options = { ...DEFAULT_OPTIONS };
let importing = false;
let statusTimer = null;
let requestCounter = 0;
let ankiConfig = null;

function element(id) {
  return document.getElementById(id);
}

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function send(type, fields = {}) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target: TARGET,
    type,
    requestId: `${type.replace(/^hd_/, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) {
    throw new Error("the extension's service worker did not reply");
  }
  return reply;
}

async function sendWorker(type, fields = {}) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target: WORKER_TARGET,
    type,
    requestId: `${type.replace(/^hd_/, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) throw new Error("the extension's service worker did not reply");
  if (!reply.ok) throw new Error(reply.error ?? "the Anki request failed");
  return reply;
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normaliseDictionaries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = [];
  for (const row of value) {
    const title = typeof row?.title === "string" ? row.title : "";
    if (title === "") {
      continue;
    }
    entries.push({
      title,
      path: typeof row?.path === "string" && row.path !== "" ? row.path : `/dicts/${title}`,
      kind: KINDS.includes(row?.kind) ? row.kind : "term",
      enabled: row?.enabled !== false,
    });
  }
  return entries;
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
  element("import-file").disabled = disabled;
  for (const control of document.querySelectorAll(".dict-row select, .dict-row input, .dict-row button")) {
    control.disabled = disabled || control.dataset.pinnedDisabled === "true";
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
  const count = reply.dictionaryCount ?? 0;
  if (reply.ready) {
    const loaded = count === 1 ? "1 dictionary loaded" : `${numberFormat.format(count)} dictionaries loaded`;
    setStatus(reply.loading ? `Ready, ${loaded}, working…` : `Ready, ${loaded}.`, "ready");
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

  // One dictionary holds one row per kind it carries, so a title can appear
  // several times; the chooser is about titles, and a title with a freq row
  // belongs only in the first group.
  const withFrequencies = new Set(
    dictionaries.filter((entry) => entry.kind === "freq").map((entry) => entry.title),
  );
  const groups = [
    { label: "Frequency dictionaries", titles: [...withFrequencies] },
    {
      label: "Other dictionaries (no frequency data)",
      titles: [...new Set(dictionaries.map((entry) => entry.title))]
        .filter((title) => !withFrequencies.has(title)),
    },
  ];
  for (const group of groups) {
    if (group.titles.length === 0) {
      continue;
    }
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const title of group.titles) {
      const option = document.createElement("option");
      option.value = title;
      option.textContent = title;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  // Keep a removed selection visible rather than silently rewriting the option.
  if (previous !== "" && !dictionaries.some((entry) => entry.title === previous)) {
    const stale = document.createElement("option");
    stale.value = previous;
    stale.textContent = `${previous} (not imported)`;
    select.appendChild(stale);
  }
  select.value = previous;
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
  renderFrequencyChoices();
}

function replaceChoices(select, values, selected, emptyLabel) {
  select.textContent = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = values.includes(selected) ? selected : "";
}

function renderAnkiConfig(discovery = null) {
  element("anki-url").value = ankiConfig.url;
  element("anki-api-key").value = ankiConfig.apiKey;
  replaceChoices(element("anki-deck"), discovery?.decks ?? [], ankiConfig.deck, "Choose a deck");
  replaceChoices(element("anki-model"), discovery?.models ?? [], ankiConfig.model, "Choose a note type");
  const fields = discovery?.fields ?? [];
  element("anki-fields").textContent = fields.length > 0 ? fields.join(", ") : "Connect to read fields.";
}

async function readAnkiConfig() {
  const reply = await sendWorker("hd_anki_config_read");
  ankiConfig = reply.config;
  renderAnkiConfig();
}

async function saveAnkiConfig() {
  const reply = await sendWorker("hd_anki_config_write", { config: ankiConfig });
  ankiConfig = reply.config;
}

async function discoverAnki() {
  const output = element("anki-status");
  output.textContent = "Connecting…";
  try {
    ankiConfig = { ...ankiConfig, url: element("anki-url").value,
      apiKey: element("anki-api-key").value };
    await saveAnkiConfig();
    const reply = await sendWorker("hd_anki_discover", { config: ankiConfig });
    renderAnkiConfig(reply.discovery);
    output.textContent = `Connected to AnkiConnect ${reply.discovery.version}.`;
  } catch (error) {
    output.textContent = describe(error);
  }
}

function renderDictionaries() {
  const list = element("dict-list");
  const template = element("dict-row-template");
  list.textContent = "";

  dictionaries.forEach((entry, index) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.classList.toggle("is-off", !entry.enabled);
    row.querySelector(".dict-rank").textContent = String(index + 1);

    const title = row.querySelector(".dict-title");
    title.textContent = entry.title;
    title.title = entry.path;

    const kind = row.querySelector(".dict-kind");
    kind.value = entry.kind;
    kind.addEventListener("change", () => {
      dictionaries[index].kind = kind.value;
      commitDictionaries();
    });

    const enabled = row.querySelector(".dict-enabled");
    enabled.checked = entry.enabled;
    enabled.addEventListener("change", () => {
      dictionaries[index].enabled = enabled.checked;
      commitDictionaries();
    });

    const up = row.querySelector(".dict-up");
    const down = row.querySelector(".dict-down");
    up.dataset.pinnedDisabled = String(index === 0);
    down.dataset.pinnedDisabled = String(index === dictionaries.length - 1);
    up.addEventListener("click", () => {
      moveDictionary(index, -1);
    });
    down.addEventListener("click", () => {
      moveDictionary(index, 1);
    });

    row.querySelector(".dict-remove").addEventListener("click", () => {
      removeDictionary(entry.title);
    });

    list.appendChild(row);
  });

  element("dict-empty").hidden = dictionaries.length > 0;
  setControlsDisabled(importing);
}

function moveDictionary(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= dictionaries.length) {
    return;
  }
  const [entry] = dictionaries.splice(index, 1);
  dictionaries.splice(target, 0, entry);
  commitDictionaries();
}

// Kind, enabled state and order all change what the engine has loaded, so the
// write to storage has to be followed by a reload.
async function commitDictionaries() {
  renderDictionaries();
  renderFrequencyChoices();
  try {
    await chrome.storage.local.set({ dictionaries });
    const reply = await send("hd_reload");
    if (!reply.ok) {
      setStatus(`Could not reload the dictionaries: ${reply.error ?? "unknown error"}`, "error");
      return;
    }
  } catch (error) {
    setStatus(`Could not reload the dictionaries: ${describe(error)}`, "error");
    return;
  }
  await refreshStatus();
}

async function removeDictionary(title) {
  if (!window.confirm(`Remove ${title}? Its imported data is deleted and has to be imported again.`)) {
    return;
  }
  try {
    const reply = await send("hd_remove", { title });
    if (!reply.ok) {
      setStatus(`Could not remove ${title}: ${reply.error ?? "unknown error"}`, "error");
      return;
    }
  } catch (error) {
    setStatus(`Could not remove ${title}: ${describe(error)}`, "error");
    return;
  }
  await reloadDictionaries();
  await refreshStatus();
}

// This page has chrome.storage.local of its own, so it reads the key it is about
// to render directly rather than through the worker and the offscreen document.
async function reloadDictionaries() {
  try {
    const stored = await chrome.storage.local.get("dictionaries");
    dictionaries = normaliseDictionaries(stored.dictionaries);
  } catch (error) {
    setStatus(`Could not read the dictionary list: ${describe(error)}`, "error");
  }
  renderDictionaries();
  renderFrequencyChoices();
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

  element("anki-connect").addEventListener("click", discoverAnki);
  element("anki-deck").addEventListener("change", async event => {
    ankiConfig.deck = event.target.value;
    await saveAnkiConfig();
  });
  element("anki-model").addEventListener("change", async event => {
    ankiConfig.model = event.target.value;
    await saveAnkiConfig();
    await discoverAnki();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!importing) {
      return;
    }
    // Leaving revokes the blob URL the offscreen document is still reading from.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.dictionaries) {
      const next = normaliseDictionaries(changes.dictionaries.newValue);
      if (JSON.stringify(next) !== JSON.stringify(dictionaries)) {
        dictionaries = next;
        renderDictionaries();
        renderFrequencyChoices();
      }
    }
    if (changes.options) {
      const next = normaliseOptions(changes.options.newValue);
      if (JSON.stringify(next) !== JSON.stringify(options)) {
        options = next;
        renderOptions();
      }
    }
  });
}

// Lookup options are read per request by the content script, so nothing needs a
// reload here.
async function writeOptions() {
  try {
    await chrome.storage.local.set({ options });
  } catch (error) {
    setStatus(`Could not save the options: ${describe(error)}`, "error");
  }
}

async function start() {
  const stored = await chrome.storage.local.get(["dictionaries", "options"]);
  dictionaries = normaliseDictionaries(stored.dictionaries);
  options = normaliseOptions(stored.options);
  attachHandlers();
  renderDictionaries();
  renderOptions();
  await readAnkiConfig();
  if (!stored.options) {
    await writeOptions();
  }
  await reloadDictionaries();
  await refreshStatus();
}

start();
